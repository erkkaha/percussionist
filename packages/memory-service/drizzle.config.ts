// drizzle-kit config — generates migration SQL from src/schema.ts.
//
//   pnpm db:generate        # writes a new migration into ./migrations
//   pnpm db:check           # verifies migrations match the schema
//
// `CREATE EXTENSION IF NOT EXISTS vector` must be the first statement of the
// baseline migration, before the `memories` table — it is hand-written into
// the generated 0000_*.sql file, which drizzle-kit leaves untouched on later
// runs. Do not delete that line when regenerating: pgvector is not part of a
// vanilla PostgreSQL image, and every later migration assumes the type exists.
//
// The server applies pending migrations on startup (initDb in src/db.ts), so
// there is no separate migrate step; the service applies the committed folder
// on startup.

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
});
