import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { logger } from "hono/logger";
import path from "node:path";
import { fileURLToPath } from "node:url";
import runs from "./routes/runs.js";
import logs from "./routes/logs.js";
import session from "./routes/session.js";
import { NAMESPACE } from "./kube.js";

// Resolve the client dist directory relative to *this* file, not cwd.
// In dev (tsx):   src/server/index.ts  -> ../../dist/client
// In production:  dist/server/index.js -> ../client
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(__dirname, "../client");

const app = new Hono();

app.use("*", logger());

// API routes
app.route("/api/runs", runs);
app.route("/api/runs", logs);
app.route("/api/runs", session);

// Health check
app.get("/api/health", (c) => c.json({ ok: true, namespace: NAMESPACE }));

// Serve the Vite-built SPA for all non-API routes.
app.use(
  "/*",
  serveStatic({
    root: clientDir,
    rewriteRequestPath: (p) => p,
  }),
);

// SPA fallback: serve index.html for client-side routes.
app.use(
  "/*",
  serveStatic({
    root: clientDir,
    rewriteRequestPath: () => "/index.html",
  }),
);

const port = parseInt(process.env.PORT ?? "8080", 10);

console.log(`percussionist-web listening on :${port}  (namespace=${NAMESPACE})`);
console.log(`serving client from ${clientDir}`);
serve({ fetch: app.fetch, port });
