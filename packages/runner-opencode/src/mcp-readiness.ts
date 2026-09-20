// mcp-readiness.ts — bounded wait for the dispatcher MCP listener before the
// embedded OpenCode 2 host opens its MCP clients.
//
// The runner (`opencode`) and the dispatcher are sibling containers in the run
// pod. The kubelet starts them in list order and does not wait for one to be
// listening before starting the next, so the runner can reach its MCP setup
// while the dispatcher's Node process — or its image pull — is still behind.
//
// OpenCode 2's MCP service connects exactly once, during host startup:
// `startServer` records a refused connection as status `failed` and never
// retries it for the life of the host. A single ECONNREFUSED from
// http://127.0.0.1:4097/mcp therefore costs the run every dispatcher tool
// (complete_run, complete_plan, complete_review, complete_merge, fail_run,
// get_status, ...) for its entire duration — the agent can no longer signal
// completion, and the run only ends when the session goes idle.
//
// Waiting for the listener first turns that race into a bounded delay. The
// dispatcher starts its MCP server at the very top of `main()`, *before* it
// waits for the runner's health (see dispatcher/src/index.ts), so the two sides
// are not mutually blocked: the endpoint always comes up on its own.
//
// The wait is best-effort and bounded. If the endpoint never answers we log a
// warning and start the host anyway, matching the runner's other readiness
// waits (credential registration, model registry): refusing to boot does not
// help a run whose dispatcher is already gone, and a definite failure here
// would otherwise be reported as a confusing health-check timeout.

import { createConnection } from 'node:net';

/** Overall readiness budget. The dispatcher's listener is up well under a
 *  second once its process is scheduled; this covers sibling-container
 *  start-order jitter and a slow image pull. The wait resolves as soon as the
 *  port accepts, so the budget is only spent when something is genuinely wrong.
 *  It cannot starve the dispatcher's own 120 s health check: that clock starts
 *  when the dispatcher process starts — i.e. when this wait is already about to
 *  finish. */
export const DEFAULT_MCP_READY_TIMEOUT_MS = 60_000;

/** Delay between connection attempts. */
export const DEFAULT_MCP_READY_INTERVAL_MS = 250;

/** Per-attempt TCP connect timeout. A loopback connect either lands fast or is
 *  refused; this only guards against a wedged accept queue. */
export const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 2_000;

/**
 * Readiness budget from `DISPATCHER_MCP_READY_TIMEOUT_MS`. `0` disables the
 * wait (useful for a dev box with no dispatcher sidecar). Unparseable or
 * negative values fall back to the default rather than disabling the guard.
 */
export function dispatcherMcpReadyTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DISPATCHER_MCP_READY_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MCP_READY_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MCP_READY_TIMEOUT_MS;
}

export type McpTarget = { host: string; port: number };

/**
 * Extract the host/port a dispatcher MCP URL points at. Returns null when the
 * URL is not an absolute http(s) URL with a resolvable port.
 */
export function parseMcpTarget(url: string): McpTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
  return { host: parsed.hostname, port };
}

export type WaitForMcpOptions = {
  /** Overall budget; the wait resolves as soon as a connect succeeds. */
  timeoutMs?: number;
  /** Delay between attempts. */
  intervalMs?: number;
  /** Per-attempt connect timeout. */
  attemptTimeoutMs?: number;
  /** Cooperative cancellation (e.g. SIGTERM during startup). */
  signal?: AbortSignal;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
};

export type WaitForMcpResult = {
  ready: boolean;
  waitedMs: number;
  attempts: number;
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        resolve();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/** Resolve true when a TCP connection to host:port is accepted. */
function probeTcp(
  host: string,
  port: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const socket = createConnection({ host, port });
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      resolve(ok);
    };
    const onAbort = (): void => finish(false);

    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    timer = setTimeout(() => finish(false), timeoutMs);
    if (signal) {
      if (signal.aborted) {
        finish(false);
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Wait until `url`'s host:port accepts a TCP connection, up to `timeoutMs`.
 * Never throws: an unreachable endpoint resolves `{ ready: false }` after a
 * warning so the caller can start the host anyway.
 */
export async function waitForDispatcherMcp(
  url: string,
  opts: WaitForMcpOptions = {},
): Promise<WaitForMcpResult> {
  const target = parseMcpTarget(url);
  if (!target) {
    opts.warn?.(
      `dispatcher MCP readiness: "${url}" is not an http(s) URL — skipping readiness wait`,
    );
    return { ready: false, waitedMs: 0, attempts: 0 };
  }

  const timeoutMs = opts.timeoutMs ?? dispatcherMcpReadyTimeoutMs();
  if (timeoutMs <= 0) {
    opts.log?.('dispatcher MCP readiness: wait disabled (timeout 0)');
    return { ready: false, waitedMs: 0, attempts: 0 };
  }

  const intervalMs = opts.intervalMs ?? DEFAULT_MCP_READY_INTERVAL_MS;
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? DEFAULT_MCP_CONNECT_TIMEOUT_MS;
  const started = Date.now();
  const deadline = started + timeoutMs;
  let attempts = 0;

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) break;
    attempts++;
    const remaining = Math.max(1, deadline - Date.now());
    const ok = await probeTcp(
      target.host,
      target.port,
      Math.min(attemptTimeoutMs, remaining),
      opts.signal,
    );
    if (ok) {
      const waitedMs = Date.now() - started;
      opts.log?.(
        `dispatcher MCP ${target.host}:${target.port} ready after ${waitedMs}ms (${attempts} attempt(s))`,
      );
      return { ready: true, waitedMs, attempts };
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())), opts.signal);
  }

  const waitedMs = Date.now() - started;
  const reason = opts.signal?.aborted ? 'wait cancelled' : `not reachable within ${timeoutMs}ms`;
  opts.warn?.(
    `dispatcher MCP ${target.host}:${target.port} ${reason} after ${attempts} attempt(s); ` +
      'starting the runner anyway — dispatcher MCP tools may be unavailable this run',
  );
  return { ready: false, waitedMs, attempts };
}
