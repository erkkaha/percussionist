import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const memories = sqliteTable('memories', {
  id: text('id').primaryKey(),
  agentRun: text('agent_run'),
  content: text('content').notNull(),
  metadata: text('metadata').default('{}'),
  createdAt: text('created_at').notNull().default("datetime('now')"),
});

// vec_memories virtual table is created via raw SQL in initDb()
// since sqlite-vec's vec0 extension requires non-standard DDL.
