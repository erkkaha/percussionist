// smoke.test.ts — integration smoke tests for the real Hono app.
//
// Uses app.request() (no port binding) against the full app built by
// createApp(). The K8s client and stats DB are both lazy — they only
// initialise on the first request that needs them.
//
// DATA_DIR is set to a temp directory before any request fires, so getDb()
// creates a fresh in-memory-equivalent DB for each test run.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/server/app.js';
import { closeDb } from '../src/server/db.js';
import { resetAuth } from '../src/server/lib/better-auth.js';

// ---------------------------------------------------------------------------
// Test DB isolation — must be set before the first app.request() call that
// hits a DB-backed route, because getDb() is lazy.

const TEST_DATA_DIR = join('/tmp', `percussionist-smoke-${Date.now()}`);

process.env.DATA_DIR = TEST_DATA_DIR;

// Save and restore AUTH_DISABLED so auth.test.ts is not affected by this test.
const _prevAuthDisabled = process.env.AUTH_DISABLED;
process.env.AUTH_DISABLED = '1';

// ---------------------------------------------------------------------------

const app = createApp();

function req(path: string, init?: RequestInit) {
  return app.request(path, init);
}

function json(path: string, body: unknown, method = 'POST') {
  return req(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(() => {
  mkdirSync(TEST_DATA_DIR, { recursive: true });
});

afterAll(() => {
  closeDb();
  resetAuth();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  if (_prevAuthDisabled !== undefined) {
    process.env.AUTH_DISABLED = _prevAuthDisabled;
  } else {
    delete process.env.AUTH_DISABLED;
  }
});

// ===========================================================================
// Health check
// ===========================================================================

describe('health', () => {
  it('GET /api/health → 200', async () => {
    const res = await req('/api/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
  });
});

// ===========================================================================
// Board API
// ===========================================================================
// Board state is backed by K8s Task CRs. Without a live cluster, CRUD
// operations return 5xx K8s errors. These tests verify routes are wired
// correctly (not 404) and that SQLite-backed event endpoints work.

const PROJECT = 'smoke-test-proj';

// What these two assert is that the route is registered — that the request
// reaches a handler instead of falling through to the catch-all. Asserting a
// literal 500 tied that to the absence of a kubeconfig: on a machine with a
// reachable cluster the API server answers 404 for the missing Project and both
// tests failed. The catch-all returns exactly `{ error: 'Not Found' }`
// (server/index.ts) and other misses answer with plain text, so a handler can be
// told from a miss without pinning a status: a miss either carries that exact
// error string or is not JSON at all, and both fail this check.
async function expectHandledNotRouterMiss(res: Response): Promise<void> {
  expect(res.status).toBeGreaterThanOrEqual(400);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.error).toBeDefined();
  expect(body.error).not.toBe('Not Found');
}

describe('board routes', () => {
  // Backed by K8s: without a cluster this fails to connect, with one it reports
  // the missing Project. Either way a handler answered.
  it('GET /api/projects/:project/board reaches its handler', async () => {
    await expectHandledNotRouterMiss(await req(`/api/projects/${PROJECT}/board`));
  });

  it('POST /api/projects/:project/board/tasks missing fields → 400', async () => {
    const res = await json(`/api/projects/${PROJECT}/board/tasks`, {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBeDefined();
  });

  it('PATCH /api/projects/:project/board/spec invalid JSON → 400', async () => {
    const res = await req(`/api/projects/${PROJECT}/board/spec`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/projects/:project/board/tasks reaches its handler', async () => {
    await expectHandledNotRouterMiss(
      await json(`/api/projects/${PROJECT}/board/tasks`, {
        type: 'BUILD',
        title: 'test task',
        agent: 'builder',
      }),
    );
  });

  // Guards the check itself. Without this, a route that stopped being registered
  // would still satisfy the two tests above if a miss happened to look like a
  // handler error.
  it('the wiring check rejects an unregistered /api path', async () => {
    const res = await req('/api/projects/no-such-route-xyz/definitely-not-a-route');
    expect(res.status).toBe(404);

    let rejected = false;
    try {
      await expectHandledNotRouterMiss(res);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });

  it('POST /api/projects/:project/board/tasks/:taskName/move missing column → 400', async () => {
    const res = await json(`/api/projects/${PROJECT}/board/tasks/t1/move`, {});
    expect(res.status).toBe(400);
  });

  it('GET /api/board/:project/events → 200 with empty events list', async () => {
    const res = await req(`/api/board/${PROJECT}/events`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[] };
    expect(Array.isArray(body.events)).toBe(true);
  });

  it('GET /api/board/:project/tasks/:taskName/events → 200 with empty events', async () => {
    const res = await req(`/api/board/${PROJECT}/tasks/t1/events`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[] };
    expect(Array.isArray(body.events)).toBe(true);
  });
});

// ===========================================================================
// Stats API
// ===========================================================================

const SESSION_ID = `smoke-session-${Date.now()}`;

describe('stats API', () => {
  it('GET /api/stats/exists/:sessionID → false for unknown', async () => {
    const res = await req(`/api/stats/exists/no-such-session`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { exists: boolean };
    expect(body.exists).toBe(false);
  });

  it('POST /api/stats/session → 200 ok', async () => {
    const res = await json('/api/stats/session', {
      sessionID: SESSION_ID,
      run: {
        name: 'smoke-run-1',
        namespace: 'percussionist',
        task: 't1',
        model: 'openai/gpt-4o',
        agent: 'builder',
        phase: 'Succeeded',
        startedAt: '2025-01-01T00:00:00Z',
        completedAt: '2025-01-01T00:05:00Z',
        tokensIn: 1000,
        tokensOut: 500,
      },
      messages: [
        {
          id: `${SESSION_ID}-0`,
          idx: 0,
          role: 'user',
          content: JSON.stringify([{ type: 'text', text: 'Hello' }]),
          tokensIn: 10,
          tokensOut: 0,
        },
        {
          id: `${SESSION_ID}-1`,
          idx: 1,
          role: 'assistant',
          content: JSON.stringify([{ type: 'text', text: 'Done' }]),
          tokensIn: 0,
          tokensOut: 50,
        },
      ],
      toolCalls: [
        {
          id: `${SESSION_ID}-tc-1`,
          messageIdx: 1,
          tool: 'Bash',
          args: JSON.stringify({ command: 'ls' }),
          success: true,
          durationMs: 120,
        },
      ],
      fileOps: [{ messageIdx: 1, filePath: '/workspace/src/index.ts', operation: 'read' }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('GET /api/stats/exists/:sessionID → true after insert', async () => {
    const res = await req(`/api/stats/exists/${SESSION_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { exists: boolean };
    expect(body.exists).toBe(true);
  });

  it('POST /api/stats/session same ID → idempotent', async () => {
    const res = await json('/api/stats/session', {
      sessionID: SESSION_ID,
      run: {
        name: 'smoke-run-1',
        namespace: 'percussionist',
        phase: 'Succeeded',
        tokensIn: 1000,
        tokensOut: 500,
      },
      messages: [],
      toolCalls: [],
      fileOps: [],
    });
    expect(res.status).toBe(200);
  });

  it('GET /api/stats/export → array includes posted session', async () => {
    const res = await req('/api/stats/export?days=0');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(Array.isArray(body)).toBe(true);
    const found = body.find((s) => s.id === SESSION_ID);
    expect(found).toBeDefined();
  });

  it('GET /api/stats/sessions → paginated result with summary/agents/models', async () => {
    const res = await req('/api/stats/sessions?days=0');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(typeof body.total).toBe('number');
    expect(body.total).toBeGreaterThan(0);
    expect(body.summary).toBeDefined();
    expect((body.summary as Record<string, unknown>).total).toBeGreaterThan(0);
    expect(Array.isArray(body.agentSummaries)).toBe(true);
    expect(Array.isArray(body.modelRows)).toBe(true);
  });

  it('POST /api/stats/session missing sessionID → 400', async () => {
    const res = await json('/api/stats/session', { run: { name: 'x' } });
    expect(res.status).toBe(400);
  });

  it('GET /api/stats/sessions/:name → returns the posted session row', async () => {
    const res = await req(`/api/stats/sessions/smoke-run-1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; name: string; phase: string };
    expect(body.name).toBe('smoke-run-1');
    expect(body.phase).toBe('Succeeded');
    expect(body.id).toBe(SESSION_ID);
  });

  it('GET /api/stats/sessions/:name unknown → 404', async () => {
    const res = await req('/api/stats/sessions/no-such-run');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeDefined();
  });

  it('GET /api/stats/sessions/:name/messages → replays stored messages from the DB', async () => {
    const res = await req('/api/stats/sessions/smoke-run-1/messages');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessionID: string;
      messages: Array<{
        info: { id: string; role: string; sessionID: string };
        parts: Array<{ type: string; text?: string }>;
      }>;
    };
    expect(body.sessionID).toBe(SESSION_ID);
    expect(body.messages.length).toBe(2);
    const first = body.messages[0];
    expect(first?.info.role).toBe('user');
    expect(first?.info.sessionID).toBe(SESSION_ID);
    // The dispatcher persists the full parts array as JSON in `content`, so the
    // replay reconstructs SessionView-compatible parts verbatim.
    expect(first?.parts[0]?.type).toBe('text');
    expect(first?.parts[0]?.text).toBe('Hello');
  });

  it('GET /api/stats/sessions/:name/messages unknown → 404', async () => {
    const res = await req('/api/stats/sessions/no-such-run/messages');
    expect(res.status).toBe(404);
  });
});
