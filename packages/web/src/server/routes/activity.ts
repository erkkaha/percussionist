// routes/activity.ts — cross-project activity feed.

import { and, desc, eq, lt } from 'drizzle-orm';
import { Hono } from 'hono';
import { auth } from '../auth.js';
import { getDb, taskEvents } from '../db.js';

const activity = new Hono();

// ---------------------------------------------------------------------------
// GET /api/activity
activity.get('/', auth(), async (c) => {
  const parsedLimit = Number.parseInt(c.req.query('limit') ?? '200', 10);
  const limit = Number.isNaN(parsedLimit) ? 200 : Math.min(Math.max(parsedLimit, 1), 500);
  const project = c.req.query('project');
  const before = c.req.query('before');
  const db = getDb();

  // Build where conditions
  const conditions = [];
  if (project) conditions.push(eq(taskEvents.project, project));
  if (before) {
    const beforeId = parseInt(before, 10);
    if (!Number.isNaN(beforeId)) conditions.push(lt(taskEvents.id, beforeId));
  }

  // Order by the same key the `before` cursor filters on (id DESC, not
  // createdAt): taskEvents.createdAt has millisecond resolution, so events
  // written in the same millisecond can share a createdAt while their ids
  // (autoincrement) diverge from it — ordering by createdAt would make cursor
  // pages skip/repeat events.
  const rows = await db
    .select()
    .from(taskEvents)
    .where(conditions.length > 0 ? and(...(conditions as [ReturnType<typeof eq>])) : undefined)
    .orderBy(desc(taskEvents.id))
    .limit(limit);

  return c.json({ events: rows, count: rows.length });
});

export default activity;
