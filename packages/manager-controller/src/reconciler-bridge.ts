// Reconciler bridge — maintains old API for index.ts while using new phase-driven reconciler.

import { KubeConfig, CustomObjectsApi } from "@kubernetes/client-node";
import { API_GROUP, API_VERSION, PLURAL_PROJECT, type Project } from "@percussionist/api";
import { NAMESPACE, getProject } from "@percussionist/kube";
import { reconcileProject } from "./reconciler/index.js";

export { NAMESPACE };

// K8s client setup (re-exported for index.ts).
export const kc = new KubeConfig();
try {
  kc.loadFromCluster();
} catch {
  kc.loadFromDefault();
}
export const k8s = kc.makeApiClient(CustomObjectsApi);

// Work queue: project names that need reconciliation.
const queue = new Set<string>();
let pausedUntil = 0;

// Pause reconciliation for a project (used by MCP tools).
export function setPaused(v: boolean, durationMs = 0): void {
  if (v) {
    pausedUntil = Date.now() + durationMs;
  } else {
    pausedUntil = 0;
  }
}

// Get pause status.
export function getPauseStatus(): { paused: boolean; elapsedMs: number; remainingMs: number } {
  const now = Date.now();
  if (pausedUntil > now) {
    return { paused: true, elapsedMs: 0, remainingMs: pausedUntil - now };
  }
  return { paused: false, elapsedMs: 0, remainingMs: 0 };
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
  // Check if paused.
  if (pausedUntil > Date.now()) {
    console.log(`[reconcile] paused, skipping ${project.metadata.name}`);
    return;
  }

  // Call the new phase-driven reconciler.
  await reconcileProject(project, project.metadata.namespace ?? NAMESPACE);
}

// Worker loop: processes the queue.
export async function runWorker(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, no-constant-condition
  while (true) {
    if (queue.size === 0 || pausedUntil > Date.now()) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    // Take one project from the queue.
    const key = queue.values().next().value as string;
    queue.delete(key);

    try {
      const parts = key.split("/");
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
      console.error(`[runWorker] ${key} error:`, e);
      // Re-enqueue on error.
      queue.add(key);
    }

    // Small delay between projects.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// Periodic resync: re-enqueue all projects every 60 seconds.
export function startPeriodicResync(): void {
  setInterval(async () => {
    console.log("[periodicResync] triggering resync");
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
      console.error("[periodicResync] failed to list projects:", e);
    }
  }, 60000);
}
