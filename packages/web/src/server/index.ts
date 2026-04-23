// Web server entry point.
//
// Runs under Bun (bun src/server/index.ts) in production and under tsx in dev.
// Bun's native HTTP server is used when available (detected via typeof Bun);
// @hono/node-server is the fallback for dev with tsx.
//
// Stats DB is initialised eagerly on startup so the first POST from a
// dispatcher doesn't pay the schema-creation cost.

import { Hono } from "hono";
import { logger } from "hono/logger";
import path from "node:path";
import { fileURLToPath } from "node:url";
import runs from "./routes/runs.js";
import logs from "./routes/logs.js";
import session from "./routes/session.js";
import stats, { runRetentionCleanup, RETENTION_DAYS } from "./routes/stats.js";
import { NAMESPACE } from "./kube.js";
import { getDb } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// In dev (tsx):   src/server/index.ts  -> ../../dist/client
// In production:  dist/server/index.js -> ../client
const clientDir = path.resolve(__dirname, "../client");

const app = new Hono();

app.use("*", logger());

// API routes
app.route("/api/runs", runs);
app.route("/api/runs", logs);
app.route("/api/runs", session);
app.route("/api/stats", stats);

// Health check
app.get("/api/health", (c) => c.json({ ok: true, namespace: NAMESPACE }));

// Serve the Vite-built SPA for all non-API routes.
// Under Bun we use its built-in static file serving; under Node we fall back
// to @hono/node-server/serve-static.
const isBun = typeof Bun !== "undefined";

if (!isBun) {
  const { serveStatic } = await import("@hono/node-server/serve-static");
  app.use(
    "/*",
    serveStatic({
      root: clientDir,
      rewriteRequestPath: (p) => p,
    }),
  );
  app.use(
    "/*",
    serveStatic({
      root: clientDir,
      rewriteRequestPath: () => "/index.html",
    }),
  );
}

if (isBun) {
  // Bun: serve static files from clientDir, fall back to index.html for SPA.
  app.use("/*", async (c) => {
    const reqPath = new URL(c.req.url).pathname;
    const filePath = path.join(clientDir, reqPath);

    let file = Bun.file(filePath);
    if (!(await file.exists())) {
      file = Bun.file(path.join(clientDir, "index.html"));
    }
    if (!(await file.exists())) {
      return c.text("Not found", 404);
    }
    return new Response(file);
  });
}

const port = parseInt(process.env.PORT ?? "8080", 10);

// ---------------------------------------------------------------------------
// Stats DB — initialise eagerly so schema is ready before first request.

try {
  getDb();
  console.log(
    `[stats] retention policy: ${RETENTION_DAYS > 0 ? `${RETENTION_DAYS} days` : "disabled (keep forever)"}`,
  );
} catch (e) {
  console.error("[stats] DB init failed:", (e as Error).message);
  // Non-fatal — stats collection degrades gracefully; core API still works.
}

// ---------------------------------------------------------------------------
// Retention cron — run hourly.

runRetentionCleanup();
setInterval(runRetentionCleanup, 60 * 60 * 1000);

// ---------------------------------------------------------------------------
// Start server

console.log(`percussionist-web listening on :${port}  (namespace=${NAMESPACE})`);
console.log(`serving client from ${clientDir}`);

if (isBun) {
  Bun.serve({ fetch: app.fetch, port });
} else {
  const { serve } = await import("@hono/node-server");
  serve({ fetch: app.fetch, port });
}
