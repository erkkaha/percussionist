// chat-handler.test.ts
//
// Coverage for test gap C3 from percussionist-dev-plan-4abf54. The chat
// handler's ConfigMap persistence, session reuse and abort race are module-
// private (only startChatServer is production-reachable), so they are exposed
// under __test — same pattern as tools.ts's __test / session-summarizer's
// __sessionFns — and exercised here against a fake CoreV1Api (spy on kube.core)
// and spied session-layer functions. No live cluster or HTTP socket required.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { EventEmitter } from 'node:events';
import * as kube from '@percussionist/kube';
import { __test } from '../chat-handler.js';
import * as session from '../session.js';

const NS = 'percussionist';
const CONFIGMAP_NAME = 'manager-chat-history';

function notFoundError(message = 'ConfigMap not found'): Error {
  return Object.assign(new Error(message), { statusCode: 404 });
}

function jsonBody(messages: Array<{ role: string; text: string }>): string {
  return JSON.stringify(messages);
}

// ---------------------------------------------------------------------------
// Fake CoreV1Api recording every ConfigMap interaction
// ---------------------------------------------------------------------------

interface FakeCoreCalls {
  patches: Array<{
    args: { name: string; namespace: string; body: { data?: Record<string, string> } };
    header: unknown;
  }>;
  creates: Array<{
    args: { namespace: string; body: { metadata: { name: string }; data: Record<string, string> } };
  }>;
  reads: Array<{ args: { name: string; namespace: string } }>;
}

function installFakeCore(state: {
  historyData?: Record<string, string>;
  readThrows?: unknown;
  patchThrows?: unknown;
  createThrows?: unknown;
}): { coreSpy: ReturnType<typeof spyOn>; calls: FakeCoreCalls } {
  const calls: FakeCoreCalls = { patches: [], creates: [], reads: [] };
  const coreSpy = spyOn(kube, 'core').mockReturnValue({
    readNamespacedConfigMap: async (args: { name: string; namespace: string }) => {
      calls.reads.push({ args });
      if (state.readThrows) throw state.readThrows;
      if (!state.historyData) throw notFoundError(`ConfigMap ${args.name} not found`);
      return { data: state.historyData };
    },
    patchNamespacedConfigMap: async (
      args: { name: string; namespace: string; body: { data?: Record<string, string> } },
      header: unknown,
    ) => {
      calls.patches.push({ args, header });
      if (state.patchThrows) throw state.patchThrows;
      return { metadata: { name: args.name } };
    },
    createNamespacedConfigMap: async (args: {
      namespace: string;
      body: { metadata: { name: string }; data: Record<string, string> };
    }) => {
      calls.creates.push({ args });
      if (state.createThrows) throw state.createThrows;
      return { metadata: { name: args.body.metadata.name } };
    },
  } as never);
  return { coreSpy, calls };
}

function seedHistory(messages: Array<{ role: string; text: string }>): void {
  __test.getState().conversationHistory.push(...messages);
}

// ---------------------------------------------------------------------------
// HTTP handler harness — fake request/response objects
// ---------------------------------------------------------------------------

class FakeRes extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = '';
  headersSent = false;

  writeHead(status: number, headers: Record<string, string>): this {
    this.statusCode = status;
    this.headers = headers;
    this.headersSent = true;
    return this;
  }

  end(data?: string): this {
    this.body = data ?? '';
    return this;
  }
}

function makeReq(method: string, url: string, rawBody?: string): EventEmitter {
  const req = new EventEmitter() as EventEmitter & { method: string; url: string };
  (req as { method: string }).method = method;
  (req as { url: string }).url = url;
  if (rawBody !== undefined) {
    setImmediate(() => {
      req.emit('data', Buffer.from(rawBody));
      req.emit('end');
    });
  }
  return req;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// Session-layer spies
// ---------------------------------------------------------------------------

let createSessionSpy: ReturnType<typeof spyOn>;
let getMessagesSpy: ReturnType<typeof spyOn>;
let sendMessageSpy: ReturnType<typeof spyOn>;
let waitForCompletionSpy: ReturnType<typeof spyOn>;

let sessionCounter: number;

beforeEach(() => {
  sessionCounter = 0;
  createSessionSpy = spyOn(session, 'createSession').mockImplementation(async () => {
    sessionCounter += 1;
    return `session-${sessionCounter}`;
  });
  getMessagesSpy = spyOn(session, 'getMessages').mockResolvedValue([]);
  sendMessageSpy = spyOn(session, 'sendMessage').mockResolvedValue(undefined as never);
  waitForCompletionSpy = spyOn(session, 'waitForCompletion').mockResolvedValue('done');
  __test.reset();
});

afterEach(() => {
  createSessionSpy.mockRestore();
  getMessagesSpy.mockRestore();
  sendMessageSpy.mockRestore();
  waitForCompletionSpy.mockRestore();
  __test.reset();
});

// ---------------------------------------------------------------------------
// loadHistoryFromConfigMap
// ---------------------------------------------------------------------------

describe('loadHistoryFromConfigMap', () => {
  it('restores valid history from the ConfigMap', async () => {
    const history = [
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'hello' },
    ];
    installFakeCore({ historyData: { 'history.json': jsonBody(history) } });

    await __test.loadHistoryFromConfigMap();

    expect(__test.getState().conversationHistory).toEqual(history);
  });

  it('ignores a missing ConfigMap (404) and keeps history empty', async () => {
    installFakeCore({});

    await __test.loadHistoryFromConfigMap();

    expect(__test.getState().conversationHistory).toEqual([]);
  });

  it('ignores malformed JSON in the ConfigMap', async () => {
    installFakeCore({ historyData: { 'history.json': 'not json {{{' } });

    await __test.loadHistoryFromConfigMap();

    expect(__test.getState().conversationHistory).toEqual([]);
  });

  it('ignores data that is not an array of role/text entries', async () => {
    installFakeCore({
      historyData: {
        'history.json': JSON.stringify([
          { role: 'user' }, // missing text
          { text: 'orphan' }, // missing role
          'garbage',
        ]),
      },
    });

    await __test.loadHistoryFromConfigMap();

    expect(__test.getState().conversationHistory).toEqual([]);
  });

  it('does not throw on non-404 read errors (degraded to in-memory only)', async () => {
    installFakeCore({ readThrows: Object.assign(new Error('API error'), { statusCode: 500 }) });

    await expect(__test.loadHistoryFromConfigMap()).resolves.toBeUndefined();
    expect(__test.getState().conversationHistory).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// saveHistoryToConfigMap — patch-then-create
// ---------------------------------------------------------------------------

describe('saveHistoryToConfigMap — patch-then-create', () => {
  const seeded = [
    { role: 'user', text: 'first' },
    { role: 'assistant', text: 'reply' },
  ] as Array<{ role: 'user' | 'assistant'; text: string }>;

  beforeEach(() => {
    seedHistory(seeded);
  });

  it('patches the existing ConfigMap with the merged history', async () => {
    const { calls } = installFakeCore({});

    await __test.saveHistoryToConfigMap();

    expect(calls.patches).toHaveLength(1);
    expect(calls.creates).toHaveLength(0);
    expect(calls.patches[0]?.args.name).toBe(CONFIGMAP_NAME);
    expect(calls.patches[0]?.args.namespace).toBe(NS);
    expect(calls.patches[0]?.args.body).toEqual({
      data: { 'history.json': jsonBody(seeded) },
    });
    // Merge-patch header middleware from setHeaderOptions must be attached.
    expect(calls.patches[0]?.header).toEqual(
      expect.objectContaining({ middleware: expect.any(Array) }),
    );
  });

  it('creates the ConfigMap when the patch 404s (first run)', async () => {
    const { calls } = installFakeCore({ patchThrows: notFoundError() });

    await __test.saveHistoryToConfigMap();

    expect(calls.patches).toHaveLength(1);
    expect(calls.creates).toHaveLength(1);
    expect(calls.creates[0]?.args.body.metadata.name).toBe(CONFIGMAP_NAME);
    expect(calls.creates[0]?.args.body.metadata.labels).toEqual({
      'app.kubernetes.io/name': 'percussionist',
      'app.kubernetes.io/component': 'manager',
    });
    expect(calls.creates[0]?.args.body.data).toEqual({
      'history.json': jsonBody(seeded),
    });
  });

  it('does not throw when creating still fails (logged only)', async () => {
    installFakeCore({
      patchThrows: notFoundError(),
      createThrows: Object.assign(new Error('forbidden'), { statusCode: 403 }),
    });

    await expect(__test.saveHistoryToConfigMap()).resolves.toBeUndefined();
  });

  it('does not attempt creation for non-404 patch errors', async () => {
    const { calls } = installFakeCore({
      patchThrows: Object.assign(new Error('API error'), { statusCode: 500 }),
    });

    await expect(__test.saveHistoryToConfigMap()).resolves.toBeUndefined();
    expect(calls.creates).toHaveLength(0);
  });

  it('stores only the last 100 messages', async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({
      role: 'user' as const,
      text: `msg-${i}`,
    }));
    const { calls } = installFakeCore({});
    __test.getState().conversationHistory.push(...many);

    await __test.saveHistoryToConfigMap();

    const saved = JSON.parse(calls.patches[0]?.args.body.data?.['history.json'] ?? '[]') as Array<{
      text: string;
    }>;
    expect(saved).toHaveLength(100);
    expect(saved[0]?.text).toBe('msg-50');
    expect(saved[99]?.text).toBe('msg-149');
  });
});

// ---------------------------------------------------------------------------
// ensureSession — session reuse
// ---------------------------------------------------------------------------

describe('ensureSession — session reuse', () => {
  it('creates a session when none is current', async () => {
    const id = await __test.ensureSession();

    expect(id).toBe('session-1');
    expect(createSessionSpy).toHaveBeenCalledWith('manager-interactive', 'manager-decision');
  });

  it('reuses the current session while it still has messages', async () => {
    await __test.ensureSession(); // creates session-1
    getMessagesSpy.mockResolvedValue([
      { info: { id: 'm1', role: 'user' }, parts: [{ type: 'text', text: 'hi' }] },
    ]);

    const id = await __test.ensureSession();

    expect(id).toBe('session-1');
    expect(getMessagesSpy).toHaveBeenCalledWith('session-1');
    expect(createSessionSpy).toHaveBeenCalledTimes(1);
  });

  it('creates a fresh session when the current one has no messages', async () => {
    await __test.ensureSession(); // creates session-1
    getMessagesSpy.mockResolvedValue([]);

    const id = await __test.ensureSession();

    expect(id).toBe('session-2');
    expect(createSessionSpy).toHaveBeenCalledTimes(2);
  });

  it('creates a fresh session when the current one is gone (getMessages throws)', async () => {
    await __test.ensureSession(); // creates session-1
    getMessagesSpy.mockRejectedValue(new Error('session expired'));

    const id = await __test.ensureSession();

    expect(id).toBe('session-2');
    expect(createSessionSpy).toHaveBeenCalledTimes(2);
    // A new session starts with no history.
    expect(__test.getState().conversationHistory).toEqual([]);
  });

  it('clears history when a new session is created', async () => {
    seedHistory([{ role: 'user', text: 'stale' }]);

    await __test.ensureSession();

    expect(__test.getState().conversationHistory).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// handleChat — happy path, validation, session reuse
// ---------------------------------------------------------------------------

describe('handleChat', () => {
  it('responds with the agent answer and appends the reply to history', async () => {
    waitForCompletionSpy.mockResolvedValue('The answer');
    const req = makeReq('POST', '/chat', JSON.stringify({ message: 'hello' }));
    const res = new FakeRes();

    await __test.handleChat(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ response: 'The answer', sessionId: 'session-1' });
    // The user message is pushed before ensureSession(); when a fresh session is
    // created (as on the first message) ensureSession resets history to [], so
    // only the assistant reply survives. Existing production behavior — pinned
    // as-is; candidates for a follow-up fix.
    expect(__test.getState().conversationHistory).toEqual([
      { role: 'assistant', text: 'The answer' },
    ]);
    expect(createSessionSpy).toHaveBeenCalledWith('manager-interactive', 'manager-decision');
  });

  it('reuses the existing session for a second message (createSession once)', async () => {
    waitForCompletionSpy.mockResolvedValue('first answer');
    await __test.handleChat(
      makeReq('POST', '/chat', JSON.stringify({ message: 'msg one' })) as never,
      new FakeRes() as never,
    );
    // Second message: the current session still has messages → reuse.
    getMessagesSpy.mockResolvedValue([
      { info: { id: 'm1', role: 'assistant' }, parts: [{ type: 'text', text: 'first answer' }] },
    ]);
    waitForCompletionSpy.mockResolvedValue('second answer');

    await __test.handleChat(
      makeReq('POST', '/chat', JSON.stringify({ message: 'msg two' })) as never,
      new FakeRes() as never,
    );

    expect(createSessionSpy).toHaveBeenCalledTimes(1);
    expect(getMessagesSpy).toHaveBeenCalledWith('session-1');
  });

  it('returns 400 for invalid JSON', async () => {
    const req = makeReq('POST', '/chat', '{not json');
    const res = new FakeRes();

    await __test.handleChat(req as never, res as never);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid JSON' });
  });

  it('returns 400 when the message is missing or empty', async () => {
    const req = makeReq('POST', '/chat', JSON.stringify({}));
    const res = new FakeRes();

    await __test.handleChat(req as never, res as never);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'message is required' });
  });

  it('returns a timeout notice when the agent never answers', async () => {
    waitForCompletionSpy.mockResolvedValue(null);
    const req = makeReq('POST', '/chat', JSON.stringify({ message: 'hello' }));
    const res = new FakeRes();

    await __test.handleChat(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      response: 'Agent did not respond in time. Please try again.',
      sessionId: 'session-1',
    });
  });
});

// ---------------------------------------------------------------------------
// handleChat — abort race
// ---------------------------------------------------------------------------

describe('handleChat — abort race', () => {
  it('a client disconnect aborts the pending wait and responds cancelled', async () => {
    let capturedSignal: AbortSignal | undefined;
    waitForCompletionSpy.mockImplementation(
      (_sid: string, _timeout: number, _frto: number | undefined, signal?: AbortSignal) => {
        capturedSignal = signal;
        // The wait resolves only when the client disconnects.
        return new Promise<string | null>((resolve) => {
          signal?.addEventListener('abort', () => resolve(null), { once: true });
        });
      },
    );

    const req = new EventEmitter() as EventEmitter & { method: string; url: string };
    req.method = 'POST';
    req.url = '/chat';
    const res = new FakeRes();

    const pending = __test.handleChat(req as never, res as never);
    await tick(); // readBody listeners attached
    req.emit('data', Buffer.from(JSON.stringify({ message: 'hello' })));
    req.emit('end');
    await tick(); // handler reached the waitForCompletion race
    expect(capturedSignal).toBeDefined();

    req.emit('close'); // client disconnects mid-turn
    await pending;

    expect(capturedSignal?.aborted).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ cancelled: true, sessionId: 'session-1' });
  });

  it('the send controller aborts alongside the wait when the client disconnects', async () => {
    let capturedSignal: AbortSignal | undefined;
    let capturedSendSignal: AbortSignal | undefined;
    sendMessageSpy.mockImplementation(
      (_sid: string, _msg: string, _agent: string, signal?: AbortSignal) => {
        capturedSendSignal = signal;
        return Promise.resolve(undefined);
      },
    );
    waitForCompletionSpy.mockImplementation(
      (_sid: string, _timeout: number, _frto: number | undefined, signal?: AbortSignal) => {
        capturedSignal = signal;
        return new Promise<string | null>((resolve) => {
          signal?.addEventListener('abort', () => resolve(null), { once: true });
        });
      },
    );

    const req = new EventEmitter() as EventEmitter & { method: string; url: string };
    req.method = 'POST';
    req.url = '/chat';
    const res = new FakeRes();

    const pending = __test.handleChat(req as never, res as never);
    await tick();
    req.emit('data', Buffer.from(JSON.stringify({ message: 'hello' })));
    req.emit('end');
    await tick();
    expect(capturedSignal).toBeDefined();
    expect(capturedSendSignal).toBeDefined();

    req.emit('close');
    await pending;

    expect(capturedSignal?.aborted).toBe(true);
    expect(capturedSendSignal?.aborted).toBe(true);
    expect(JSON.parse(res.body)).toEqual({ cancelled: true, sessionId: 'session-1' });
  });
});

// ---------------------------------------------------------------------------
// Debounced ConfigMap persistence through the real handler path
// ---------------------------------------------------------------------------

describe('handleChat — debounced ConfigMap persistence', () => {
  it('persists history to the ConfigMap after the debounce window', async () => {
    waitForCompletionSpy.mockResolvedValue('saved reply');
    const { calls } = installFakeCore({});

    await __test.handleChat(
      makeReq('POST', '/chat', JSON.stringify({ message: 'persist me' })) as never,
      new FakeRes() as never,
    );

    // Debounce is 2s — wait past it and allow the fire-and-forget save to run.
    await new Promise((resolve) => setTimeout(resolve, 2200));

    expect(calls.patches.length).toBeGreaterThan(0);
    const saved = JSON.parse(calls.patches[0]?.args.body.data?.['history.json'] ?? '[]') as Array<{
      role: string;
      text: string;
    }>;
    // The user message was cleared by the fresh-session reset in ensureSession
    // (see the happy-path test above) — the persisted history holds the reply.
    expect(saved).toEqual([{ role: 'assistant', text: 'saved reply' }]);
  }, 10_000);
});
