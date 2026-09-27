import { afterAll, afterEach, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { vector as vectorExtension } from '@electric-sql/pglite-pgvector';
import { and, eq, sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Integration-style test: the real Drizzle query layer against an in-process
// PGlite with pgvector compiled in, running the committed migrations. Only
// embed.js is mocked (no real Ollama calls).
// ---------------------------------------------------------------------------

import {
  assertStoredDimensions,
  closeDb,
  createPgliteDb,
  getDb,
  getEmbeddingDimensions,
  getProject,
  inTransaction,
  toEmbeddingVector,
} from '../db.js';
import {
  handleContext,
  handleDeleteMemory,
  handleGetMemory,
  handleHealth,
  handleListMemories,
  handleSearch,
  handleStoreMemory,
  handleUpdateMemory,
  parseLimit,
  parseOffset,
  ValidationError,
} from '../routes.js';
import { DEFAULT_EMBEDDING_DIMENSIONS, memories } from '../schema.js';
import { mockEmbedding, mockEmbeddingFor } from './shared-mocks.js';

const PROJECT_A = 'test-project-a';
const PROJECT_B = 'test-project-b';

const PROJECT_DIMS = 'test-project-dims';
const RANKING_QUERY = 'ranking query';

const FAKE_VECTOR = Array.from(mockEmbedding());

let client: PGlite;

// Booting the PGlite WASM module (plus its pgvector extension) and applying the
// migrations costs 1.5–5 s, and the first instantiation in a process is the
// slowest. Bun's 5 s default therefore expires on beforeAll roughly one run in
// six — which showed up as a hook timeout followed by "PGlite is closed" from
// the tests that ran after it. Mirrors packages/web/tests/helpers/pglite.ts.
setDefaultTimeout(30_000);

beforeAll(async () => {
  process.env.MEMORY_PROJECT = PROJECT_A;
  client = new PGlite({ extensions: { vector: vectorExtension } });
  await createPgliteDb(client);
});

afterAll(async () => {
  // closeDb() closes the injected PGlite instance (and its WASM heap). The
  // database-down health case below already closed it, so this is a no-op if
  // that ran first.
  await closeDb();
  await client.close().catch(() => undefined);
  delete process.env.MEMORY_PROJECT;
});

// ---------------------------------------------------------------------------
// Helpers

let seedEpoch = 0;

/**
 * Insert rows straight through Drizzle. `createdAt` is set explicitly from a
 * monotonically increasing base so "newest first" ordering is deterministic
 * instead of depending on how fast the WASM inserts happen to land.
 */
async function seed(
  count: number,
  opts: {
    project?: string;
    contentPrefix?: string;
    metadata?: (i: number) => Record<string, unknown>;
  } = {},
): Promise<string[]> {
  const project = opts.project ?? getProject();
  seedEpoch += 3_600_000;
  const base = Date.UTC(2026, 0, 1) + seedEpoch;
  const rows = Array.from({ length: count }, (_, i) => ({
    project,
    id: randomUUID(),
    content: `${opts.contentPrefix ?? 'memory content'} ${i}`,
    metadata: opts.metadata ? opts.metadata(i) : { task: i % 2 === 0 ? 'task-abc' : 'task-xyz' },
    embedding: FAKE_VECTOR,
    dims: FAKE_VECTOR.length,
    createdAt: new Date(base + i * 1000),
  }));
  await getDb().insert(memories).values(rows);
  return rows.map((r) => r.id);
}

async function clear(project: string = getProject()): Promise<void> {
  await getDb().delete(memories).where(eq(memories.project, project));
}

async function fetchRow(id: string, project: string = getProject()) {
  const rows = await getDb()
    .select({
      project: memories.project,
      id: memories.id,
      content: memories.content,
      metadata: memories.metadata,
      agentRun: memories.agentRun,
      createdAt: memories.createdAt,
    })
    .from(memories)
    .where(and(eq(memories.project, project), eq(memories.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

async function rowCount(project: string = getProject()): Promise<number> {
  const rows = await getDb()
    .select({ value: sql<number>`count(*)::int` })
    .from(memories)
    .where(eq(memories.project, project));
  return rows[0]?.value ?? 0;
}

async function scalar<T>(text: string): Promise<T | undefined> {
  const result = (await getDb().execute(sql.raw(text))) as unknown as { rows: T[] };
  return result.rows[0];
}

function stubFetch(handler: () => Promise<Response>): void {
  globalThis.fetch = (() => handler()) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Schema / migration

describe('migrated schema', () => {
  it('applied the pgvector extension', async () => {
    const row = await scalar<{ extversion: string }>(
      `select extversion from pg_extension where extname = 'vector'`,
    );
    expect(row?.extversion).toBeTruthy();
  });

  it('created the embedding column as an unbounded vector', async () => {
    const row = await scalar<{ column_type: string; typmod: number }>(
      `select format_type(a.atttypid, null) as column_type, a.atttypmod as typmod
       from pg_attribute a
       where a.attrelid = 'memories'::regclass and a.attname = 'embedding'`,
    );
    expect(row?.column_type).toBe('vector');
    expect(row?.typmod).toBe(-1);
  });

  it('round-trips a vector of arbitrary width through the column', async () => {
    for (const dims of [3, 1024]) {
      const id = randomUUID();
      const values = Array.from({ length: dims }, (_, i) => Math.sin(i));
      await getDb()
        .insert(memories)
        .values({
          project: PROJECT_DIMS,
          id,
          content: `${dims} dims`,
          metadata: {},
          embedding: values,
          dims,
        });
      const rows = await getDb()
        .select({
          dims: sql<number>`vector_dims(${memories.embedding})`,
          embedding: memories.embedding,
        })
        .from(memories)
        .where(and(eq(memories.project, PROJECT_DIMS), eq(memories.id, id)));
      expect(rows[0]?.dims).toBe(dims);
      expect(rows[0]?.embedding.length).toBe(dims);
      expect(rows[0]?.embedding[0]).toBeCloseTo(values[0] ?? 0, 5);
    }
    await clear(PROJECT_DIMS);
  });

  it('scopes the primary key by project', async () => {
    const row = await scalar<{ keys: string }>(
      `select string_agg(a.attname, ',' order by a.attnum) as keys
       from pg_constraint c
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
       where c.conrelid = 'memories'::regclass and c.contype = 'p'`,
    );
    expect(row?.keys).toBe('project,id');
  });

  it('keeps dims honest with a CHECK against vector_dims(embedding)', async () => {
    const row = await scalar<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition
       from pg_constraint
       where conrelid = 'memories'::regclass and conname = 'memories_dims_matches_embedding'`,
    );
    expect(row?.definition).toContain('vector_dims');

    // A row whose declared width disagrees with its vector is rejected outright,
    // which is what lets assertStoredDimensions() trust the column.
    await expect(
      getDb()
        .insert(memories)
        .values({
          project: PROJECT_DIMS,
          id: randomUUID(),
          content: 'lying about its width',
          metadata: {},
          embedding: Array.from({ length: 8 }, (_, i) => Math.sin(i)),
          dims: 768,
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('indexes (project, dims) so the width assertion is not a scan', async () => {
    const row = await scalar<{ count: number }>(
      `select count(*)::int as count from pg_indexes
       where tablename = 'memories' and indexname = 'idx_memories_project_dims'`,
    );
    expect(row?.count).toBe(1);
  });

  it('built the per-width HNSW index at startup', async () => {
    const row = await scalar<{ indexdef: string }>(
      `select indexdef from pg_indexes
       where tablename = 'memories'
         and indexname = 'idx_memories_embedding_hnsw_${DEFAULT_EMBEDDING_DIMENSIONS}'`,
    );
    expect(row?.indexdef).toContain('hnsw');
    expect(row?.indexdef).toContain('vector_cosine_ops');
    // Partial to this width, so a project with a different EMBEDDING_DIMENSIONS
    // sharing the table neither breaks the build nor bloats the index.
    expect(row?.indexdef).toContain('WHERE');
  });

  it('orders search by the HNSW index, not a sequential scan', async () => {
    await clear();
    await seed(5);
    // A small table would cost out an ANN scan regardless, so the check is
    // whether the planner can match the query to the index at all: with sorting
    // and sequential scans disabled, the only plan left for this ORDER BY is the
    // HNSW index — and only if the query repeats the indexed expression.
    const plan = await inTransaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      await tx.execute(sql`set local enable_bitmapscan = off`);
      await tx.execute(sql`set local enable_sort = off`);
      const width = sql.raw(String(DEFAULT_EMBEDDING_DIMENSIONS));
      const query = sql`${`[${FAKE_VECTOR.join(',')}]`}::vector`;
      return (await tx.execute(
        sql`EXPLAIN SELECT id FROM memories
              WHERE project = ${PROJECT_A} AND dims = ${DEFAULT_EMBEDDING_DIMENSIONS}
              ORDER BY (embedding::vector(${width})) <=> ${query}
              LIMIT 10`,
      )) as unknown as { rows: Array<{ 'QUERY PLAN': string }> };
    });
    const text = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(text).toContain(`idx_memories_embedding_hnsw_${DEFAULT_EMBEDDING_DIMENSIONS}`);
    await clear();
  });
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

describe('handleHealth', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns ok when Ollama model is available', async () => {
    stubFetch(
      async () =>
        new Response(JSON.stringify({ models: [{ name: 'nomic-embed-text' }] }), { status: 200 }),
    );

    expect(await handleHealth()).toEqual({ ok: true });
  });

  it('returns not-ok when Ollama is unreachable', async () => {
    stubFetch(async () => new Response(null, { status: 503 }));

    expect(await handleHealth()).toEqual({ ok: false });
  });

  it('returns not-ok when model is not listed in tags', async () => {
    stubFetch(
      async () => new Response(JSON.stringify({ models: [{ name: 'llama3' }] }), { status: 200 }),
    );

    expect(await handleHealth()).toEqual({ ok: false });
  });

  it('returns not-ok when Ollama throws', async () => {
    stubFetch(async () => {
      throw new Error('connection refused');
    });

    expect(await handleHealth()).toEqual({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

describe('handleStoreMemory', () => {
  beforeAll(async () => clear());

  it('stores a memory and returns an id', async () => {
    const result = await handleStoreMemory({ content: 'test memory' });
    expect(result).toHaveProperty('id');
    expect(typeof result.id).toBe('string');

    const row = await fetchRow(result.id);
    expect(row).not.toBeNull();
    expect(row?.content).toBe('test memory');
    expect(row?.project).toBe(PROJECT_A);
  });

  it('returns createdAt as an ISO string', async () => {
    const result = await handleStoreMemory({ content: 'iso timestamp' });
    const mem = await handleGetMemory(result.id);
    expect(mem.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(mem.createdAt ?? ''))).toBe(false);
  });

  it('stores with metadata and agentRun', async () => {
    const result = await handleStoreMemory({
      content: 'task-specific memory',
      metadata: { task: 'task-abc', type: 'observation' },
      agentRun: 'run:test-1',
    });
    expect(result).toHaveProperty('id');

    const row = await fetchRow(result.id);
    expect(row?.content).toBe('task-specific memory');
    expect(row?.metadata).toEqual({ task: 'task-abc', type: 'observation' });
    expect(row?.agentRun).toBe('run:test-1');
  });

  it('defaults metadata to an empty object', async () => {
    const result = await handleStoreMemory({ content: 'no metadata' });
    const row = await fetchRow(result.id);
    expect(row?.metadata).toEqual({});
    expect(row?.agentRun).toBeNull();
  });

  it('stores session-summary metadata correctly', async () => {
    const result = await handleStoreMemory({
      content: 'Session summary of agent work on feature X',
      metadata: { type: 'session-summary', runName: 'plan-worker-1', sessionID: 'sess-abc123' },
      agentRun: 'run:plan-worker-1',
    });

    const row = await fetchRow(result.id);
    expect(row?.content).toBe('Session summary of agent work on feature X');
    expect(row?.metadata).toMatchObject({
      type: 'session-summary',
      runName: 'plan-worker-1',
      sessionID: 'sess-abc123',
    });
    expect(row?.agentRun).toBe('run:plan-worker-1');
  });

  it('stores session-summary with truncated content', async () => {
    const longContent = 'x'.repeat(50_000);
    const result = await handleStoreMemory({
      content: longContent,
      metadata: { type: 'session-summary', runName: 'build-worker-2', sessionID: 'sess-def456' },
      agentRun: 'run:build-worker-2',
    });

    const row = await fetchRow(result.id);
    // Content is stored as-is (truncation happens at summarizer level, not here)
    expect(row?.content.length).toBe(50_000);
    expect(row?.metadata).toMatchObject({ type: 'session-summary' });
  });

  it('survives delete + re-store without orphaned vectors', async () => {
    await clear();

    const first = await handleStoreMemory({ content: 'first memory' });
    const search1 = await handleSearch({ query: 'test', limit: 10 });
    expect(search1.length).toBeGreaterThanOrEqual(1);
    expect(search1[0]?.content).toBe('first memory');

    await clear();

    const second = await handleStoreMemory({ content: 'second memory' });
    expect(second.id).not.toBe(first.id);

    const search2 = await handleSearch({ query: 'test', limit: 10 });
    expect(search2.length).toBe(1);
    expect(search2[0]?.content).toBe('second memory');
    expect(search2[0]?.id).toBe(second.id);
    // Exactly one row: content and embedding share it, so no second table can
    // keep a vector whose content is gone.
    expect(await rowCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

describe('handleSearch', () => {
  beforeAll(async () => {
    await clear();
    await seed(3);
  });

  it('returns results ordered by distance', async () => {
    const results = await handleSearch({ query: 'test', limit: 10 });
    expect(results.length).toBe(3);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]?.distance ?? Infinity).toBeLessThanOrEqual(results[i]?.distance ?? 0);
    }
    for (const r of results) {
      expect(typeof r.distance).toBe('number');
    }
  });

  it('filters by task when provided', async () => {
    const results = await handleSearch({ query: 'test', limit: 10, task: 'task-abc' });
    expect(results.length).toBe(2);
    for (const r of results) {
      expect(r.metadata?.task).toBe('task-abc');
    }
  });

  it('returns empty array when no results match task filter', async () => {
    expect(await handleSearch({ query: 'test', limit: 10, task: 'task-nonexistent' })).toEqual([]);
  });

  it('respects limit', async () => {
    expect((await handleSearch({ query: 'test', limit: 1 })).length).toBe(1);
  });

  it('finds session-summary memories by type metadata', async () => {
    await getDb()
      .insert(memories)
      .values({
        project: getProject(),
        id: randomUUID(),
        content: 'session summary of plan task',
        metadata: { type: 'session-summary' },
        embedding: FAKE_VECTOR,
        dims: FAKE_VECTOR.length,
      });

    const results = await handleSearch({ query: 'session', limit: 10 });
    expect(results.length).toBe(4);
  });

  it('ranks the nearest neighbour first', async () => {
    const queryVector = Array.from(mockEmbeddingFor(RANKING_QUERY));
    await clear();
    await getDb()
      .insert(memories)
      .values([
        {
          project: getProject(),
          id: randomUUID(),
          content: 'opposite',
          metadata: {},
          embedding: queryVector.map((v) => -v),
          dims: queryVector.length,
        },
        {
          project: getProject(),
          id: randomUUID(),
          content: 'same direction',
          metadata: {},
          embedding: queryVector,
          dims: queryVector.length,
        },
      ]);

    const results = await handleSearch({ query: RANKING_QUERY, limit: 10 });
    expect(results.length).toBe(2);
    expect(results[0]?.content).toBe('same direction');
    expect(results[0]?.distance ?? 1).toBeLessThan(0.0001);
    expect(results[1]?.content).toBe('opposite');
    expect(results[1]?.distance ?? 0).toBeCloseTo(2, 4);
  });
});

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

describe('handleContext', () => {
  beforeAll(async () => {
    await clear();
    await seed(3);
  });

  it('returns formatted context', async () => {
    const result = await handleContext({ query: 'test' });
    expect(result.context).not.toBe('No relevant context found.');
    expect(result.context).toMatch(/\[1\] \(relevance:/);
  });

  it('filters by task when provided', async () => {
    const result = await handleContext({ query: 'test', task: 'task-xyz' });
    expect(result.context).not.toBe('No relevant context found.');
    expect(result.context).not.toContain('memory content 0');
  });

  it('returns no context when database is empty', async () => {
    await clear();
    expect((await handleContext({ query: 'anything' })).context).toBe('No relevant context found.');
  });
});

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

describe('handleListMemories', () => {
  beforeAll(async () => {
    await clear();
    await seed(5);
  });

  it('returns all memories ordered by created_at DESC', async () => {
    const result = await handleListMemories({});
    expect(result.memories.length).toBe(5);
    expect(result.total).toBe(5);
    for (let i = 0; i < result.memories.length - 1; i++) {
      const current = result.memories[i];
      const next = result.memories[i + 1];
      const prev = new Date(current?.createdAt ?? '').getTime();
      const curr = new Date(next?.createdAt ?? '').getTime();
      expect(prev).toBeGreaterThan(curr);
    }
    expect(result.memories[0]?.content).toBe('memory content 4');
  });

  it('filters by task', async () => {
    const result = await handleListMemories({ task: 'task-abc' });
    expect(result.total).toBe(3);
    for (const m of result.memories) {
      expect(m.metadata?.task).toBe('task-abc');
    }
  });

  it('respects limit', async () => {
    const result = await handleListMemories({ limit: 2 });
    expect(result.memories.length).toBe(2);
    expect(result.total).toBe(5);
  });

  it('respects offset for pagination', async () => {
    const page1 = await handleListMemories({ limit: 2, offset: 0 });
    const page2 = await handleListMemories({ limit: 2, offset: 2 });
    expect(page1.memories.length).toBe(2);
    expect(page2.memories.length).toBe(2);
    const ids1 = new Set(page1.memories.map((m) => m.id));
    for (const id of page2.memories.map((m) => m.id)) {
      expect(ids1.has(id)).toBe(false);
    }
  });

  it('returns empty list when no memories match task', async () => {
    const result = await handleListMemories({ task: 'nonexistent' });
    expect(result.memories).toEqual([]);
    expect(result.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// limit/offset validation — negative/NaN/oversized values must never reach
// SQL, where a negative LIMIT is a syntax error and NaN is an unbindable
// parameter. These seed >200 rows so the cap assertions cannot pass by
// accident.
// ---------------------------------------------------------------------------

describe('limit/offset validation — handleListMemories', () => {
  beforeAll(async () => {
    await clear();
    await seed(250);
  });

  it('caps oversized limit at 200', async () => {
    const result = await handleListMemories({ limit: 999 });
    expect(result.memories.length).toBe(200);
    expect(result.total).toBe(250);
  });

  it('rejects negative limit', async () => {
    await expect(handleListMemories({ limit: -1 })).rejects.toThrow(
      'limit must be an integer >= 1',
    );
  });

  it('rejects NaN limit', async () => {
    await expect(handleListMemories({ limit: Number.NaN })).rejects.toThrow(
      'limit must be an integer >= 1',
    );
  });

  it('rejects non-numeric limit string', async () => {
    await expect(handleListMemories({ limit: 'abc' })).rejects.toThrow(
      'limit must be an integer >= 1',
    );
  });

  it('rejects zero limit', async () => {
    await expect(handleListMemories({ limit: 0 })).rejects.toThrow('limit must be an integer >= 1');
  });

  it('rejects negative offset', async () => {
    await expect(handleListMemories({ offset: -1 })).rejects.toThrow(
      'offset must be an integer >= 0',
    );
  });

  it('rejects fractional offset', async () => {
    await expect(handleListMemories({ offset: 1.5 })).rejects.toThrow(
      'offset must be an integer >= 0',
    );
  });

  it('coerces numeric strings and caps oversized (entry-point style params)', async () => {
    const result = await handleListMemories({ limit: '999', offset: '0' });
    expect(result.memories.length).toBe(200);
    expect(result.total).toBe(250);
  });
});

describe('limit validation — handleSearch', () => {
  beforeAll(async () => {
    await clear();
    await seed(150);
  });

  it('caps oversized limit at 100', async () => {
    expect((await handleSearch({ query: 'test', limit: 999 })).length).toBe(100);
  });

  it('rejects negative limit', async () => {
    await expect(handleSearch({ query: 'test', limit: -5 })).rejects.toThrow(
      'limit must be an integer >= 1',
    );
  });

  it('rejects NaN limit', async () => {
    await expect(handleSearch({ query: 'test', limit: Number.NaN })).rejects.toThrow(
      'limit must be an integer >= 1',
    );
  });

  it('rejects non-numeric limit string', async () => {
    await expect(handleSearch({ query: 'test', limit: 'abc' })).rejects.toThrow(
      'limit must be an integer >= 1',
    );
  });
});

// ---------------------------------------------------------------------------
// parseLimit / parseOffset coercion units — no DB required.
// ---------------------------------------------------------------------------

describe('parseLimit / parseOffset coercion', () => {
  it('falls back when the value is undefined, null or empty', () => {
    expect(parseLimit(undefined, 10, 100)).toBe(10);
    expect(parseLimit(null, 10, 100)).toBe(10);
    expect(parseLimit('', 10, 100)).toBe(10);
    expect(parseOffset(undefined)).toBe(0);
    expect(parseOffset(null)).toBe(0);
    expect(parseOffset('')).toBe(0);
  });

  it('coerces numeric strings and accepts integers in range', () => {
    expect(parseLimit('5', 10, 100)).toBe(5);
    expect(parseLimit(5, 10, 100)).toBe(5);
    expect(parseOffset('7')).toBe(7);
    expect(parseOffset(0)).toBe(0);
  });

  it('caps values above max', () => {
    expect(parseLimit(999, 10, 100)).toBe(100);
    expect(parseLimit('999', 50, 200)).toBe(200);
  });

  it('rejects negative, zero, NaN and fractional values', () => {
    expect(() => parseLimit(-1, 10, 100)).toThrow(ValidationError);
    expect(() => parseLimit(0, 10, 100)).toThrow(ValidationError);
    expect(() => parseLimit(Number.NaN, 10, 100)).toThrow(ValidationError);
    expect(() => parseLimit('abc', 10, 100)).toThrow(ValidationError);
    expect(() => parseLimit(1.5, 10, 100)).toThrow(ValidationError);
    expect(() => parseOffset(-1)).toThrow(ValidationError);
    expect(() => parseOffset(1.5)).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Embedding dimension validation
// ---------------------------------------------------------------------------

describe('embedding dimensions', () => {
  const originalDims = process.env.EMBEDDING_DIMENSIONS;
  const originalMockDims = process.env.MOCK_EMBEDDING_DIMENSIONS;
  const originalProject = process.env.MEMORY_PROJECT;

  afterEach(async () => {
    if (originalDims === undefined) delete process.env.EMBEDDING_DIMENSIONS;
    else process.env.EMBEDDING_DIMENSIONS = originalDims;
    if (originalMockDims === undefined) delete process.env.MOCK_EMBEDDING_DIMENSIONS;
    else process.env.MOCK_EMBEDDING_DIMENSIONS = originalMockDims;
    process.env.MEMORY_PROJECT = originalProject ?? PROJECT_A;
    await clear(PROJECT_DIMS);
  });

  it('defaults to 768 when EMBEDDING_DIMENSIONS is unset or blank', () => {
    delete process.env.EMBEDDING_DIMENSIONS;
    expect(getEmbeddingDimensions()).toBe(DEFAULT_EMBEDDING_DIMENSIONS);
    process.env.EMBEDDING_DIMENSIONS = '  ';
    expect(getEmbeddingDimensions()).toBe(DEFAULT_EMBEDDING_DIMENSIONS);
  });

  it('reads the configured width', () => {
    process.env.EMBEDDING_DIMENSIONS = '1024';
    expect(getEmbeddingDimensions()).toBe(1024);
    process.env.EMBEDDING_DIMENSIONS = '384';
    expect(getEmbeddingDimensions()).toBe(384);
  });

  it('rejects a non-integer or non-positive width', () => {
    for (const raw of ['lots', '0', '-8', '12.5']) {
      process.env.EMBEDDING_DIMENSIONS = raw;
      expect(() => getEmbeddingDimensions()).toThrow(
        'EMBEDDING_DIMENSIONS must be a positive integer',
      );
    }
  });

  it('rejects an embedding whose width disagrees with the configuration', () => {
    process.env.EMBEDDING_DIMENSIONS = '1024';
    expect(() => toEmbeddingVector(new Float32Array(768))).toThrow(
      'embedding has 768 dimensions but EMBEDDING_DIMENSIONS=1024',
    );
    process.env.EMBEDDING_DIMENSIONS = String(DEFAULT_EMBEDDING_DIMENSIONS);
    expect(() => toEmbeddingVector(new Float32Array(1024))).toThrow(
      `embedding has 1024 dimensions but EMBEDDING_DIMENSIONS=${DEFAULT_EMBEDDING_DIMENSIONS}`,
    );
  });

  it('rejects a non-finite component', () => {
    const dims = getEmbeddingDimensions();
    const bad = Array.from({ length: dims }, () => 1);
    bad[3] = Number.NaN;
    expect(() => toEmbeddingVector(bad)).toThrow('embedding contains a non-finite value');
  });

  it('accepts a Float32Array of the configured width', () => {
    for (const dims of [DEFAULT_EMBEDDING_DIMENSIONS, 1024, 384]) {
      process.env.EMBEDDING_DIMENSIONS = String(dims);
      expect(toEmbeddingVector(mockEmbedding()).length).toBe(dims);
    }
  });

  // The dedup threshold in manager-controller converts a legacy L2 cutoff into a
  // cosine one as l2²/2, which only holds for unit vectors. These pin the
  // invariant that conversion depends on.
  it('normalises an embedding to unit length', () => {
    const raw = Array.from({ length: DEFAULT_EMBEDDING_DIMENSIONS }, (_, i) => Math.sin(i) * 7);
    const unit = toEmbeddingVector(raw);
    const norm = Math.sqrt(unit.reduce((acc, v) => acc + v * v, 0));
    expect(norm).toBeCloseTo(1, 10);
    // Direction is preserved; only the magnitude changes.
    expect(unit[0]).toBeCloseTo((raw[0] ?? 0) / 7, 10);
  });

  it('stores the same vector whatever magnitude the model emits', () => {
    // Cosine search is scale-invariant, so a model returning 100x-magnitude
    // vectors must not change what is stored or how it ranks.
    const small = toEmbeddingVector(mockEmbedding());
    const large = toEmbeddingVector(Array.from(mockEmbedding(), (v) => v * 100));
    for (let i = 0; i < small.length; i++) {
      expect(large[i]).toBeCloseTo(small[i] ?? 0, 6);
    }
  });

  it('rejects a zero-magnitude embedding instead of storing an unusable direction', () => {
    expect(() => toEmbeddingVector(new Array(DEFAULT_EMBEDDING_DIMENSIONS).fill(0))).toThrow(
      'zero magnitude',
    );
  });

  it('stores and searches a 1024-dimensional project', async () => {
    process.env.EMBEDDING_DIMENSIONS = '1024';
    process.env.MEMORY_PROJECT = 'test-project-1024';

    const stored = await handleStoreMemory({
      content: 'high dimensional memory',
      metadata: { task: 'task-abc' },
    });
    const row = await scalar<{ dims: number }>(
      `select vector_dims(embedding) as dims from memories where id = '${stored.id}'`,
    );
    expect(row?.dims).toBe(1024);

    const results = await handleSearch({ query: 'high dimensional memory', limit: 5 });
    expect(results[0]?.id).toBe(stored.id);
    expect(results[0]?.distance ?? 1).toBeLessThan(0.0001);
    expect((await handleSearch({ query: 'q', limit: 5, task: 'task-abc' })).length).toBe(1);

    const updated = await handleUpdateMemory(stored.id, { content: 'still 1024 dimensions' });
    expect(updated.content).toBe('still 1024 dimensions');
    const afterUpdate = await scalar<{ dims: number }>(
      `select vector_dims(embedding) as dims from memories where id = '${stored.id}'`,
    );
    expect(afterUpdate?.dims).toBe(1024);

    await expect(assertStoredDimensions()).resolves.toBeUndefined();
    await handleDeleteMemory(stored.id);
    expect((await handleListMemories({})).total).toBe(0);
  });

  it('rejects a model that returns a different width than configured', async () => {
    process.env.EMBEDDING_DIMENSIONS = String(DEFAULT_EMBEDDING_DIMENSIONS);
    process.env.MOCK_EMBEDDING_DIMENSIONS = '1024';

    const before = await rowCount();
    await expect(handleStoreMemory({ content: 'mismatched model' })).rejects.toThrow(
      `embedding has 1024 dimensions but EMBEDDING_DIMENSIONS=${DEFAULT_EMBEDDING_DIMENSIONS}`,
    );
    expect(await rowCount()).toBe(before);
  });

  it('rejects a project whose stored vectors have a different width', async () => {
    process.env.EMBEDDING_DIMENSIONS = String(DEFAULT_EMBEDDING_DIMENSIONS);
    process.env.MEMORY_PROJECT = PROJECT_DIMS;
    await getDb()
      .insert(memories)
      .values({
        project: PROJECT_DIMS,
        id: randomUUID(),
        content: 'stale width',
        metadata: {},
        embedding: Array.from({ length: 1024 }, (_, i) => Math.sin(i)),
        dims: 1024,
      });

    await expect(assertStoredDimensions()).rejects.toThrow(
      'stored memories for project "test-project-dims" have 1024-dimensional vectors but EMBEDDING_DIMENSIONS=768',
    );

    process.env.EMBEDDING_DIMENSIONS = '1024';
    await expect(assertStoredDimensions()).resolves.toBeUndefined();
  });

  it('does not fail the dimension check on an empty project', async () => {
    process.env.MEMORY_PROJECT = 'test-project-empty';
    process.env.EMBEDDING_DIMENSIONS = '1024';
    await expect(assertStoredDimensions()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Get
// ---------------------------------------------------------------------------

describe('handleGetMemory', () => {
  beforeAll(async () => {
    await clear();
    await seed(3);
  });

  it('returns a memory by ID', async () => {
    const result = await handleStoreMemory({ content: 'get-test memory' });
    const mem = await handleGetMemory(result.id);
    expect(mem.id).toBe(result.id);
    expect(mem.content).toBe('get-test memory');
    expect(typeof mem.distance).toBe('number');
    expect(typeof mem.createdAt).toBe('string');
  });

  it('throws on not-found', async () => {
    await expect(handleGetMemory('nonexistent-id')).rejects.toThrow(
      'Memory not found: nonexistent-id',
    );
  });
});

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

describe('handleUpdateMemory', () => {
  beforeAll(async () => {
    await clear();
    await seed(3);
  });

  it('updates content and refreshes the embedding', async () => {
    const result = await handleStoreMemory({ content: 'original content' });
    const updated = await handleUpdateMemory(result.id, { content: 'updated content' });
    expect(updated.content).toBe('updated content');

    // The refreshed embedding is the one the new content hashes to, so the row
    // is an exact match for a query of that content. Had the update left the
    // old vector in place, this row would rank behind the seeds and its
    // distance for the old content would still be ~0.
    const results = await handleSearch({ query: 'updated content', limit: 1 });
    expect(results[0]?.id).toBe(result.id);
    expect(results[0]?.content).toBe('updated content');
    expect(results[0]?.distance ?? 1).toBeLessThan(0.0001);
    const stale = await handleSearch({ query: 'original content', limit: 200 });
    expect(stale.find((r) => r.id === result.id)?.distance ?? 0).toBeGreaterThan(0.5);
  });

  it('updates metadata without re-embedding', async () => {
    const result = await handleStoreMemory({
      content: 'metadata-only update test',
      metadata: { task: 'task-old' },
    });
    const before = await fetchRow(result.id);
    const updated = await handleUpdateMemory(result.id, {
      metadata: { task: 'task-new', version: 2 },
    });
    expect(updated.metadata).toEqual({ task: 'task-new', version: 2 });
    expect(updated.content).toBe('metadata-only update test');
    // The embedding was not regenerated, so the row is otherwise untouched.
    const after = await fetchRow(result.id);
    expect(after?.createdAt.getTime()).toBe(before?.createdAt.getTime());
  });

  it('updates both content and metadata in one call', async () => {
    const result = await handleStoreMemory({ content: 'old' });
    const updated = await handleUpdateMemory(result.id, {
      content: 'new content',
      metadata: { key: 'val' },
    });
    expect(updated.content).toBe('new content');
    expect(updated.metadata).toEqual({ key: 'val' });
    expect(updated.agentRun).toBeNull();

    const results = await handleSearch({ query: 'new content' });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('throws on not-found', async () => {
    await expect(handleUpdateMemory('nonexistent-id', { content: 'x' })).rejects.toThrow(
      'Memory not found: nonexistent-id',
    );
  });

  it('no-op when neither content nor metadata provided', async () => {
    const result = await handleStoreMemory({ content: 'unchanged' });
    const updated = await handleUpdateMemory(result.id, {});
    expect(updated.content).toBe('unchanged');
  });
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

describe('handleDeleteMemory', () => {
  beforeAll(async () => {
    await clear();
    await seed(3);
  });

  it('removes the memory and its embedding', async () => {
    const result = await handleStoreMemory({ content: 'to-delete' });
    expect(await fetchRow(result.id)).not.toBeNull();

    const deleted = await handleDeleteMemory(result.id);
    expect(deleted.deleted).toBe(true);

    expect(await fetchRow(result.id)).toBeNull();
  });

  it('removes memory from search results after delete', async () => {
    const result = await handleStoreMemory({ content: 'search-delete-test' });
    const beforeSearch = await handleSearch({ query: 'search-delete-test' });
    expect(beforeSearch.some((r) => r.id === result.id)).toBe(true);

    await handleDeleteMemory(result.id);

    const afterSearch = await handleSearch({ query: 'search-delete-test' });
    expect(afterSearch.some((r) => r.id === result.id)).toBe(false);
  });

  it('throws on not-found', async () => {
    await expect(handleDeleteMemory('nonexistent-id')).rejects.toThrow(
      'Memory not found: nonexistent-id',
    );
  });

  it('survives delete + re-store', async () => {
    const first = await handleStoreMemory({ content: 'first' });
    const s1 = await handleSearch({ query: 'first', limit: 200 });
    expect(s1.some((r) => r.id === first.id)).toBe(true);

    const all = await handleListMemories({ limit: 200 });
    for (const m of all.memories) {
      await handleDeleteMemory(m.id);
    }
    expect(await rowCount()).toBe(0);

    const second = await handleStoreMemory({ content: 'second' });
    expect(second.id).not.toBe(first.id);

    const s2 = await handleSearch({ query: 'second', limit: 10 });
    expect(s2[0]?.content).toBe('second');
    expect(s2.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Project isolation — one database can back several memory services, so a
// query must never cross the MEMORY_PROJECT boundary.
// ---------------------------------------------------------------------------

describe('project isolation', () => {
  beforeAll(async () => {
    await clear(PROJECT_A);
    await clear(PROJECT_B);
  });

  afterAll(async () => {
    await clear(PROJECT_A);
    await clear(PROJECT_B);
    process.env.MEMORY_PROJECT = PROJECT_A;
  });

  it('keeps memories of another project out of search, list, get, update and delete', async () => {
    process.env.MEMORY_PROJECT = PROJECT_A;
    const shared = randomUUID();
    await getDb()
      .insert(memories)
      .values({
        project: PROJECT_A,
        id: shared,
        content: 'project A secret',
        metadata: { task: 'task-abc' },
        embedding: FAKE_VECTOR,
        dims: FAKE_VECTOR.length,
      });

    // Same id, other project: the composite primary key allows it, so this also
    // proves the scope is a real column and not an accidental key collision.
    process.env.MEMORY_PROJECT = PROJECT_B;
    await getDb()
      .insert(memories)
      .values({
        project: PROJECT_B,
        id: shared,
        content: 'project B secret',
        metadata: { task: 'task-abc' },
        embedding: FAKE_VECTOR,
        dims: FAKE_VECTOR.length,
      });

    const searchB = await handleSearch({ query: 'secret', limit: 10 });
    expect(searchB.map((r) => r.content)).toEqual(['project B secret']);

    const listB = await handleListMemories({});
    expect(listB.total).toBe(1);
    expect(listB.memories.map((m) => m.content)).toEqual(['project B secret']);

    const gotB = await handleGetMemory(shared);
    expect(gotB.content).toBe('project B secret');

    const updatedB = await handleUpdateMemory(shared, { content: 'project B edited' });
    expect(updatedB.content).toBe('project B edited');

    process.env.MEMORY_PROJECT = PROJECT_A;
    const gotA = await handleGetMemory(shared);
    expect(gotA.content).toBe('project A secret');
    expect((await handleListMemories({})).total).toBe(1);

    await handleUpdateMemory(shared, { content: 'project A edited' });

    // Deleting from B must not touch A.
    process.env.MEMORY_PROJECT = PROJECT_B;
    await handleDeleteMemory(shared);
    expect(await rowCount(PROJECT_B)).toBe(0);
    expect(await rowCount(PROJECT_A)).toBe(1);

    process.env.MEMORY_PROJECT = PROJECT_A;
    expect((await handleGetMemory(shared)).content).toBe('project A edited');

    // The task filter cannot be used to reach across either.
    process.env.MEMORY_PROJECT = PROJECT_B;
    expect(await handleSearch({ query: 'secret', task: 'task-abc' })).toEqual([]);
  });

  it('reports a memory from another project as not found', async () => {
    process.env.MEMORY_PROJECT = PROJECT_A;
    const stored = await handleStoreMemory({ content: 'only in A' });

    process.env.MEMORY_PROJECT = PROJECT_B;
    await expect(handleGetMemory(stored.id)).rejects.toThrow(`Memory not found: ${stored.id}`);
    await expect(handleUpdateMemory(stored.id, { content: 'x' })).rejects.toThrow(
      `Memory not found: ${stored.id}`,
    );
    await expect(handleDeleteMemory(stored.id)).rejects.toThrow(`Memory not found: ${stored.id}`);

    process.env.MEMORY_PROJECT = PROJECT_A;
    expect((await handleGetMemory(stored.id)).content).toBe('only in A');
  });

  it('defaults the project scope to "default"', () => {
    delete process.env.MEMORY_PROJECT;
    expect(getProject()).toBe('default');
    process.env.MEMORY_PROJECT = PROJECT_A;
  });
});

// ---------------------------------------------------------------------------
// Transaction safety — drizzle rolls back a failed transaction and leaves the
// connection usable, which is what the old hand-rolled BEGIN/COMMIT path
// failed to guarantee (a failure mid-write wedged every later write until the
// pod restarted).
// ---------------------------------------------------------------------------

describe('inTransaction', () => {
  beforeAll(async () => clear());

  it('commits the work when the callback succeeds', async () => {
    const stored = await handleStoreMemory({ content: 'commit me' });
    await inTransaction(async (tx) => {
      await tx.update(memories).set({ content: 'committed' }).where(eq(memories.id, stored.id));
    });
    expect((await fetchRow(stored.id))?.content).toBe('committed');
  });

  it('rolls back on failure and leaves the connection usable', async () => {
    const stored = await handleStoreMemory({ content: 'original' });

    await expect(
      inTransaction(async (tx) => {
        await tx
          .update(memories)
          .set({ content: 'half-written' })
          .where(eq(memories.id, stored.id));
        throw new Error('embedding failed');
      }),
    ).rejects.toThrow('embedding failed');

    // The partial write must be undone...
    expect((await fetchRow(stored.id))?.content).toBe('original');

    // ...and, critically, the connection must not be stuck mid-transaction:
    // this is the assertion that fails if ROLLBACK is missing.
    await inTransaction(async (tx) => {
      await tx.select({ one: sql<number>`1` });
    });

    // A normal write still works afterwards.
    const before = await rowCount();
    const after = await handleStoreMemory({ content: 'after rollback' });
    expect(after.id).toBeTruthy();
    expect(await rowCount()).toBe(before + 1);
  });

  it('rolls back an insert when a later statement in the same transaction fails', async () => {
    await clear();
    const id = randomUUID();
    await expect(
      inTransaction(async (tx) => {
        await tx.insert(memories).values({
          project: getProject(),
          id,
          content: 'never committed',
          metadata: {},
          embedding: FAKE_VECTOR,
          dims: FAKE_VECTOR.length,
        });
        await tx.insert(memories).values({
          project: getProject(),
          id: `${id}-duplicate`,
          content: 'boom',
          metadata: {},
          embedding: new Array(getEmbeddingDimensions()).fill(0),
          dims: getEmbeddingDimensions(),
        });
        // Violates the primary key: forces the rollback path.
        await tx.insert(memories).values({
          project: getProject(),
          id,
          content: 'duplicate id',
          metadata: {},
          embedding: FAKE_VECTOR,
          dims: FAKE_VECTOR.length,
        });
      }),
    ).rejects.toThrow();
    expect(await rowCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Health when the database is unreachable — /health must report a real
// failure, not just "process started". Runs last because it closes the client.
// ---------------------------------------------------------------------------

describe('handleHealth — database down', () => {
  const originalFetch = globalThis.fetch;

  it('returns not-ok when the database query fails', async () => {
    stubFetch(
      async () =>
        new Response(JSON.stringify({ models: [{ name: 'nomic-embed-text' }] }), { status: 200 }),
    );
    await closeDb();
    expect(await handleHealth()).toEqual({ ok: false });
    globalThis.fetch = originalFetch;
  });
});
