// Stats API routes.
//
// POST /api/stats/session
//   Called by the dispatcher sidecar after a session completes. Persists the
//   full session — run metadata, every message (with full content), tool
//   invocations, and file accesses — to percussionist.db.
//
// PATCH /api/stats/session
//   Called by the dispatcher incrementally after each assistant turn completes.
//   Upserts the run row and inserts new messages/toolCalls/fileOps using
//   insert-or-ignore so partial writes never overwrite a later full flush.
//   The run row is created early so in-progress sessions appear in the UI.
//
// GET /api/stats/export
//   Returns all sessions (within a configurable look-back window) as a single
//   JSON document suitable for piping into an LLM for pattern analysis.
//   Query params:
//     days=N   — look-back window in days (default: 30; 0 = all time)

import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { adminAuth, auth } from '../auth.js';
import { fileOps, getDb, messages, metricSnapshots, runs, toolCalls } from '../db.js';

// ---------------------------------------------------------------------------
// Payload types (sent by the dispatcher)

interface RunPayload {
  name: string;
  namespace?: string;
  task?: string;
  model?: string;
  agent?: string;
  phase?: string;
  startedAt?: string;
  completedAt?: string;
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  error?: string;
}

interface MessagePayload {
  id?: string;
  idx: number;
  role?: string;
  // Full content as JSON string (array of parts) or plain text.
  content?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  tokensReasoning?: number;
  tokensCacheRead?: number;
  tokensCacheWrite?: number;
  cost?: number;
  createdAt?: string;
  completedAt?: string;
}

interface ToolCallPayload {
  id?: string;
  messageIdx: number;
  tool: string;
  args?: string; // JSON string
  success?: boolean;
  error?: string;
  durationMs?: number;
}

interface FileOpPayload {
  messageIdx: number;
  filePath: string;
  operation: string; // "read" | "write"
}

interface SessionPayload {
  sessionID: string;
  run: RunPayload;
  messages?: MessagePayload[];
  toolCalls?: ToolCallPayload[];
  fileOps?: FileOpPayload[];
}

// ---------------------------------------------------------------------------
// Routes

const stats = new Hono();

// POST /api/stats/session — ingest a completed session from the dispatcher.
stats.post('/session', adminAuth(), async (c) => {
  let body: SessionPayload;
  try {
    body = (await c.req.json()) as SessionPayload;
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  const { sessionID, run: runPayload } = body;
  if (!sessionID || !runPayload?.name) {
    return c.json({ error: 'sessionID and run.name are required' }, 400);
  }

  const db = getDb();

  try {
    db.transaction((tx) => {
      // Upsert the run row (idempotent — dispatcher may retry on network hiccup).
      tx.insert(runs)
        .values({
          id: sessionID,
          name: runPayload.name,
          namespace: runPayload.namespace,
          task: runPayload.task,
          model: runPayload.model,
          agent: runPayload.agent,
          phase: runPayload.phase,
          startedAt: runPayload.startedAt,
          completedAt: runPayload.completedAt,
          tokensIn: runPayload.tokensIn ?? 0,
          tokensOut: runPayload.tokensOut ?? 0,
          cost: runPayload.cost,
          error: runPayload.error,
          createdAt: new Date().toISOString(),
        })
        .onConflictDoUpdate({
          target: runs.id,
          set: {
            phase: runPayload.phase,
            completedAt: runPayload.completedAt,
            tokensIn: runPayload.tokensIn ?? 0,
            tokensOut: runPayload.tokensOut ?? 0,
            cost: runPayload.cost,
            error: runPayload.error,
          },
        })
        .run();

      // Messages — delete+re-insert so retries don't duplicate rows.
      if (body.messages?.length) {
        tx.delete(messages).where(eq(messages.sessionId, sessionID)).run();
        for (const m of body.messages) {
          tx.insert(messages)
            .values({
              id: m.id ?? randomUUID(),
              sessionId: sessionID,
              idx: m.idx,
              role: m.role,
              content: m.content,
              model: m.model,
              tokensIn: m.tokensIn,
              tokensOut: m.tokensOut,
              tokensReasoning: m.tokensReasoning,
              tokensCacheRead: m.tokensCacheRead,
              tokensCacheWrite: m.tokensCacheWrite,
              cost: m.cost,
              createdAt: m.createdAt,
              completedAt: m.completedAt,
            })
            .run();
        }
      }

      // Tool calls
      if (body.toolCalls?.length) {
        tx.delete(toolCalls).where(eq(toolCalls.sessionId, sessionID)).run();
        for (const t of body.toolCalls) {
          tx.insert(toolCalls)
            .values({
              id: t.id ?? randomUUID(),
              sessionId: sessionID,
              messageIdx: t.messageIdx,
              tool: t.tool,
              args: t.args,
              success: t.success,
              error: t.error,
              durationMs: t.durationMs,
            })
            .run();
        }
      }

      // File ops
      if (body.fileOps?.length) {
        tx.delete(fileOps).where(eq(fileOps.sessionId, sessionID)).run();
        for (const f of body.fileOps) {
          tx.insert(fileOps)
            .values({
              sessionId: sessionID,
              messageIdx: f.messageIdx,
              filePath: f.filePath,
              operation: f.operation,
            })
            .run();
        }
      }
    });
  } catch (e) {
    console.error('[stats] failed to persist session:', (e as Error).message);
    return c.json({ error: 'failed to persist session' }, 500);
  }

  return c.json({ ok: true });
});

// PATCH /api/stats/session — incremental flush after each assistant turn.
// Uses insert-or-ignore so concurrent/repeated calls are idempotent and never
// overwrite a later full POST flush. The run row is created on first call so
// in-progress sessions show up in the UI immediately.
stats.patch('/session', adminAuth(), async (c) => {
  let body: SessionPayload;
  try {
    body = (await c.req.json()) as SessionPayload;
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  const { sessionID, run: runPayload } = body;
  if (!sessionID || !runPayload?.name) {
    return c.json({ error: 'sessionID and run.name are required' }, 400);
  }

  const db = getDb();

  try {
    db.transaction((tx) => {
      // Upsert run row — create if not exists, update token counts and phase if set.
      tx.insert(runs)
        .values({
          id: sessionID,
          name: runPayload.name,
          namespace: runPayload.namespace,
          task: runPayload.task,
          model: runPayload.model,
          agent: runPayload.agent,
          phase: runPayload.phase ?? 'Running',
          startedAt: runPayload.startedAt,
          completedAt: runPayload.completedAt,
          tokensIn: runPayload.tokensIn ?? 0,
          tokensOut: runPayload.tokensOut ?? 0,
          cost: runPayload.cost,
          error: runPayload.error,
          createdAt: new Date().toISOString(),
        })
        .onConflictDoUpdate({
          target: runs.id,
          set: {
            // Only update token counts, cost, and phase — never overwrite name/task/model.
            tokensIn: runPayload.tokensIn ?? 0,
            tokensOut: runPayload.tokensOut ?? 0,
            cost: runPayload.cost,
            ...(runPayload.phase ? { phase: runPayload.phase } : {}),
            ...(runPayload.completedAt ? { completedAt: runPayload.completedAt } : {}),
            ...(runPayload.error ? { error: runPayload.error } : {}),
          },
        })
        .run();

      // Messages — insert-or-ignore: never overwrite rows that may have richer
      // data from a later full POST flush.
      if (body.messages?.length) {
        for (const m of body.messages) {
          tx.insert(messages)
            .values({
              id: m.id ?? randomUUID(),
              sessionId: sessionID,
              idx: m.idx,
              role: m.role,
              content: m.content,
              model: m.model,
              tokensIn: m.tokensIn,
              tokensOut: m.tokensOut,
              tokensReasoning: m.tokensReasoning,
              tokensCacheRead: m.tokensCacheRead,
              tokensCacheWrite: m.tokensCacheWrite,
              cost: m.cost,
              createdAt: m.createdAt,
              completedAt: m.completedAt,
            })
            .onConflictDoNothing()
            .run();
        }
      }

      // Tool calls — insert-or-ignore.
      if (body.toolCalls?.length) {
        for (const t of body.toolCalls) {
          tx.insert(toolCalls)
            .values({
              id: t.id ?? randomUUID(),
              sessionId: sessionID,
              messageIdx: t.messageIdx,
              tool: t.tool,
              args: t.args,
              success: t.success,
              error: t.error,
              durationMs: t.durationMs,
            })
            .onConflictDoNothing()
            .run();
        }
      }

      // File ops — insert-or-ignore (composite PK).
      if (body.fileOps?.length) {
        for (const f of body.fileOps) {
          tx.insert(fileOps)
            .values({
              sessionId: sessionID,
              messageIdx: f.messageIdx,
              filePath: f.filePath,
              operation: f.operation,
            })
            .onConflictDoNothing()
            .run();
        }
      }
    });
  } catch (e) {
    console.error('[stats] incremental flush failed:', (e as Error).message);
    return c.json({ error: 'failed to persist incremental flush' }, 500);
  }

  return c.json({ ok: true });
});

// GET /api/stats/exists/:sessionID — check if a session row exists (for backfill guard).
stats.get('/exists/:sessionID', auth(), (c) => {
  const { sessionID } = c.req.param();
  const db = getDb();
  const row = db.select({ id: runs.id }).from(runs).where(eq(runs.id, sessionID)).get();
  return c.json({ exists: row !== undefined });
});

// GET /api/stats/export?days=30 — full dump for LLM analysis.
//
// Returns a JSON array where each element is a session with nested messages,
// tool calls, and file operations. Intended to be saved to disk and fed to
// an LLM wholesale: jq . sessions.json | llm "find patterns in agent usage".
stats.get('/export', auth(), (c) => {
  const daysParam = c.req.query('days') ?? '30';
  const days = parseInt(daysParam, 10);

  const db = getDb();

  const cutoff = days > 0 ? new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString() : null;

  const runRows = cutoff
    ? db.select().from(runs).where(gte(runs.startedAt, cutoff)).all()
    : db.select().from(runs).all();

  const sessionIds = runRows.map((r) => r.id);

  // Fetch all related rows per session and assemble the nested result.
  // Session count is bounded to ~10 concurrent runs so N+1 is fine.
  const result = runRows.map((r) => ({
    ...r,
    messages: db.select().from(messages).where(eq(messages.sessionId, r.id)).all(),
    toolCalls: db.select().from(toolCalls).where(eq(toolCalls.sessionId, r.id)).all(),
    fileOps: db.select().from(fileOps).where(eq(fileOps.sessionId, r.id)).all(),
  }));

  void sessionIds; // unused after refactor — keep for future bulk query path

  return c.json(result);
});

// GET /api/stats/sessions?days=30&limit=50&offset=0 — lightweight session listing for UI.
//
// Returns flat run rows (no nested messages/toolCalls/fileOps) plus server-side
// aggregated summary, agent breakdown, and model breakdown. Pagination via
// limit/offset.
stats.get('/sessions', auth(), (c) => {
  const daysParam = c.req.query('days') ?? '30';
  const days = parseInt(daysParam, 10);
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 200);
  const offset = Math.max(parseInt(c.req.query('offset') ?? '0', 10), 0);

  const db = getDb();

  const cutoff = days > 0 ? new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString() : null;

  // Resolve model: runs.model first, fallback to first user message's model.
  const resolvedModel = sql<string>`
    COALESCE(${runs.model}, (
      SELECT ${messages.model} FROM ${messages}
      WHERE ${messages.sessionId} = ${runs.id}
        AND ${messages.role} = 'user'
        AND ${messages.model} IS NOT NULL
      LIMIT 1
    ), 'unknown')
  `;

  const baseQuery = db
    .select({
      id: runs.id,
      name: runs.name,
      namespace: runs.namespace,
      task: runs.task,
      model: runs.model,
      agent: runs.agent,
      phase: runs.phase,
      startedAt: runs.startedAt,
      completedAt: runs.completedAt,
      tokensIn: runs.tokensIn,
      tokensOut: runs.tokensOut,
      cost: runs.cost,
      error: runs.error,
      createdAt: runs.createdAt,
      resolvedModel,
    })
    .from(runs)
    .orderBy(desc(runs.startedAt));

  const allRows = cutoff ? baseQuery.where(gte(runs.startedAt, cutoff)).all() : baseQuery.all();

  const total = allRows.length;

  // Summary
  const succeeded = allRows.filter((r) => r.phase === 'Succeeded').length;
  const failed = allRows.filter((r) => r.phase === 'Failed').length;
  const totalTokensIn = allRows.reduce((a, r) => a + (r.tokensIn ?? 0), 0);
  const totalTokensOut = allRows.reduce((a, r) => a + (r.tokensOut ?? 0), 0);
  const totalCost = allRows.reduce((a, r) => a + (r.cost ?? 0), 0);

  const durations: number[] = [];
  for (const r of allRows) {
    if (r.startedAt && r.completedAt) {
      const ms = new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime();
      if (!Number.isNaN(ms)) durations.push(ms);
    }
  }
  const avgDurationMs =
    durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : null;

  // Per-model breakdown
  const modelMap = new Map<
    string,
    { runs: number; tokensIn: number; tokensOut: number; cost: number }
  >();
  for (const r of allRows) {
    const model = r.resolvedModel ?? r.model ?? 'unknown';
    const existing = modelMap.get(model) ?? { runs: 0, tokensIn: 0, tokensOut: 0, cost: 0 };
    modelMap.set(model, {
      runs: existing.runs + 1,
      tokensIn: existing.tokensIn + (r.tokensIn ?? 0),
      tokensOut: existing.tokensOut + (r.tokensOut ?? 0),
      cost: existing.cost + (r.cost ?? 0),
    });
  }
  const modelRows = [...modelMap.entries()]
    .map(([model, v]) => ({ model, ...v }))
    .sort((a, b) => b.tokensIn - a.tokensIn);

  // Per-agent breakdown
  const agentMap = new Map<
    string,
    {
      runs: number;
      succeeded: number;
      failed: number;
      tokensIn: number;
      tokensOut: number;
      cost: number;
      durationSum: number;
      durationCount: number;
      models: Set<string>;
    }
  >();
  for (const r of allRows) {
    const agent = r.agent ?? 'unknown';
    const existing = agentMap.get(agent) ?? {
      runs: 0,
      succeeded: 0,
      failed: 0,
      tokensIn: 0,
      tokensOut: 0,
      cost: 0,
      durationSum: 0,
      durationCount: 0,
      models: new Set<string>(),
    };
    existing.runs++;
    if (r.phase === 'Succeeded') existing.succeeded++;
    else if (r.phase === 'Failed') existing.failed++;
    existing.tokensIn += r.tokensIn ?? 0;
    existing.tokensOut += r.tokensOut ?? 0;
    existing.cost += r.cost ?? 0;
    if (r.startedAt && r.completedAt) {
      const ms = new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime();
      if (!Number.isNaN(ms)) {
        existing.durationSum += ms;
        existing.durationCount++;
      }
    }
    if (r.model) existing.models.add(r.model);
    agentMap.set(agent, existing);
  }
  const agentSummaries = [...agentMap.entries()]
    .map(([agent, v]) => ({
      agent,
      runs: v.runs,
      succeeded: v.succeeded,
      failed: v.failed,
      successRate: v.runs > 0 ? Math.round((v.succeeded / v.runs) * 100) : null,
      totalTokensIn: v.tokensIn,
      totalTokensOut: v.tokensOut,
      totalCost: v.cost,
      avgTokensPerRun: v.runs > 0 ? Math.round((v.tokensIn + v.tokensOut) / v.runs) : 0,
      avgDurationMs: v.durationCount > 0 ? Math.round(v.durationSum / v.durationCount) : null,
      models: [...v.models],
    }))
    .sort((a, b) => b.runs - a.runs);

  // Paginate sessions for the table
  const sessions = allRows.slice(offset, offset + limit);

  return c.json({
    sessions,
    total,
    limit,
    offset,
    summary: {
      total,
      succeeded,
      failed,
      successRate: total > 0 ? Math.round((succeeded / total) * 100) : null,
      totalTokensIn,
      totalTokensOut,
      totalCost,
      avgDurationMs,
    },
    agentSummaries,
    modelRows,
  });
});

// ---------------------------------------------------------------------------
// Retention cleanup — exported so the server can schedule it.

export const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS ?? '30', 10);

export function runRetentionCleanup(): void {
  if (RETENTION_DAYS <= 0) return; // 0 = keep forever
  const db = getDb();
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Cascade deletes handle messages / tool_calls / file_ops via FK ON DELETE
  // CASCADE. Deleting from runs is sufficient.
  const result = db.delete(runs).where(lt(runs.startedAt, cutoff)).run() as unknown as {
    changes: number;
  };

  if (result.changes > 0) {
    console.log(
      `[stats] retention cleanup: deleted ${result.changes} run(s) older than ${RETENTION_DAYS} days`,
    );
  }
}

// GET /api/stats/tool-metrics?days=30&agent=X — aggregated tool usage stats.
// Sources data from tool_calls (message-part extraction) instead of tool_events (SSE/MCP events).
stats.get('/tool-metrics', auth(), (c) => {
  const daysParam = c.req.query('days') ?? '30';
  const days = parseInt(daysParam, 10);
  const agent = c.req.query('agent');

  const db = getDb();
  const cutoff = days > 0 ? new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString() : null;

  const conditions: ReturnType<typeof gte | typeof eq>[] = [];
  if (cutoff) conditions.push(gte(runs.createdAt, cutoff));
  if (agent) conditions.push(eq(runs.agent, agent));
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // 1. Tool metrics grouped by tool name.
  const rows = db
    .select({
      toolName: toolCalls.tool,
      calls: sql<number>`COUNT(*)`.as('calls'),
      avgDurationMs: sql<number>`AVG(${toolCalls.durationMs})`.as('avg_duration_ms'),
      successRate:
        sql<number>`CAST(SUM(CASE WHEN ${toolCalls.success} = 1 THEN 1 ELSE 0 END) AS REAL) / CAST(COUNT(*) AS REAL)`.as(
          'success_rate',
        ),
      avgResultSize: sql<null>`NULL`.as('avg_result_size'),
      totalErrors: sql<number>`SUM(CASE WHEN ${toolCalls.success} = 0 THEN 1 ELSE 0 END)`.as(
        'total_errors',
      ),
      sessionsUsing: sql<number>`COUNT(DISTINCT ${toolCalls.sessionId})`.as('sessions_using'),
    })
    .from(toolCalls)
    .innerJoin(runs, eq(toolCalls.sessionId, runs.id))
    .where(whereClause)
    .groupBy(toolCalls.tool)
    .orderBy(desc(sql`COUNT(*)`))
    .all() as Array<{
    toolName: string;
    calls: number;
    avgDurationMs: number | null;
    successRate: number | null;
    avgResultSize: null;
    totalErrors: number;
    sessionsUsing: number;
  }>;

  // 2. Token attribution: distribute message-level tokensOut across tool calls.
  // For each tool call, find its assistant message's tokensOut and how many
  // tool calls share that message, then attribute tokensOut / count.
  const tokenData = db
    .select({
      tool: toolCalls.tool,
      tokensOut: messages.tokensOut,
      msgToolCount: sql<number>`(
        SELECT CAST(COUNT(*) AS REAL) FROM tool_calls tc2
        WHERE tc2.session_id = ${toolCalls.sessionId}
          AND tc2.message_idx = ${toolCalls.messageIdx}
      )`.as('msg_tool_count'),
    })
    .from(toolCalls)
    .innerJoin(runs, eq(toolCalls.sessionId, runs.id))
    .leftJoin(
      messages,
      and(
        eq(toolCalls.sessionId, messages.sessionId),
        eq(toolCalls.messageIdx, messages.idx),
        eq(messages.role, 'assistant'),
      ),
    )
    .where(whereClause)
    .all() as Array<{
    tool: string;
    tokensOut: number | null;
    msgToolCount: number;
  }>;

  const tokenMap = new Map<string, { total: number; count: number }>();
  for (const d of tokenData) {
    if (d.tokensOut != null && d.msgToolCount > 0) {
      const cost = d.tokensOut / d.msgToolCount;
      const entry = tokenMap.get(d.tool) ?? { total: 0, count: 0 };
      entry.total += cost;
      entry.count++;
      tokenMap.set(d.tool, entry);
    }
  }

  for (const row of rows) {
    const tok = tokenMap.get(row.toolName);
    (row as Record<string, unknown>).estTokensOut = tok ? Math.round(tok.total) : 0;
    (row as Record<string, unknown>).avgTokensOutPerCall =
      tok && tok.count > 0 ? Math.round(tok.total / tok.count) : 0;
  }

  // 3. Agent summary — one row per agent.
  const agentConditions: ReturnType<typeof gte | typeof eq>[] = [];
  if (cutoff) agentConditions.push(gte(runs.createdAt, cutoff));
  const agentWhereClause = agentConditions.length > 0 ? and(...agentConditions) : undefined;

  const agentSummary = db
    .select({
      agent: runs.agent,
      calls: sql<number>`COUNT(*)`.as('calls'),
      totalTokensOut: sql<number>`COALESCE(SUM(${messages.tokensOut}), 0)`.as('total_tokens_out'),
      totalSessions: sql<number>`COUNT(DISTINCT ${runs.id})`.as('total_sessions'),
    })
    .from(toolCalls)
    .innerJoin(runs, eq(toolCalls.sessionId, runs.id))
    .leftJoin(
      messages,
      and(
        eq(toolCalls.sessionId, messages.sessionId),
        eq(toolCalls.messageIdx, messages.idx),
        eq(messages.role, 'assistant'),
      ),
    )
    .where(and(agentWhereClause, sql`${runs.agent} IS NOT NULL`))
    .groupBy(runs.agent)
    .orderBy(desc(sql`COUNT(*)`))
    .all() as Array<{
    agent: string;
    calls: number;
    totalTokensOut: number;
    totalSessions: number;
  }>;

  const totalCalls = rows.reduce((s, r) => s + r.calls, 0);

  const sessionCountQuery = db
    .select({ count: sql<number>`COUNT(DISTINCT ${toolCalls.sessionId})` })
    .from(toolCalls)
    .innerJoin(runs, eq(toolCalls.sessionId, runs.id));
  const totalSessions = whereClause
    ? sessionCountQuery.where(whereClause).get()
    : sessionCountQuery.get();

  return c.json({
    tools: rows,
    totalCalls,
    totalSessions: totalSessions?.count ?? 0,
    agentSummary,
    period: {
      days,
      from: cutoff,
      to: new Date().toISOString(),
    },
  });
});

// ---------------------------------------------------------------------------
// GET /api/stats/metrics-timeseries — time-series metrics data.
// Query params: hours=N (default 1), node=X (default "all")

stats.get('/metrics-timeseries', auth(), async (c) => {
  const hours = Math.min(Math.max(parseInt(c.req.query('hours') ?? '1', 10) || 1, 1), 168);
  const nodeFilter = c.req.query('node') ?? 'all';

  const db = getDb();
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const where = and(
    gte(metricSnapshots.recordedAt, cutoff),
    nodeFilter !== 'all' ? eq(metricSnapshots.node, nodeFilter) : undefined,
  );

  const rows = db
    .select({
      recordedAt: metricSnapshots.recordedAt,
      node: metricSnapshots.node,
      cpuPct: sql<number>`ROUND(CAST(${metricSnapshots.cpuUsageMillicores} AS REAL) / NULLIF(${metricSnapshots.cpuCapacityMillicores}, 0) * 100, 1)`,
      memPct: sql<number>`ROUND(CAST(${metricSnapshots.memoryUsageBytes} AS REAL) / NULLIF(${metricSnapshots.memoryCapacityBytes}, 0) * 100, 1)`,
    })
    .from(metricSnapshots)
    .where(where)
    .orderBy(asc(metricSnapshots.recordedAt))
    .all();

  // Bucket by minute: average per node per minute.
  const buckets = new Map<string, { cpuSum: number; memSum: number; count: number }>();
  for (const r of rows) {
    const minute = r.recordedAt.slice(0, 16); // "2024-01-01T12:00"
    const key = `${r.node}|${minute}`;
    const b = buckets.get(key) ?? { cpuSum: 0, memSum: 0, count: 0 };
    b.cpuSum += r.cpuPct;
    b.memSum += r.memPct;
    b.count += 1;
    buckets.set(key, b);
  }

  // Build per-node-per-minute averages.
  const nodeBuckets = new Map<
    string,
    Array<{ recordedAt: string; cpuPct: number; memPct: number }>
  >();
  for (const [key, b] of buckets) {
    const [node, minute] = key.split('|') as [string, string];
    const pt = {
      recordedAt: `${minute}:00`,
      cpuPct: Math.round((b.cpuSum / b.count) * 10) / 10,
      memPct: Math.round((b.memSum / b.count) * 10) / 10,
    };
    const nb = nodeBuckets.get(node) ?? [];
    nb.push(pt);
    nodeBuckets.set(node, nb);
  }

  // Average across all nodes per minute for the "all nodes" view.
  const minuteBuckets = new Map<string, { cpuSum: number; memSum: number; count: number }>();
  for (const [key, b] of buckets) {
    const [, minute] = key.split('|') as [string, string];
    const avgCpu = b.cpuSum / b.count;
    const avgMem = b.memSum / b.count;
    const mb = minuteBuckets.get(minute) ?? { cpuSum: 0, memSum: 0, count: 0 };
    mb.cpuSum += avgCpu;
    mb.memSum += avgMem;
    mb.count += 1;
    minuteBuckets.set(minute, mb);
  }

  const dataPoints: Array<{ recordedAt: string; cpuPct: number; memPct: number }> = [];
  for (const [minute, mb] of minuteBuckets) {
    dataPoints.push({
      recordedAt: `${minute}:00`,
      cpuPct: Math.round((mb.cpuSum / mb.count) * 10) / 10,
      memPct: Math.round((mb.memSum / mb.count) * 10) / 10,
    });
  }
  dataPoints.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));

  // Fetch run windows within the same time window.
  const runWindows = db
    .select({
      name: runs.name,
      agent: runs.agent,
      task: runs.task,
      startedAt: runs.startedAt,
      completedAt: runs.completedAt,
    })
    .from(runs)
    .where(and(gte(runs.startedAt, cutoff)))
    .orderBy(asc(runs.startedAt))
    .all()
    .filter((r) => r.startedAt && r.completedAt)
    .map((r) => ({
      name: r.name,
      agent: r.agent ?? '',
      task: r.task ?? '',
      startedAt: r.startedAt!,
      completedAt: r.completedAt!,
    }));

  return c.json({ dataPoints, runWindows, nodeBuckets: Object.fromEntries(nodeBuckets) });
});

// ---------------------------------------------------------------------------
// GET /api/stats/trends?days=30 — daily aggregated trend data for charts.
// Returns: { trendPoints: TrendPoint[], modelTrendPoints: ModelTrendPoint[] }

interface TrendPoint {
  date: string;
  runs: number;
  succeeded: number;
  failed: number;
  successRate: number;
  avgDurationMs: number | null;
  tokensIn: number;
  tokensOut: number;
  cost: number;
}

interface ModelTrendPoint {
  date: string;
  [key: string]: string | number;
}

stats.get('/trends', auth(), (c) => {
  const daysParam = c.req.query('days') ?? '30';
  const days = parseInt(daysParam, 10);

  const db = getDb();
  const cutoff = days > 0 ? new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString() : null;

  const whereClause = cutoff ? gte(runs.startedAt, cutoff) : undefined;

  // Daily run aggregates
  const dailyRows = db
    .select({
      date: sql<string>`DATE(${runs.startedAt})`.as('date'),
      runs: sql<number>`COUNT(*)`.as('runs'),
      succeeded: sql<number>`SUM(CASE WHEN ${runs.phase} = 'Succeeded' THEN 1 ELSE 0 END)`.as(
        'succeeded',
      ),
      failed: sql<number>`SUM(CASE WHEN ${runs.phase} = 'Failed' THEN 1 ELSE 0 END)`.as('failed'),
      avgDurationMs:
        sql<number>`AVG(CASE WHEN ${runs.startedAt} IS NOT NULL AND ${runs.completedAt} IS NOT NULL
        THEN (julianday(${runs.completedAt}) - julianday(${runs.startedAt})) * 86400000 ELSE NULL END)`.as(
          'avg_duration_ms',
        ),
      tokensIn: sql<number>`COALESCE(SUM(${runs.tokensIn}), 0)`.as('tokens_in'),
      tokensOut: sql<number>`COALESCE(SUM(${runs.tokensOut}), 0)`.as('tokens_out'),
      cost: sql<number>`COALESCE(SUM(${runs.cost}), 0)`.as('cost'),
    })
    .from(runs)
    .where(whereClause)
    .groupBy(sql`DATE(${runs.startedAt})`)
    .orderBy(asc(sql`DATE(${runs.startedAt})`))
    .all() as Array<{
    date: string;
    runs: number;
    succeeded: number;
    failed: number;
    avgDurationMs: number | null;
    tokensIn: number;
    tokensOut: number;
    cost: number;
  }>;

  const trendPoints: TrendPoint[] = dailyRows.map((r) => ({
    date: r.date,
    runs: r.runs,
    succeeded: r.succeeded,
    failed: r.failed,
    successRate: r.runs > 0 ? Math.round((r.succeeded / r.runs) * 100) : 0,
    avgDurationMs: r.avgDurationMs != null ? Math.round(r.avgDurationMs) : null,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    cost: r.cost,
  }));

  // Tokens per model per day
  const modelRows = db
    .select({
      date: sql<string>`DATE(${runs.startedAt})`.as('date'),
      model: runs.model,
      tokensIn: sql<number>`COALESCE(SUM(${runs.tokensIn}), 0)`.as('tokens_in'),
      tokensOut: sql<number>`COALESCE(SUM(${runs.tokensOut}), 0)`.as('tokens_out'),
    })
    .from(runs)
    .where(and(whereClause, sql`${runs.model} IS NOT NULL`))
    .groupBy(sql`DATE(${runs.startedAt})`, runs.model)
    .orderBy(asc(sql`DATE(${runs.startedAt})`))
    .all() as Array<{
    date: string;
    model: string | null;
    tokensIn: number;
    tokensOut: number;
  }>;

  // Pivot into per-date, per-model total tokens (in + out)
  const pivotMap = new Map<string, Map<string, number>>();
  for (const r of modelRows) {
    if (!r.model) continue;
    const total = r.tokensIn + r.tokensOut;
    const dateMap = pivotMap.get(r.date) ?? new Map();
    dateMap.set(r.model, (dateMap.get(r.model) ?? 0) + total);
    pivotMap.set(r.date, dateMap);
  }

  const allModels = new Set<string>();
  for (const dateMap of pivotMap.values()) {
    for (const model of dateMap.keys()) allModels.add(model);
  }

  const sortedDates = [...pivotMap.keys()].sort();
  const modelTrendPoints: ModelTrendPoint[] = sortedDates.map((date) => {
    const entry: ModelTrendPoint = { date };
    const dateMap = pivotMap.get(date)!;
    for (const model of allModels) {
      entry[model] = dateMap.get(model) ?? 0;
    }
    return entry;
  });

  return c.json({ trendPoints, modelTrendPoints });
});

export default stats;
