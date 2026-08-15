// session.test.ts — snapshot compaction + health-wait semantics.
//
// A6 regression: compactMessagesForSnapshot used to stamp
// `metadata.truncated: true` on EVERY tool part, even when the output was
// under the 4k-char cap and left untouched — so every tool call in every
// ConfigMap session snapshot read as truncated in the web session view and in
// facilitation context. The flag must only be set when the output was sliced.

import { describe, expect, it } from 'bun:test';
import {
  compactMessagesForSnapshot,
  type RawMessage,
  SNAPSHOT_TEXT_CONTENT_CAP,
  SNAPSHOT_TOOL_OUTPUT_CAP,
  SNAPSHOT_TRUNCATION_MARKER,
  type ToolPart,
  waitForHealthy,
} from '../session.js';

const tool = (state?: ToolPart['state']): ToolPart => ({
  type: 'tool',
  tool: 'bash',
  ...(state ? { state } : {}),
});

const message = (parts: RawMessage['parts']): RawMessage => ({
  info: { id: 'm1', role: 'assistant' },
  parts,
});

describe('compactMessagesForSnapshot budget cap', () => {
  it('slices a tool output longer than the cap and keeps exactly cap + marker', () => {
    const long = 'x'.repeat(SNAPSHOT_TOOL_OUTPUT_CAP + 1);
    const [msg] = compactMessagesForSnapshot([message([tool({ output: long })])]);
    const part = msg.parts?.[0] as ToolPart;
    expect(part.state?.output).toBe(
      'x'.repeat(SNAPSHOT_TOOL_OUTPUT_CAP) + SNAPSHOT_TRUNCATION_MARKER,
    );
  });

  it('leaves a tool output exactly at the cap untouched', () => {
    const atCap = 'y'.repeat(SNAPSHOT_TOOL_OUTPUT_CAP);
    const [msg] = compactMessagesForSnapshot([message([tool({ output: atCap })])]);
    const part = msg.parts?.[0] as ToolPart;
    expect(part.state?.output).toBe(atCap);
  });

  it('slices a text part longer than the text cap with the marker', () => {
    const long = 't'.repeat(SNAPSHOT_TEXT_CONTENT_CAP + 1);
    const [msg] = compactMessagesForSnapshot([message([{ type: 'text', text: long }])]);
    const part = msg.parts?.[0] as { type: 'text'; text: string };
    expect(part.text).toBe('t'.repeat(SNAPSHOT_TEXT_CONTENT_CAP) + SNAPSHOT_TRUNCATION_MARKER);
  });

  it('leaves a text part at or under the cap untouched', () => {
    const short = 'hello';
    const original = { type: 'text' as const, text: short };
    const [msg] = compactMessagesForSnapshot([message([original])]);
    expect(msg.parts?.[0]).toBe(original);
  });
});

describe('compactMessagesForSnapshot marker', () => {
  it('appends the truncation marker to sliced tool output', () => {
    const [msg] = compactMessagesForSnapshot([
      message([tool({ output: 'z'.repeat(SNAPSHOT_TOOL_OUTPUT_CAP + 5) })]),
    ]);
    const part = msg.parts?.[0] as ToolPart;
    expect(part.state?.output?.endsWith(SNAPSHOT_TRUNCATION_MARKER)).toBe(true);
  });
});

describe('compactMessagesForSnapshot truncated flag', () => {
  it('does NOT flag a tool output under the cap (A6 regression)', () => {
    const [msg] = compactMessagesForSnapshot([message([tool({ output: 'short output' })])]);
    const part = msg.parts?.[0] as ToolPart;
    expect(part.state?.metadata?.truncated).toBeUndefined();
  });

  it('flags a tool output over the cap as truncated', () => {
    const [msg] = compactMessagesForSnapshot([
      message([tool({ output: 'z'.repeat(SNAPSHOT_TOOL_OUTPUT_CAP + 1) })]),
    ]);
    const part = msg.parts?.[0] as ToolPart;
    expect(part.state?.metadata?.truncated).toBe(true);
  });

  it('preserves pre-existing metadata and adds truncated only when sliced', () => {
    const [sliced] = compactMessagesForSnapshot([
      message([tool({ output: 'z'.repeat(SNAPSHOT_TOOL_OUTPUT_CAP + 1), metadata: { exit: 1 } })]),
    ]);
    expect((sliced.parts?.[0] as ToolPart).state?.metadata).toEqual({ exit: 1, truncated: true });

    const [kept] = compactMessagesForSnapshot([
      message([tool({ output: 'ok', metadata: { exit: 0 } })]),
    ]);
    expect((kept.parts?.[0] as ToolPart).state?.metadata).toEqual({ exit: 0 });
  });

  it('does not flag non-string output (objects pass through untouched)', () => {
    const output = { files: ['a.txt'] };
    const original = tool({ output, metadata: {} });
    const [msg] = compactMessagesForSnapshot([message([original])]);
    const part = msg.parts?.[0] as ToolPart;
    expect(part.state?.output).toBe(output);
    expect(part.state?.metadata?.truncated).toBeUndefined();
  });

  it('passes a tool part without state through unchanged', () => {
    const original = tool();
    const [msg] = compactMessagesForSnapshot([message([original])]);
    expect(msg.parts?.[0]).toBe(original);
  });
});

describe('compactMessagesForSnapshot passthrough', () => {
  it('preserves message info and passes non-tool/non-text parts through', () => {
    const info = { id: 'm1', role: 'assistant' as const, time: { created: 123 } };
    const finish = { type: 'step-finish' as const, id: 'sf1', reason: 'done' };
    const [msg] = compactMessagesForSnapshot([{ info, parts: [finish] }]);
    expect(msg.info).toBe(info);
    expect(msg.parts?.[0]).toBe(finish);
  });

  it('handles messages with no parts array', () => {
    const [msg] = compactMessagesForSnapshot([{ info: { id: 'm1', role: 'assistant' } }]);
    expect(msg.parts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// waitForHealthy

type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

async function withFetchStub<T>(handler: FetchHandler, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init))) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const healthy = () => new Response(JSON.stringify({ healthy: true }), { status: 200 });
const unhealthy = (status = 200) => new Response(JSON.stringify({ healthy: false }), { status });
// Real timer-backed sleep keeps the poll loop from hot-spinning in tests.
const pollSleep = () => new Promise((resolve) => setTimeout(resolve, 2));

describe('waitForHealthy', () => {
  it('resolves once the health endpoint reports healthy', async () => {
    const handler: FetchHandler = (url) => {
      expect(url).toContain('/global/health');
      return healthy();
    };
    await withFetchStub(handler, () => waitForHealthy(1000, () => false, pollSleep));
  });

  it('keeps polling while unhealthy and throws on timeout', async () => {
    let calls = 0;
    const handler: FetchHandler = () => {
      calls += 1;
      return unhealthy();
    };
    await expect(
      withFetchStub(handler, () => waitForHealthy(50, () => false, pollSleep)),
    ).rejects.toThrow(/did not become healthy within 50ms/);
    expect(calls).toBeGreaterThan(1);
  });

  it('surfaces the last HTTP error when the server never returns ok', async () => {
    const handler: FetchHandler = () => new Response('nope', { status: 503 });
    await expect(
      withFetchStub(handler, () => waitForHealthy(50, () => false, pollSleep)),
    ).rejects.toThrow(/HTTP 503/);
  });

  it('surfaces the last transport error when fetch keeps failing', async () => {
    const handler: FetchHandler = () => {
      throw new Error('connection refused');
    };
    await expect(
      withFetchStub(handler, () => waitForHealthy(50, () => false, pollSleep)),
    ).rejects.toThrow(/connection refused/);
  });

  it('returns without throwing when shuttingDown flips before the deadline', async () => {
    let shuttingDown = false;
    const handler: FetchHandler = () => {
      shuttingDown = true;
      return unhealthy(500);
    };
    await withFetchStub(handler, () => waitForHealthy(1000, () => shuttingDown, pollSleep));
  });
});
