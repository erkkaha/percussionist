import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { streamSseEvents } from '../polling.js';

// streamSseEvents is the shared SSE transport for the interactive and prompt
// stream loops (extracted from the two copy-pasted streamEvents closures). It
// owns the /event fetch, the \n\n buffer split / data: filter / JSON.parse
// loop, logEvent, reader.cancel(), the 5-error fatal threshold and the 5s /
// 1s backoff sleeps. These tests drive it with a scripted global fetch and an
// injected sleep so the timing-sensitive parts (chunk reassembly, reconnect
// counting, error backoff) are deterministic.
//
// bun reuses the same spy for a given global across tests in a file, so a
// spy's accumulated call count leaks between tests and into later test files
// in the same process. Restore both globals after every test to keep each
// test's counts fresh.

const enc = new TextEncoder();

afterEach(() => {
  (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
  (globalThis.console.log as unknown as { mockRestore?: () => void }).mockRestore?.();
});

/** A one-shot SSE response delivering the given raw chunks then closing. */
function sseResponse(...chunks: string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('streamSseEvents', () => {
  it('delivers events split across chunks', async () => {
    spyOn(globalThis, 'fetch').mockImplementation(async () =>
      // Event `a` arrives whole in the first chunk; event `b`'s JSON is split
      // across the chunk boundary and must be reassembled by the buffer.
      sseResponse('data: {"type":"a"}\n\ndata: {"ty', 'pe":"b"}\n\n'),
    );

    const received: string[] = [];
    let done = false;
    await streamSseEvents({
      mode: 'interactive',
      isTerminated: () => done,
      sleep: async () => {},
      onEvent: async (evt) => {
        if (evt.type) received.push(evt.type);
        if (received.length >= 2) done = true;
      },
    });

    expect(received).toEqual(['a', 'b']);
  });

  it('logs logEvent-worthy events and skips server.connected', async () => {
    const logSpy = spyOn(globalThis.console, 'log');
    spyOn(globalThis, 'fetch').mockImplementation(async () =>
      sseResponse(
        'data: {"type":"server.connected"}\n\n',
        'data: {"type":"message.updated","properties":{"info":{"sessionID":"s1","id":"m1","role":"assistant"}}}\n\n',
      ),
    );

    let done = false;
    await streamSseEvents({
      mode: 'prompt',
      isTerminated: () => done,
      sleep: async () => {},
      // Stop only once the logEvent-worthy event is seen, so the second chunk
      // is actually read (logEvent runs before onEvent in the parse loop).
      onEvent: async (evt) => {
        if (evt.type === 'message.updated') done = true;
      },
    });

    const logged = logSpy.mock.calls.map((c) => c.join(' '));
    expect(logged.some((l) => l.includes('[event] message.updated'))).toBe(true);
    expect(logged.some((l) => l.includes('[event] server.connected'))).toBe(false);
  });

  it('throws the exact message after 5 consecutive stream failures', async () => {
    let calls = 0;
    spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls++;
      throw new Error('connection refused');
    });
    const sleeps: number[] = [];

    await expect(
      streamSseEvents({
        mode: 'interactive',
        isTerminated: () => false,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        onEvent: async () => {},
      }),
    ).rejects.toThrow('opencode server unreachable: stream disconnected');

    expect(calls).toBe(5);
    // 5s error backoff after each of the first 4 failures; the 5th throws.
    expect(sleeps.filter((ms) => ms === 5000)).toHaveLength(4);
    // 1s inter-reconnect delay after each of the first 4 failures.
    expect(sleeps.filter((ms) => ms === 1000)).toHaveLength(4);
  });

  it('resets the error counter after a successful stream', async () => {
    let calls = 0;
    spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls++;
      if (calls === 2) return sseResponse('data: {"type":"session.idle"}\n\n');
      throw new Error('boom');
    });
    const received: string[] = [];

    await expect(
      streamSseEvents({
        mode: 'prompt',
        isTerminated: () => false,
        sleep: async () => {},
        onEvent: async (evt) => {
          if (evt.type) received.push(evt.type);
        },
      }),
    ).rejects.toThrow('opencode server unreachable: stream disconnected');

    // 1 failure, 1 success (resets the counter), then 5 more failures.
    expect(calls).toBe(7);
    expect(received).toEqual(['session.idle']);
  });

  it('sleeps 5s and retries when the response is not ok', async () => {
    let calls = 0;
    spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls++;
      if (calls === 1) return new Response('oops', { status: 503 });
      return sseResponse();
    });
    const sleeps: number[] = [];

    await streamSseEvents({
      mode: 'prompt',
      isTerminated: () => calls >= 2,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      onEvent: async () => {},
    });

    expect(calls).toBe(2);
    // The 503 response triggers the 5s backoff before the retry.
    expect(sleeps).toContain(5000);
  });
});
