// ttl.ts — periodic cleanup of expired Run CRs past their retention period.
// Reads runTTLDays from ClusterSettings and deletes terminal-phase Runs
// whose completedAt + runTTLDays is in the past.

import { CoreV1Api } from '@kubernetes/client-node';
import {
  API_GROUP,
  API_VERSION,
  type ClusterSettings,
  PLURAL_CLUSTER_SETTINGS,
  PLURAL_RUN,
  type Run,
  TERMINAL_PHASES,
} from '@percussionist/api';
import { gitUrlHash } from '@percussionist/kube';
import { co, kc, NAMESPACE } from './reconciler.js';

const coreV1 = kc.makeApiClient(CoreV1Api);

const log = (...args: unknown[]) => console.log(`[ttl ${new Date().toISOString()}]`, ...args);
const err = (...args: unknown[]) => console.error(`[ttl ${new Date().toISOString()}]`, ...args);

const RUN_TTL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

function isNotFound(e: unknown): boolean {
  return (
    ((e as { statusCode?: number; code?: number }).statusCode ?? (e as { code?: number }).code) ===
    404
  );
}

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
      cleanupExpiredRunWorktree(run).catch(() => {});
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

/**
 * Spawn a fire-and-forget pod to remove a run's worktree directory from the PVC.
 */
async function cleanupExpiredRunWorktree(run: Run): Promise<void> {
  const runName = run.metadata.name;
  const projectName = run.metadata.labels?.['percussionist.dev/project'];
  if (!projectName) return;

  const dataMountPath = '/data';
  const worktreeDir = `${dataMountPath}/worktrees/${runName}`;
  const gitUrl = (run.spec as { source?: { git?: { url?: string } } } | undefined)?.source?.git
    ?.url;

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
      'fi',
    );
  }

  scriptLines.push('echo "[cleanup-ttl] done"');

  const podName = `cleanup-ttl-${runName}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 63)
    .replace(/-+$/, '');

  const pod = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: podName, namespace: NAMESPACE },
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
          persistentVolumeClaim: { claimName: `${projectName}-data` },
        },
      ],
    },
  };

  try {
    await coreV1.createNamespacedPod({ namespace: NAMESPACE, body: pod });
    log(`cleanup pod ${podName} created for run ${runName}`);
  } catch (e: unknown) {
    if ((e as { statusCode?: number }).statusCode !== 409) {
      err(`cleanup pod for ${runName}:`, (e as Error).message);
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
