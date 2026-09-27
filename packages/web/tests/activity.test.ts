// activity.test.ts — GET /api/activity cursor consistency.
//
// The `before` cursor filters on task_events.id, so the feed must order by id
// DESC. taskEvents.createdAt is datetime('now') at second resolution, so events
// written in the same second share a createdAt while their ids (autoincrement)
// diverge from it — ordering by createdAt would make cursor pages skip/repeat
// events. These tests insert events sharing a createdAt with distinct ids and
// assert id-DESC order plus exact, gap-free `before=<min id>` pagination.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createApp } from '../src/server/app.js';
import { getDb, taskEvents } from '../src/server/db.js';
import { closeTestDb, createTestDb } from './helpers/pglite.js';

// ---------------------------------------------------------------------------
// Test DB isolation — a fresh in-memory PGlite for the file, installed before
// the first getDb()/request because getDb() is lazy. Every test below scopes its
// queries to its own project, so the shared id sequence does not leak between
// them.

process.env.AUTH_DISABLED = '1';

const app = createApp();

// A single timestamp shared by a batch of events — simulates events written in
// the same second, where createdAt collides but ids stay distinct.
const SAME_SECOND = '2025-01-01 12:00:00';

// Postgres has no lastInsertRowid: an insert that needs its generated key asks
// for it back with .returning().
async function insertEvent(project: string, taskName: string, createdAt: string): Promise<number> {
  const rows = await getDb()
    .insert(taskEvents)
    .values({
      project,
      taskName,
      taskType: 'BUILD',
      eventType: 'column.changed',
      payload: '{}',
      createdAt,
    })
    .returning({ id: taskEvents.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('insertEvent returned no id');
  return id;
}

interface ActivityResponse {
  events: Array<{ id: number; createdAt: string }>;
  count: number;
}

async function fetchActivity(query: string): Promise<ActivityResponse> {
  const res = await app.request(`/api/activity${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as ActivityResponse;
}

beforeAll(async () => {
  await createTestDb();
});

afterAll(async () => {
  await closeTestDb();
  delete process.env.AUTH_DISABLED;
});

describe('GET /api/activity cursor consistency', () => {
  it('orders by id DESC when multiple events share the same createdAt', async () => {
    const project = 'act-proj-same-second';
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await insertEvent(project, `task-${i}`, SAME_SECOND));
    }

    const { events } = await fetchActivity(`?project=${project}&limit=10`);
    expect(events.map((e) => e.id)).toEqual([...ids].reverse());
    // Every event carries the colliding timestamp, yet ids order the page.
    for (const event of events) {
      expect(event.createdAt).toBe(SAME_SECOND);
    }
  });

  it('orders by id, not createdAt, when timestamps disagree with insertion order', async () => {
    const project = 'act-proj-mixed-ts';
    // Insert an event, then a *later* id carrying an *earlier* timestamp. id is
    // the cursor key, so id DESC must win regardless of createdAt.
    const firstId = await insertEvent(project, 'task-a', '2025-01-01 12:00:00');
    const secondId = await insertEvent(project, 'task-b', '2025-01-01 11:00:00');

    const { events } = await fetchActivity(`?project=${project}&limit=10`);
    expect(events.map((e) => e.id)).toEqual([secondId, firstId]);
    expect(events[0]?.createdAt).toBe('2025-01-01 11:00:00');
  });

  it('before=<min id> returns exactly the older set with no skips or repeats', async () => {
    const project = 'act-proj-cursor';
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(await insertEvent(project, `task-${i}`, SAME_SECOND));
    }

    // First page: newest 4 of the 6, ordered by id DESC.
    const first = await fetchActivity(`?project=${project}&limit=4`);
    expect(first.events.map((e) => e.id)).toEqual(ids.slice(2).reverse());

    // Second page: before = min id of the first page → the remaining older set.
    const minId = Math.min(...first.events.map((e) => e.id));
    const second = await fetchActivity(`?project=${project}&limit=4&before=${minId}`);
    expect(second.events.map((e) => e.id)).toEqual(ids.slice(0, 2).reverse());

    // Union of both pages is exactly the full set: no skips, no repeats.
    const allIds = [...first.events, ...second.events].map((e) => e.id);
    expect(allIds).toEqual([...ids].reverse());
    expect(new Set(allIds).size).toBe(ids.length);
  });

  it('before cursor is exclusive of the given id', async () => {
    const project = 'act-proj-exclusive';
    const idA = await insertEvent(project, 'task-a', SAME_SECOND);
    const idB = await insertEvent(project, 'task-b', SAME_SECOND);
    await insertEvent(project, 'task-c', SAME_SECOND);

    const { events } = await fetchActivity(`?project=${project}&limit=10&before=${idB}`);
    expect(events.map((e) => e.id)).toEqual([idA]);
  });
});
