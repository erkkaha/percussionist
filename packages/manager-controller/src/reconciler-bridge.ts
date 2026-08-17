// Reconciler bridge — maintains old API for index.ts while using new phase-driven reconciler.

import { CustomObjectsApi, KubeConfig } from '@kubernetes/client-node';
import { API_GROUP, API_VERSION, PLURAL_PROJECT, type Project } from '@percussionist/api';
import { getProject, makeNodeApiClient, NAMESPACE } from '@percussionist/kube';
import { reconcileProject } from './reconciler/index.js';

export { NAMESPACE };

// K8s client setup (re-exported for index.ts).
export const kc = new KubeConfig();
try {
  kc.loadFromCluster();
} catch {
  kc.loadFromDefault();
}
export const k8s = makeNodeApiClient(kc, CustomObjectsApi);

// How long to wait after a genuine reconcile failure before letting the loop
// pick the same project up again.
const ERROR_BACKOFF_MS = 5_000;

/** True for a Kubernetes 404 — the object is gone, so retrying cannot help. */
function isNotFoundError(e: unknown): boolean {
  const err = e as { statusCode?: number; code?: number; body?: { reason?: string } };
  return (err.statusCode ?? err.code) === 404 || err.body?.reason === 'NotFound';
}

// Work queue: project names that need reconciliation.
const queue = new Set<string>();

// Pause state is per project so pausing one project never freezes the others.
// Two sources of truth, both consulted by reconcile()/getPauseStatus():
//   1. The in-memory map below, written by pause_reconciliation /
//      resume_reconciliation in the current manager process (fast path).
//   2. The project CR's `percussionist.dev/reconcile-paused` annotations,
//      written by the same tools. reconcile() reads them directly, so a pause
//      survives a manager restart — the annotation is the durable source and
//      the map is only a cache while this process is alive.
interface PauseState {
  /** Epoch ms when the pause started. */
  pausedAt: number;
  /** Epoch ms when the pause expires. */
  pausedUntil: number;
  /** Total pause duration in ms. */
  durationMs: number;
}

const pauseStates = new Map<string, PauseState>();

// Actual last-reconcile timestamp per project (for get_reconcile_status —
// never fabricated).
const lastReconcileAt = new Map<string, number>();

function projectKey(namespace: string | undefined, name: string): string {
  return `${namespace ?? NAMESPACE}/${name}`;
}

// Pause state recorded on the project CR itself. This is what lets a pause
// outlive the manager process that created it.
function annotationPauseState(project: Project): PauseState | undefined {
  const annotations = project.metadata?.annotations ?? {};
  if (annotations['percussionist.dev/reconcile-paused'] !== 'true') return undefined;
  const pausedAt = Date.parse(annotations['percussionist.dev/reconcile-paused-at'] ?? '');
  const durationSeconds = Number(annotations['percussionist.dev/reconcile-paused-duration'] ?? 0);
  if (!Number.isFinite(pausedAt) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return undefined;
  }
  return {
    pausedAt,
    durationMs: durationSeconds * 1000,
    pausedUntil: pausedAt + durationSeconds * 1000,
  };
}

// Effective pause state for a project: the in-memory entry wins while this
// process is alive; otherwise fall back to the project's annotations so a
// pause written by a previous manager process (or any external writer) is
// honored.
function effectivePauseState(project: Project): PauseState | undefined {
  return (
    pauseStates.get(projectKey(project.metadata.namespace, project.metadata.name)) ??
    annotationPauseState(project)
  );
}

// Pause reconciliation for a single project (used by MCP tools).
export function setPaused(
  projectName: string,
  v: boolean,
  durationMs = 0,
  namespace?: string,
): void {
  const key = projectKey(namespace, projectName);
  if (v) {
    const pausedAt = Date.now();
    pauseStates.set(key, { pausedAt, pausedUntil: pausedAt + durationMs, durationMs });
  } else {
    pauseStates.delete(key);
  }
}

// Per-project pause status with real elapsed/remaining times. Falls back to
// the project's annotations so a pause survives a manager restart.
export function getPauseStatus(project: Project): {
  paused: boolean;
  elapsedMs: number;
  remainingMs: number;
} {
  const state = effectivePauseState(project);
  const now = Date.now();
  if (!state) return { paused: false, elapsedMs: 0, remainingMs: 0 };
  if (state.pausedUntil > now) {
    return {
      paused: true,
      elapsedMs: Math.max(0, now - state.pausedAt),
      remainingMs: state.pausedUntil - now,
    };
  }
  // Expired: report the full elapsed duration and 0 remaining.
  return { paused: false, elapsedMs: state.durationMs, remainingMs: 0 };
}

// Actual timestamp of the last successful reconcile for a project, or
// undefined if it has not been reconciled in this process.
export function getLastReconcile(project: Project): string | undefined {
  const ts = lastReconcileAt.get(projectKey(project.metadata.namespace, project.metadata.name));
  return ts === undefined ? undefined : new Date(ts).toISOString();
}

// Enqueue a project for reconciliation.
export function enqueue(project: Project): void {
  const key = `${project.metadata.namespace ?? NAMESPACE}/${project.metadata.name}`;
  queue.add(key);
}

// Dequeue a project (on delete).
export function dequeue(key: string): void {
  queue.delete(key);
}

// Reconcile a single project (called by runWorker).
export async function reconcile(project: Project): Promise<void> {
  const key = projectKey(project.metadata.namespace, project.metadata.name);

  // Per-project pause check — in-memory map first, then the project CR's
  // annotations so a pause survives a manager restart.
  const pause = effectivePauseState(project);
  if (pause && pause.pausedUntil > Date.now()) {
    console.log(`[reconcile] ${project.metadata.name} paused, skipping`);
    return;
  }

  // Call the new phase-driven reconciler.
  await reconcileProject(project, project.metadata.namespace ?? NAMESPACE);
  lastReconcileAt.set(key, Date.now());
}

/**
 * Options for the worker loop — injectable so tests can drive it with tiny
 * delays and a bounded iteration count; production callers use the defaults.
 */
export interface RunWorkerOptions {
  /** Sleep between polls while the queue is empty (default 1000ms). */
  queueEmptyDelayMs?: number;
  /** Backoff after a genuine (non-404) reconcile error (default 5000ms). */
  errorBackoffMs?: number;
  /** Delay between consecutive queue items (default 100ms). */
  interProjectDelayMs?: number;
  /** Test escape hatch: stop the loop after this many iterations. */
  maxIterations?: number;
}

// Worker loop: processes the queue. Pausing is per project and enforced inside
// reconcile(), so a paused project is skipped without freezing the others.
export async function runWorker(opts: RunWorkerOptions = {}): Promise<void> {
  const queueEmptyDelayMs = opts.queueEmptyDelayMs ?? 1000;
  const errorBackoffMs = opts.errorBackoffMs ?? ERROR_BACKOFF_MS;
  const interProjectDelayMs = opts.interProjectDelayMs ?? 100;
  let iterations = 0;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, no-constant-condition
  while (true) {
    if (opts.maxIterations !== undefined && iterations >= opts.maxIterations) return;
    iterations++;

    if (queue.size === 0) {
      await new Promise((resolve) => setTimeout(resolve, queueEmptyDelayMs));
      continue;
    }

    // Take one project from the queue.
    const key = queue.values().next().value as string;
    queue.delete(key);

    try {
      const parts = key.split('/');
      let namespace = NAMESPACE;
      let name = key;
      if (parts.length === 2) {
        [namespace, name] = parts as [string, string];
      }
      const project = await getProject(name, namespace);
      if (!project) {
        console.log(`[runWorker] project ${key} not found, skipping`);
        continue;
      }
      await reconcile(project);
    } catch (e) {
      // A deleted project must be dropped, not retried. getProject throws a 404
      // rather than returning undefined, so the `!project` guard above is
      // unreachable and the throw landed here — where the key was re-enqueued
      // unconditionally. With only the 100ms inter-project delay that became a
      // hot loop: one deleted project logged thousands of identical stack
      // traces per minute, burying real reconcile errors in noise. The periodic
      // resync re-adds the project if it ever comes back, so forgetting it here
      // costs nothing.
      if (isNotFoundError(e)) {
        console.log(`[runWorker] project ${key} is gone, dropping from queue`);
        continue;
      }
      console.error(`[runWorker] ${key} error:`, e);
      // Genuine failure — retry, but back off so a persistently failing project
      // cannot saturate the loop either.
      queue.add(key);
      await new Promise((resolve) => setTimeout(resolve, errorBackoffMs));
    }

    // Small delay between projects.
    await new Promise((resolve) => setTimeout(resolve, interProjectDelayMs));
  }
}

// Periodic resync: re-enqueue all projects every 60 seconds.
export function startPeriodicResync(): void {
  setInterval(async () => {
    console.log('[periodicResync] triggering resync');
    try {
      const res = await k8s.listNamespacedCustomObject({
        group: API_GROUP,
        version: API_VERSION,
        namespace: NAMESPACE,
        plural: PLURAL_PROJECT,
      });
      const items = (res as { items: Project[] }).items ?? [];
      for (const project of items) {
        enqueue(project);
      }
      console.log(`[periodicResync] re-enqueued ${items.length} project(s)`);
    } catch (e) {
      console.error('[periodicResync] failed to list projects:', e);
    }
  }, 60000);
}
