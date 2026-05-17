// Stats API routes.
//
// POST /api/stats/session
//   Called by the dispatcher sidecar after a session completes. Persists the
//   full session — run metadata, every message (with full content), tool
//   invocations, and file accesses — to percussionist.db.
//
// GET /api/stats/export
//   Returns all sessions (within a configurable look-back window) as a single
//   JSON document suitable for piping into an LLM for pattern analysis.
//   Query params:
//     days=N   — look-back window in days (default: 30; 0 = all time)

import { Hono } from "hono";
import { getDb, runs, messages, toolCalls, fileOps } from "../db.js";
import { lt, gte, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

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
stats.post("/session", async (c) => {
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

// GET /api/stats/exists/:sessionID — check if a session row exists (for backfill guard).
stats.get("/exists/:sessionID", (c) => {
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
stats.get("/export", (c) => {
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

export default stats;
