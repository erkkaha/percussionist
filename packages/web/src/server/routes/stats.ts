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

import { Hono } from "hono";
import { getDb, runs, messages, toolCalls, fileOps, toolEvents } from "../db.js";
import { lt, gte, eq, and, like, desc, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { auth, adminAuth } from "../auth.js";

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

interface ToolEventPayload {
  id: string;
  sessionId: string;
  runName: string;
  toolName: string;
  isMcp?: boolean;
  calledAt: string;
  durationMs?: number;
  success?: boolean;
  resultSize?: number;
  resultTruncated?: boolean;
  error?: string;
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
stats.post("/session", adminAuth(), async (c) => {
  let body: SessionPayload;
  try {
    body = (await c.req.json()) as SessionPayload;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const { sessionID, run: runPayload } = body;
  if (!sessionID || !runPayload?.name) {
    return c.json({ error: "sessionID and run.name are required" }, 400);
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
    console.error("[stats] failed to persist session:", (e as Error).message);
    return c.json({ error: "failed to persist session" }, 500);
  }

  return c.json({ ok: true });
});

// PATCH /api/stats/session — incremental flush after each assistant turn.
stats.patch("/session", adminAuth(), async (c) => {
  let body: SessionPayload;
  try {
    body = (await c.req.json()) as SessionPayload;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const { sessionID, run: runPayload } = body;
  if (!sessionID || !runPayload?.name) {
    return c.json({ error: "sessionID and run.name are required" }, 400);
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
          phase: runPayload.phase ?? "Running",
          startedAt: runPayload.startedAt,
          completedAt: runPayload.completedAt,
          tokensIn: runPayload.tokensIn ?? 0,
          tokensOut: runPayload.tokensOut ?? 0,
          error: runPayload.error,
          createdAt: new Date().toISOString(),
        })
        .onConflictDoUpdate({
          target: runs.id,
          set: {
            // Only update token counts and phase — never overwrite name/task/model.
            tokensIn: runPayload.tokensIn ?? 0,
            tokensOut: runPayload.tokensOut ?? 0,
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
    console.error("[stats] incremental flush failed:", (e as Error).message);
    return c.json({ error: "failed to persist incremental flush" }, 500);
  }

  return c.json({ ok: true });
});

// GET /api/stats/exists/:sessionID — check if a session row exists (for backfill guard).
stats.get("/exists/:sessionID", auth(), (c) => {
  const { sessionID } = c.req.param();
  const db = getDb();
  const row = db.select({ id: runs.id }).from(runs).where(eq(runs.id, sessionID)).get();
  return c.json({ exists: row !== undefined });
});

// POST /api/stats/tool-events — batch ingest of tool invocation events.
stats.post("/tool-events", adminAuth(), async (c) => {
  let body: { events: ToolEventPayload[] };
  try {
    body = (await c.req.json()) as { events: ToolEventPayload[] };
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  if (!body.events?.length) {
    return c.json({ error: "events array is required" }, 400);
  }

  const db = getDb();
  let inserted = 0;

  try {
    for (const e of body.events) {
      if (!e.id || !e.sessionId || !e.runName) continue;
      db.insert(toolEvents)
        .values({
          id: e.id,
          sessionId: e.sessionId,
          runName: e.runName,
          toolName: e.toolName,
          isMcp: e.isMcp ?? false,
          calledAt: e.calledAt,
          durationMs: e.durationMs,
          success: e.success,
          resultSize: e.resultSize,
          resultTruncated: e.resultTruncated,
          error: e.error,
        })
        .onConflictDoNothing()
        .run();
      inserted++;
    }
  } catch (err) {
    console.error("[stats] tool-events persist error:", (err as Error).message);
    return c.json({ error: "failed to persist tool events" }, 500);
  }

  return c.json({ ok: true, inserted });
});

// GET /api/stats/export?days=30 — full dump for LLM analysis.
stats.get("/export", auth(), (c) => {
  const daysParam = c.req.query("days") ?? "30";
  const days = parseInt(daysParam, 10);

  const db = getDb();

  const cutoff =
    days > 0
      ? new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
      : null;

  const runRows = cutoff
    ? db
        .select()
        .from(runs)
        .where(gte(runs.startedAt, cutoff))
        .all()
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

// ---------------------------------------------------------------------------
// Retention cleanup — exported so the server can schedule it.

export const RETENTION_DAYS = parseInt(
  process.env.RETENTION_DAYS ?? "30",
  10,
);

export function runRetentionCleanup(): void {
  if (RETENTION_DAYS <= 0) return; // 0 = keep forever
  const db = getDb();
  const cutoff = new Date(
    Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  // Cascade deletes handle messages / tool_calls / file_ops via FK ON DELETE
  // CASCADE. Deleting from runs is sufficient.
  const result = db
    .delete(runs)
    .where(lt(runs.startedAt, cutoff))
    .run() as unknown as { changes: number };

  if (result.changes > 0) {
    console.log(
      `[stats] retention cleanup: deleted ${result.changes} run(s) older than ${RETENTION_DAYS} days`,
    );
  }
}

// GET /api/stats/tool-metrics?days=30&agent=X — aggregated tool usage stats.
stats.get("/tool-metrics", auth(), (c) => {
  const daysParam = c.req.query("days") ?? "30";
  const days = parseInt(daysParam, 10);
  const agent = c.req.query("agent");

  const db = getDb();
  const cutoff =
    days > 0
      ? new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
      : null;

  const conditions: ReturnType<typeof gte | typeof eq>[] = [];
  if (cutoff) conditions.push(gte(runs.createdAt, cutoff));
  if (agent) conditions.push(eq(runs.agent, agent));
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // 1. Tool metrics grouped by tool name.
  const rows = db
    .select({
      toolName: toolCalls.tool,
      calls: sql<number>`COUNT(*)`.as("calls"),
      avgDurationMs: sql<number>`AVG(${toolCalls.durationMs})`.as("avg_duration_ms"),
      successRate: sql<number>`CAST(SUM(CASE WHEN ${toolCalls.success} = 1 THEN 1 ELSE 0 END) AS REAL) / CAST(COUNT(*) AS REAL)`.as("success_rate"),
      avgResultSize: sql<null>`NULL`.as("avg_result_size"),
      totalErrors: sql<number>`SUM(CASE WHEN ${toolCalls.success} = 0 THEN 1 ELSE 0 END)`.as("total_errors"),
      sessionsUsing: sql<number>`COUNT(DISTINCT ${toolCalls.sessionId})`.as("sessions_using"),
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
        SELECT CAST(COUNT(*) AS REAL) FROM ${toolCalls} tc2
        WHERE tc2.${toolCalls.sessionId} = ${toolCalls.sessionId}
          AND tc2.${toolCalls.messageIdx} = ${toolCalls.messageIdx}
      )`.as("msg_tool_count"),
    })
    .from(toolCalls)
    .innerJoin(runs, eq(toolCalls.sessionId, runs.id))
    .leftJoin(messages, and(
      eq(toolCalls.sessionId, messages.sessionId),
      eq(toolCalls.messageIdx, messages.idx),
      eq(messages.role, "assistant"),
    ))
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
    (row as Record<string, unknown>).avgTokensOutPerCall = tok && tok.count > 0 ? Math.round(tok.total / tok.count) : 0;
  }

  // 3. Agent summary — one row per agent.
  const agentConditions: ReturnType<typeof gte | typeof eq>[] = [];
  if (cutoff) agentConditions.push(gte(runs.createdAt, cutoff));
  const agentWhereClause = agentConditions.length > 0 ? and(...agentConditions) : undefined;

  const agentSummary = db
    .select({
      agent: runs.agent,
      calls: sql<number>`COUNT(*)`.as("calls"),
      totalTokensOut: sql<number>`COALESCE(SUM(${messages.tokensOut}), 0)`.as("total_tokens_out"),
      totalSessions: sql<number>`COUNT(DISTINCT ${runs.id})`.as("total_sessions"),
    })
    .from(toolCalls)
    .innerJoin(runs, eq(toolCalls.sessionId, runs.id))
    .leftJoin(messages, and(
      eq(toolCalls.sessionId, messages.sessionId),
      eq(toolCalls.messageIdx, messages.idx),
      eq(messages.role, "assistant"),
    ))
    .where(and(
      agentWhereClause,
      sql`${runs.agent} IS NOT NULL`,
    ))
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

// GET /api/stats/tool-events?sessionId=X&runName=Y&limit=100 — raw tool events.
stats.get("/tool-events", auth(), (c) => {
  const sessionId = c.req.query("sessionId");
  const runName = c.req.query("runName");
  const tool = c.req.query("tool");
  const limitParam = c.req.query("limit") ?? "100";
  const limit = Math.min(Math.max(parseInt(limitParam, 10) || 100, 1), 1000);

  const db = getDb();
  const conditions: ReturnType<typeof eq>[] = [];
  if (sessionId) conditions.push(eq(toolEvents.sessionId, sessionId));
  if (runName) conditions.push(eq(toolEvents.runName, runName));
  if (tool) conditions.push(eq(toolEvents.toolName, tool));

  const baseQuery = db.select().from(toolEvents);
  const rows = (conditions.length > 0
    ? baseQuery.where(and(...conditions))
    : baseQuery
  )
    .orderBy(desc(toolEvents.calledAt))
    .limit(limit)
    .all();

  return c.json({ events: rows, total: rows.length });
});

export default stats;
