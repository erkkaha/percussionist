// Drizzle schema definitions — no driver imports, safe to import from drizzle-kit.
//
// Tables:
//   runs          — one row per Run session
//   messages      — full message history (user + assistant turns)
//   tool_calls    — every tool invocation with args, result, duration
//   file_ops      — files read/written during a session
//   task_events   — append-only audit log of Task state transitions

import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    namespace: text('namespace'),
    task: text('task'),
    model: text('model'),
    agent: text('agent'),
    phase: text('phase'),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
    tokensIn: integer('tokens_in').default(0),
    tokensOut: integer('tokens_out').default(0),
    cost: real('cost'),
    error: text('error'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [index('idx_runs_started_at').on(table.startedAt)],
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    idx: integer('idx').notNull(),
    role: text('role'), // "user" | "assistant"
    content: text('content'),
    model: text('model'),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    tokensReasoning: integer('tokens_reasoning'),
    tokensCacheRead: integer('tokens_cache_read'),
    tokensCacheWrite: integer('tokens_cache_write'),
    cost: real('cost'),
    createdAt: text('created_at'),
    completedAt: text('completed_at'),
  },
  (table) => [index('idx_messages_session_id').on(table.sessionId)],
);

export const toolCalls = sqliteTable(
  'tool_calls',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    messageIdx: integer('message_idx').notNull(),
    tool: text('tool').notNull(),
    args: text('args'),
    success: integer('success', { mode: 'boolean' }),
    error: text('error'),
    durationMs: integer('duration_ms'),
  },
  (table) => [index('idx_tool_calls_session_id').on(table.sessionId)],
);

export const fileOps = sqliteTable(
  'file_ops',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    messageIdx: integer('message_idx').notNull(),
    filePath: text('file_path').notNull(),
    operation: text('operation').notNull(), // "read" | "write" | "delete"
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.messageIdx, table.filePath] }),
    index('idx_file_ops_session_id').on(table.sessionId),
  ],
);

export const metricSnapshots = sqliteTable(
  'metric_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    node: text('node').notNull(),
    cpuUsageMillicores: integer('cpu_usage_millicores').notNull(),
    memoryUsageBytes: integer('memory_usage_bytes').notNull(),
    cpuCapacityMillicores: integer('cpu_capacity_millicores').notNull(),
    memoryCapacityBytes: integer('memory_capacity_bytes').notNull(),
    recordedAt: text('recorded_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_metric_snapshots_node_recorded').on(table.node, table.recordedAt),
    index('idx_metric_snapshots_recorded').on(table.recordedAt),
  ],
);

export const usageDaily = sqliteTable(
  'usage_daily',
  {
    date: text('date').notNull(),
    reviewing: integer('reviewing').default(0),
    planning: integer('planning').default(0),
    other: integer('other').default(0),
  },
  (table) => [primaryKey({ columns: [table.date] })],
);

export const usageDailyProject = sqliteTable(
  'usage_daily_project',
  {
    date: text('date').notNull(),
    project: text('project').notNull(),
    reviewing: integer('reviewing').default(0),
    planning: integer('planning').default(0),
  },
  (table) => [primaryKey({ columns: [table.date, table.project] })],
);

export const usageSettings = sqliteTable('usage_settings', {
  id: integer('id').primaryKey().default(1),
  maxTimeHours: integer('max_time_hours').default(0),
  showPercent: integer('show_percent', { mode: 'boolean' }).default(false),
  lockOnMax: integer('lock_on_max', { mode: 'boolean' }).default(false),
});

export const taskEvents = sqliteTable(
  'task_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    // Project name (Project metadata.name).
    project: text('project').notNull(),
    // Task CR name (Task metadata.name).
    taskName: text('task_name').notNull(),
    // Task type: "PLAN" | "BUILD".
    taskType: text('task_type').notNull(),
    // Event type: "column.changed" | "run.created" | "run.failed" | "merged" |
    //             "escalated" | "blocked" | "approved" | "request-changes"
    eventType: text('event_type').notNull(),
    // JSON payload with before/after state or relevant context.
    payload: text('payload').notNull().default('{}'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_task_events_project_task').on(table.project, table.taskName),
    index('idx_task_events_project_created').on(table.project, table.createdAt),
  ],
);
