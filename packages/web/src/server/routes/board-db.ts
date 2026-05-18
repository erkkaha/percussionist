// routes/board-db.ts — task event history endpoints.
//
// The board state is now authoritative in Task CRDs (K8s).
// This module serves the append-only task_events audit log from SQLite.
//
// Mounted at /api/board.
//
// GET /api/board/:project/events        — recent task events for a project
// GET /api/board/:project/tasks/:name/events — events for a specific task CR

import { Hono } from "hono";
import { eq, and, desc } from "drizzle-orm";
import { getDb, taskEvents } from "../db.js";

const boardDb = new Hono();

// ---------------------------------------------------------------------------
// GET /api/board/:project/events?limit=100

boardDb.get("/:project/events", (c) => {
  const project = c.req.param("project");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "100", 10), 500);
  const db = getDb();

  const rows = db
    .select()
    .from(taskEvents)
    .where(eq(taskEvents.project, project))
    .orderBy(desc(taskEvents.createdAt))
    .limit(limit)
    .all();

  return c.json({ events: rows });
});

// ---------------------------------------------------------------------------
// GET /api/board/:project/tasks/:taskName/events?limit=50

boardDb.get("/:project/tasks/:taskName/events", (c) => {
  const project = c.req.param("project");
  const taskName = c.req.param("taskName");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 200);
  const db = getDb();

  const rows = db
    .select()
    .from(taskEvents)
    .where(and(eq(taskEvents.project, project), eq(taskEvents.taskName, taskName)))
    .orderBy(desc(taskEvents.createdAt))
    .limit(limit)
    .all();

  return c.json({ events: rows });
});

export default boardDb;
