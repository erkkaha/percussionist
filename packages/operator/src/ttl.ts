// ttl.ts — periodic cleanup of expired Run CRs past their retention period.
// Reads runTTLDays from ClusterSettings and deletes terminal-phase Runs
// whose completedAt + runTTLDays is in the past.

import {
  API_GROUP,
  API_VERSION,
  PLURAL_RUN,
  PLURAL_CLUSTER_SETTINGS,
  TERMINAL_PHASES,
  type Run,
  type ClusterSettings,
} from "@percussionist/api";
import { co, NAMESPACE } from "./reconciler.js";

const log = (...args: unknown[]) =>
  console.log(`[ttl ${new Date().toISOString()}]`, ...args);
const err = (...args: unknown[]) =>
  console.error(`[ttl ${new Date().toISOString()}]`, ...args);

const RUN_TTL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

function isNotFound(e: unknown): boolean {
  return ((e as { statusCode?: number; code?: number }).statusCode ?? (e as { code?: number }).code) === 404;
}

async function fetchRunTTLDays(): Promise<number> {
  try {
    const cs = await co.getClusterCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      plural: PLURAL_CLUSTER_SETTINGS,
      name: "default",
    }) as ClusterSettings;
    return cs.spec?.runTTLDays ?? 7;
  } catch {
    return 7; // Default if ClusterSettings not found.
  }
}

async function listTerminalRuns(): Promise<Run[]> {
  try {
    const res = await co.listNamespacedCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      namespace: NAMESPACE,
      plural: PLURAL_RUN,
    }) as { items: Run[] };
    return (res.items ?? []).filter((r) => {
      const phase = r.status?.phase;
      return phase && TERMINAL_PHASES.has(phase);
    });
  } catch (e) {
    err(`listTerminalRuns:`, (e as Error).message);
    return [];
  }
}

function isExpired(run: Run, ttlDays: number): boolean {
  const completedAt = run.status?.completedAt;
  if (!completedAt) return false;
  const deadline = new Date(completedAt).getTime() + ttlDays * 86400 * 1000;
  return Date.now() > deadline;
}

export async function runTTLCleanup(): Promise<void> {
  const ttlDays = await fetchRunTTLDays();
  const runs = await listTerminalRuns();
  let deleted = 0;

  for (const run of runs) {
    if (!isExpired(run, ttlDays)) continue;
    const name = run.metadata.name;
    try {
      await co.deleteNamespacedCustomObject({
        group: API_GROUP,
        version: API_VERSION,
        namespace: NAMESPACE,
        plural: PLURAL_RUN,
        name,
      });
      log(`deleted expired Run ${name} (past ${ttlDays}d TTL)`);
      deleted++;
    } catch (e: unknown) {
      if (!isNotFound(e)) {
        err(`delete Run ${name}:`, (e as Error).message);
      }
    }
  }

  if (deleted > 0) {
    log(`cleanup complete: ${deleted} Run(s) deleted`);
  }
}

let intervalHandle: ReturnType<typeof setInterval> | undefined;

export function startTTLCleanup(): void {
  if (intervalHandle) return;
  log(`starting TTL cleanup every ${RUN_TTL_INTERVAL_MS / 1000}s`);
  runTTLCleanup(); // Run immediately on startup.
  intervalHandle = setInterval(runTTLCleanup, RUN_TTL_INTERVAL_MS);
  intervalHandle.unref();
}
