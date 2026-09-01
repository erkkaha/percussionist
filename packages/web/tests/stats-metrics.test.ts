// stats-metrics.test.ts — route-level tests for the money-adjacent stats math
// (C8) and the hourly retention cleanup (C12):
//
//   - GET /api/stats/tool-metrics — per-message token attribution across tool
//     calls (tokensOut / message's tool-call count), agent summary, and
//     window/agent filtering.
//   - GET /api/stats/trends — daily aggregates, success rate, cost, and the
//     per-model token pivot.
//   - GET /api/stats/metrics-timeseries — cpu/mem percentage math, per-minute
//     bucketing per node and averaged across nodes, node filter.
//   - runRetentionCleanup() — deletes runs older than RETENTION_DAYS and relies
//     on FK ON DELETE CASCADE to sweep messages / tool_calls / file_ops.
//
// RETENTION_DAYS is read from the environment once at module load, so it must
// be set before the stats module is imported — hence the dynamic import below
// (--isolate keeps the env change contained to this file).
//
// Each test opens its own temp DATA_DIR (getDb() is lazy and re-reads
// process.env.DATA_DIR on every open after closeDb()), so every test seeds a
// fresh DB — the hand-computed expectations below never interact with rows
// seeded by another test.

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { closeDb, getDb, metricSnapshots, runs, toolCalls } from '../src/server/db.js';
import { resetAuth } from '../src/server/lib/better-auth.js';

process.env.AUTH_DISABLED = '1';
process.env.RETENTION_DAYS = '1';

const { default: statsRouter, runRetentionCleanup } = await import('../src/server/routes/stats.js');

type SeedSession = (payload: {
  sessionID: string;
  run: Record<string, unknown>;
  messages?: Array<Record<string, unknown>>;
  toolCalls?: Array<Record<string, unknown>>;
  fileOps?: Array<Record<string, unknown>>;
}) => Promise<Response>;

interface TestClient {
  req: (path: string, init?: RequestInit) => Promise<Response>;
  seedSession: SeedSession;
}

const dataDirs: string[] = [];

// Fresh temp DATA_DIR + app for an isolated test DB. The returned client's
// requests hit a Hono app mounted with only the stats router (auth is disabled
// via AUTH_DISABLED=1).
function makeClient(): TestClient {
  const dataDir = join('/tmp', `percussionist-stats-metrics-${Date.now()}-${Math.random()}`);
  dataDirs.push(dataDir);
  mkdirSync(dataDir, { recursive: true });
  process.env.DATA_DIR = dataDir;
  closeDb();
  resetAuth();

  const app = new Hono();
  app.route('/api/stats', statsRouter);

  return {
    req: (path, init) => app.request(path, init),
    seedSession: (payload) =>
      app.request('/api/stats/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
  };
}

/** Seed a session through POST /api/stats/session, asserting success. */
async function seed(api: TestClient, payload: Parameters<SeedSession>[0]): Promise<void> {
  const res = await api.seedSession(payload);
  expect(res.status).toBe(200);
}

afterEach(() => {
  closeDb();
  resetAuth();
  delete process.env.DATA_DIR;
  for (const dir of dataDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  process.env.AUTH_DISABLED = '1';
});

afterAll(() => {
  closeDb();
  resetAuth();
  delete process.env.DATA_DIR;
  delete process.env.RETENTION_DAYS;
});

// ===========================================================================
// C8 — GET /api/stats/tool-metrics
// ===========================================================================

describe('GET /api/stats/tool-metrics', () => {
  // Seeds two sessions for the builder agent: one with two tool calls sharing
  // an assistant message (tokensOut=100 → 50 each) plus a sole call on its own
  // message (tokensOut=60 → full attribution), and a second with a failed
  // Bash call whose message produced no output tokens.
  async function seedBuilderAgent(api: TestClient): Promise<void> {
    await seed(api, {
      sessionID: 'tm-builder-s1',
      run: {
        name: 'tm-builder-run-1',
        agent: 'builder',
        model: 'openai/gpt-4o',
        phase: 'Succeeded',
        startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        completedAt: new Date(Date.now() - 55 * 60 * 1000).toISOString(),
        tokensIn: 100,
        tokensOut: 20,
      },
      messages: [
        { id: 'tm-b1-m0', idx: 0, role: 'user', content: '[]', tokensIn: 10, tokensOut: 0 },
        { id: 'tm-b1-m1', idx: 1, role: 'assistant', content: '[]', tokensOut: 100 },
        { id: 'tm-b1-m2', idx: 2, role: 'assistant', content: '[]', tokensOut: 60 },
      ],
      toolCalls: [
        {
          id: 'tm-b1-tc-a',
          messageIdx: 1,
          tool: 'Bash',
          args: '{}',
          success: true,
          durationMs: 100,
        },
        {
          id: 'tm-b1-tc-b',
          messageIdx: 1,
          tool: 'Read',
          args: '{}',
          success: true,
          durationMs: 200,
        },
        {
          id: 'tm-b1-tc-c',
          messageIdx: 2,
          tool: 'Write',
          args: '{}',
          success: true,
          durationMs: 300,
        },
      ],
      fileOps: [],
    });

    await seed(api, {
      sessionID: 'tm-builder-s2',
      run: {
        name: 'tm-builder-run-2',
        agent: 'builder2',
        model: 'openai/gpt-4o',
        phase: 'Failed',
        startedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        completedAt: new Date(Date.now() - 29 * 60 * 1000).toISOString(),
        tokensIn: 10,
        tokensOut: 0,
      },
      messages: [
        { id: 'tm-b2-m0', idx: 0, role: 'user', content: '[]', tokensIn: 10, tokensOut: 0 },
        { id: 'tm-b2-m1', idx: 1, role: 'assistant', content: '[]', tokensOut: 0 },
      ],
      toolCalls: [
        {
          id: 'tm-b2-tc-d',
          messageIdx: 1,
          tool: 'Bash',
          args: '{}',
          success: false,
          durationMs: 50,
          error: 'command failed',
        },
      ],
      fileOps: [],
    });
  }

  it('attributes each message tokensOut across the tool calls sharing that message', async () => {
    const api = makeClient();
    await seedBuilderAgent(api);

    const res = await api.req('/api/stats/tool-metrics?days=0&agent=builder');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tools: Array<{
        toolName: string;
        calls: number;
        avgDurationMs: number | null;
        successRate: number | null;
        totalErrors: number;
        sessionsUsing: number;
        estTokensOut: number;
        avgTokensOutPerCall: number;
      }>;
      totalCalls: number;
      totalSessions: number;
      period: { days: number; from: string | null; to: string };
    };

    const byName = (tool: string) => {
      const row = body.tools.find((t) => t.toolName === tool);
      expect(row, `tool ${tool} present`).toBeDefined();
      return row as (typeof body.tools)[number];
    };

    // Shared message (idx 1, tokensOut=100) has 2 tool calls → 50 each.
    const bash = byName('Bash');
    expect(bash.calls).toBe(1);
    expect(bash.avgDurationMs).toBe(100);
    expect(bash.successRate).toBe(1);
    expect(bash.totalErrors).toBe(0);
    expect(bash.sessionsUsing).toBe(1);
    expect(bash.estTokensOut).toBe(50);
    expect(bash.avgTokensOutPerCall).toBe(50);

    const read = byName('Read');
    expect(read.calls).toBe(1);
    expect(read.avgDurationMs).toBe(200);
    expect(read.estTokensOut).toBe(50);
    expect(read.avgTokensOutPerCall).toBe(50);

    // Sole call on its own message (idx 2, tokensOut=60) → full attribution.
    const write = byName('Write');
    expect(write.calls).toBe(1);
    expect(write.avgDurationMs).toBe(300);
    expect(write.estTokensOut).toBe(60);
    expect(write.avgTokensOutPerCall).toBe(60);

    expect(body.totalCalls).toBe(3);
    expect(body.totalSessions).toBe(1);
    expect(body.period.days).toBe(0);
    expect(body.period.from).toBeNull();
    expect(typeof body.period.to).toBe('string');
  });

  it('merges rows across sessions and folds zero-output messages into the average', async () => {
    const api = makeClient();
    await seedBuilderAgent(api);

    const res = await api.req('/api/stats/tool-metrics?days=0');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tools: Array<{
        toolName: string;
        calls: number;
        successRate: number | null;
        totalErrors: number;
        sessionsUsing: number;
        estTokensOut: number;
        avgTokensOutPerCall: number;
      }>;
      totalCalls: number;
      totalSessions: number;
      agentSummary: Array<{
        agent: string;
        calls: number;
        totalTokensOut: number;
        totalSessions: number;
      }>;
    };

    // Both sessions contribute Bash calls: one success (100ms) + one failure
    // (50ms). The failed call's message produced 0 tokensOut, so the token
    // attribution average dilutes from 50 → 25 while the total stays 50.
    const bash = body.tools.find((t) => t.toolName === 'Bash');
    expect(bash).toBeDefined();
    expect(bash?.calls).toBe(2);
    expect(bash?.successRate).toBeCloseTo(0.5, 6);
    expect(bash?.totalErrors).toBe(1);
    expect(bash?.sessionsUsing).toBe(2);
    expect(bash?.estTokensOut).toBe(50);
    expect(bash?.avgTokensOutPerCall).toBe(25);

    expect(body.totalCalls).toBe(4);
    expect(body.totalSessions).toBe(2);

    // Agent summary sums messages.tokensOut over the joined (tool call, message)
    // rows: builder-1's shared message joins twice (100 + 100), its second
    // message once (60), builder-2's zero-output message once (0) → 260.
    const builder = body.agentSummary.find((a) => a.agent === 'builder');
    expect(builder).toBeDefined();
    expect(builder?.calls).toBe(3);
    expect(builder?.totalTokensOut).toBe(260);
    expect(builder?.totalSessions).toBe(1);

    const builder2 = body.agentSummary.find((a) => a.agent === 'builder2');
    expect(builder2).toBeDefined();
    expect(builder2?.calls).toBe(1);
    expect(builder2?.totalTokensOut).toBe(0);
    expect(builder2?.totalSessions).toBe(1);
  });

  it('filters by the 30-day createdAt window and by agent', async () => {
    const api = makeClient();
    await seed(api, {
      sessionID: 'tm-window-recent',
      run: {
        name: 'tm-window-run',
        agent: 'windowtest',
        phase: 'Succeeded',
        startedAt: new Date().toISOString(),
        tokensIn: 1,
        tokensOut: 1,
      },
      messages: [{ id: 'tm-w-m0', idx: 0, role: 'user', content: '[]' }],
      toolCalls: [{ id: 'tm-w-tc', messageIdx: 0, tool: 'Git', success: true, durationMs: 5 }],
      fileOps: [],
    });

    // A second, much older session for the same agent — inserted past the API
    // so its createdAt lands in 2020 (the route sets createdAt itself).
    const db = getDb();
    db.insert(runs)
      .values({
        id: 'tm-window-old',
        name: 'tm-window-old-run',
        agent: 'windowtest',
        phase: 'Succeeded',
        startedAt: '2020-01-01T00:00:00Z',
        createdAt: '2020-01-01T00:00:00Z',
        tokensIn: 0,
        tokensOut: 0,
      })
      .run();
    db.insert(toolCalls)
      .values({
        id: 'tm-window-old-tc',
        sessionId: 'tm-window-old',
        messageIdx: 0,
        tool: 'OldTool',
        success: true,
        durationMs: 5,
      })
      .run();

    const defaultWindow = (await (
      await api.req('/api/stats/tool-metrics?agent=windowtest')
    ).json()) as { tools: Array<{ toolName: string }> };
    expect(defaultWindow.tools.map((t) => t.toolName)).toEqual(['Git']);

    const allTime = (await (
      await api.req('/api/stats/tool-metrics?days=0&agent=windowtest')
    ).json()) as { tools: Array<{ toolName: string }> };
    expect(allTime.tools.map((t) => t.toolName).sort()).toEqual(['Git', 'OldTool']);

    // A different agent sees nothing from this agent's sessions.
    const otherAgent = (await (
      await api.req('/api/stats/tool-metrics?days=0&agent=someone-else')
    ).json()) as { tools: unknown[]; totalCalls: number; totalSessions: number };
    expect(otherAgent.tools).toEqual([]);
    expect(otherAgent.totalCalls).toBe(0);
    expect(otherAgent.totalSessions).toBe(0);
  });
});

// ===========================================================================
// C8 — GET /api/stats/trends
// ===========================================================================

describe('GET /api/stats/trends', () => {
  const seeds: Parameters<SeedSession>[0][] = [
    {
      sessionID: 'trend-a',
      run: {
        name: 'trend-run-a',
        agent: 'builder',
        model: 'openai/gpt-4o',
        phase: 'Succeeded',
        startedAt: '2024-01-01T10:00:00Z',
        completedAt: '2024-01-01T10:05:00Z',
        tokensIn: 1000,
        tokensOut: 500,
        cost: 0.05,
      },
      messages: [],
      toolCalls: [],
      fileOps: [],
    },
    {
      sessionID: 'trend-b',
      run: {
        name: 'trend-run-b',
        agent: 'planner',
        model: 'openai/gpt-4o',
        phase: 'Failed',
        startedAt: '2024-01-01T11:00:00Z',
        completedAt: null,
        tokensIn: 2000,
        tokensOut: 1000,
        cost: 0.1,
      },
      messages: [],
      toolCalls: [],
      fileOps: [],
    },
    {
      // No runs.model → excluded from the per-model pivot.
      sessionID: 'trend-c',
      run: {
        name: 'trend-run-c',
        agent: 'reviewer',
        model: null,
        phase: 'Succeeded',
        startedAt: '2024-01-02T09:00:00Z',
        completedAt: '2024-01-02T09:10:00Z',
        tokensIn: 500,
        tokensOut: 250,
        cost: 0.025,
      },
      messages: [],
      toolCalls: [],
      fileOps: [],
    },
  ];

  it('aggregates daily run/token/cost math and pivots model tokens', async () => {
    const api = makeClient();
    for (const s of seeds) {
      await seed(api, s);
    }

    const res = await api.req('/api/stats/trends?days=0');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      trendPoints: Array<{
        date: string;
        runs: number;
        succeeded: number;
        failed: number;
        successRate: number;
        avgDurationMs: number | null;
        tokensIn: number;
        tokensOut: number;
        cost: number;
      }>;
      modelTrendPoints: Array<Record<string, string | number>>;
    };

    expect(body.trendPoints).toHaveLength(2);

    const day1 = body.trendPoints.find((p) => p.date === '2024-01-01');
    expect(day1).toBeDefined();
    expect(day1?.runs).toBe(2);
    expect(day1?.succeeded).toBe(1);
    expect(day1?.failed).toBe(1);
    expect(day1?.successRate).toBe(50);
    // Only trend-run-a has a completedAt.
    expect(day1?.avgDurationMs).toBe(300000);
    expect(day1?.tokensIn).toBe(3000);
    expect(day1?.tokensOut).toBe(1500);
    expect(day1?.cost).toBeCloseTo(0.15, 5);

    const day2 = body.trendPoints.find((p) => p.date === '2024-01-02');
    expect(day2).toBeDefined();
    expect(day2?.runs).toBe(1);
    expect(day2?.succeeded).toBe(1);
    expect(day2?.failed).toBe(0);
    expect(day2?.successRate).toBe(100);
    expect(day2?.avgDurationMs).toBe(600000);
    expect(day2?.tokensIn).toBe(500);
    expect(day2?.tokensOut).toBe(250);
    expect(day2?.cost).toBeCloseTo(0.025, 5);

    // Model pivot: tokensIn + tokensOut per model per day. trend-c has no
    // model so 2024-01-02 does not appear at all.
    expect(body.modelTrendPoints).toEqual([{ date: '2024-01-01', 'openai/gpt-4o': 4500 }]);
  });

  it('honours the days window (old runs dropped)', async () => {
    const api = makeClient();
    for (const s of seeds) {
      await seed(api, s);
    }

    // 2024 seeds are outside the default 30-day window (now is well past).
    const res = await api.req('/api/stats/trends');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      trendPoints: unknown[];
      modelTrendPoints: unknown[];
    };
    expect(body.trendPoints).toEqual([]);
    expect(body.modelTrendPoints).toEqual([]);
  });
});

// ===========================================================================
// C8 — GET /api/stats/metrics-timeseries
// ===========================================================================

describe('GET /api/stats/metrics-timeseries', () => {
  // Minute-aligned timestamps so seeded samples land in deterministic minute
  // buckets regardless of the wall-clock seconds when the test runs (raw
  // Date.now() minus offsets can straddle a minute boundary at :40+ seconds).
  function atMinuteOffset(minutesAgoCount: number, secondsIntoMinute: number): string {
    const now = new Date();
    const base = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      now.getHours(),
      now.getMinutes(),
      0,
      0,
    );
    base.setMinutes(base.getMinutes() - minutesAgoCount);
    base.setSeconds(secondsIntoMinute);
    return base.toISOString();
  }

  function minuteKeyAt(minutesAgoCount: number): string {
    return `${atMinuteOffset(minutesAgoCount, 0).slice(0, 16)}:00`;
  }

  // Seeds metric_snapshots directly (no API for them): node-a with two samples
  // in one minute (75%/50%) and one in a second minute (50%/25%), node-b with
  // one sample in the first minute (50%/25%), plus one completed run within
  // the window for runWindows.
  async function seedSnapshotsAndRuns(api: TestClient): Promise<void> {
    const db = getDb();
    db.insert(metricSnapshots)
      .values([
        {
          node: 'node-a',
          cpuUsageMillicores: 1500,
          memoryUsageBytes: 1073741824, // 1 GiB
          cpuCapacityMillicores: 2000,
          memoryCapacityBytes: 2147483648, // 2 GiB
          recordedAt: atMinuteOffset(30, 10),
        },
        {
          node: 'node-a',
          cpuUsageMillicores: 1600,
          memoryUsageBytes: 1073741824,
          cpuCapacityMillicores: 2000,
          memoryCapacityBytes: 2147483648,
          recordedAt: atMinuteOffset(30, 40),
        },
        {
          node: 'node-b',
          cpuUsageMillicores: 1000,
          memoryUsageBytes: 536870912, // 0.5 GiB
          cpuCapacityMillicores: 2000,
          memoryCapacityBytes: 2147483648,
          recordedAt: atMinuteOffset(30, 20),
        },
        {
          node: 'node-a',
          cpuUsageMillicores: 1000,
          memoryUsageBytes: 536870912,
          cpuCapacityMillicores: 2000,
          memoryCapacityBytes: 2147483648,
          recordedAt: atMinuteOffset(90, 20),
        },
      ])
      .run();

    await seed(api, {
      sessionID: 'ts-run-s1',
      run: {
        name: 'ts-run-1',
        agent: 'builder',
        task: 'ts-task',
        phase: 'Succeeded',
        startedAt: atMinuteOffset(25, 5),
        completedAt: atMinuteOffset(20, 50),
        tokensIn: 10,
        tokensOut: 10,
      },
      messages: [],
      toolCalls: [],
      fileOps: [],
    });
  }

  it('buckets per minute per node and averages across nodes', async () => {
    const api = makeClient();
    await seedSnapshotsAndRuns(api);

    const res = await api.req('/api/stats/metrics-timeseries?hours=2');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dataPoints: Array<{ recordedAt: string; cpuPct: number; memPct: number }>;
      nodeBuckets: Record<string, Array<{ recordedAt: string; cpuPct: number; memPct: number }>>;
      runWindows: Array<{ name: string; agent: string; startedAt: string; completedAt: string }>;
    };

    const recentMinute = minuteKeyAt(30, 0);
    const olderMinute = minuteKeyAt(90, 0);

    // All-nodes view averages per-node minute averages: recent minute has
    // node-a (77.5, 50) [two samples: 75 + 80] and node-b (50, 25) →
    // (63.75 → 63.8, 37.5); older minute has only node-a (50, 25).
    expect(body.dataPoints).toEqual([
      { recordedAt: olderMinute, cpuPct: 50, memPct: 25 },
      { recordedAt: recentMinute, cpuPct: 63.8, memPct: 37.5 },
    ]);

    // Per-node buckets: node-a's recent minute averages its two samples
    // ((1500+1600)/2 / 2000 → 77.5% cpu, 50% mem).
    expect(body.nodeBuckets['node-a']).toEqual([
      { recordedAt: olderMinute, cpuPct: 50, memPct: 25 },
      { recordedAt: recentMinute, cpuPct: 77.5, memPct: 50 },
    ]);
    expect(body.nodeBuckets['node-b']).toEqual([
      { recordedAt: recentMinute, cpuPct: 50, memPct: 25 },
    ]);

    // The seeded completed run is inside the window and carries its fields.
    expect(body.runWindows).toHaveLength(1);
    expect(body.runWindows[0]?.name).toBe('ts-run-1');
    expect(body.runWindows[0]?.agent).toBe('builder');
    expect(body.runWindows[0]?.task).toBe('ts-task');
  });

  it('filters to a single node via ?node=', async () => {
    const api = makeClient();
    await seedSnapshotsAndRuns(api);

    const res = await api.req('/api/stats/metrics-timeseries?hours=2&node=node-a');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dataPoints: Array<{ cpuPct: number; memPct: number }>;
      nodeBuckets: Record<string, unknown[]>;
    };

    // Only node-a data → each minute averages over node-a samples alone,
    // and node-b disappears from every part of the response.
    expect(body.dataPoints).toHaveLength(2);
    expect(body.dataPoints[0]).toMatchObject({ cpuPct: 50, memPct: 25 });
    expect(body.dataPoints[1]).toMatchObject({ cpuPct: 77.5, memPct: 50 });
    expect(Object.keys(body.nodeBuckets)).toEqual(['node-a']);
  });
});

// ===========================================================================
// C12 — runRetentionCleanup (FK cascade)
// ===========================================================================

describe('runRetentionCleanup', () => {
  it('deletes expired runs and cascades to children, keeping recent rows', async () => {
    const api = makeClient();

    // Old run — startedAt far before the 1-day cutoff, with all three child
    // table types attached.
    await seed(api, {
      sessionID: 'retention-old-session',
      run: {
        name: 'retention-old-run',
        agent: 'builder',
        phase: 'Succeeded',
        startedAt: '2020-01-01T00:00:00Z',
        completedAt: '2020-01-01T00:05:00Z',
        tokensIn: 10,
        tokensOut: 10,
      },
      messages: [{ id: 'retention-old-m0', idx: 0, role: 'user', content: '[]' }],
      toolCalls: [
        { id: 'retention-old-tc0', messageIdx: 0, tool: 'Bash', success: true, durationMs: 5 },
      ],
      fileOps: [{ messageIdx: 0, filePath: '/workspace/old.ts', operation: 'read' }],
    });

    // Recent run — startedAt now, same child tables.
    const recentId = 'retention-recent-session';
    await seed(api, {
      sessionID: recentId,
      run: {
        name: 'retention-recent-run',
        agent: 'builder',
        phase: 'Succeeded',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        tokensIn: 10,
        tokensOut: 10,
      },
      messages: [{ id: 'retention-recent-m0', idx: 0, role: 'user', content: '[]' }],
      toolCalls: [
        { id: 'retention-recent-tc0', messageIdx: 0, tool: 'Bash', success: true, durationMs: 5 },
      ],
      fileOps: [{ messageIdx: 0, filePath: '/workspace/recent.ts', operation: 'read' }],
    });

    runRetentionCleanup();

    const db = getDb();

    // Old run gone entirely.
    const oldRun = db.select({ id: runs.id }).from(runs).where({ name: 'retention-old-run' }).get();
    expect(oldRun).toBeUndefined();

    // The old run's children are swept by the FK ON DELETE CASCADE: the
    // tool_calls table still holds exactly the recent session's rows.
    const leftoverToolSessions = db
      .select({ sessionId: toolCalls.sessionId })
      .from(toolCalls)
      .all()
      .map((r) => r.sessionId);
    expect(leftoverToolSessions).toEqual([recentId]);

    // The export route is the natural consumer-facing check: the old session's
    // nested children are gone and only the recent run remains, intact.
    const exportRes = await api.req('/api/stats/export?days=0');
    expect(exportRes.status).toBe(200);
    const exported = (await exportRes.json()) as Array<{
      name: string;
      messages: unknown[];
      toolCalls: unknown[];
      fileOps: unknown[];
    }>;
    expect(exported.map((r) => r.name)).toEqual(['retention-recent-run']);
    const recent = exported.find((r) => r.name === 'retention-recent-run');
    expect(recent?.messages).toHaveLength(1);
    expect(recent?.toolCalls).toHaveLength(1);
    expect(recent?.fileOps).toHaveLength(1);
  });

  it('leaves a fully recent DB untouched', async () => {
    const api = makeClient();
    await seed(api, {
      sessionID: 'retention-only-recent',
      run: {
        name: 'retention-only-recent-run',
        agent: 'builder',
        phase: 'Succeeded',
        startedAt: new Date().toISOString(),
        tokensIn: 1,
        tokensOut: 1,
      },
      messages: [{ id: 'retention-only-recent-m0', idx: 0, role: 'user', content: '[]' }],
      toolCalls: [],
      fileOps: [],
    });

    runRetentionCleanup();

    const exportRes = await api.req('/api/stats/export?days=0');
    const exported = (await exportRes.json()) as Array<{ name: string }>;
    expect(exported.map((r) => r.name)).toEqual(['retention-only-recent-run']);
  });
});
