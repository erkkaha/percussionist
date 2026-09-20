// health.ts — plain HTTP health endpoint for kubelet probes.
//
// The operator used to be probed with `exec: sh -c "pgrep -f node"`. Every
// probe went through the containerd shim's ExecSync path; after a host
// suspend/resume those execs started timing out and each timed-out probe left
// a process behind (~3/min for 11 hours) until the node froze. An HTTP probe
// never forks anything inside the container, so it cannot leak.
//
//   GET /healthz -> 200 while the process is up (liveness-safe)
//   GET /readyz  -> 200 once the informers have started, 503 before that

import { createServer, type Server } from 'node:http';

const log = (...args: unknown[]) => console.log(`[operator ${new Date().toISOString()}]`, ...args);

export const HEALTH_PORT = Number(process.env.OPERATOR_HEALTH_PORT ?? 8081);

let ready = false;

/** Flip /readyz to 200. Called once the watches are established. */
export function markReady(): void {
  ready = true;
}

export function isReady(): boolean {
  return ready;
}

/** Test hook: back to the not-ready state. */
export function resetHealthForTests(): void {
  ready = false;
}

/**
 * Start the health server. Never throws on bind failure: a broken health
 * endpoint must not take the operator down with it, so errors are logged and
 * the returned server is simply not listening (probes will then fail, which
 * is the correct signal).
 */
export function startHealthServer(port: number = HEALTH_PORT, host = '0.0.0.0'): Server {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end('method not allowed');
      return;
    }
    switch (req.url) {
      case '/healthz':
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
        return;
      case '/readyz':
        res.writeHead(ready ? 200 : 503, { 'content-type': 'text/plain' });
        res.end(ready ? 'ready' : 'starting');
        return;
      default:
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
    }
  });
  server.on('error', (e) => {
    console.error(`[operator ${new Date().toISOString()}] health server error:`, e.message);
  });
  server.listen(port, host, () => {
    const addr = server.address();
    const bound = typeof addr === 'object' && addr ? addr.port : port;
    log(`health server listening on ${host}:${bound} (/healthz, /readyz)`);
  });
  return server;
}
