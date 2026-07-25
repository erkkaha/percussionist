// Drizzle schema definitions — no driver imports, safe to import from drizzle-kit.
//
// Tables:
//   runs          — one row per Run session
//   messages      — full message history (user + assistant turns)
//   tool_calls    — every tool invocation with args, result, duration
//   file_ops      — files read/written during a session
//   task_events   — append-only audit log of Task state transitions
//
// The tables at the bottom of this file (user, session, account, verification,
// apikey, deviceCode) are owned by better-auth — see the note there before
// editing them.

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

// ===========================================================================
// better-auth tables
//
// These mirror the schema better-auth derives from its options — the shape is
// dictated by the library, not by us, so the exported binding names (`user`,
// `session`, `apikey`, `deviceCode`, …) must match better-auth's model names
// exactly: the drizzle adapter looks tables up as `schema[modelName]`.
//
// Regenerate the expected shape after a better-auth upgrade with
// `getSchema()` from `better-auth/db` (see lib/better-auth.ts for the options
// to pass) and reconcile any drift here, then `pnpm db:generate`.
//
// `date` fields are integer/timestamp because the adapter hands drizzle real
// Date objects and re-wraps whatever comes back in `new Date(...)`.

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  // Custom field (see `user.additionalFields` in lib/better-auth.ts) — carries
  // the GitHub login so the sign-in allowlist can be enforced.
  githubLogin: text('github_login'),
});

export const session = sqliteTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [index('idx_session_user_id').on(table.userId)],
);

export const account = sqliteTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp' }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp' }),
    scope: text('scope'),
    password: text('password'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [index('idx_account_user_id').on(table.userId)],
);

export const verification = sqliteTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [index('idx_verification_identifier').on(table.identifier)],
);

// API keys — the agent-facing credential. `permissions` holds the JSON scope
// map that scoped() checks; `metadata` carries {runName, runUid, project} for
// per-run keys so a key can be traced back to the run that held it.
export const apikey = sqliteTable(
  'apikey',
  {
    id: text('id').primaryKey(),
    configId: text('config_id').notNull().default('default'),
    name: text('name'),
    start: text('start'),
    referenceId: text('reference_id').notNull(),
    prefix: text('prefix'),
    key: text('key').notNull(),
    refillInterval: integer('refill_interval'),
    refillAmount: integer('refill_amount'),
    lastRefillAt: integer('last_refill_at', { mode: 'timestamp' }),
    enabled: integer('enabled', { mode: 'boolean' }).default(true),
    rateLimitEnabled: integer('rate_limit_enabled', { mode: 'boolean' }).default(true),
    rateLimitTimeWindow: integer('rate_limit_time_window'),
    rateLimitMax: integer('rate_limit_max'),
    requestCount: integer('request_count').default(0),
    remaining: integer('remaining'),
    lastRequest: integer('last_request', { mode: 'timestamp' }),
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
    permissions: text('permissions'),
    metadata: text('metadata'),
  },
  (table) => [
    index('idx_apikey_key').on(table.key),
    index('idx_apikey_reference_id').on(table.referenceId),
    index('idx_apikey_config_id').on(table.configId),
  ],
);

// Device authorization grant (RFC 8628) — backs `beatctl auth login`.
export const deviceCode = sqliteTable('device_code', {
  id: text('id').primaryKey(),
  deviceCode: text('device_code').notNull(),
  userCode: text('user_code').notNull(),
  userId: text('user_id'),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  status: text('status').notNull(),
  lastPolledAt: integer('last_polled_at', { mode: 'timestamp' }),
  pollingInterval: integer('polling_interval'),
  clientId: text('client_id'),
  scope: text('scope'),
});

// ===========================================================================
// Web Push
//
// See lib/push.ts. Both tables live in the same DB as the better-auth users
// they reference, so keys, subscriptions, and identities share one lifecycle:
// wiping the data dir invalidates all three together, never one without the
// others.

// The cluster's VAPID keypair, generated on first use. A single row (id = 1).
// Rotating it (deleting the row) orphans every subscription — browsers reject
// pushes signed by an unknown key — so clients must then re-subscribe.
export const pushVapid = sqliteTable('push_vapid', {
  id: integer('id').primaryKey().default(1),
  publicKey: text('public_key').notNull(),
  privateKey: text('private_key').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// One row per browser/device a user enabled push on. `endpoint` is the push
// service URL and is globally unique by construction; `p256dh`/`auth` are the
// client keys that end-to-end encrypt payloads (RFC 8291). Rows are removed
// when the push service reports the subscription gone (404/410) or the user
// disables push on that device.
export const pushSubscription = sqliteTable(
  'push_subscription',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull().unique(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    // Which browser/device this is, for a future "manage devices" UI.
    userAgent: text('user_agent'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [index('idx_push_subscription_user').on(table.userId)],
);
