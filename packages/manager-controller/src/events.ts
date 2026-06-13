// events.ts — fire-and-forget event emission from the reconciler to the web
// server's task_events audit log.
//
// The web server URL is discovered from the WEB_SERVICE_URL env var (same as
// stats-backfill). Events are best-effort — failure is logged but never throws
// so the reconcile cycle is never blocked.

const NAMESPACE = process.env.PERCUSSIONIST_NAMESPACE ?? 'percussionist';
const WEB_URL =
  process.env.WEB_SERVICE_URL ?? `http://percussionist-web.${NAMESPACE}.svc.cluster.local:8080`;
const WEB_AUTH_TOKEN = process.env.WEB_AUTH_TOKEN ?? '';

const log = (...args: unknown[]) => console.log(`[events ${new Date().toISOString()}]`, ...args);

/**
 * Emit a task lifecycle event to the web server's audit log.
 * Fire-and-forget — never throws.
 */
export function emitEvent(
  project: string,
  taskName: string,
  taskType: string,
  eventType: string,
  payload: Record<string, unknown> = {},
): void {
  const url = `${WEB_URL}/api/projects/${encodeURIComponent(project)}/board/task-events`;
  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(WEB_AUTH_TOKEN ? { Authorization: `Bearer ${WEB_AUTH_TOKEN}` } : {}),
    },
    body: JSON.stringify({ taskName, taskType, eventType, payload }),
  }).catch((e: unknown) => {
    log(`emitEvent(${project}/${taskName}/${eventType}) failed:`, (e as Error).message);
  });
}
