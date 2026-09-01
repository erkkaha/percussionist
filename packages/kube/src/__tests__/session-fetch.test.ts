// session-fetch.test.ts — regression tests for the OpenCode session-fetch
// helpers' 20MB body guard and abort-timer lifecycle.
//
// fetchSessionMessages and fetchAllSessionMessages talk to a live run pod via
// global fetch. These tests stub globalThis.fetch with Response objects whose
// bodies are real ReadableStreams so the guard inside readJsonWithLimit (the
// shared private helper both functions use) is exercised end-to-end:
// over-limit bodies reject, under-limit bodies parse, and an oversized
// per-session body in fetchAllSessionMessages is skipped, not fatal. The
// abort-timer fix is structural (clearTimeout now runs after the body is read
// and when fetch rejects), so it is asserted via completion, never via timer
// introspection.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { fetchAllSessionMessages, fetchSessionMessages } from '../index.js';

const NS = 'test-ns';
const SVC = 'opencode-svc';

const originalFetch = globalThis.fetch;

// --- ReadableStream response helpers -----------------------------------------

/** A Response whose body is a real ReadableStream emitting the given bytes. */
function streamResponse(bytes: Uint8Array): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
}

function jsonResponse(data: unknown): Response {
  return streamResponse(new TextEncoder().encode(JSON.stringify(data)));
}

/** A body larger than the 20MB cap (single chunk, not valid JSON). */
function oversizedResponse(size = 20_000_001): Response {
  return streamResponse(new Uint8Array(size));
}

// --- fetch stub ---------------------------------------------------------------

let fetchHandler: (url: string) => Response;

beforeEach(() => {
  fetchHandler = () => jsonResponse({});
  globalThis.fetch = ((input: unknown) =>
    Promise.resolve(fetchHandler(String(input)))) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('fetchAllSessionMessages — 20MB guard', () => {
  it('rejects when the session list response exceeds 20MB', async () => {
    fetchHandler = () => oversizedResponse();
    await expect(fetchAllSessionMessages(SVC, NS)).rejects.toThrow(/too large/i);
  });

  it('parses an under-limit session list and per-session messages', async () => {
    fetchHandler = (url) => {
      if (url.endsWith('/session')) return jsonResponse([{ id: 's1' }, { id: 's2' }]);
      if (url.includes('/message')) return jsonResponse([{ id: 'm1' }, { id: 'm2' }]);
      throw new Error(`unexpected URL: ${url}`);
    };
    const result = await fetchAllSessionMessages(SVC, NS);
    expect(result.sessions).toEqual([
      { id: 's1', messages: [{ id: 'm1' }, { id: 'm2' }] },
      { id: 's2', messages: [{ id: 'm1' }, { id: 'm2' }] },
    ]);
    expect(result.allMessages).toEqual([{ id: 'm1' }, { id: 'm2' }, { id: 'm1' }, { id: 'm2' }]);
  });

  it('skips a session whose message body exceeds 20MB instead of failing the whole fetch', async () => {
    fetchHandler = (url) => {
      if (url.endsWith('/session')) return jsonResponse([{ id: 's1' }, { id: 's2' }]);
      if (url.includes('/s1/message')) return oversizedResponse();
      if (url.includes('/s2/message')) return jsonResponse([{ id: 'ok' }]);
      throw new Error(`unexpected URL: ${url}`);
    };
    const result = await fetchAllSessionMessages(SVC, NS);
    expect(result.sessions).toEqual([{ id: 's2', messages: [{ id: 'ok' }] }]);
    expect(result.allMessages).toEqual([{ id: 'ok' }]);
  });
});

describe('fetchSessionMessages — 20MB guard and timer lifecycle', () => {
  it('rejects when the response exceeds 20MB', async () => {
    fetchHandler = () => oversizedResponse();
    await expect(fetchSessionMessages(SVC, 's1', NS)).rejects.toThrow(/too large/i);
  });

  it('parses an under-limit response', async () => {
    fetchHandler = () => jsonResponse([{ id: 'm1' }]);
    await expect(fetchSessionMessages(SVC, 's1', NS)).resolves.toEqual([{ id: 'm1' }]);
  });

  it('propagates a fetch rejection and completes (timer cleared via finally)', async () => {
    fetchHandler = () => {
      throw new Error('network down');
    };
    await expect(fetchSessionMessages(SVC, 's1', NS)).rejects.toThrow('network down');
  });

  it('propagates a non-ok status rejection and completes', async () => {
    fetchHandler = () => new Response('nope', { status: 503 });
    await expect(fetchSessionMessages(SVC, 's1', NS)).rejects.toThrow(/503/);
  });
});
