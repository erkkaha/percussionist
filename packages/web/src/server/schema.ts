// Drizzle schema definitions — no driver imports, safe to import from drizzle-kit.
//
// Tables:
//   runs          — one row per OpenCodeRun session
//   messages      — full message history (user + assistant turns)
//   tool_calls    — every tool invocation with args, result, duration
//   file_ops      — files read/written during a session
//   board_tasks   — authoritative board task state (replaces CR status.board)
//   board_workers — worker assignment state per task
//   board_events  — append-only audit log of board state transitions

import {
  sqliteTable,
  text,
  integer,
  index,
  primaryKey,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

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
    operation: text("operation").notNull(), // "read" | "write" | "delete"
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.messageIdx, table.filePath] }),
    index("idx_file_ops_session_id").on(table.sessionId),
  ],
);

// ---------------------------------------------------------------------------
// Board tables — authoritative state for OpenCodeProject boards.
// The manager controller writes here instead of patching CR status.board.

export const boardTasks = sqliteTable(
  "board_tasks",
  {
    project: text("project").notNull(),
    taskId: text("task_id").notNull(),
    // Current column: "ready" | "in-progress" | "review" | "rework" | "done"
    column: text("column").notNull(),
    // Monotonically increasing sequence number within the project, used for
    // ordering tasks within a column.
    seq: integer("seq").notNull().default(0),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    primaryKey({ columns: [table.project, table.taskId] }),
    index("idx_board_tasks_project_column").on(table.project, table.column),
  ],
);

export const boardWorkers = sqliteTable(
  "board_workers",
  {
    project: text("project").notNull(),
    taskId: text("task_id").notNull(),
    runName: text("run_name").notNull(),
    retryCount: integer("retry_count").notNull().default(0),
    // Worker status mirrors WorkerStatus.status from the API schema.
    status: text("status").notNull(),
    branch: text("branch"),
    facilitated: integer("facilitated", { mode: "boolean" }).notNull().default(false),
    reviewRunName: text("review_run_name"),
    reworkRunName: text("rework_run_name"),
    facilitationRunName: text("facilitation_run_name"),
    // JSON blob of remaining WorkerStatus fields not in the main columns
    // (e.g. reviewApproved, reviewFeedback, reworkAgent, escalation, mergeRunName,
    // facilitationResult, buildTasksFacilitatorRun, startedAt, completedAt, etc.)
    extra: text("extra"),
    assignedAt: text("assigned_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    primaryKey({ columns: [table.project, table.taskId] }),
    index("idx_board_workers_project").on(table.project),
  ],
);

export const boardEvents = sqliteTable(
  "board_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    project: text("project").notNull(),
    taskId: text("task_id").notNull(),
    // e.g. "task.moved", "worker.assigned", "worker.completed", "worker.failed"
    eventType: text("event_type").notNull(),
    // JSON payload with before/after state or relevant context.
    payload: text("payload").notNull().default("{}"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_board_events_project_task").on(table.project, table.taskId),
  ],
);
