import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as sqliteVec from 'sqlite-vec';
import * as schema from './schema.js';

let _db: ReturnType<typeof drizzle> | null = null;
let _raw: Database | null = null;

export function getDb(): ReturnType<typeof drizzle> {
  if (_db) return _db;
  const dbPath = process.env.MEMORY_DB_PATH ?? '/data/memory/vectors.db';
  const dir = dbPath.substring(0, dbPath.lastIndexOf('/'));
  Bun.spawnSync(['mkdir', '-p', dir]);
  _raw = new Database(dbPath);
  _raw.run('PRAGMA journal_mode=WAL');
  _raw.run('PRAGMA foreign_keys=ON');
  sqliteVec.load(_raw);
  _db = drizzle({ client: _raw, schema });
  return _db;
}

export function getRawDb(): Database {
  if (!_raw) {
    getDb();
  }
  return _raw!;
}
