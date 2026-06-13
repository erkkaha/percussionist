import { defineConfig } from 'drizzle-kit';

// drizzle-kit config — used for `pnpm db:generate` to produce migration SQL files
// from the Drizzle schema in schema.ts.
//
// To add or change a column:
//   1. Edit src/server/schema.ts
//   2. Run:  pnpm db:generate    (creates a new migration file in ./migrations/)
//   3. Commit the migration file alongside the schema change
//   4. On next startup the server applies all pending migrations automatically
//      (migrate() is called in getDb() before any queries run)

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/server/schema.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env.DATA_DIR
      ? `${process.env.DATA_DIR}/percussionist.db`
      : './data/percussionist.db',
  },
});
