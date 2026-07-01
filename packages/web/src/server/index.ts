// Web server entry point.
//
// Runs under Bun (bun src/server/index.ts) in production and under tsx in dev.
// Bun's native HTTP server is used when available (detected via typeof Bun);
// @hono/node-server is the fallback for dev with tsx.
//
// Stats DB is initialised eagerly on startup so the first POST from a
// dispatcher doesn't pay the schema-creation cost.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { attachWsHandlers, isAttachAuthorized, resolveAttachTarget } from './attach-ws.js';
import { getDb } from './db.js';
import { NAMESPACE } from './kube.js';
import { startMetricsCollector } from './metrics-collector.js';
import stats, { RETENTION_DAYS, runRetentionCleanup } from './routes/stats.js';

void stats; // imported for side-effect registration only (retention helpers)

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// In dev (tsx):   src/server/index.ts  -> ../../dist/client
// In production:  dist/server/index.js -> ../client
const clientDir = path.resolve(__dirname, '../client');

process.on('unhandledRejection', (reason) => {
  console.error(`[web ${new Date().toISOString()}] unhandledRejection:`, reason);
  process.exit(1);
});

const app = createApp();

// Return 404 for any /api/* path that wasn't matched by the registered routes.
// Without this, unmatched API paths would fall through to the SPA catch-all and
// receive index.html with a 200, which is misleading for API consumers.
app.all('/api/*', (c) => c.json({ error: 'Not Found' }, 404));

// Serve the Vite-built SPA for all non-API routes.
// Under Bun we use its built-in static file serving; under Node we fall back
// to @hono/node-server/serve-static.
const isBun = typeof Bun !== 'undefined';

if (!isBun) {
  const { serveStatic } = await import('@hono/node-server/serve-static');
  app.use(
    '/*',
    serveStatic({
      root: clientDir,
      rewriteRequestPath: (p) => p,
    }),
  );
  app.use(
    '/*',
    serveStatic({
      root: clientDir,
      rewriteRequestPath: () => '/index.html',
    }),
  );
}

if (isBun) {
  // Bun: serve static files from clientDir, fall back to index.html for SPA.
  app.use('/*', async (c) => {
    const reqPath = new URL(c.req.url).pathname;
    const filePath = path.join(clientDir, reqPath);

    let file = Bun.file(filePath);
    if (!(await file.exists())) {
      file = Bun.file(path.join(clientDir, 'index.html'));
    }
    if (!(await file.exists())) {
      return c.text('Not found', 404);
    }
    return new Response(file);
  });
}

const port = parseInt(process.env.PORT ?? '8080', 10);

// ---------------------------------------------------------------------------
// Stats DB — initialise eagerly so schema is ready before first request.

getDb();
console.log(
  `[stats] retention policy: ${RETENTION_DAYS > 0 ? `${RETENTION_DAYS} days` : 'disabled (keep forever)'}`,
);

// ---------------------------------------------------------------------------
// Retention cron — run hourly.

runRetentionCleanup();
setInterval(runRetentionCleanup, 60 * 60 * 1000);

// ---------------------------------------------------------------------------
// Metrics snapshot collector — starts only if metrics-server is available.

void startMetricsCollector();

// ---------------------------------------------------------------------------
// Start server

console.log(`percussionist-web listening on :${port}  (namespace=${NAMESPACE})`);
console.log(`serving client from ${clientDir}`);

if (isBun) {
  Bun.serve({
    fetch: async (req, server) => {
      // Intercept WebSocket upgrade requests for /api/runs/:name/attach.
      const url = new URL(req.url);
      if (
        req.headers.get('upgrade') === 'websocket' &&
        url.pathname.match(/^\/api\/runs\/[^/]+\/attach$/)
      ) {
        if (!isAttachAuthorized(url)) {
          return new Response('Unauthorized', { status: 401 });
        }
        const runName = decodeURIComponent(
          url.pathname.match(/^\/api\/runs\/([^/]+)\/attach$/)?.[1] ?? '',
        );
        const target = await resolveAttachTarget(runName);
        if ('error' in target) {
          return new Response(target.error, { status: target.status });
        }
        if (
          server.upgrade(req, {
            data: {
              podName: target.podName,
              namespace: target.namespace,
              runName: target.runName,
              stdin: undefined,
              stdout: undefined,
              closed: false,
            },
          })
        ) {
          return undefined;
        }
        return new Response('WebSocket upgrade failed', { status: 500 });
      }
      return app.fetch(req);
    },
    websocket: attachWsHandlers,
    port,
    // Prevent Bun's default 10s keep-alive timeout (10s is too short for
    // SSE streams that may have gaps between keepalive pings). 120s gives
    // plenty of headroom while still cleaning up truly dead connections.
    idleTimeout: 120,
  });
} else {
  const { serve } = await import('@hono/node-server');
  serve({ fetch: app.fetch, port });
}
