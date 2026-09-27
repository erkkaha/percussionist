// Standalone migration runner — used by `pnpm db:migrate`.
// Applies all pending migrations from migrations-pg/ to the target DB.

import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required — it names the PostgreSQL database to migrate');
}

function resolveMigrationsFolder(): string {
  const candidates: string[] = [];
  const override = process.env.WEB_MIGRATIONS_DIR;
  if (override) {
    candidates.push(isAbsolute(override) ? override : resolve(process.cwd(), override));
  }
  const here = dirname(fileURLToPath(import.meta.url));
  candidates.push(join(here, '..', '..', 'migrations-pg'));
  candidates.push(join(process.cwd(), 'migrations-pg'));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`migrations-pg directory not found (looked in ${candidates.join(', ')})`);
}

const migrationsFolder = resolveMigrationsFolder();
const migrationClient = new Client({ connectionString });
const migrationsTable = 'drizzle_web_migrations';

try {
  await migrationClient.connect();
  await migrationClient.query('select pg_advisory_lock(hashtext($1))', [
    'percussionist:web:migrations',
  ]);
  try {
    console.log(`[migrate] applying migrations from ${migrationsFolder}`);
    await migrate(drizzle(migrationClient), { migrationsFolder, migrationsTable });
    console.log('[migrate] done');
  } finally {
    await migrationClient.query('select pg_advisory_unlock(hashtext($1))', [
      'percussionist:web:migrations',
    ]);
  }
} finally {
  await migrationClient.end().catch(() => undefined);
}
