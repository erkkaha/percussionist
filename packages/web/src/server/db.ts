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

function openDatabase(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA foreign_keys=ON;');
  // Checkpoint every 200 pages (~800KB) instead of default 1000 (~4MB) to
  // keep WAL small and reduce data loss on unclean shutdown.
  db.exec('PRAGMA wal_autocheckpoint=200;');
  return db;
}

function integrityOk(sqlite: Database): boolean {
  try {
    const row = sqlite.query('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
    return row !== undefined && Object.values(row)[0] === 'ok';
  } catch {
    return false;
  }
}

function openWithRecovery(dbPath: string): Database {
  const sqlite = openDatabase(dbPath);

  if (integrityOk(sqlite)) return sqlite;

  // Corruption detected: rename the corrupt file, create fresh.
  const corruptPath = `${dbPath}.corrupt.${Date.now()}`;
  console.error(`[db] corruption detected, renaming to ${corruptPath}`);
  sqlite.close();
  try {
    fs.renameSync(dbPath, corruptPath);
  } catch {}
  try {
    fs.unlinkSync(`${dbPath}-wal`);
  } catch {}
  try {
    fs.unlinkSync(`${dbPath}-shm`);
  } catch {}

  const fresh = openDatabase(dbPath);
  console.log(`[db] fresh database created (corrupt backup: ${corruptPath})`);
  return fresh;
}

export function getDb(): ReturnType<typeof drizzle> {
  if (_db) return _db;

  const dataDir = process.env.DATA_DIR ?? './data';
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'percussionist.db');

  const sqlite = openWithRecovery(dbPath);

  const db = drizzle(sqlite, { schema });

  const migrationsFolder = path.join(import.meta.dirname, '../../migrations');
  migrate(db, { migrationsFolder });

  _sqlite = sqlite;
  _db = db;

  console.log(`[db] percussionist.db opened at ${dbPath}`);

  registerShutdown(sqlite);

  return _db;
}

// ---------------------------------------------------------------------------
// Shutdown & WAL checkpoint management

let _shutdownRegistered = false;

function registerShutdown(sqlite: Database): void {
  if (_shutdownRegistered) return;
  _shutdownRegistered = true;

  // Periodic WAL checkpoint (every 60s) to keep WAL small and reduce the
  // amount of data that could be lost on an unclean shutdown.
  const interval = setInterval(() => {
    try {
      sqlite.exec('PRAGMA wal_checkpoint(PASSIVE)');
    } catch {
      // ignore checkpoint errors
    }
  }, 60_000);
  interval.unref();

  // Graceful shutdown: checkpoint the WAL before closing, then let Bun
  // handle process exit naturally (no process.exit() — that would abort
  // in-flight requests and cause corruption).
  process.on('SIGTERM', () => {
    interval.unref();
    clearInterval(interval);
    try {
      sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // ignore checkpoint errors on shutdown
    }
    try {
      sqlite.close();
    } catch {
      // ignore close errors
    }
  });
}

// ---------------------------------------------------------------------------
// Exported for testing / manual shutdown

export function closeDb(): void {
  _sqlite?.close();
  _db = null;
  _sqlite = null;
}

export type Db = ReturnType<typeof getDb>;
