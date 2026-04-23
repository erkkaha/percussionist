import { defineConfig } from "drizzle-kit";

// drizzle-kit config — used for `pnpm db:generate` (generate migration SQL)
// and inspection tooling. The actual schema is applied at runtime via
// CREATE TABLE IF NOT EXISTS in db.ts, so migrations are not required for
// normal operation.

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/server/db.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env.DATA_DIR ? `${process.env.DATA_DIR}/stats.db` : "./data/stats.db",
  },
});
