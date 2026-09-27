// postgres-live.test.ts — the memory service against a real PostgreSQL + pgvector.
//
// The unit suite runs on PGlite, whose pgvector is a WASM build. The production
// path is a `pg.Pool` against the pgvector image, and the parts that differ are
// exactly the parts this service depends on:
//
//   - `CREATE EXTENSION IF NOT EXISTS vector` (the baseline migration) against a
//     server that may or may not have pgvector installed
//   - the HNSW index built on the `embedding::vector(n)` expression — pgvector
//     refuses to build it on an unbounded column, and a WASM build may not
//     enforce that the same way
//   - the advisory lock that serialises migrations across per-project pods
//   - the `pg` driver's parameter typing for vector literals
//
// SKIPPED unless PERCUSSIONIST_TEST_PG_URL points at a disposable database:
//
//   docker run -d --name pcs-pg -p 55432:5432 \
//     -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=pcs pgvector/pgvector:0.8.6-pg18
//   PERCUSSIONIST_TEST_PG_URL=postgresql://postgres:pw@localhost:55432/pcs \
//     bun test --isolate src/__tests__/postgres-live.test.ts
//
// It only touches rows it creates (scoped to a throwaway project id) and drops
// the pgvector-owning schema objects it needs, so keep the URL disposable.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Client } from 'pg';

const URL = process.env.PERCUSSIONIST_TEST_PG_URL;
const describeLive = URL ? describe : describe.skip;

const PROJECT = 'live-pg-project';

beforeAll(async () => {
  if (!URL) return;
  // Only the extension + the memories table are needed, and a previous run's
  // tables would make the migration journal skip the baseline.
  const client = new Client({ connectionString: URL });
  await client.connect();
  try {
    // The table and the journal are what must be clean: drizzle's migrator only
    // compares the last journal row, so a stale journal makes it skip the
    // baseline and create nothing.
    //
    // The extension is left alone on purpose. `drop extension ... cascade` on a
    // database that has used the type can leave an orphaned `vector` row in
    // pg_type, after which the migration's `CREATE EXTENSION IF NOT EXISTS`
    // fails with "type vector already exists" — a state no real deployment is
    // in. Install-on-a-fresh-database is covered by the E2E suite, which brings
    // up a new StatefulSet pod with an empty PGDATA.
    await client.query('drop table if exists memories cascade');
    await client.query('drop schema if exists drizzle cascade');
  } finally {
    await client.end();
  }
  process.env.DATABASE_URL = URL;
  process.env.MEMORY_PROJECT = PROJECT;
});

afterAll(async () => {
  if (!URL) return;
  const { closeDb } = await import('../db.js');
  await closeDb().catch(() => undefined);
  const client = new Client({ connectionString: URL });
  await client.connect();
  try {
    await client.query('delete from memories where project = $1', [PROJECT]);
  } finally {
    await client.end();
  }
  delete process.env.DATABASE_URL;
  delete process.env.MEMORY_PROJECT;
});

describeLive('live PostgreSQL + pgvector', () => {
  it('installs pgvector and applies the memory migrations', async () => {
    const { initDb, getDb } = await import('../db.js');
    const { sql } = await import('drizzle-orm');
    await initDb();
    const db = getDb();

    const ext = (await db.execute(
      sql`select extversion from pg_extension where extname = 'vector'`,
    )) as unknown as { rows: Array<{ extversion: string }> };
    expect(ext.rows[0]?.extversion).toBeTruthy();

    const journal = (await db.execute(
      sql`select count(*)::int as count from drizzle.drizzle_memory_migrations`,
    )) as unknown as { rows: Array<{ count: number }> };
    expect(Number(journal.rows[0]?.count ?? 0)).toBeGreaterThan(0);
  });

  it('builds the HNSW index on the cast expression, as pgvector requires', async () => {
    const { getDb } = await import('../db.js');
    const { sql } = await import('drizzle-orm');
    const rows = (
      (await getDb().execute(
        sql`select indexdef from pg_indexes where tablename = 'memories' and indexname like 'idx_memories_embedding_hnsw_%'`,
      )) as unknown as { rows: Array<{ indexdef: string }> }
    ).rows;
    // A plain `USING hnsw (embedding ...)` on an unbounded column is rejected by
    // pgvector, so its presence proves the expression index is what shipped.
    expect(
      rows.some((r) => r.indexdef.includes('hnsw') && r.indexdef.includes('vector_cosine_ops')),
    ).toBe(true);
  });

  it('stores, searches and deletes through the pg driver', async () => {
    const { handleStoreMemory, handleSearch, handleDeleteMemory } = await import('../routes.js');
    const { handleContext } = await import('../routes.js');

    // getEmbedding hits Ollama; stub it the way shared-mocks does.
    const { mockEmbeddingFor } = await import('./shared-mocks.js');
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ embedding: Array.from(mockEmbeddingFor('live query')) }),
      )) as never;

    const stored = await handleStoreMemory({
      content: 'live postgres memory',
      metadata: { k: 'v' },
    });
    expect(stored.id).toBeTruthy();

    const hits = await handleSearch({ query: 'live query', limit: 5 });
    expect(hits.map((h) => h.id)).toContain(stored.id);
    // pg returns numerics for `<=>` as doubles; a string here would mean the
    // driver type mapping is off.
    expect(typeof hits[0]?.distance).toBe('number');
    expect(hits[0]?.distance).toBeGreaterThanOrEqual(0);
    // The API contract is an ISO string. Internally the row must be a Date —
    // routes.ts calls toISOString() on it, which throws on a raw string, so a
    // schema with mode: 'string' would fail this line on pg but pass on PGlite.
    expect(hits[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);

    const context = await handleContext({ query: 'live query' });
    expect(context.context).toContain('live postgres memory');

    expect((await handleDeleteMemory(stored.id)).deleted).toBe(true);
    expect((await handleSearch({ query: 'live query', limit: 5 })).map((h) => h.id)).not.toContain(
      stored.id,
    );
  });

  it('rejects a row whose vector width contradicts EMBEDDING_DIMENSIONS', async () => {
    const { getDb } = await import('../db.js');
    const { memories } = await import('../schema.js');
    await expect(
      getDb()
        .insert(memories)
        .values({
          project: PROJECT,
          id: 'live-bad-width',
          content: 'lying',
          metadata: {},
          embedding: Array.from({ length: 8 }, (_, i) => Math.sin(i)),
          dims: 768,
        })
        .execute(),
    ).rejects.toThrow();
  });
});
