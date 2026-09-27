// db.ts — PostgreSQL access for the memory service.
//
// Production: pg.Pool via drizzle-orm/node-postgres, selected by DATABASE_URL.
// Tests/dev: PGlite with pgvector compiled in, via drizzle-orm/pglite.
// Migrations: ./migrations, applied by the drizzle migrator on startup.

import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, ne, sql } from 'drizzle-orm';
import { drizzle as drizzleNodePostgres } from 'drizzle-orm/node-postgres';
import { migrate as migrateNodePostgres } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { Client, Pool } from 'pg';
import { DEFAULT_EMBEDDING_DIMENSIONS, memories, schema } from './schema.js';

export type MemoryDb = PgDatabase<PgQueryResultHKT, typeof schema>;
export type MemoryTx = Parameters<Parameters<MemoryDb['transaction']>[0]>[0];

export const DEFAULT_PROJECT = 'default';

let _db: MemoryDb | null = null;
let _close: (() => Promise<void>) | null = null;
let _init: Promise<MemoryDb> | null = null;
const MIGRATIONS_TABLE = 'drizzle_memory_migrations';

export function getProject(): string {
  return process.env.MEMORY_PROJECT ?? DEFAULT_PROJECT;
}

export function getEmbeddingDimensions(): number {
  const raw = process.env.EMBEDDING_DIMENSIONS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_EMBEDDING_DIMENSIONS;
  const dims = Number(raw);
  if (!Number.isInteger(dims) || dims < 1) {
    throw new Error(`EMBEDDING_DIMENSIONS must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return dims;
}

/**
 * Validate an embedding from the model and normalise it to unit length.
 *
 * The width check matters because the `vector` column is unbounded, so nothing
 * at the database level stops a model switch from writing a different width.
 *
 * The normalisation is what makes the *distance* interpretable. pgvector's
 * cosine distance (`<=>`, used by handleSearch) is scale-invariant, so dividing
 * by the norm changes no search result and no ranking — but it pins the stored
 * representation to a known magnitude, which is what lets callers calibrate
 * against another metric. Specifically, for unit vectors `l2 = sqrt(2·(1-cos))`,
 * so an L2 cutoff converts to a cosine cutoff as `l2² / 2`. The findings
 * dedup threshold in manager-controller's findings-ingestion.ts is calibrated
 * that way, from the old sqlite-vec backend; without this normalisation that
 * conversion would silently depend on whatever magnitude the embedding model
 * happens to emit.
 */
export function toEmbeddingVector(values: ArrayLike<number>): number[] {
  const expected = getEmbeddingDimensions();
  const vector = Array.from(values);
  if (vector.length !== expected) {
    throw new Error(
      `embedding has ${vector.length} dimensions but EMBEDDING_DIMENSIONS=${expected}; ` +
        'the embedding model and the project embedding config must agree',
    );
  }
  let sumSquares = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new Error('embedding contains a non-finite value');
    }
    sumSquares += value * value;
  }
  const norm = Math.sqrt(sumSquares);
  if (norm === 0) {
    // A zero vector has no direction, so cosine distance to it is undefined
    // (pgvector returns NaN) and it would poison every search that hits it.
    throw new Error('embedding has zero magnitude and cannot be normalised');
  }
  return vector.map((value) => value / norm);
}

/**
 * Refuse to serve a project whose stored vectors have a different width than
 * the configured one. The column is unbounded, so nothing at the database level
 * would stop a model switch from writing 1024-dim vectors into a project that
 * still has 768-dim rows — every later search would then fail inside pgvector.
 *
 * Backed by the `dims` column (kept honest by a CHECK constraint against
 * `vector_dims(embedding)`) plus the `(project, dims)` index, so this is a
 * btree probe rather than a scan of the project's history.
 */
export async function assertStoredDimensions(): Promise<void> {
  const expected = getEmbeddingDimensions();
  const rows = await getDb()
    .select({ dims: memories.dims })
    .from(memories)
    .where(and(eq(memories.project, getProject()), ne(memories.dims, expected)))
    .limit(1);
  const mismatch = rows[0];
  if (mismatch) {
    throw new Error(
      `stored memories for project "${getProject()}" have ${mismatch.dims}-dimensional vectors but ` +
        `EMBEDDING_DIMENSIONS=${expected}; re-embed the existing memories or point the ` +
        'project back at its original embedding model',
    );
  }
}

/**
 * Build the ANN index for this project's embedding width.
 *
 * pgvector can only index a `vector(n)` column, and the column here is
 * unbounded so that `spec.embedding.dimensions` stays a setting rather than a
 * migration. The way out is an index on the cast expression, partial to the
 * rows of one width: rows of a different width are excluded by the predicate
 * and never evaluated, so projects sharing the table with different dimensions
 * coexist safely.
 *
 * The index name carries the width, so a project that changes EMBEDDING_DIMENSIONS
 * gets a second index instead of reusing one built for the old width. Queries
 * must repeat the same expression and the same `dims = <n>` filter for the
 * planner to use it — see handleSearch in routes.ts.
 *
 * Best-effort by design: a failure here degrades search to a sequential scan,
 * which is slow rather than wrong, so it is logged and startup continues.
 */
export async function ensureVectorIndex(): Promise<void> {
  const dims = getEmbeddingDimensions();
  const name = `idx_memories_embedding_hnsw_${dims}`;
  try {
    // Both the width and the predicate are inlined: a type modifier must be a
    // constant, and DDL is not an optimizable statement, so it cannot carry
    // bind parameters. getEmbeddingDimensions() has already rejected anything
    // that is not a positive integer, so the interpolation is safe.
    await getDb().execute(
      sql`CREATE INDEX IF NOT EXISTS ${sql.identifier(name)} ON ${memories}
          USING hnsw ((${memories.embedding}::vector(${sql.raw(String(dims))})) vector_cosine_ops)
          WHERE ${memories.dims} = ${sql.raw(String(dims))}`,
    );
  } catch (e) {
    console.warn(
      `[db] could not build ${name} (${e instanceof Error ? e.message : String(e)}); ` +
        'vector search will fall back to a sequential scan',
    );
  }
}

function resolveMigrationsFolder(): string {
  const candidates: string[] = [];
  const override = process.env.MEMORY_MIGRATIONS_DIR;
  if (override) candidates.push(isAbsolute(override) ? override : resolve(process.cwd(), override));
  const here = dirname(fileURLToPath(import.meta.url));
  candidates.push(join(here, '..', 'migrations'));
  candidates.push(join(process.cwd(), 'migrations'));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `migrations directory not found (looked in ${candidates.join(', ')}). ` +
      'The memory service applies schema migrations on startup, so ./migrations must be ' +
      'shipped alongside dist/ — or point MEMORY_MIGRATIONS_DIR at it.',
  );
}

export function initDb(): Promise<MemoryDb> {
  _init ??= open().catch((e: unknown) => {
    _init = null;
    throw e;
  });
  return _init;
}

async function open(): Promise<MemoryDb> {
  getEmbeddingDimensions();
  const migrationsFolder = resolveMigrationsFolder();
  if (!process.env.DATABASE_URL) {
    if (process.env.PERCUSSIONIST_ALLOW_PGLITE !== '1' && process.env.NODE_ENV !== 'test') {
      throw new Error('DATABASE_URL is required — set it to a PostgreSQL connection string');
    }
    const db = await openPglite(migrationsFolder);
    await afterOpen();
    return db;
  }
  const db = await openNodePostgres(migrationsFolder);
  await afterOpen();
  return db;
}

async function afterOpen(): Promise<void> {
  await assertStoredDimensions();
  await ensureVectorIndex();
}

/**
 * Turn the two migration failures an operator can actually fix into an
 * actionable message. Everything else is rethrown untouched.
 *
 * The pgvector extension is created by the baseline migration, which needs a
 * role with CREATE privilege in the target database. The bundled StatefulSet
 * runs as the POSTGRES_USER superuser, so this only bites when DATABASE_URL
 * points at a managed database whose admin has not installed pgvector yet.
 */
function explainMigrationFailure(e: unknown): unknown {
  const message = e instanceof Error ? e.message : String(e);
  if (/must be owner of extension|permission denied to create extension/i.test(message)) {
    return new Error(
      `${message}\n\nThe memory schema needs the pgvector extension and this database role may ` +
        'not install it. Either run `CREATE EXTENSION vector;` once as an administrator (the ' +
        'migration then becomes a no-op), or point DATABASE_URL at a role that can — the bundled ' +
        'percussionist-postgres StatefulSet already can.',
    );
  }
  if (/advisory lock|deadlock|timeout.*migrat/i.test(message)) {
    return new Error(
      `${message}\n\nAnother migration holds the percussionist:memory:migrations advisory lock. ` +
        'Wait for it to finish (or check for a stuck memory pod) and retry.',
    );
  }
  return e;
}

async function openNodePostgres(migrationsFolder: string): Promise<MemoryDb> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const migrationClient = new Client({ connectionString });
  await migrationClient.connect();
  await migrationClient.query('select pg_advisory_lock(hashtext($1))', [
    'percussionist:memory:migrations',
  ]);
  try {
    await migrateNodePostgres(drizzleNodePostgres(migrationClient, { schema }), {
      migrationsFolder,
      migrationsTable: MIGRATIONS_TABLE,
    });
  } catch (e) {
    throw explainMigrationFailure(e);
  } finally {
    await migrationClient.query('select pg_advisory_unlock(hashtext($1))', [
      'percussionist:memory:migrations',
    ]);
    await migrationClient.end();
  }

  const pool = new Pool({
    connectionString,
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
  });
  const db = drizzleNodePostgres(pool, { schema });
  _db = db as unknown as MemoryDb;
  _close = () => pool.end();
  console.log(`[db] postgres connected (project "${getProject()}")`);
  return _db;
}

async function openPglite(migrationsFolder: string): Promise<MemoryDb> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { vector: vectorExtension } = await import('@electric-sql/pglite-pgvector');
  const client = new PGlite({ extensions: { vector: vectorExtension } });
  await client.exec('CREATE EXTENSION IF NOT EXISTS vector');
  const db = drizzlePglite(client, { schema });
  await migratePglite(db, { migrationsFolder, migrationsTable: MIGRATIONS_TABLE });
  _db = db as unknown as MemoryDb;
  _close = () => client.close();
  console.log(`[db] pglite initialised (project "${getProject()}")`);
  return _db;
}

export async function createPgliteDb(client: {
  exec: (query: string) => Promise<unknown>;
  close: () => Promise<void>;
}): Promise<MemoryDb> {
  await client.exec('CREATE EXTENSION IF NOT EXISTS vector');
  const db = drizzlePglite(client as never, { schema });
  await migratePglite(db, {
    migrationsFolder: resolveMigrationsFolder(),
    migrationsTable: MIGRATIONS_TABLE,
  });
  _db = db as unknown as MemoryDb;
  _close = () => client.close();
  await afterOpen();
  return _db;
}

export function getDb(): MemoryDb {
  if (!_db) {
    throw new Error('database not initialised — await initDb() before issuing queries');
  }
  return _db;
}

export function inTransaction<T>(fn: (tx: MemoryTx) => Promise<T>): Promise<T> {
  return getDb().transaction(async (tx) => fn(tx as unknown as MemoryTx));
}

export async function pingDatabase(): Promise<void> {
  await getDb().execute(sql`select 1`);
}

export async function closeDb(): Promise<void> {
  const close = _close;
  _close = null;
  _db = null;
  _init = null;
  if (close) await close();
}
