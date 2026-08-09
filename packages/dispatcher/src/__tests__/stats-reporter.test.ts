// stats-reporter.test.ts — incrementalFlush cursor-advancement semantics.
//
// WEB_STATS_URL / OPENCODE_BASE_URL are read at module scope (stats-reporter.ts:14,
// session.ts:3), so env must be set BEFORE the dynamic import; restore in afterAll.

import { afterAll, describe, expect, it } from 'bun:test';
import type { RawMessage } from '../session.js';

const ORIGINAL_ENV = { ...process.env };

process.env.WEB_STATS_URL = 'http://web.test';
process.env.OPENCODE_BASE_URL = 'http://opencode.test';
process.env.RUN_NAME = 'test-run';
process.env.RUN_NAMESPACE = 'test-ns';
process.env.RUN_TASK = 'test-task';
process.env.RUN_MODEL = 'test-model';
process.env.RUN_AGENT = 'test-agent';

// Query-string variant: test files share a module registry, and other files
// (e.g. sse-stream/poll-status/token-aggregator via polling.js) import
// stats-reporter.js at module scope with WEB_STATS_URL unset, caching it with
// an empty URL. The `?test` query forces a fresh evaluation AFTER the env is
// set above, so the module-scope `WEB_STATS_URL` is `http://web.test`.
const { incrementalFlush } = await import('../stats-reporter.js?test');

afterAll(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const startedAt = '2026-08-09T00:00:00.000Z';
const totals = {
  tokensIn: 10,
  tokensOut: 20,
  tokensReasoning: 0,
  tokensCacheRead: 0,
  tokensCacheWrite: 0,
  cost: 0.001,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fakeMessages(count: number): RawMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    info: { id: `msg-${i}`, role: 'assistant' as const, time: { created: 1000 + i } },
    parts: [{ type: 'text', text: `hello ${i}` }],
  }));
}

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

describe('incrementalFlush cursor advancement', () => {
  it('advances the cursor to rawMessages.length when the PATCH succeeds (200)', async () => {
    const handler: FetchHandler = (url) => {
      if (url.includes('/session/s1/message')) return jsonResponse(fakeMessages(2));
      if (url.includes('/api/stats/session')) return jsonResponse({ ok: true });
      throw new Error(`unexpected URL: ${url}`);
    };
    const result = await withFetchStub(handler, () => incrementalFlush('s1', startedAt, totals, 0));
    expect(result).toBe(2);
  });

  it('holds the cursor (returns fromIdx) when the PATCH returns HTTP 500', async () => {
    const handler: FetchHandler = (url) => {
      if (url.includes('/session/s1/message')) return jsonResponse(fakeMessages(2));
      if (url.includes('/api/stats/session')) return jsonResponse({ error: 'boom' }, 500);
      throw new Error(`unexpected URL: ${url}`);
    };
    const result = await withFetchStub(handler, () => incrementalFlush('s1', startedAt, totals, 0));
    expect(result).toBe(0);
  });

  it('holds the cursor (returns fromIdx) when the PATCH throws', async () => {
    const handler: FetchHandler = (url) => {
      if (url.includes('/session/s1/message')) return jsonResponse(fakeMessages(2));
      if (url.includes('/api/stats/session')) throw new Error('connection refused');
      throw new Error(`unexpected URL: ${url}`);
    };
    const result = await withFetchStub(handler, () => incrementalFlush('s1', startedAt, totals, 0));
    expect(result).toBe(0);
  });

  it('holds the cursor (returns fromIdx) when the message fetch is not ok (regression guard)', async () => {
    const handler: FetchHandler = (url) => {
      if (url.includes('/session/s1/message')) return jsonResponse({ error: 'gone' }, 500);
      throw new Error(`unexpected URL: ${url}`);
    };
    const result = await withFetchStub(handler, () => incrementalFlush('s1', startedAt, totals, 0));
    expect(result).toBe(0);
  });

  it('holds the cursor (returns fromIdx) when the message fetch throws (regression guard)', async () => {
    const handler: FetchHandler = (url) => {
      if (url.includes('/session/s1/message')) throw new Error('opencode busy');
      throw new Error(`unexpected URL: ${url}`);
    };
    const result = await withFetchStub(handler, () => incrementalFlush('s1', startedAt, totals, 0));
    expect(result).toBe(0);
  });

  it('returns fromIdx when there is nothing new (rawMessages.length <= fromIdx)', async () => {
    const handler: FetchHandler = (url) => {
      if (url.includes('/session/s1/message')) return jsonResponse(fakeMessages(2));
      throw new Error(`unexpected URL: ${url}`);
    };
    const result = await withFetchStub(handler, () => incrementalFlush('s1', startedAt, totals, 2));
    expect(result).toBe(2);
  });

  it('returns fromIdx when WEB_STATS_URL is unset (fresh module instance)', async () => {
    delete process.env.WEB_STATS_URL;
    try {
      const fresh = await import('../stats-reporter.js?no-url');
      const result = await fresh.incrementalFlush('s1', startedAt, totals, 0);
      expect(result).toBe(0);
    } finally {
      process.env.WEB_STATS_URL = 'http://web.test';
    }
  });
});
