import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as sqliteVec from 'sqlite-vec';
import * as schema from './schema.js';

let _db: ReturnType<typeof drizzle> | null = null;
let _raw: Database | null = null;

/**
 * Load the sqlite-vec extension, and explain the failure when it does not load.
 *
 * Two quirks conspire to make the raw error actively misleading. Bun's
 * `loadExtension()` appends `.so` to whatever path it is handed, and SQLite
 * retries with its own suffix when the first `dlopen` fails — so
 * `sqliteVec.load()`, which passes a path that already ends in `.so`, reports
 * `…/vec0.so.so: cannot open shared object file`. That reads like a path bug in
 * this repo and is not one: the doubled suffix is only the last attempt SQLite
 * made, and the real failure is that the actual `vec0.so` could not be loaded.
 *
 * It usually could not be loaded because of libc. The prebuilt extension in
 * `sqlite-vec-linux-x64` links glibc (`NEEDED libc.so.6`, `GLIBC_2.14`
 * symbols), and the package declares only `os`/`cpu` — no `libc` — so package
 * managers install it on Alpine too, where `dlopen` then fails. Alpine's
 * `libc6-compat` supplies the `libc.so.6` name but not glibc's versioned
 * symbols, so having it installed (the runner images do) is not enough. That is
 * why `images/memory/Dockerfile` runs on Debian `oven/bun` despite installing
 * dependencies on Alpine.
 */
function loadVecExtension(db: Database): void {
  let loadablePath: string;
  try {
    // Resolution itself fails when the platform package is absent or unreadable,
    // before any dlopen is attempted.
    loadablePath = sqliteVec.getLoadablePath();
  } catch (e) {
    throw new Error(
      `sqlite-vec could not be resolved: ${(e as Error).message}\n` +
        `The sqlite-vec-linux-x64 optional dependency is missing or unreadable. ` +
        `Reinstall without --no-optional / --ignore-optional.`,
    );
  }
  // Hand Bun the path without the suffix it re-appends, so the first dlopen
  // attempt is the real file and any error names it instead of `vec0.so.so`.
  try {
    db.loadExtension(loadablePath.replace(/\.so$/, ''));
  } catch (e) {
    const cause = (e as Error).message;
    const detail = existsSync(loadablePath)
      ? `The file exists, so this is a libc mismatch: that extension links glibc and cannot be ` +
        `dlopen()ed on musl/Alpine — libc6-compat does not provide glibc's versioned symbols. ` +
        `Run on a glibc base image, as images/memory/Dockerfile does.`
      : `The file is missing: the sqlite-vec-linux-x64 optional dependency was not installed. ` +
        `Reinstall without --no-optional / --ignore-optional.`;
    throw new Error(`sqlite-vec failed to load from ${loadablePath}: ${cause}\n${detail}`);
  }
}

/**
 * Why sqlite-vec cannot be loaded here, or null when it loads fine.
 *
 * Vector-backed tests call this to skip themselves with a reason instead of
 * failing a whole-monorepo `pnpm test` on any musl machine — which is what made
 * the husky pre-commit hook unusable for agents committing from Alpine runner
 * pods, and taught everyone to reach for `--no-verify`.
 */
export function vecUnavailableReason(): string | null {
  const probe = new Database(':memory:');
  try {
    loadVecExtension(probe);
    return null;
  } catch (e) {
    return (e as Error).message;
  } finally {
    probe.close();
  }
}

export function getDb(): ReturnType<typeof drizzle> {
  if (_db) return _db;
  const dbPath = process.env.MEMORY_DB_PATH ?? '/data/memory/vectors.db';
  const dir = dbPath.substring(0, dbPath.lastIndexOf('/'));
  Bun.spawnSync(['mkdir', '-p', dir]);
  _raw = new Database(dbPath);
  _raw.run('PRAGMA journal_mode=WAL');
  _raw.run('PRAGMA foreign_keys=ON');
  loadVecExtension(_raw);
  _db = drizzle({ client: _raw, schema });
  return _db;
}

export function getRawDb(): Database {
  if (!_raw) {
    getDb();
  }
  if (!_raw) throw new Error('Database not initialized');
  return _raw;
}
