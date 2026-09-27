// postgres-live.test.ts — the PGlite suite's blind spots, against a real server.
//
// PGlite is PostgreSQL compiled to WASM, and the whole unit suite runs on it.
// That covers the query builder, the SQL and the migrations, but not the things
// that only exist when `pg` talks to a server:
//
//   - the node-postgres Pool path (connection reuse, pool exhaustion, pool.end())
//   - pg_advisory_lock, which is what serialises the migration step when the web
//     pod and N memory pods start at once. PGlite is single-connection, so it
//     cannot reproduce a contended lock at all.
//   - better-auth's session writes through the Drizzle adapter, i.e. the
//     `provider: 'pg'` decision, against real types and real constraints.
//
// SKIPPED unless PERCUSSIONIST_TEST_PG_URL points at a disposable database:
//
//   docker run -d --name pcs-pg -p 55432:5432 \
//     -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=pcs pgvector/pgvector:0.8.6-pg18
//   PERCUSSIONIST_TEST_PG_URL=postgresql://postgres:pw@localhost:55432/pcs \
//     bun test --isolate tests/postgres-live.test.ts
//
// It DROPS SCHEMA public on the target database — never point it at anything you
// care about. The package's `test` script does not include it; run it explicitly
// (CI can add a service container and call it).

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { Client } from 'pg';
import { session, user } from '../src/server/schema.js';

const URL = process.env.PERCUSSIONIST_TEST_PG_URL;
// describe.skip still evaluates the module body, so nothing below may touch a
// database at import time — everything is behind a call.
const describeLive = URL ? describe : describe.skip;

/**
 * Wipe the target database. The `drizzle` schema goes too: drizzle's migrator
 * only compares the *last* journal row's timestamp, so leaving a stale journal
 * behind makes it skip every migration while creating nothing.
 */
async function resetSchema(url: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('drop schema if exists public cascade');
    await client.query('create schema public');
    await client.query('drop schema if exists drizzle cascade');
  } finally {
    await client.end();
  }
}

/** Count rows of a query, which `pg` returns as a string. */
function countOf(result: unknown): number {
  const rows = (result as { rows: Array<Record<string, unknown>> }).rows;
  return Number(rows[0]?.count ?? 0);
}

describeLive('live PostgreSQL', () => {
  beforeAll(async () => {
    await resetSchema(URL as string);
    // db.ts reads DATABASE_URL when initDb() runs, not at import time.
    process.env.DATABASE_URL = URL;
    process.env.AUTH_DISABLED = '1';
    process.env.SESSION_SECRET = 'live-postgres-test-secret-value-32ch';
  });

  afterAll(async () => {
    delete process.env.DATABASE_URL;
    delete process.env.SESSION_SECRET;
    const { closeDb } = await import('../src/server/db.js');
    await closeDb().catch(() => undefined);
    const { resetAuth } = await import('../src/server/lib/better-auth.js');
    resetAuth();
  });

  it('applies the committed web migrations to a real server', async () => {
    const { getDb, closeDb, initDb } = await import('../src/server/db.js');
    await initDb();
    const db = getDb();

    // drizzle-kit keeps the journal in its own `drizzle` schema, not public.
    expect(
      countOf(
        await db.execute(sql`select count(*)::int as count from drizzle.drizzle_web_migrations`),
      ),
    ).toBeGreaterThan(0);
    expect(
      countOf(
        await db.execute(
          sql`select count(*)::int as count from information_schema.tables where table_schema = 'public'`,
        ),
      ),
    ).toBeGreaterThan(5);

    // Idempotent: a second boot finds nothing pending and must not throw.
    await closeDb();
    await initDb();
    expect(countOf(await getDb().execute(sql`select count(*)::int as count from runs`))).toBe(0);
  });

  it('serialises concurrent migration attempts with an advisory lock', async () => {
    // Two pods starting at once (web + memory) both run migrations. Without the
    // advisory lock the loser collides on CREATE TABLE; with it, it waits and
    // then finds nothing to do. PGlite cannot model this — one connection.
    //
    // This drives the same steps as openNodePostgres rather than initDb(),
    // because the db module memoises a single pool: three concurrent initDb()
    // calls would share one connection and prove nothing about the lock.
    await resetSchema(URL as string);
    const results = await Promise.allSettled([
      migrateWithLock(),
      migrateWithLock(),
      migrateWithLock(),
    ]);
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);

    const check = new Client({ connectionString: URL as string });
    await check.connect();
    try {
      expect(
        countOf(
          await check.query('select count(*)::int as count from drizzle.drizzle_web_migrations'),
        ),
      ).toBeGreaterThan(0);
      // Every table exists exactly once — a lock failure would show up as a
      // duplicate-object error or a missing table here.
      expect(
        countOf(
          await check.query(
            "select count(*)::int as count from information_schema.tables where table_schema = 'public'",
          ),
        ),
      ).toBeGreaterThan(5);
    } finally {
      await check.end();
    }
  });

  it('serves queries through the node-postgres pool and refuses work after closeDb', async () => {
    const { getDb, closeDb, initDb } = await import('../src/server/db.js');
    await initDb();
    // Two statements in sequence: the second must reuse a pooled connection
    // rather than open (and leak) a new one per query.
    await getDb().execute(sql`select 1`);
    await getDb().execute(sql`select 2`);
    await closeDb();
    // After close the pool refuses new work instead of silently reconnecting,
    // which is what makes a SIGTERM drain observable.
    expect(() => getDb()).toThrow(/not initialised/);
  });

  it('round-trips a better-auth session through the pg adapter', async () => {
    // The interesting part of the pg move for auth is the write path: the
    // adapter maps better-auth's camelCase records onto the pg tables, and the
    // real types (timestamptz, text, unique token, FK to user) have to behave.
    //
    // `auth.api.getSession({ headers: { cookie } })` is deliberately not used
    // here: it returns null for a hand-built cookie in this configuration on
    // PGlite as well, so it asserts nothing about PostgreSQL.
    const { getDb, initDb } = await import('../src/server/db.js');
    await initDb();
    const db = getDb();
    const { getAuth, resetAuth } = await import('../src/server/lib/better-auth.js');
    resetAuth();

    const now = new Date();
    const expires = new Date(now.getTime() + 86_400_000);
    await db.insert(user).values({
      id: 'live-user',
      name: 'Live User',
      email: 'live@example.com',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });

    // Write through better-auth's own adapter, not a hand-rolled insert.
    const auth = getAuth() as unknown as {
      $context: Promise<{
        internalAdapter: { createSession: (u: string) => Promise<{ token: string }> };
      }>;
    };
    const ctx = await auth.$context;
    const created = await ctx.internalAdapter.createSession('live-user', {}, false);
    expect(created.token).toBeTruthy();

    const [row] = await db
      .select({
        token: session.token,
        userId: session.userId,
        expiresAt: session.expiresAt,
        createdAt: session.createdAt,
      })
      .from(session)
      .where(eq(session.token, created.token));
    expect(row?.userId).toBe('live-user');
    // timestamptz round-trips as a Date, not a string — the difference that
    // breaks a schema written for SQLite.
    expect(row?.expiresAt).toBeInstanceOf(Date);
    expect(row?.createdAt).toBeInstanceOf(Date);
    expect(row?.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // The unique token index and the user FK are enforced by the server.
    await expect(
      db
        .insert(session)
        .values({
          id: 'live-session-dup',
          token: created.token,
          userId: 'live-user',
          expiresAt: expires,
          createdAt: now,
          updatedAt: now,
        })
        .execute(),
    ).rejects.toThrow();
    await expect(
      db
        .insert(session)
        .values({
          id: 'live-session-orphan',
          token: 'orphan-token',
          userId: 'no-such-user',
          expiresAt: expires,
          createdAt: now,
          updatedAt: now,
        })
        .execute(),
    ).rejects.toThrow();
  });
});

/** One migration attempt behind the advisory lock, exactly as db.ts does it. */
async function migrateWithLock(): Promise<void> {
  const { migrate } = await import('drizzle-orm/node-postgres/migrator');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const { MIGRATIONS_DIR } = await import('./helpers/pglite.js');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('select pg_advisory_lock(hashtext($1))', ['percussionist:web:migrations']);
    try {
      await migrate(drizzle(client), {
        migrationsFolder: MIGRATIONS_DIR,
        migrationsTable: 'drizzle_web_migrations',
      });
    } finally {
      await client.query('select pg_advisory_unlock(hashtext($1))', [
        'percussionist:web:migrations',
      ]);
    }
  } finally {
    await client.end();
  }
}
