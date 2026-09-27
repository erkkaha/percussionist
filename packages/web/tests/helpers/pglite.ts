// tests/helpers/pglite.ts — a fresh in-memory PGlite database per test.
//
// The production DB is PostgreSQL: `src/server/db.ts` builds a Drizzle
// `PgDatabase` over either a node-postgres pool (DATABASE_URL) or PGlite, and
// schema.ts is pg-core. Tests therefore run against PGlite too, so the same
// Drizzle query builder and the same SQL execute in both places — a driver-specific
// test would pass while production, on Postgres, broke.
//
// Everything here is async because the driver is: there is no `.all()` /
// `.get()` / `.run()` and no `lastInsertRowid`. Postgres has no such thing —
// inserts that need the generated key must ask for it with `.returning()`, and
// aggregate results must be coerced if PGlite hands back a shape the assertion
// did not expect.
//
// Typical use:
//
//   beforeEach(async () => { db = await createTestDb(); });
//   afterEach(async () => { await closeTestDb(); });
//
// or for a whole file:
//
//   beforeAll(async () => { db = await createTestDb(); });
//   afterAll(async () => { await closeTestDb(); });

import { setDefaultTimeout } from 'bun:test';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import type { Db } from '../../src/server/db.js';
import { closeDb, setDbForTesting } from '../../src/server/db.js';
import * as schema from '../../src/server/schema.js';

// Booting the PGlite WASM module costs ~1.5 s per database and ~5 s for the very
// first one in a process (WASM instantiation). Bun's 5 s default therefore
// expires on whichever hook or test first calls createTestDb(), so raise the
// default for any file that imports this helper.
setDefaultTimeout(30_000);

/**
 * Absolute path to the committed migrations-pg folder.
 *
 * The migrator reads `meta/_journal.json` plus the SQL files off disk with
 * node:fs, which works under `bun test` because it runs from the package root.
 * WEB_MIGRATIONS_DIR wins when set, matching src/server/db.ts.
 */
export const MIGRATIONS_DIR = (() => {
  const override = process.env.WEB_MIGRATIONS_DIR;
  if (override) return resolve(process.cwd(), override);
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations-pg');
})();

/**
 * Create a fresh in-memory PGlite, apply the committed migrations to it, and
 * install it as the database every `getDb()` caller sees.
 *
 * Returns the Drizzle instance. Safe to call repeatedly: a previously installed
 * database is closed first, so a stale client never leaks a WASM heap.
 */
export async function createTestDb(): Promise<Db> {
  await closeTestDb();
  const fresh = new PGlite();
  const created = drizzlePglite(fresh, { schema }) as unknown as Db;
  try {
    await migratePglite(created, {
      migrationsFolder: MIGRATIONS_DIR,
      migrationsTable: 'drizzle_web_migrations',
    });
  } catch (e) {
    // A client that never reaches setDbForTesting has no other owner to close
    // it, so unwind it here rather than leaking a WASM heap per failed setup.
    try {
      await fresh.close();
    } catch {
      // Already torn down; the migration error below is the one worth reporting.
    }
    throw e;
  }
  setDbForTesting(created, async () => {
    await fresh.close();
  });
  return created;
}

/**
 * Close the installed PGlite and clear the production module's singleton.
 *
 * Delegates to `closeDb()` so the injected client goes through the same
 * teardown path as a real pool — the close callback registered by
 * createTestDb() is what actually closes the PGlite, so there is nothing to
 * track here.
 *
 * Call from afterEach/afterAll: an un-closed PGlite keeps a WASM instance and its
 * timers alive, which leaks memory across the suite under `bun test --isolate`.
 * Idempotent, and never throws — a client that already died on its own is fine.
 */
export async function closeTestDb(): Promise<void> {
  try {
    await closeDb();
  } catch {
    // Already closed, or the WASM module was torn down with the process.
  }
}
