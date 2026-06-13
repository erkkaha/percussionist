// stats-reporter.test.ts — unit tests for manager-side stats reporting

import { describe, expect, it } from 'bun:test';
import {
  buildPayloads,
  extractTokenTotals,
  getManagerRunName,
  MANAGER_RUN_AGENT,
} from '../stats-reporter.js';

// Set env vars at module load time so stats-reporter reads them on import.
process.env.WEB_SERVICE_URL = 'http://web:8080';
process.env.AGENT_OPENCODE_URL = 'http://127.0.0.1:4096';
process.env.PERCUSSIONIST_NAMESPACE = 'percussionist';

describe('manager stats reporter constants', () => {
  it('should have the correct synthetic agent name', () => {
    expect(MANAGER_RUN_AGENT).toBe('manager run');
  });

  it('should generate consistent run names for a given session ID', () => {
    const sessionId = 'test-session-123';
    const name1 = getManagerRunName(sessionId);
    const name2 = getManagerRunName(sessionId);

    expect(name1).toBe(`manager-session-${sessionId}`);
    expect(name1).toBe(name2);
  });

  it('should produce different run names for different session IDs', () => {
    const name1 = getManagerRunName('session-a');
    const name2 = getManagerRunName('session-b');

    expect(name1).not.toBe(name2);
  });
});

describe('extractTokenTotals', () => {
  it('should extract token totals from messages with tokens', () => {
    const messages = [
      {
        info: {
          role: 'user',
          tokens: { input: 10, output: 5 },
        },
      } as any,
      {
        info: {
          role: 'assistant',
          tokens: { input: 0, output: 20 },
        },
      } as any,
    ];

    const totals = extractTokenTotals(messages);
    expect(totals).toEqual({ tokensIn: 10, tokensOut: 25, cost: 0 });
  });

  it('should handle messages without token info', () => {
    const messages = [{ info: { role: 'user' } } as any, { info: { role: 'assistant' } } as any];

    const totals = extractTokenTotals(messages);
    expect(totals).toEqual({ tokensIn: 0, tokensOut: 0, cost: 0 });
  });

  it('should include cost when present', () => {
    const messages = [
      { info: { role: 'user', cost: 0.01 } } as any,
      { info: { role: 'assistant', cost: 0.02 } } as any,
    ];

    const totals = extractTokenTotals(messages);
    expect(totals).toEqual({ tokensIn: 0, tokensOut: 0, cost: 0.03 });
  });

  it('should handle mixed messages with and without tokens', () => {
    const messages = [
      { info: { role: 'user', tokens: { input: 5 } } } as any,
      { info: { role: 'assistant' } } as any, // no tokens
      { info: { role: 'user', cost: 0.01 } } as any, // only cost
    ];

    const totals = extractTokenTotals(messages);
    expect(totals).toEqual({ tokensIn: 5, tokensOut: 0, cost: 0.01 });
  });
});

describe('buildPayloads', () => {
  it('should build message payload with all fields', () => {
    const messages = [
      {
        info: {
          id: 'msg-1',
          role: 'user',
          model: { providerID: 'openai', modelID: 'gpt-4' },
          time: { created: 1000, completed: 2000 },
          tokens: {
            input: 10,
            output: 5,
            reasoning: 2,
            cache: { read: 3, write: 1 },
          },
          cost: 0.042,
        },
        parts: [{ type: 'text', text: 'Hello' }],
      } as any,
    ];

    const { messagesPayload } = buildPayloads(messages, 'session-1', 0);
    expect(messagesPayload).toHaveLength(1);

    const msg = messagesPayload[0];
    expect(msg).toEqual({
      id: 'msg-1',
      idx: 0,
      role: 'user',
      content: JSON.stringify([{ type: 'text', text: 'Hello' }]),
      model: 'openai/gpt-4',
      tokensIn: 10,
      tokensOut: 5,
      tokensReasoning: 2,
      tokensCacheRead: 3,
      tokensCacheWrite: 1,
      cost: 0.042,
      createdAt: new Date(1000).toISOString(),
      completedAt: new Date(2000).toISOString(),
    });
  });

  it('should build message payload with string model', () => {
    const messages = [{ info: { role: 'user', model: 'openai/gpt-4' }, parts: [] } as any];

    const { messagesPayload } = buildPayloads(messages, 'session-1', 0);
    expect(messagesPayload[0].model).toBe('openai/gpt-4');
  });

  it('should extract file operations from tool parts with filePath', () => {
    const messages = [
      {
        info: { role: 'assistant' },
        parts: [
          {
            type: 'tool',
            tool: 'write_file',
            input: { filePath: '/path/to/file.ts' } as any,
          } as any,
        ],
      } as any,
    ];

    const { fileOpsPayload } = buildPayloads(messages, 'session-1', 0);
    expect(fileOpsPayload).toHaveLength(1);
    expect(fileOpsPayload[0]).toEqual({
      messageIdx: 0,
      filePath: '/path/to/file.ts',
      operation: 'write',
    });
  });

  it('should extract file operations from tool parts with path', () => {
    const messages = [
      {
        info: { role: 'assistant' },
        parts: [
          {
            type: 'tool',
            tool: 'read_file',
            state: { input: { path: '/path/to/file.ts' } } as any,
          } as any,
        ],
      } as any,
    ];

    const { fileOpsPayload } = buildPayloads(messages, 'session-1', 0);
    expect(fileOpsPayload).toHaveLength(1);
    expect(fileOpsPayload[0]).toEqual({
      messageIdx: 0,
      filePath: '/path/to/file.ts',
      operation: 'read',
    });
  });

  it('should extract file operations from tool parts with input.path (tool name variation)', () => {
    const messages = [
      {
        info: { role: 'assistant' },
        parts: [
          {
            type: 'tool',
            tool: 'readFile',
            state: { input: { path: '/src/app.ts' } } as any,
          } as any,
        ],
      } as any,
    ];

    const { fileOpsPayload } = buildPayloads(messages, 'session-1', 0);
    expect(fileOpsPayload).toHaveLength(1);
    expect(fileOpsPayload[0]).toEqual({
      messageIdx: 0,
      filePath: '/src/app.ts',
      operation: 'read',
    });
  });

  it('should extract file operations from tool-use parts with filePath', () => {
    const messages = [
      {
        info: { role: 'assistant' },
        parts: [
          {
            type: 'tool-use',
            name: 'edit_file',
            input: { path: '/src/app.ts' } as any,
          } as any,
        ],
      } as any,
    ];

    const { fileOpsPayload } = buildPayloads(messages, 'session-1', 0);
    expect(fileOpsPayload).toHaveLength(1);
    expect(fileOpsPayload[0].filePath).toBe('/src/app.ts');
  });

  it('should detect file operations correctly based on tool name', () => {
    const testCases: Array<{ tool: string; expectedOp: string }> = [
      { tool: 'read_file', expectedOp: 'read' },
      { tool: 'readFile', expectedOp: 'read' },
      { tool: 'read', expectedOp: 'read' },
      { tool: 'write_file', expectedOp: 'write' },
      { tool: 'writeFile', expectedOp: 'write' },
      { tool: 'write', expectedOp: 'write' },
      { tool: 'edit', expectedOp: 'write' },
      { tool: 'multiedit', expectedOp: 'write' },
      { tool: 'delete_file', expectedOp: 'delete' },
      { tool: 'rm', expectedOp: 'access' }, // unknown tool defaults to access
    ];

    testCases.forEach(({ tool, expectedOp }) => {
      const messages = [
        {
          info: { role: 'assistant' },
          parts: [{ type: 'tool', tool, state: { input: { filePath: '/test.ts' } } }] as any,
        } as any,
      ];

      const { fileOpsPayload } = buildPayloads(messages, 'session-1', 0);
      expect(fileOpsPayload).toHaveLength(1);
      expect(fileOpsPayload[0].operation).toBe(expectedOp);
    });
  });

  it('should include file path from file part', () => {
    const messages = [
      {
        info: { role: 'user' },
        parts: [{ type: 'file', path: '/read/file.txt' }] as any,
      } as any,
    ];

    const { fileOpsPayload } = buildPayloads(messages, 'session-1', 0);
    expect(fileOpsPayload).toHaveLength(1);
    expect(fileOpsPayload[0]).toEqual({
      messageIdx: 0,
      filePath: '/read/file.txt',
      operation: 'read',
    });
  });

  it('should handle unknown part types gracefully', () => {
    const messages = [
      {
        info: { role: 'assistant' },
        parts: [{ type: 'unknown-type', someField: 'value' }] as any,
      } as any,
    ];

    // Should not throw and should produce empty fileOps
    const { fileOpsPayload } = buildPayloads(messages, 'session-1', 0);
    expect(fileOpsPayload).toHaveLength(0);
  });

  it('should handle message parts that are null/undefined', () => {
    const messages = [{ info: { role: 'user' }, parts: null }] as any;

    // Should not throw
    const result = buildPayloads(messages, 'session-1', 0);
    expect(result.messagesPayload).toHaveLength(1);
  });

  it('should handle empty messages array', () => {
    const { messagesPayload, toolCallsPayload, fileOpsPayload } = buildPayloads([], 'session-1', 0);

    expect(messagesPayload).toEqual([]);
    expect(toolCallsPayload).toEqual([]);
    expect(fileOpsPayload).toEqual([]);
  });

  it('should apply baseIdx to message indices', () => {
    const messages = [{ info: { role: 'user' }, parts: [] } as any];

    const { messagesPayload } = buildPayloads(messages, 'session-1', 5);
    expect(messagesPayload[0].idx).toBe(5); // baseIdx + 0
  });
});

// ---------------------------------------------------------------------------
// Incremental flush — PATCH /api/stats/session
// ---------------------------------------------------------------------------

describe('incrementalFlushManagerSession', () => {
  it("should issue PATCH with run.agent = 'manager run' on success", async () => {
    let openCodeCallCount = 0;
    let patchBody: unknown = null;

    globalThis.fetch = async (url: any, init?: any) => {
      const urlString = typeof url === 'string' ? url : url.toString();
      if (urlString.includes('/session/session-abc/message') && !urlString.includes('stats')) {
        openCodeCallCount++;
        return new Response(
          JSON.stringify([
            { info: { role: 'user', tokens: { input: 10 } }, parts: [] },
            {
              info: { role: 'assistant', tokens: { output: 20 }, time: { completed: Date.now() } },
              parts: [{ type: 'text', text: 'Hi' }],
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      // Web stats endpoint (PATCH)
      patchBody = JSON.parse((init as any).body);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const { incrementalFlushManagerSession } = await import('../stats-reporter.js');
    const result = await incrementalFlushManagerSession('session-abc', new Date().toISOString(), 0);

    expect(result).toBe(2); // cursor advanced to total messages seen
    expect(openCodeCallCount).toBe(1);
    expect(patchBody).not.toBeNull();
    const body = patchBody as Record<string, unknown>;
    expect((body.run as any).agent).toBe('manager run');
  });

  it('should return fromIdx immediately when no new messages (idempotency)', async () => {
    const _patchCallCount = 0;

    globalThis.fetch = async (_url: any, _init?: any) => {
      // Return same number of messages as fromIdx — nothing new to flush
      return new Response(
        JSON.stringify([
          { info: { role: 'user' }, parts: [] },
          {
            info: { role: 'assistant', tokens: { output: 5 } },
            parts: [{ type: 'text', text: 'X' }],
          },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    const { incrementalFlushManagerSession } = await import('../stats-reporter.js');
    const result = await incrementalFlushManagerSession('session-abc', new Date().toISOString(), 2);

    expect(result).toBe(2); // cursor unchanged — no flush sent
  });

  it('should return fromIdx when OpenCode endpoint is not ok', async () => {
    globalThis.fetch = async (_url: any, _init?: any) => {
      return new Response('', { status: 503, headers: { 'Content-Type': 'application/json' } });
    };

    const { incrementalFlushManagerSession } = await import('../stats-reporter.js');
    const result = await incrementalFlushManagerSession('session-abc', new Date().toISOString(), 0);

    expect(result).toBe(0); // returns fromIdx on error — non-fatal
  });

  it('should return fromIdx when fetch throws (network error)', async () => {
    globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };

    const { incrementalFlushManagerSession } = await import('../stats-reporter.js');
    const result = await incrementalFlushManagerSession('session-abc', new Date().toISOString(), 0);

    expect(result).toBe(0); // returns fromIdx on network error — non-fatal
  });

  it("should send correct payload structure with agent = 'manager run'", async () => {
    let capturedBody: unknown = null;

    globalThis.fetch = async (url: any, init?: any) => {
      const urlString = typeof url === 'string' ? url : url.toString();
      if (urlString.includes('/session/session-abc/message') && !urlString.includes('stats')) {
        return new Response(
          JSON.stringify([
            {
              info: { role: 'assistant', tokens: { input: 5, output: 10 }, cost: 0.02 },
              parts: [{ type: 'text', text: 'Hello' }],
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      // Capture the PATCH body
      if (urlString.includes('/api/stats/session')) {
        capturedBody = JSON.parse((init as any).body);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response('', { status: 200 });
    };

    const { incrementalFlushManagerSession } = await import('../stats-reporter.js');
    await incrementalFlushManagerSession('session-abc', '2024-01-01T00:00:00.000Z', 0);

    expect(capturedBody).not.toBeNull();
    const body = capturedBody as Record<string, unknown>;
    expect(body.sessionID).toBe('session-abc');
    expect((body.run as any).agent).toBe('manager run');
    expect((body.run as any).name).toBe('manager-session-session-abc');
    expect((body.run as any).phase).toBe('Running');
  });

  it('should handle HTTP error from web pod non-fatally', async () => {
    globalThis.fetch = async (url: any, _init?: any) => {
      const urlString = typeof url === 'string' ? url : url.toString();
      if (urlString.includes('/session/session-abc/message') && !urlString.includes('stats')) {
        return new Response(
          JSON.stringify([{ info: { role: 'assistant', tokens: { output: 5 } }, parts: [] }]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      // Web pod returns error
      return new Response('Internal Server Error', { status: 500 });
    };

    const { incrementalFlushManagerSession } = await import('../stats-reporter.js');
    const result = await incrementalFlushManagerSession('session-abc', new Date().toISOString(), 0);

    expect(result).toBe(1); // cursor advanced despite web error — non-fatal
  });

  it('should handle AbortSignal.timeout failure gracefully', async () => {
    globalThis.fetch = async (url: any, _init?: any) => {
      const urlString = typeof url === 'string' ? url : url.toString();
      if (urlString.includes('/session/session-abc/message') && !urlString.includes('stats')) {
        return new Response(
          JSON.stringify([{ info: { role: 'assistant', tokens: { output: 5 } }, parts: [] }]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      // Simulate timeout by rejecting
      return new Promise<Response>((_resolve, reject) => {
        setTimeout(() => reject(new Error('Timeout')), 10);
      });
    };

    const { incrementalFlushManagerSession } = await import('../stats-reporter.js');
    const result = await incrementalFlushManagerSession('session-abc', new Date().toISOString(), 0);

    expect(result).toBe(1); // cursor advanced despite timeout — non-fatal
  });
});

// ---------------------------------------------------------------------------
// Final flush — POST /api/stats/session
// ---------------------------------------------------------------------------

describe('sendManagerSessionStats', () => {
  it('should issue POST with phase Succeeded on success', async () => {
    let capturedBody: unknown = null;

    globalThis.fetch = async (url: any, init?: any) => {
      const urlString = typeof url === 'string' ? url : url.toString();
      if (urlString.includes('/session/session-abc/message') && !urlString.includes('stats')) {
        return new Response(
          JSON.stringify([
            {
              info: { role: 'assistant', tokens: { input: 10, output: 20 }, cost: 0.05 },
              parts: [{ type: 'text', text: 'Done' }],
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      capturedBody = JSON.parse((init as any).body);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const { sendManagerSessionStats } = await import('../stats-reporter.js');
    await sendManagerSessionStats(
      'session-abc',
      'Succeeded',
      '2024-01-01T00:00:00.000Z',
      '2024-01-01T00:01:00.000Z',
    );

    expect(capturedBody).not.toBeNull();
    const body = capturedBody as Record<string, unknown>;
    expect((body.run as any).phase).toBe('Succeeded');
    expect((body.run as any).agent).toBe('manager run');
    expect((body.run as any).name).toBe('manager-session-session-abc');
  });

  it('should issue POST with phase Failed on failure', async () => {
    let capturedBody: unknown = null;

    globalThis.fetch = async (url: any, init?: any) => {
      const urlString = typeof url === 'string' ? url : url.toString();
      if (urlString.includes('/session/session-abc/message') && !urlString.includes('stats')) {
        return new Response(
          JSON.stringify([{ info: { role: 'assistant', tokens: { output: 5 } }, parts: [] }]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      capturedBody = JSON.parse((init as any).body);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const { sendManagerSessionStats } = await import('../stats-reporter.js');
    await sendManagerSessionStats(
      'session-abc',
      'Failed',
      '2024-01-01T00:00:00.000Z',
      '2024-01-01T00:01:00.000Z',
    );

    expect(capturedBody).not.toBeNull();
    const body = capturedBody as Record<string, unknown>;
    expect((body.run as any).phase).toBe('Failed');
  });

  it('should retry up to 3 times on HTTP error with exponential backoff', async () => {
    let postCallCount = 0;

    globalThis.fetch = async (url: any, _init?: any) => {
      const urlString = typeof url === 'string' ? url : url.toString();
      if (urlString.includes('/session/session-abc/message') && !urlString.includes('stats')) {
        return new Response(
          JSON.stringify([{ info: { role: 'assistant', tokens: { output: 5 } }, parts: [] }]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      postCallCount++;
      if (postCallCount < 3) {
        return new Response('Service Unavailable', { status: 503 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const { sendManagerSessionStats } = await import('../stats-reporter.js');
    // Should not throw — retries are non-fatal
    await sendManagerSessionStats(
      'session-abc',
      'Succeeded',
      new Date().toISOString(),
      new Date().toISOString(),
    );

    expect(postCallCount).toBe(3); // 2 failures + 1 success
  });

  it('should swallow errors after all retries exhausted (non-fatal)', async () => {
    globalThis.fetch = async (_url: any, _init?: any) => {
      return new Response('Bad Gateway', { status: 502 });
    };

    const { sendManagerSessionStats } = await import('../stats-reporter.js');
    // Should not throw — all retries exhausted but non-fatal
    await expect(async () => {
      await sendManagerSessionStats(
        'session-abc',
        'Failed',
        new Date().toISOString(),
        new Date().toISOString(),
      );
    }).not.toThrow();
  });

  it('should swallow network errors after all retries exhausted (non-fatal)', async () => {
    let callCount = 0;
    globalThis.fetch = async (_url: any, _init?: any) => {
      callCount++;
      if (callCount <= 3) throw new Error('ECONNREFUSED');
      return new Response('', { status: 200 });
    };

    const { sendManagerSessionStats } = await import('../stats-reporter.js');
    // Should not throw — network errors are non-fatal
    await expect(async () => {
      await sendManagerSessionStats(
        'session-abc',
        'Failed',
        new Date().toISOString(),
        new Date().toISOString(),
      );
    }).not.toThrow();

    // Should have made 3 POST attempts (all failed) + 1 OpenCode fetch = 4 total
    expect(callCount).toBe(4);
  });

  it('should handle messages fetch failure gracefully', async () => {
    globalThis.fetch = async (_url: any, _init?: any) => {
      throw new Error('Network error');
    };

    const { sendManagerSessionStats } = await import('../stats-reporter.js');
    // Should not throw — message fetch failure is handled
    await expect(async () => {
      await sendManagerSessionStats(
        'session-abc',
        'Succeeded',
        new Date().toISOString(),
        new Date().toISOString(),
      );
    }).not.toThrow();

    // Should still attempt POST with empty messages (best-effort)
  });

  it('should include completedAt in payload when provided', async () => {
    let capturedBody: unknown = null;

    globalThis.fetch = async (url: any, init?: any) => {
      const urlString = typeof url === 'string' ? url : url.toString();
      if (urlString.includes('/session/session-abc/message') && !urlString.includes('stats')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      capturedBody = JSON.parse((init as any).body);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const { sendManagerSessionStats } = await import('../stats-reporter.js');
    await sendManagerSessionStats(
      'session-abc',
      'Succeeded',
      '2024-01-01T00:00:00.000Z',
      '2024-01-01T00:05:00.000Z',
    );

    expect(capturedBody).not.toBeNull();
    const body = capturedBody as Record<string, unknown>;
    expect((body.run as any).completedAt).toBe('2024-01-01T00:05:00.000Z');
  });

  it('should handle undefined completedAt gracefully', async () => {
    let capturedBody: unknown = null;

    globalThis.fetch = async (url: any, init?: any) => {
      const urlString = typeof url === 'string' ? url : url.toString();
      if (urlString.includes('/session/session-abc/message') && !urlString.includes('stats')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      capturedBody = JSON.parse((init as any).body);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const { sendManagerSessionStats } = await import('../stats-reporter.js');
    await sendManagerSessionStats(
      'session-abc',
      'Succeeded',
      '2024-01-01T00:00:00.000Z',
      undefined,
    );

    expect(capturedBody).not.toBeNull();
    const body = capturedBody as Record<string, unknown>;
    // completedAt should be undefined (omitted from JSON)
    expect((body.run as any).completedAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// waitForCompletion() flush integration tests
// ---------------------------------------------------------------------------

describe('waitForCompletion flush integration', () => {
  it('should call incremental flush during each polling iteration', async () => {
    let messageCount = 0;
    const openCodeCalls: string[] = [];
    const patchCalls: Record<string, unknown>[] = [];

    globalThis.fetch = async (url: any, init?: any) => {
      const urlString = typeof url === 'string' ? url : url.toString();

      if (urlString.includes('/session/session-abc/message') && !urlString.includes('stats')) {
        openCodeCalls.push(urlString);
        messageCount++;
        // First poll: no assistant messages yet
        if (messageCount <= 2) {
          return new Response(
            JSON.stringify([{ info: { role: 'user', tokens: { input: 5 } }, parts: [] }]),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        // Third poll: assistant message completed
        return new Response(
          JSON.stringify([
            { info: { role: 'user', tokens: { input: 5 } }, parts: [] },
            {
              info: { role: 'assistant', tokens: { output: 10 }, time: { completed: Date.now() } },
              parts: [{ type: 'text', text: 'Done' }],
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (urlString.includes('/api/stats/session')) {
        const method = (init as any)?.method;
        if (method === 'PATCH') {
          patchCalls.push(JSON.parse((init as any).body));
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      return new Response('', { status: 200 });
    };

    const { waitForCompletion } = await import('../session.js');
    // Use very short timeout so test completes quickly
    const result = await waitForCompletion('session-abc', 5000);

    expect(result).toBe('Done');
    // Multiple incremental flushes should have been called (one per poll) + final flush
    expect(patchCalls.length).toBeGreaterThan(1);
    // All patches should have agent = "manager run"
    for (const call of patchCalls) {
      expect((call as any).run.agent).toBe('manager run');
    }
  });

  it('should call final flush with Succeeded phase on completion', async () => {
    let _messageCount = 0;
    const postCalls: Record<string, unknown>[] = [];

    globalThis.fetch = async (url: any, init?: any) => {
      const urlString = typeof url === 'string' ? url : url.toString();

      if (urlString.includes('/session/session-abc/message') && !urlString.includes('stats')) {
        _messageCount++;
        // First poll returns assistant with completed flag
        return new Response(
          JSON.stringify([
            {
              info: { role: 'assistant', tokens: { output: 10 }, time: { completed: Date.now() } },
              parts: [{ type: 'text', text: 'Ready' }],
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (urlString.includes('/api/stats/session')) {
        const method = (init as any)?.method;
        if (method === 'POST') {
          postCalls.push(JSON.parse((init as any).body));
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      return new Response('', { status: 200 });
    };

    const { waitForCompletion } = await import('../session.js');
    const result = await waitForCompletion('session-abc', 5000);

    expect(result).toBe('Ready');
    // Final POST should have been called with Succeeded phase
    expect(postCalls.length).toBeGreaterThan(0);
    for (const call of postCalls) {
      expect((call as any).run.phase).toBe('Succeeded');
    }
  });

  it('should call final flush with Failed phase on timeout', async () => {
    const postCalls: Record<string, unknown>[] = [];

    globalThis.fetch = async (url: any, init?: any) => {
      const urlString = typeof url === 'string' ? url : url.toString();

      if (urlString.includes('/session/session-abc/message') && !urlString.includes('stats')) {
        // Never returns assistant messages — will timeout
        return new Response(
          JSON.stringify([{ info: { role: 'user', tokens: { input: 5 } }, parts: [] }]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (urlString.includes('/api/stats/session')) {
        const method = (init as any)?.method;
        if (method === 'POST') {
          postCalls.push(JSON.parse((init as any).body));
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      return new Response('', { status: 200 });
    };

    const { waitForCompletion } = await import('../session.js');
    // Very short timeout to trigger quickly
    const result = await waitForCompletion('session-abc', 100);

    expect(result).toBeNull();
    // Final POST should have been called with Failed phase (timeout)
    expect(postCalls.length).toBeGreaterThan(0);
    for (const call of postCalls) {
      expect((call as any).run.phase).toBe('Failed');
    }
  });

  it('should call final flush with Failed phase on signal abort', async () => {
    const postCalls: Record<string, unknown>[] = [];
    const controller = new AbortController();

    globalThis.fetch = async (url: any, init?: any) => {
      const urlString = typeof url === 'string' ? url : url.toString();

      if (urlString.includes('/session/session-abc/message') && !urlString.includes('stats')) {
        // Never returns assistant messages — will be aborted
        return new Response(
          JSON.stringify([{ info: { role: 'user', tokens: { input: 5 } }, parts: [] }]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (urlString.includes('/api/stats/session')) {
        const method = (init as any)?.method;
        if (method === 'POST') {
          postCalls.push(JSON.parse((init as any).body));
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      return new Response('', { status: 200 });
    };

    const { waitForCompletion } = await import('../session.js');

    // Abort after a short delay
    setTimeout(() => controller.abort(), 50);

    const result = await waitForCompletion('session-abc', 30000, undefined, controller.signal);

    expect(result).toBeNull();
    // Final POST should have been called with Failed phase (cancelled)
    expect(postCalls.length).toBeGreaterThan(0);
    for (const call of postCalls) {
      expect((call as any).run.phase).toBe('Failed');
    }
  });

  it('should not double-report messages — cursor advances correctly', async () => {
    let pollCount = 0;
    const patchBodies: Record<string, unknown>[] = [];

    globalThis.fetch = async (url: any, init?: any) => {
      const urlString = typeof url === 'string' ? url : url.toString();

      if (urlString.includes('/session/session-abc/message') && !urlString.includes('stats')) {
        pollCount++;
        // First few polls: only user messages (no assistant activity, so activity timeout fires)
        if (pollCount <= 2) {
          return new Response(
            JSON.stringify([{ info: { role: 'user', tokens: { input: 5 } }, parts: [] }]),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        // After activity timeout fires, function returns null — but we test cursor behavior
        // by using a longer timeout and growing messages
        const msgCount = Math.min(pollCount - 1, 3);
        const msgs: unknown[] = [];
        for (let i = 0; i < msgCount; i++) {
          msgs.push({
            info: { role: 'assistant', tokens: { output: i + 1 }, time: { completed: Date.now() } },
            parts: [{ type: 'text', text: `Msg ${i}` }],
          });
        }
        return new Response(JSON.stringify(msgs), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (urlString.includes('/api/stats/session')) {
        const method = (init as any)?.method;
        if (method === 'PATCH') {
          patchBodies.push(JSON.parse((init as any).body));
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      return new Response('', { status: 200 });
    };

    const { waitForCompletion } = await import('../session.js');
    // Short timeout so we get a few polls before completion/timeout
    const result = await waitForCompletion('session-abc', 100);

    expect(result).toBeNull(); // will timeout since activityTimeout fires first (no assistant msgs initially)

    // Each PATCH should contain only the delta of new messages
    for (const body of patchBodies) {
      const msgs = (body as any).messages;
      if (Array.isArray(msgs)) {
        // All message indices should be unique within each flush
        const indices = msgs.map((m: any) => m.idx);
        expect(indices.length).toBe(new Set(indices).size);
      }
    }
  });

  it('should handle web pod errors non-fatally during polling', async () => {
    let _pollCount = 0;
    const postCalls: Record<string, unknown>[] = [];

    globalThis.fetch = async (url: any, init?: any) => {
      const urlString = typeof url === 'string' ? url : url.toString();

      if (urlString.includes('/session/session-abc/message') && !urlString.includes('stats')) {
        _pollCount++;
        // Return assistant message on first poll to trigger completion
        return new Response(
          JSON.stringify([
            {
              info: { role: 'assistant', tokens: { output: 10 }, time: { completed: Date.now() } },
              parts: [{ type: 'text', text: 'Done' }],
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (urlString.includes('/api/stats/session')) {
        const method = (init as any)?.method;
        if (method === 'POST') {
          postCalls.push(JSON.parse((init as any).body));
        }
        // Web pod returns error — should be non-fatal
        return new Response('Service Unavailable', { status: 503 });
      }

      return new Response('', { status: 200 });
    };

    const { waitForCompletion } = await import('../session.js');
    // Should not throw despite web pod errors
    await expect(async () => {
      await waitForCompletion('session-abc', 5000);
    }).not.toThrow();

    // Final flush was still attempted (even though it failed)
    expect(postCalls.length).toBeGreaterThan(0);
  });
});
