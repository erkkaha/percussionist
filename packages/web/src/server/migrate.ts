// Standalone migration runner — used by `pnpm db:migrate`.
// Applies all pending migrations from migrations/ to the target DB.

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as fs from "node:fs";
import * as path from "node:path";

const dataDir = process.env.DATA_DIR ?? "./data";
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, "percussionist.db");

const sqlite = new Database(dbPath, { create: true });
sqlite.exec("PRAGMA journal_mode=WAL;");
sqlite.exec("PRAGMA foreign_keys=ON;");

const db = drizzle(sqlite);
const migrationsFolder = path.join(import.meta.dirname, "../../migrations");

console.log(`[migrate] applying migrations from ${migrationsFolder}`);
migrate(db, { migrationsFolder });
console.log(`[migrate] done — ${dbPath}`);
