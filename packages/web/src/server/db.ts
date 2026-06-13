// Stats database — Drizzle ORM over bun:sqlite.
//
// The DB file lives at DATA_DIR/percussionist.db (default: /app/data/percussionist.db when
// running in the web pod, ./data/percussionist.db in dev). The directory is created
// on startup if it doesn't exist.
//
// Schema is defined in schema.ts (driver-free, importable by drizzle-kit).
// Migrations live in ../../migrations/ (relative to this file's compiled
// location at dist/server/). On startup, migrate() applies any pending
// migration files before the first query runs.
//
// To add or change columns: edit schema.ts, run `pnpm db:generate`, commit
// the new migration file. See drizzle.config.ts for full workflow notes.

import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import * as schema from './schema.js';

export * from './schema.js';

// ---------------------------------------------------------------------------
// Client singleton

let _db: ReturnType<typeof drizzle> | null = null;
let _sqlite: Database | null = null;

export function getDb(): ReturnType<typeof drizzle> {
  if (_db) return _db;

  const dataDir = process.env.DATA_DIR ?? './data';
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'percussionist.db');

  const sqlite = new Database(dbPath, { create: true });
  // WAL mode for better concurrent read/write performance.
  sqlite.exec('PRAGMA journal_mode=WAL;');
  sqlite.exec('PRAGMA foreign_keys=ON;');

  const db = drizzle(sqlite, { schema });

  // Apply all pending migrations from the migrations/ folder.
  // import.meta.dirname is dist/server/ in production, src/server/ in dev —
  // both are two levels below the package root where migrations/ lives.
  const migrationsFolder = path.join(import.meta.dirname, '../../migrations');
  migrate(db, { migrationsFolder });

  // Only assign the singleton after migrations succeed — prevents a failed
  // migration from leaving _db set to an unmigrated database handle.
  _sqlite = sqlite;
  _db = db;

  console.log(`[db] percussionist.db opened at ${dbPath}`);

  // Graceful shutdown: close the raw SQLite handle on SIGTERM to prevent WAL
  // corruption during pod termination. Must be registered after singleton
  // assignment so _sqlite is always defined when the handler fires.
  process.on('SIGTERM', () => {
    try {
      _sqlite?.close();
    } finally {
      process.exit(0);
    }
  });

  return _db;
}

// ---------------------------------------------------------------------------
// Exported for testing / manual shutdown

export function closeDb(): void {
  _sqlite?.close();
  _db = null;
  _sqlite = null;
}

export type Db = ReturnType<typeof getDb>;
