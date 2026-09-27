import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const DEFAULT_EMBEDDING_DIMENSIONS = 768;

/**
 * Unbounded pgvector column: `vector` with no typmod, so the width is not part
 * of the schema. A `vector(n)` column would make `spec.embedding.dimensions`
 * a migration rather than a setting, and a project changing its embedding model
 * would have to redeploy the table.
 *
 * driverData is the wire form (`[1,2,3]`) both node-postgres and PGlite return
 * for a `vector` value. `toDriver` emits that same text form, which PostgreSQL
 * parses with the vector input function when the parameter type is inferred
 * from the column.
 */
export const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return 'vector';
  },
  toDriver(value) {
    return JSON.stringify(value);
  },
  fromDriver(value) {
    return String(value)
      .replace(/^\[/, '')
      .replace(/\]$/, '')
      .split(',')
      .filter((part) => part !== '')
      .map((part) => Number(part));
  },
});

export const memories = pgTable(
  'memories',
  {
    project: text('project').notNull(),
    id: text('id').notNull(),
    content: text('content').notNull(),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    agentRun: text('agent_run'),
    embedding: vector('embedding').notNull(),
    /**
     * Width of this row's `embedding`, duplicated as a column so the boot-time
     * dimension assertion is an index lookup instead of a `SELECT DISTINCT
     * vector_dims(...)` over the project's whole history. The CHECK below makes
     * the duplication impossible to desynchronise.
     */
    dims: integer('dims').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.project, t.id] }),
    index('idx_memories_project_created').on(t.project, t.createdAt),
    // Serves the (project, dims) lookup in assertStoredDimensions().
    index('idx_memories_project_dims').on(t.project, t.dims),
    check('memories_dims_matches_embedding', sql`${t.dims} = vector_dims(${t.embedding})`),
  ],
);

export type MemoryRow = typeof memories.$inferSelect;
export type NewMemoryRow = typeof memories.$inferInsert;

export const schema = { memories };
