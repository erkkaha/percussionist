import { defineConfig } from 'drizzle-kit';

// drizzle-kit config — used for `pnpm db:generate` to produce migration SQL files
// from the Drizzle schema in schema.ts.
//
// To add or change a column:
//   1. Edit src/server/schema.ts
//   2. Run:  pnpm db:generate    (creates a new migration file in ./migrations-pg/)
//   3. Commit the migration file alongside the schema change
//   4. On next startup the server applies all pending migrations automatically
//      (initDb() is awaited in index.ts before any queries run)

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/server/schema.ts',
  out: './migrations-pg',
});
