// Stats database — Drizzle ORM over bun:sqlite.
//
// The DB file lives at DATA_DIR/stats.db (default: /app/data/stats.db when
// running in the web pod, ./data/stats.db in dev). The directory is created
// on startup if it doesn't exist.
//
// Schema:
//   runs        — one row per OpenCodeRun session
//   messages    — full message history (user + assistant turns)
//   tool_calls  — every tool invocation with args, result, duration
//   file_ops    — files read/written during a session

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  sqliteTable,
  text,
  integer,
  index,
  primaryKey,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Schema

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    namespace: text("namespace"),
    task: text("task"),
    model: text("model"),
    agent: text("agent"),
    phase: text("phase"),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    tokensIn: integer("tokens_in").default(0),
    tokensOut: integer("tokens_out").default(0),
    error: text("error"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [index("idx_runs_started_at").on(table.startedAt)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    role: text("role"), // "user" | "assistant"
    // Full message content — may be large. Stored as JSON string (array of
    // parts: text, image, tool-use, tool-result, etc.)
    content: text("content"),
    model: text("model"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    createdAt: text("created_at"),
    completedAt: text("completed_at"),
  },
  (table) => [index("idx_messages_session_id").on(table.sessionId)],
);

export const toolCalls = sqliteTable(
  "tool_calls",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    messageIdx: integer("message_idx").notNull(),
    tool: text("tool").notNull(),
    // JSON-encoded arguments passed to the tool.
    args: text("args"),
    success: integer("success", { mode: "boolean" }),
    error: text("error"),
    durationMs: integer("duration_ms"),
  },
  (table) => [index("idx_tool_calls_session_id").on(table.sessionId)],
);

export const fileOps = sqliteTable(
  "file_ops",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    messageIdx: integer("message_idx").notNull(),
    filePath: text("file_path").notNull(),
    operation: text("operation").notNull(), // "read" | "write"
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.messageIdx, table.filePath] }),
    index("idx_file_ops_session_id").on(table.sessionId),
  ],
);

// ---------------------------------------------------------------------------
// Client singleton

let _db: ReturnType<typeof drizzle> | null = null;

export function getDb(): ReturnType<typeof drizzle> {
  if (_db) return _db;

  const dataDir = process.env.DATA_DIR ?? "./data";
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "stats.db");

  const sqlite = new Database(dbPath, { create: true });
  // WAL mode for better concurrent read/write performance. With 10 dispatcher
  // pods posting simultaneously this prevents writer starvation.
  sqlite.exec("PRAGMA journal_mode=WAL;");
  sqlite.exec("PRAGMA foreign_keys=ON;");

  _db = drizzle(sqlite, { schema: { runs, messages, toolCalls, fileOps } });

  // Apply schema inline (no external migration runner needed for SQLite in a
  // single-process server). We use CREATE TABLE IF NOT EXISTS so restarts are
  // idempotent. Index creation is also idempotent via IF NOT EXISTS.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      namespace TEXT,
      task TEXT,
      model TEXT,
      agent TEXT,
      phase TEXT,
      started_at TEXT,
      completed_at TEXT,
      tokens_in INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      role TEXT,
      content TEXT,
      model TEXT,
      tokens_in INTEGER,
      tokens_out INTEGER,
      created_at TEXT,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);

    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      message_idx INTEGER NOT NULL,
      tool TEXT NOT NULL,
      args TEXT,
      success INTEGER,
      error TEXT,
      duration_ms INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_tool_calls_session_id ON tool_calls(session_id);

    CREATE TABLE IF NOT EXISTS file_ops (
      session_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      message_idx INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      operation TEXT NOT NULL,
      PRIMARY KEY (session_id, message_idx, file_path)
    );

    CREATE INDEX IF NOT EXISTS idx_file_ops_session_id ON file_ops(session_id);
  `);

  console.log(`[db] stats.db opened at ${dbPath}`);
  return _db;
}

export type Db = ReturnType<typeof getDb>;
