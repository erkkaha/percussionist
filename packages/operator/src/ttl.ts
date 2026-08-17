// ttl.ts — periodic cleanup of expired Run CRs past their retention period.
// Reads runTTLDays from ClusterSettings and deletes terminal-phase Runs
// whose completedAt + runTTLDays is in the past.

import { BatchV1Api } from '@kubernetes/client-node';
import {
  API_GROUP,
  API_VERSION,
  type ClusterSettings,
  PLURAL_CLUSTER_SETTINGS,
  PLURAL_RUN,
  type Run,
  TERMINAL_PHASES,
} from '@percussionist/api';
import { gitUrlHash, isNotFoundError, makeNodeApiClient } from '@percussionist/kube';
import { co, kc, NAMESPACE } from './reconciler.js';

const batchV1 = makeNodeApiClient(kc, BatchV1Api);

const CLEANUP_JOB_TTL_SECONDS = 3600;

const log = (...args: unknown[]) => console.log(`[ttl ${new Date().toISOString()}]`, ...args);
const err = (...args: unknown[]) => console.error(`[ttl ${new Date().toISOString()}]`, ...args);

const RUN_TTL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

async function fetchRunTTLDays(): Promise<number> {
  try {
    const cs = (await co.getClusterCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      plural: PLURAL_CLUSTER_SETTINGS,
      name: 'default',
    })) as ClusterSettings;
    return cs.spec?.runTTLDays ?? 7;
  } catch {
    return 7; // Default if ClusterSettings not found.
  }
}

async function listTerminalRuns(): Promise<Run[]> {
  try {
    const res = (await co.listNamespacedCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      namespace: NAMESPACE,
      plural: PLURAL_RUN,
    })) as { items: Run[] };
    return (res.items ?? []).filter((r) => {
      const phase = r.status?.phase;
      return phase && TERMINAL_PHASES.has(phase);
    });
  } catch (e) {
    err(`listTerminalRuns:`, (e as Error).message);
    return [];
  }
}

export function expiryDeadline(run: Run, ttlDays: number): number | undefined {
  const completedAt = run.status?.completedAt;
  if (!completedAt) return undefined;
  const ttlSeconds = run.spec.ttlSecondsAfterFinished ?? ttlDays * 86400;
  return new Date(completedAt).getTime() + ttlSeconds * 1000;
}

export function isExpired(run: Run, ttlDays: number): boolean {
  const deadline = expiryDeadline(run, ttlDays);
  if (deadline === undefined) return false;
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
      if (!isNotFoundError(e)) {
        err(`delete Run ${name}:`, (e as Error).message);
      }
    }
  }

  if (deleted > 0) {
    log(`cleanup complete: ${deleted} Run(s) deleted`);
  }
}

/**
 * Build the batch/v1 Job spec that removes a run's worktree directory (and
 * prunes its git mirror worktree/branch) from the data PVC. Pure so it's
 * unit-testable without a cluster.
 */
export function buildCleanupJob(run: Run) {
  const runName = run.metadata.name;
  const projectName = run.metadata.labels?.['percussionist.dev/project'];
  const dataPvcName = run.spec.data?.pvcName ?? `${projectName}-data`;
  const dataMountPath = run.spec.data?.mountPath ?? '/data';
  const worktreeDir = `${dataMountPath}/worktrees/${runName}`;
  const gitUrl = run.spec.source?.git?.url;

  const scriptLines: string[] = [
    'set -e',
    `echo "[cleanup-ttl] removing worktree ${worktreeDir}"`,
    `BRANCH=$(git -C ${worktreeDir} symbolic-ref HEAD 2>/dev/null || true)`,
    `rm -rf ${worktreeDir}`,
  ];

  if (gitUrl) {
    const hash = gitUrlHash(gitUrl);
    const mirrorDir = `${dataMountPath}/git-mirrors/${hash}`;
    scriptLines.push(
      `if [ -d "${mirrorDir}" ]; then`,
      `  echo "[cleanup-ttl] pruning mirror ${mirrorDir}"`,
      `  git -C "${mirrorDir}" worktree prune --expire=now 2>/dev/null || true`,
      `  if [ -n "$BRANCH" ]; then`,
      `    echo "[cleanup-ttl] deleting branch ref \${BRANCH#refs/heads/}"`,
      `    git -C "${mirrorDir}" branch -D "\${BRANCH#refs/heads/}" 2>/dev/null || true`,
      `  fi`,
      `  echo "[cleanup-ttl] repacking mirror objects"`,
      `  git -C "${mirrorDir}" gc --auto 2>/dev/null || true`,
      'fi',
    );
  }

  scriptLines.push('echo "[cleanup-ttl] done"');

  const jobName = `cleanup-ttl-${runName}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 63)
    .replace(/-+$/, '');

  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: jobName, namespace: NAMESPACE },
    spec: {
      ttlSecondsAfterFinished: CLEANUP_JOB_TTL_SECONDS,
      backoffLimit: 2,
      template: {
        spec: {
          restartPolicy: 'Never',
          containers: [
            {
              name: 'cleanup',
              image: 'alpine/git',
              imagePullPolicy: 'IfNotPresent',
              command: ['/bin/sh', '-c'],
              args: [scriptLines.join('\n')],
              resources: {
                requests: { cpu: '50m', memory: '64Mi' },
                limits: { cpu: '200m', memory: '256Mi' },
              },
              volumeMounts: [{ name: 'data', mountPath: dataMountPath }],
            },
          ],
          volumes: [
            {
              name: 'data',
              persistentVolumeClaim: { claimName: dataPvcName },
            },
          ],
        },
      },
    },
  };
}

/**
 * Spawn a fire-and-forget Job to remove a run's worktree directory from the
 * PVC. Deterministically named so a 409 on create just means one is already
 * in flight for this run.
 */
export async function spawnWorktreeCleanupJob(run: Run): Promise<void> {
  const runName = run.metadata.name;
  const projectName = run.metadata.labels?.['percussionist.dev/project'];
  if (!projectName && !run.spec.data?.pvcName) return;

  const job = buildCleanupJob(run);

  try {
    await batchV1.createNamespacedJob({ namespace: NAMESPACE, body: job });
    log(`cleanup job ${job.metadata.name} created for run ${runName}`);
  } catch (e: unknown) {
    if ((e as { statusCode?: number }).statusCode !== 409) {
      err(`cleanup job for ${runName}:`, (e as Error).message);
    }
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
