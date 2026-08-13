// smoke.test.ts — integration smoke tests for the real Hono app.
//
// Uses app.request() (no port binding) against the full app built by
// createApp(). The K8s client and stats DB are both lazy — they only
// initialise on the first request that needs them.
//
// DATA_DIR is set to a temp directory before any request fires, so getDb()
// creates a fresh in-memory-equivalent DB for each test run.

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
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

// Flipped guard: asserts the API catch-all answered for a path that no longer
// has a handler. The catch-all returns 404 (in the test app, Hono's default
// notFound; in production the explicit `/api/*` handler in index.ts), which is
// exactly what `expectHandledNotRouterMiss` rejects on — so expecting it to
// reject proves no handler matched and the 404 catch-all answered.
async function expectRouterMiss(res: Response): Promise<void> {
  expect(res.status).toBe(404);
  let rejected = false;
  try {
    await expectHandledNotRouterMiss(res);
  } catch {
    rejected = true;
  }
  expect(rejected).toBe(true);
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

  it('POST /api/projects/:project/board/tasks/:taskName/abandon reaches its handler', async () => {
    await expectHandledNotRouterMiss(
      await req(`/api/projects/${PROJECT}/board/tasks/t1/abandon`, { method: 'POST' }),
    );
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

// Response shape of GET /api/stats/sessions — mirrors the client types in
// SessionList.tsx / StatsView.tsx so shape drift is caught here.
interface SessionRow {
  id: string;
  name: string;
  resolvedModel: string;
  agent: string | null;
  model: string | null;
  phase: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

interface AgentSummaryRow {
  agent: string;
  runs: number;
  succeeded: number;
  failed: number;
  successRate: number | null;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCost: number;
  avgTokensPerRun: number;
  avgDurationMs: number | null;
  models: string[];
}

interface ModelRow {
  model: string;
  runs: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
}

interface SessionsResponse {
  sessions: SessionRow[];
  total: number;
  limit: number;
  offset: number;
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    successRate: number | null;
    totalTokensIn: number;
    totalTokensOut: number;
    totalCost: number;
    avgDurationMs: number | null;
  };
  agentSummaries: AgentSummaryRow[];
  modelRows: ModelRow[];
}

describe('stats API', () => {
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

  it('GET /api/stats/exists/:sessionID → 404 (route removed)', async () => {
    const res = await req(`/api/stats/exists/${SESSION_ID}`);
    await expectRouterMiss(res);
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

  it('GET /api/stats/export → array includes posted session with nested children', async () => {
    const res = await req('/api/stats/export?days=0');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: string;
      messages: Array<{ id: string }>;
      toolCalls: unknown[];
      fileOps: unknown[];
    }>;
    expect(Array.isArray(body)).toBe(true);
    const found = body.find((s) => s.id === SESSION_ID);
    expect(found).toBeDefined();
    // Nested children present for the returned session — the batched fetch
    // must reassemble the same nested shape the old per-session N+1 loop did.
    expect(found?.messages.some((m) => m.id === `${SESSION_ID}-0`)).toBe(true);
    expect(found?.toolCalls.length).toBe(1);
    expect(found?.fileOps.length).toBe(1);
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

  it('GET /api/stats/sessions paginates in SQL and aggregates over the full window', async () => {
    // Baseline: exactly the SESSION_ID posted by the earlier tests in this file.
    // If this ever fails, an earlier test started inserting sessions and the
    // hand-computed expectations below need updating.
    const baseRes = await req('/api/stats/sessions?days=0');
    expect(baseRes.status).toBe(200);
    const base = (await baseRes.json()) as SessionsResponse;
    expect(base.total).toBe(1);

    const now = Date.now();
    const inserts = [
      {
        // Same agent/model as the baseline session (builder + openai/gpt-4o).
        sessionID: `smoke-paging-builder-${now}`,
        run: {
          name: 'smoke-run-2',
          agent: 'builder',
          model: 'openai/gpt-4o',
          phase: 'Succeeded',
          startedAt: '2025-02-01T00:00:00Z',
          completedAt: '2025-02-01T00:10:00Z', // 600000 ms
          tokensIn: 1000,
          tokensOut: 500,
          cost: 0.05,
        },
        messages: [],
        toolCalls: [],
        fileOps: [],
      },
      {
        sessionID: `smoke-paging-planner-${now}`,
        run: {
          name: 'smoke-run-3',
          agent: 'planner',
          model: 'anthropic/claude-3',
          phase: 'Failed',
          startedAt: '2025-02-02T00:00:00Z',
          completedAt: '2025-02-02T00:20:00Z', // 1200000 ms
          tokensIn: 2000,
          tokensOut: 1000,
          cost: 0.1,
        },
        messages: [],
        toolCalls: [],
        fileOps: [],
      },
      {
        // No runs.model — resolved from the user message's model.
        sessionID: `smoke-paging-reviewer-${now}`,
        run: {
          name: 'smoke-run-4',
          agent: 'reviewer',
          model: null,
          phase: 'Succeeded',
          startedAt: '2025-02-03T00:00:00Z',
          completedAt: null, // no duration
          tokensIn: 500,
          tokensOut: 250,
          cost: 0.025,
        },
        messages: [
          {
            id: `smoke-paging-reviewer-${now}-m0`,
            idx: 0,
            role: 'user',
            content: '[]',
            model: 'openai/gpt-4o',
          },
        ],
        toolCalls: [],
        fileOps: [],
      },
    ];
    for (const payload of inserts) {
      expect((await json('/api/stats/session', payload)).status).toBe(200);
    }

    // First page: LIMIT/OFFSET must be applied in SQL, newest startedAt first.
    const res = await req('/api/stats/sessions?days=0&limit=2&offset=0');
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionsResponse;
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(0);
    expect(body.sessions.length).toBe(2);
    expect(body.sessions.map((s) => s.name)).toEqual(['smoke-run-4', 'smoke-run-3']);
    // Correlated subquery resolves the reviewer session's model from its user message.
    expect(body.sessions[0]?.resolvedModel).toBe('openai/gpt-4o');

    // Second page — offset works in SQL too.
    const res2 = await req('/api/stats/sessions?days=0&limit=2&offset=2');
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as SessionsResponse;
    expect(body2.sessions.map((s) => s.name)).toEqual(['smoke-run-2', 'smoke-run-1']);

    // total + summary cover the full window (4 sessions = 1 baseline + 3 new),
    // independent of the page bounds.
    expect(body.total).toBe(4);
    expect(body.summary.total).toBe(4);
    expect(body.summary.succeeded).toBe(3);
    expect(body.summary.failed).toBe(1);
    expect(body.summary.successRate).toBe(75);
    expect(body.summary.totalTokensIn).toBe(4500);
    expect(body.summary.totalTokensOut).toBe(2250);
    expect(body.summary.totalCost).toBeCloseTo(0.175, 5);
    // Durations: 300000 (baseline) + 600000 + 1200000 over 3 runs.
    expect(body.summary.avgDurationMs).toBe(700000);

    // modelRows — resolved models, ordered by tokensIn DESC.
    expect(body.modelRows).toHaveLength(2);
    const gptRow = body.modelRows[0];
    expect(gptRow.model).toBe('openai/gpt-4o');
    expect(gptRow.runs).toBe(3); // baseline + smoke-run-2 + smoke-run-4 (message-resolved)
    expect(gptRow.tokensIn).toBe(2500);
    expect(gptRow.tokensOut).toBe(1250);
    expect(gptRow.cost).toBeCloseTo(0.075, 6);
    const claudeRow = body.modelRows[1];
    expect(claudeRow.model).toBe('anthropic/claude-3');
    expect(claudeRow.runs).toBe(1);
    expect(claudeRow.tokensIn).toBe(2000);
    expect(claudeRow.tokensOut).toBe(1000);
    expect(claudeRow.cost).toBeCloseTo(0.1, 6);

    // agentSummaries — per-agent SQL groups with derived values.
    expect(body.agentSummaries).toHaveLength(3);
    const byAgent = (agent: string) => {
      const row = body.agentSummaries.find((a) => a.agent === agent);
      expect(row).toBeDefined();
      return row as AgentSummaryRow;
    };

    const builder = byAgent('builder');
    expect(builder.runs).toBe(2);
    expect(builder.succeeded).toBe(2);
    expect(builder.failed).toBe(0);
    expect(builder.successRate).toBe(100);
    expect(builder.totalTokensIn).toBe(2000);
    expect(builder.totalTokensOut).toBe(1000);
    expect(builder.totalCost).toBeCloseTo(0.05, 6);
    expect(builder.avgTokensPerRun).toBe(1500);
    // (300000 + 600000) / 2
    expect(builder.avgDurationMs).toBe(450000);
    expect(builder.models).toEqual(['openai/gpt-4o']);

    const planner = byAgent('planner');
    expect(planner.runs).toBe(1);
    expect(planner.succeeded).toBe(0);
    expect(planner.failed).toBe(1);
    expect(planner.successRate).toBe(0);
    expect(planner.totalTokensIn).toBe(2000);
    expect(planner.totalTokensOut).toBe(1000);
    expect(planner.totalCost).toBeCloseTo(0.1, 6);
    expect(planner.avgTokensPerRun).toBe(3000);
    expect(planner.avgDurationMs).toBe(1200000);
    expect(planner.models).toEqual(['anthropic/claude-3']);

    const reviewer = byAgent('reviewer');
    expect(reviewer.runs).toBe(1);
    expect(reviewer.succeeded).toBe(1);
    expect(reviewer.failed).toBe(0);
    expect(reviewer.successRate).toBe(100);
    expect(reviewer.totalTokensIn).toBe(500);
    expect(reviewer.totalTokensOut).toBe(250);
    expect(reviewer.totalCost).toBeCloseTo(0.025, 6);
    expect(reviewer.avgTokensPerRun).toBe(750);
    // No completedAt — duration stays null.
    expect(reviewer.avgDurationMs).toBeNull();
    // models[] comes from runs.model only; smoke-run-4 has none.
    expect(reviewer.models).toEqual([]);

    // agentSummaries sorted by runs DESC (builder first).
    expect(body.agentSummaries[0]?.agent).toBe('builder');
  });

  it('GET /api/stats/export respects EXPORT_MAX_SESSIONS and logs truncation', async () => {
    // Cap the export to 2 sessions and insert 3 fresh ones (newest startedAt
    // last). The DB already holds the baseline + paging sessions from earlier
    // tests, so the window exceeds the cap and the export must truncate to the
    // 2 most recent sessions with a console.warn. Placed after the paging test
    // so the hand-computed baseline (total === 1) above stays stable.
    const prevCap = process.env.EXPORT_MAX_SESSIONS;
    process.env.EXPORT_MAX_SESSIONS = '2';

    const warn = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warn;

    try {
      const now = Date.now();
      const inserts = [
        {
          sessionID: `smoke-export-cap-1-${now}`,
          run: {
            name: 'cap-run-1',
            agent: 'builder',
            phase: 'Succeeded',
            startedAt: '2025-04-01T00:00:00Z',
            completedAt: '2025-04-01T00:05:00Z',
            tokensIn: 100,
            tokensOut: 50,
          },
          messages: [{ id: `cap-1-m-${now}`, idx: 0, role: 'user', content: '[]' }],
          toolCalls: [],
          fileOps: [],
        },
        {
          sessionID: `smoke-export-cap-2-${now}`,
          run: {
            name: 'cap-run-2',
            agent: 'builder',
            phase: 'Succeeded',
            startedAt: '2025-04-02T00:00:00Z',
            completedAt: '2025-04-02T00:05:00Z',
            tokensIn: 100,
            tokensOut: 50,
          },
          messages: [{ id: `cap-2-m-${now}`, idx: 0, role: 'user', content: '[]' }],
          toolCalls: [],
          fileOps: [],
        },
        {
          sessionID: `smoke-export-cap-3-${now}`,
          run: {
            name: 'cap-run-3',
            agent: 'builder',
            phase: 'Succeeded',
            startedAt: '2025-04-03T00:00:00Z',
            completedAt: '2025-04-03T00:05:00Z',
            tokensIn: 100,
            tokensOut: 50,
          },
          messages: [{ id: `cap-3-m-${now}`, idx: 0, role: 'user', content: '[]' }],
          toolCalls: [],
          fileOps: [],
        },
      ];
      for (const payload of inserts) {
        expect((await json('/api/stats/session', payload)).status).toBe(200);
      }

      const res = await req('/api/stats/export?days=0');
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{
        name: string;
        messages: Array<{ id: string }>;
      }>;
      expect(Array.isArray(body)).toBe(true);

      // Cap respected: only the 2 most recent sessions (by startedAt DESC) are
      // returned, never more than EXPORT_MAX_SESSIONS.
      expect(body.length).toBe(2);
      expect(body.map((s) => s.name)).toEqual(['cap-run-3', 'cap-run-2']);

      // Nested children present for the returned sessions.
      expect(body[0]?.messages.length).toBe(1);
      expect(body[0]?.messages[0]?.id).toBe(`cap-3-m-${now}`);
      expect(body[1]?.messages.length).toBe(1);

      // Truncation logged via console.warn.
      expect(warn).toHaveBeenCalled();
      const args = warn.mock.calls[0] as [string];
      expect(args[0]).toContain('export truncated');
      expect(args[0]).toContain('EXPORT_MAX_SESSIONS=2');
    } finally {
      console.warn = originalWarn;
      if (prevCap !== undefined) process.env.EXPORT_MAX_SESSIONS = prevCap;
      else delete process.env.EXPORT_MAX_SESSIONS;
    }
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

// ===========================================================================
// Removed product surface — deleted endpoints must be answered by the 404
// catch-all, not by a handler.
// ===========================================================================

describe('removed product surface → API 404 catch-all', () => {
  // These were deleted as dead product surface: the four findings-triage
  // routes and GET /stats/exists/:sessionID. (The board task /abandon route
  // was among them but was re-added by the waiting-for-input exit work — it is
  // asserted as wired in the board routes block above.) A reviewer of the
  // guard itself should note the wiring check above — the flip of
  // expectHandledNotRouterMiss is asserted per path here.
  const removedPaths: Array<{ method: string; path: string; body?: unknown }> = [
    { method: 'GET', path: `/api/projects/${PROJECT}/findings` },
    { method: 'GET', path: `/api/projects/${PROJECT}/findings/f1` },
    {
      method: 'PATCH',
      path: `/api/projects/${PROJECT}/findings/f1`,
      body: { status: 'wontfix' },
    },
    { method: 'POST', path: `/api/projects/${PROJECT}/findings/f1/task`, body: { type: 'BUILD' } },
    { method: 'GET', path: '/api/stats/exists/sid' },
  ];

  for (const { method, path, body } of removedPaths) {
    it(`${method} ${path} → 404 from the API catch-all`, async () => {
      const res = await req(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      await expectRouterMiss(res);
    });
  }
});
