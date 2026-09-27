// routes/board-db.ts — task event history endpoints.

import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { scoped } from '../auth.js';
import { getDb, taskEvents } from '../db.js';

const boardDb = new Hono();

function parseBoundedLimit(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(raw ?? String(fallback), 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), max);
}

// ---------------------------------------------------------------------------
// GET /api/board/:project/events?limit=100
boardDb.get('/:project/events', scoped('board', 'read'), async (c) => {
  const project = c.req.param('project');
  const limit = parseBoundedLimit(c.req.query('limit'), 100, 500);
  const db = getDb();

  const rows = await db
    .select()
    .from(taskEvents)
    .where(eq(taskEvents.project, project))
    .orderBy(desc(taskEvents.id))
    .limit(limit);

  return c.json({ events: rows });
});

// ---------------------------------------------------------------------------
// GET /api/board/:project/tasks/:taskName/events?limit=50
boardDb.get('/:project/tasks/:taskName/events', scoped('board', 'read'), async (c) => {
  const project = c.req.param('project');
  const taskName = c.req.param('taskName');
  const limit = parseBoundedLimit(c.req.query('limit'), 50, 200);
  const db = getDb();

  const rows = await db
    .select()
    .from(taskEvents)
    .where(and(eq(taskEvents.project, project), eq(taskEvents.taskName, taskName)))
    .orderBy(desc(taskEvents.id))
    .limit(limit);

  return c.json({ events: rows });
});

export default boardDb;
