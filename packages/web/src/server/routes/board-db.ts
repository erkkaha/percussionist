// routes/board-db.ts — SQLite-backed board state API.
//
// These endpoints are the authoritative read/write interface for board task
// and worker state.  The manager controller calls these instead of patching
// CR status.board directly, removing the merge-patch contention problem.
//
// Mounted at /api/board.
//
// GET    /api/board/:project                          — full board
// GET    /api/board/:project/tasks/:taskId            — single task (fast path)
// POST   /api/board/:project/tasks/:taskId/move       — { column } atomic move
// PUT    /api/board/:project/workers/:taskId          — upsert worker
// DELETE /api/board/:project/workers/:taskId          — remove worker
// POST   /api/board/:project/seed                     — bulk-load tasks from JSON

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import {
  getDb,
  boardTasks,
  boardWorkers,
  boardEvents,
} from "../db.js";

const boardDb = new Hono();

// ---------------------------------------------------------------------------
// Types

interface WorkerUpsertBody {
  runName: string;
  retryCount?: number;
  status: string;
  branch?: string;
  facilitated?: boolean;
  reviewRunName?: string;
  reworkRunName?: string;
  facilitationRunName?: string;
  // JSON blob of extra WorkerStatus fields (reviewApproved, escalation, etc.)
  extra?: Record<string, unknown>;
}

interface TaskRow {
  taskId: string;
  column: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

interface WorkerRow {
  taskId: string;
  runName: string;
  retryCount: number;
  status: string;
  branch: string | null;
  facilitated: boolean;
  reviewRunName: string | null;
  reworkRunName: string | null;
  facilitationRunName: string | null;
  extra: string | null;
  assignedAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// GET /api/board/:project — full board state

boardDb.get("/:project", (c) => {
  const project = c.req.param("project");
  const db = getDb();

  const tasks = db.select().from(boardTasks).where(eq(boardTasks.project, project)).all() as TaskRow[];
  const workers = db.select().from(boardWorkers).where(eq(boardWorkers.project, project)).all() as WorkerRow[];

  // Group tasks by column.
  const columns: Record<string, string[]> = {};
  for (const t of tasks) {
    if (!columns[t.column]) columns[t.column] = [];
    columns[t.column]!.push(t.taskId);
  }

  const workersByTaskId: Record<string, WorkerRow & { extra: Record<string, unknown> | null }> = {};
  for (const w of workers) {
    workersByTaskId[w.taskId] = {
      ...w,
      extra: w.extra ? (JSON.parse(w.extra) as Record<string, unknown>) : null,
    } as unknown as WorkerRow & { extra: Record<string, unknown> | null };
  }

  const activeWorkers = workers.filter((w) => w.status === "Running" && w.runName).length;

  return c.json({ columns, workers: workersByTaskId, activeWorkers });
});

// ---------------------------------------------------------------------------
// GET /api/board/:project/tasks/:taskId — single task lookup

boardDb.get("/:project/tasks/:taskId", (c) => {
  const project = c.req.param("project");
  const taskId = c.req.param("taskId");
  const db = getDb();

  const rows = db
    .select()
    .from(boardTasks)
    .where(and(eq(boardTasks.project, project), eq(boardTasks.taskId, taskId)))
    .all() as TaskRow[];

  if (rows.length === 0) return c.json({ error: "task not found" }, 404);

  const worker = db
    .select()
    .from(boardWorkers)
    .where(and(eq(boardWorkers.project, project), eq(boardWorkers.taskId, taskId)))
    .all() as WorkerRow[];

  return c.json({ task: rows[0], worker: worker[0] ?? null });
});

// ---------------------------------------------------------------------------
// POST /api/board/:project/tasks/:taskId/move — { column: string }

boardDb.post("/:project/tasks/:taskId/move", async (c) => {
  const project = c.req.param("project");
  const taskId = c.req.param("taskId");

  let body: { column?: string };
  try {
    body = (await c.req.json()) as { column?: string };
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const { column } = body;
  if (!column) return c.json({ error: "column is required" }, 400);

  const db = getDb();

  const now = new Date().toISOString();

  db.transaction((tx) => {
    const existing = tx
      .select()
      .from(boardTasks)
      .where(and(eq(boardTasks.project, project), eq(boardTasks.taskId, taskId)))
      .all() as TaskRow[];

    const previousColumn = existing[0]?.column ?? null;

    if (existing.length === 0) {
      // Insert — task seen for the first time.
      tx.insert(boardTasks)
        .values({ project, taskId, column, seq: 0, updatedAt: now })
        .run();
    } else {
      tx.update(boardTasks)
        .set({ column, updatedAt: now })
        .where(and(eq(boardTasks.project, project), eq(boardTasks.taskId, taskId)))
        .run();
    }

    // Append event.
    tx.insert(boardEvents)
      .values({
        project,
        taskId,
        eventType: "task.moved",
        payload: JSON.stringify({ from: previousColumn, to: column }),
        createdAt: now,
      })
      .run();
  });

  return c.json({ project, taskId, column });
});

// ---------------------------------------------------------------------------
// PUT /api/board/:project/workers/:taskId — upsert worker

boardDb.put("/:project/workers/:taskId", async (c) => {
  const project = c.req.param("project");
  const taskId = c.req.param("taskId");

  let body: WorkerUpsertBody;
  try {
    body = (await c.req.json()) as WorkerUpsertBody;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  if (!body.runName || !body.status) {
    return c.json({ error: "runName and status are required" }, 400);
  }

  const db = getDb();
  const now = new Date().toISOString();

  db.transaction((tx) => {
    const existing = tx
      .select()
      .from(boardWorkers)
      .where(and(eq(boardWorkers.project, project), eq(boardWorkers.taskId, taskId)))
      .all();

    const values = {
      project,
      taskId,
      runName: body.runName,
      retryCount: body.retryCount ?? 0,
      status: body.status,
      branch: body.branch ?? null,
      facilitated: body.facilitated ?? false,
      reviewRunName: body.reviewRunName ?? null,
      reworkRunName: body.reworkRunName ?? null,
      facilitationRunName: body.facilitationRunName ?? null,
      extra: body.extra ? JSON.stringify(body.extra) : null,
      updatedAt: now,
    };

    if (existing.length === 0) {
      tx.insert(boardWorkers).values({ ...values, assignedAt: now }).run();
      tx.insert(boardEvents)
        .values({
          project,
          taskId,
          eventType: "worker.assigned",
          payload: JSON.stringify({ runName: body.runName, status: body.status }),
          createdAt: now,
        })
        .run();
    } else {
      tx.update(boardWorkers)
        .set(values)
        .where(and(eq(boardWorkers.project, project), eq(boardWorkers.taskId, taskId)))
        .run();
      tx.insert(boardEvents)
        .values({
          project,
          taskId,
          eventType: "worker.updated",
          payload: JSON.stringify({ runName: body.runName, status: body.status }),
          createdAt: now,
        })
        .run();
    }
  });

  return c.json({ project, taskId, runName: body.runName, status: body.status });
});

// ---------------------------------------------------------------------------
// DELETE /api/board/:project/workers/:taskId — remove worker

boardDb.delete("/:project/workers/:taskId", (c) => {
  const project = c.req.param("project");
  const taskId = c.req.param("taskId");
  const db = getDb();
  const now = new Date().toISOString();

  db.transaction((tx) => {
    tx.delete(boardWorkers)
      .where(and(eq(boardWorkers.project, project), eq(boardWorkers.taskId, taskId)))
      .run();
    tx.insert(boardEvents)
      .values({
        project,
        taskId,
        eventType: "worker.removed",
        payload: "{}",
        createdAt: now,
      })
      .run();
  });

  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// POST /api/board/:project/seed — bulk-load tasks from JSON
//
// Body: { tasks: Array<{ taskId: string; column: string; seq?: number }> }
//
// Idempotent: inserts tasks that don't exist yet; skips existing ones.
// Used by the manager on first startup to populate SQLite from CR spec, and
// by the CLI to bootstrap new projects.

boardDb.post("/:project/seed", async (c) => {
  const project = c.req.param("project");

  let body: { tasks?: Array<{ taskId: string; column: string; seq?: number }> };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  if (!Array.isArray(body.tasks)) return c.json({ error: "tasks array is required" }, 400);

  const db = getDb();
  const now = new Date().toISOString();
  let inserted = 0;
  let skipped = 0;

  db.transaction((tx) => {
    for (const t of body.tasks!) {
      if (!t.taskId || !t.column) continue;

      const existing = tx
        .select()
        .from(boardTasks)
        .where(and(eq(boardTasks.project, project), eq(boardTasks.taskId, t.taskId)))
        .all();

      if (existing.length > 0) {
        skipped++;
        continue;
      }

      tx.insert(boardTasks)
        .values({
          project,
          taskId: t.taskId,
          column: t.column,
          seq: t.seq ?? 0,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      inserted++;
    }
  });

  return c.json({ project, inserted, skipped });
});

// ---------------------------------------------------------------------------
// POST /api/board/:project/sync — atomic full board state replace.
//
// Accepts the reconciler's final in-memory state and atomically syncs it to
// SQLite.  This replaces the end-of-cycle patchProjectStatus call for board
// state, eliminating the merge-patch race condition.
//
// Body:
//   tasks:   Array<{ taskId, column }>         — full backlog (all tasks)
//   workers: Array<WorkerUpsertBody & { taskId }> — all worker entries

boardDb.post("/:project/sync", async (c) => {
  const project = c.req.param("project");

  let body: {
    tasks?: Array<{ taskId: string; column: string }>;
    workers?: Array<WorkerUpsertBody & { taskId: string }>;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  if (!Array.isArray(body.tasks)) return c.json({ error: "tasks array is required" }, 400);
  if (!Array.isArray(body.workers)) return c.json({ error: "workers array is required" }, 400);

  const db = getDb();
  const now = new Date().toISOString();

  const taskIds = new Set(body.tasks.map((t) => t.taskId));
  const workerTaskIds = new Set(body.workers.map((w) => w.taskId));

  db.transaction((tx) => {
    // Upsert all provided tasks.
    for (const t of body.tasks!) {
      if (!t.taskId || !t.column) continue;
      const existing = tx
        .select()
        .from(boardTasks)
        .where(and(eq(boardTasks.project, project), eq(boardTasks.taskId, t.taskId)))
        .all() as TaskRow[];

      if (existing.length === 0) {
        tx.insert(boardTasks).values({ project, taskId: t.taskId, column: t.column, seq: 0, updatedAt: now }).run();
      } else if (existing[0]!.column !== t.column) {
        tx.update(boardTasks)
          .set({ column: t.column, updatedAt: now })
          .where(and(eq(boardTasks.project, project), eq(boardTasks.taskId, t.taskId)))
          .run();
        tx.insert(boardEvents).values({
          project,
          taskId: t.taskId,
          eventType: "task.moved",
          payload: JSON.stringify({ from: existing[0]!.column, to: t.column }),
          createdAt: now,
        }).run();
      }
    }

    // Delete tasks no longer in backlog (pruned by reconciler).
    const allTasks = tx.select().from(boardTasks).where(eq(boardTasks.project, project)).all() as TaskRow[];
    for (const row of allTasks) {
      if (!taskIds.has(row.taskId)) {
        tx.delete(boardTasks).where(and(eq(boardTasks.project, project), eq(boardTasks.taskId, row.taskId))).run();
      }
    }

    // Upsert all provided workers.
    for (const w of body.workers!) {
      if (!w.taskId || !w.runName || !w.status) continue;
      const existing = tx
        .select()
        .from(boardWorkers)
        .where(and(eq(boardWorkers.project, project), eq(boardWorkers.taskId, w.taskId)))
        .all();

      const values = {
        project,
        taskId: w.taskId,
        runName: w.runName,
        retryCount: w.retryCount ?? 0,
        status: w.status,
        branch: w.branch ?? null,
        facilitated: w.facilitated ?? false,
        reviewRunName: w.reviewRunName ?? null,
        reworkRunName: w.reworkRunName ?? null,
        facilitationRunName: w.facilitationRunName ?? null,
        extra: w.extra ? JSON.stringify(w.extra) : null,
        updatedAt: now,
      };

      if (existing.length === 0) {
        tx.insert(boardWorkers).values({ ...values, assignedAt: now }).run();
      } else {
        tx.update(boardWorkers).set(values).where(and(eq(boardWorkers.project, project), eq(boardWorkers.taskId, w.taskId))).run();
      }
    }

    // Delete workers no longer present.
    const allWorkers = tx.select().from(boardWorkers).where(eq(boardWorkers.project, project)).all() as WorkerRow[];
    for (const row of allWorkers) {
      if (!workerTaskIds.has(row.taskId)) {
        tx.delete(boardWorkers).where(and(eq(boardWorkers.project, project), eq(boardWorkers.taskId, row.taskId))).run();
      }
    }
  });

  return c.json({ project, tasks: body.tasks!.length, workers: body.workers!.length });
});

export default boardDb;
