// worktree-cleanup.ts — spawns a short-lived Pod to remove a run's worktree
// from the project data PVC once the task transitions to "done".
//
// The cleanup pod mounts the data PVC, removes the worktree directory for the
// completed run, and calls `git worktree prune` on the bare mirror so git's
// internal metadata stays consistent.
//
// The pod is created with `restartPolicy: Never` and carries an owner
// reference to the Task CR so it is garbage-collected when the task is
// eventually deleted.

import { core, gitUrlHash } from "@percussionist/kube";
import { API_GROUP_VERSION, KIND_TASK, LABELS, MANAGED_BY } from "@percussionist/api";
import type { Task } from "@percussionist/api";

const log = (...args: unknown[]) =>
  console.log(`[worktree-cleanup ${new Date().toISOString()}]`, ...args);
const err = (...args: unknown[]) =>
  console.error(`[worktree-cleanup ${new Date().toISOString()}]`, ...args);

function cleanupPodName(prefix: string, name: string): string {
  const suffix = Date.now().toString(36).slice(-6);
  return `${prefix}-${name}-${suffix}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63).replace(/-+$/, "");
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface WorktreeCleanupOptions {
  task: Task;
  runName: string;
  projectName: string;
  namespace: string;
  /** Runner image — must have git and sh available. */
  image: string;
  /** Mount path of the data PVC (default /data). */
  dataMountPath?: string;
  /** PVC name (default {project}-data). */
  dataPvcName?: string;
  /** Git URL, used to derive the mirror directory hash. Omit for local workspaces. */
  gitUrl?: string;
}

export interface TaskWorktreeCleanupOptions {
  task: Task;
  projectName: string;
  namespace: string;
  /** Runner image — must have git and sh available. */
  image: string;
  /** Mount path of the data PVC (default /data). */
  dataMountPath?: string;
  /** PVC name (default {project}-data). */
  dataPvcName?: string;
  /** Git URL, used to derive the mirror directory hash. Omit for local workspaces. */
  gitUrl?: string;
}

/**
 * Spawns a cleanup pod that:
 *  1. Removes /data/worktrees/{runName}/ from the data PVC
 *  2. Calls `git worktree prune` on the bare mirror (if gitUrl is set)
 *
 * The pod is fire-and-forget — errors are logged but not surfaced to the
 * caller to avoid blocking task state transitions.
 */
export async function spawnWorktreeCleanupPod(
  opts: WorktreeCleanupOptions,
): Promise<void> {
  const {
    task,
    runName,
    projectName,
    namespace,
    image,
    dataMountPath = "/data",
    dataPvcName = `${projectName}-data`,
    gitUrl,
  } = opts;

  const podName = cleanupPodName("cleanup", runName);
  const mirrorDir = gitUrl
    ? `${dataMountPath}/git-mirrors/${gitUrlHash(gitUrl)}`
    : undefined;
  const worktreeDir = `${dataMountPath}/worktrees/${runName}`;

  const script = [
    "set -e",
    `echo "[cleanup] removing worktree ${worktreeDir}"`,
    `rm -rf ${shQuote(worktreeDir)}`,
    ...(mirrorDir
      ? [
          `echo "[cleanup] pruning git worktree metadata in ${mirrorDir}"`,
          `if [ -d "${mirrorDir}" ]; then`,
          `  git -C "${mirrorDir}" worktree prune --expire=now 2>/dev/null || true`,
          `fi`,
        ]
      : []),
    `echo "[cleanup] done"`,
  ].join("\n");

  const pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: podName,
      namespace,
      labels: {
        [LABELS.managedBy]: MANAGED_BY,
        [LABELS.projectName]: projectName,
        "percussionist.dev/component": "worktree-cleanup",
        "percussionist.dev/run": runName,
      },
      ownerReferences: [
        {
          apiVersion: API_GROUP_VERSION,
          kind: KIND_TASK,
          name: task.metadata.name,
          uid: task.metadata.uid!,
          controller: false,
          blockOwnerDeletion: false,
        },
      ],
    },
    spec: {
      restartPolicy: "Never",
      containers: [
        {
          name: "cleanup",
          image,
          imagePullPolicy: "IfNotPresent",
          command: ["/bin/sh", "-c"],
          args: [script],
          resources: {
            requests: { cpu: "50m", memory: "64Mi" },
            limits: { cpu: "200m", memory: "256Mi" },
          },
          volumeMounts: [
            { name: "data", mountPath: dataMountPath },
          ],
        },
      ],
      volumes: [
        { name: "data", persistentVolumeClaim: { claimName: dataPvcName } },
      ],
    },
  };

  try {
    await core().createNamespacedPod({ namespace, body: pod });
    log(`cleanup pod ${namespace}/${podName} created for run ${runName}`);
  } catch (e: unknown) {
    const statusCode =
      (e as { statusCode?: number }).statusCode ??
      (e as { code?: number }).code;
    if (statusCode === 409) {
      log(`cleanup pod ${namespace}/${podName} already exists, skipping`);
      return;
    }
    // Log but don't re-throw — cleanup failure must not block task transition.
    err(`failed to create cleanup pod for run ${runName}:`, (e as Error).message);
  }
}

/**
 * Spawns a cleanup pod that removes ALL worktrees for a task from the data PVC.
 * Used when a task moves to "done" to clean up all runs (retries/rework).
 *
 * The pod:
 *  1. Removes all /data/worktrees/{projectName}-* directories matching the task
 *  2. Calls `git worktree prune` on the bare mirror (if gitUrl is set)
 *
 * Fire-and-forget — errors are logged but not surfaced to avoid blocking task transitions.
 */
export async function spawnTaskWorktreeCleanupPod(
  opts: TaskWorktreeCleanupOptions,
): Promise<void> {
  const {
    task,
    projectName,
    namespace,
    image,
    dataMountPath = "/data",
    dataPvcName = `${projectName}-data`,
    gitUrl,
  } = opts;

  const taskName = task.metadata.name;
  const podName = cleanupPodName("cleanup-task", taskName);
  const mirrorDir = gitUrl
    ? `${dataMountPath}/git-mirrors/${gitUrlHash(gitUrl)}`
    : undefined;
  const worktreeDir = `${dataMountPath}/worktrees`;

  const sanitizedTaskName = taskName.toLowerCase().replace(/[^a-z0-9]/g, "-");
  const runPrefix = `${projectName}-${sanitizedTaskName}`;

  // Remove all deterministic worker worktrees for this task.
  const script = [
    "set -e",
    `echo "[cleanup] removing all worktrees for task ${taskName}"`,
    `cd ${shQuote(worktreeDir)} || exit 0`, // Exit gracefully if worktree dir doesn't exist
    `for dir in ${shQuote(runPrefix)}-*; do`,
    `  [ -e "$dir" ] || continue`,
    `  case "$dir" in`,
    `    ${runPrefix}-??????????) ;;`,
    `    *) continue ;;`,
    `  esac`,
    `    echo "[cleanup] removing $dir"`,
    `    rm -rf "$dir"`,
    `done`,
    ...(mirrorDir
      ? [
          `echo "[cleanup] pruning git worktree metadata in ${mirrorDir}"`,
          `if [ -d "${mirrorDir}" ]; then`,
          `  git -C "${mirrorDir}" worktree prune --expire=now 2>/dev/null || true`,
          `fi`,
        ]
      : []),
    `echo "[cleanup] done"`,
  ].join("\n");

  const pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: podName,
      namespace,
      labels: {
        [LABELS.managedBy]: MANAGED_BY,
        [LABELS.projectName]: projectName,
        "percussionist.dev/component": "worktree-cleanup",
        "percussionist.dev/task": taskName,
      },
      ownerReferences: [
        {
          apiVersion: API_GROUP_VERSION,
          kind: KIND_TASK,
          name: taskName,
          uid: task.metadata.uid!,
          controller: false,
          blockOwnerDeletion: false,
        },
      ],
    },
    spec: {
      restartPolicy: "Never",
      containers: [
        {
          name: "cleanup",
          image,
          imagePullPolicy: "IfNotPresent",
          command: ["/bin/sh", "-c"],
          args: [script],
          resources: {
            requests: { cpu: "50m", memory: "64Mi" },
            limits: { cpu: "200m", memory: "256Mi" },
          },
          volumeMounts: [
            { name: "data", mountPath: dataMountPath },
          ],
        },
      ],
      volumes: [
        { name: "data", persistentVolumeClaim: { claimName: dataPvcName } },
      ],
    },
  };

  try {
    await core().createNamespacedPod({ namespace, body: pod });
    log(`task cleanup pod ${namespace}/${podName} created for task ${taskName}`);
  } catch (e: unknown) {
    const statusCode =
      (e as { statusCode?: number }).statusCode ??
      (e as { code?: number }).code;
    if (statusCode === 409) {
      log(`task cleanup pod ${namespace}/${podName} already exists, skipping`);
      return;
    }
    // Log but don't re-throw — cleanup failure must not block task transition.
    err(`failed to create task cleanup pod for task ${taskName}:`, (e as Error).message);
  }
}
