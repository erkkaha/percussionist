// Stats database — Drizzle ORM over PostgreSQL.
//
// Production: a `pg.Pool` via drizzle-orm/node-postgres, selected by
// DATABASE_URL. Tests: an injected PGlite client via drizzle-orm/pglite, so
// the same Drizzle query builder and the same SQL run in both places.
//
// Everything that touches the driver is async: no synchronous singleton, and
// no `.all`/`.get`/`.run`. `initDb()` must be awaited before the first query;
// `getDb()` stays synchronous for the existing callers and throws if startup
// skipped it, which is a louder failure than a per-request reconnect storm.
//
// Shutdown is owned by the server entry point (index.ts), which stops the
// metrics collector and timers, drains `closeDb()`, and handles both SIGTERM
// and SIGINT — this module must not install its own signal handlers, or a
// SIGTERM would exit without draining the pool.
//
// Schema is defined in schema.ts (driver-free, importable by drizzle-kit).
// Migrations live in ../../migrations-pg/ (relative to this file's compiled
// location at dist/server/). On startup, initDb() applies any pending
// migration files before the first query runs.
//
// To add or change columns: edit schema.ts, run `pnpm db:generate`, commit
// the new migration file. See drizzle.config.ts for full workflow notes.

import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle as drizzleNodePostgres } from 'drizzle-orm/node-postgres';
import { migrate as migrateNodePostgres } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { Client, Pool } from 'pg';
import * as schema from './schema.js';

export * from './schema.js';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

// ---------------------------------------------------------------------------
// Client singleton

let _db: Db | null = null;
let _close: (() => Promise<void>) | null = null;
let _init: Promise<Db> | null = null;
const MIGRATIONS_TABLE = 'drizzle_web_migrations';

function resolveMigrationsFolder(): string {
  const candidates: string[] = [];
  const override = process.env.WEB_MIGRATIONS_DIR;
  if (override) {
    candidates.push(isAbsolute(override) ? override : resolve(process.cwd(), override));
  }
  const here = dirname(fileURLToPath(import.meta.url));
  // src/ when running from source, dist/ in the built image — two levels below
  // the package root either way.
  candidates.push(join(here, '..', '..', 'migrations-pg'));
  candidates.push(join(process.cwd(), 'migrations-pg'));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `migrations-pg directory not found (looked in ${candidates.join(', ')}). The web server ` +
      'applies schema migrations on startup, so migrations-pg must be shipped alongside dist/ — ' +
      'or point WEB_MIGRATIONS_DIR at it.',
  );
}

export function initDb(): Promise<Db> {
  _init ??= open().catch((e: unknown) => {
    _init = null;
    throw e;
  });
  return _init;
}

async function open(): Promise<Db> {
  const migrationsFolder = resolveMigrationsFolder();
  if (!process.env.DATABASE_URL) {
    if (process.env.PERCUSSIONIST_ALLOW_PGLITE !== '1' && process.env.NODE_ENV !== 'test') {
      throw new Error('DATABASE_URL is required — set it to a PostgreSQL connection string');
    }
    return openPglite(migrationsFolder);
  }
  return openNodePostgres(migrationsFolder);
}

async function openNodePostgres(migrationsFolder: string): Promise<Db> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const migrationClient = new Client({ connectionString });
  await migrationClient.connect();
  await migrationClient.query('select pg_advisory_lock(hashtext($1))', [
    'percussionist:web:migrations',
  ]);
  try {
    await migrateNodePostgres(drizzleNodePostgres(migrationClient, { schema }), {
      migrationsFolder,
      migrationsTable: MIGRATIONS_TABLE,
    });
  } finally {
    await migrationClient.query('select pg_advisory_unlock(hashtext($1))', [
      'percussionist:web:migrations',
    ]);
    await migrationClient.end();
  }

  const pool = new Pool({
    connectionString,
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
  });
  const db = drizzleNodePostgres(pool, { schema });
  _db = db as unknown as Db;
  _close = () => pool.end();
  console.log('[db] postgres connected');
  return _db;
}

async function openPglite(migrationsFolder: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const client = new PGlite();
  const db = drizzlePglite(client, { schema });
  await migratePglite(db, { migrationsFolder, migrationsTable: MIGRATIONS_TABLE });
  _db = db as unknown as Db;
  _close = () => client.close();
  console.log('[db] pglite initialised');
  return _db;
}

export function setDbForTesting(db: Db, close: () => Promise<void>): void {
  _db = db;
  _close = close;
  _init = null;
}

export function getDb(): Db {
  if (!_db) {
    throw new Error('database not initialised — await initDb() before issuing queries');
  }
  return _db;
}

export async function closeDb(): Promise<void> {
  const close = _close;
  _close = null;
  _db = null;
  _init = null;
  if (close) await close();
}
