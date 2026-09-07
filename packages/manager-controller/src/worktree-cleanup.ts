// worktree-cleanup.ts — spawns a short-lived Job to remove a run's worktree
// from the project data PVC once the task transitions to "done".
//
// The cleanup Job mounts the data PVC, removes the worktree directory for the
// completed run, and calls `git worktree prune` on the bare mirror so git's
// internal metadata stays consistent.
//
// It is a Job rather than a bare Pod so the job controller reaps it (and its
// pod) via `ttlSecondsAfterFinished` — bare pods stayed in Completed forever
// and piled up by the hundreds. It also carries an owner reference to the
// Task CR so it is garbage-collected early when the task is deleted.

import type { Task } from '@percussionist/api';
import { API_GROUP_VERSION, KIND_TASK, LABELS, MANAGED_BY } from '@percussionist/api';
import { batch, gitUrlHash } from '@percussionist/kube';
import { getErrorStatusCode } from './kube-errors.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Finished cleanup Jobs (and their pods) are deleted by the job controller after this long. */
const CLEANUP_JOB_TTL_SECONDS = 3600;

const log = (...args: unknown[]) =>
  console.log(`[worktree-cleanup ${new Date().toISOString()}]`, ...args);
const err = (...args: unknown[]) =>
  console.error(`[worktree-cleanup ${new Date().toISOString()}]`, ...args);

async function retryCreateJob(
  namespace: string,
  job: object,
  runName: string,
  jobName: string,
  maxRetries = 3,
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await batch().createNamespacedJob({ namespace, body: job });
      log(`cleanup job ${namespace}/${jobName} created for run ${runName}`);
      return;
    } catch (e: unknown) {
      const statusCode = getErrorStatusCode(e);
      if (statusCode === 409) {
        log(`cleanup job ${namespace}/${jobName} already exists, skipping`);
        return;
      }
      if (attempt < maxRetries) {
        err(
          `failed to create cleanup job for run ${runName} (attempt ${attempt}/${maxRetries}):`,
          (e as Error).message,
        );
        await sleep(2000 * attempt);
      } else {
        err(
          `failed to create cleanup job for run ${runName} after ${maxRetries} attempts:`,
          (e as Error).message,
        );
      }
    }
  }
}

function cleanupJobName(prefix: string, name: string): string {
  const suffix = Date.now().toString(36).slice(-6);
  return `${prefix}-${name}-${suffix}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 63)
    .replace(/-+$/, '');
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
  /**
   * Exact run names to remove in addition to the worker-prefix glob match.
   * Covers auxiliary runs (review/buildgen/merge) whose names don't match the
   * deterministic worker-run suffix pattern.
   */
  runNames?: string[];
  /**
   * Branch names whose refs/percussionist/<branch> namespaced refs should be
   * deleted from the remote. Passed explicitly (task.status.worker.gitBranch)
   * because worktree-HEAD sniffing fails when per-run cleanup jobs already
   * removed the trees.
   */
  branches?: string[];
  /** SSH key secret for the remote ref deletion (project source.git.sshSecret). */
  sshSecret?: { name: string; key?: string };
  /** GitHub token secret for the remote ref deletion (project source.git.githubTokenSecret). */
  githubTokenSecret?: { name: string; key?: string };
}

/**
 * Spawns a cleanup job that:
 *  1. Removes /data/worktrees/{runName}/ from the data PVC
 *  2. Calls `git worktree prune` on the bare mirror (if gitUrl is set)
 *
 * The Job is fire-and-forget — errors are logged but not surfaced to the
 * caller to avoid blocking task state transitions.
 */
export async function spawnWorktreeCleanupPod(opts: WorktreeCleanupOptions): Promise<void> {
  const {
    task,
    runName,
    projectName,
    namespace,
    image,
    dataMountPath = '/data',
    dataPvcName = `${projectName}-data`,
    gitUrl,
  } = opts;

  const jobName = cleanupJobName('cleanup', runName);
  const mirrorDir = gitUrl ? `${dataMountPath}/git-mirrors/${gitUrlHash(gitUrl)}` : undefined;
  const lockFile = gitUrl ? `${dataMountPath}/git-mirrors/${gitUrlHash(gitUrl)}.lock` : undefined;
  const worktreeDir = `${dataMountPath}/worktrees/${runName}`;

  const script = [
    'set -e',
    `echo "[cleanup] removing worktree ${worktreeDir}"`,
    `BRANCH=$(git -C ${shQuote(worktreeDir)} symbolic-ref HEAD 2>/dev/null || true)`,
    // A task-level cleanup job may be deleting the same tree concurrently;
    // entries vanishing mid-rm make rm exit non-zero, which is still success.
    `rm -rf ${shQuote(worktreeDir)} 2>/dev/null || true`,
    ...(mirrorDir
      ? [
          `if [ -d "${mirrorDir}" ]; then`,
          `  mkdir -p "$(dirname "${lockFile}")"`,
          `  (`,
          `    flock -x 200`,
          `    echo "[cleanup] pruning mirror ${mirrorDir}"`,
          `    git -C "${mirrorDir}" worktree prune --expire=now 2>/dev/null || true`,
          `    if [ -n "$BRANCH" ]; then`,
          `      echo "[cleanup] deleting branch ref \${BRANCH#refs/heads/}"`,
          `      git -C "${mirrorDir}" branch -D "\${BRANCH#refs/heads/}" 2>/dev/null || true`,
          `    fi`,
          `    echo "[cleanup] repacking mirror objects"`,
          `    git -C "${mirrorDir}" gc --auto 2>/dev/null || true`,
          `  ) 200>"${lockFile}"`,
          `fi`,
        ]
      : []),
    `echo "[cleanup] done"`,
  ].join('\n');

  const labels = {
    [LABELS.managedBy]: MANAGED_BY,
    [LABELS.projectName]: projectName,
    'percussionist.dev/component': 'worktree-cleanup',
    'percussionist.dev/run': runName,
  };

  const job = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace,
      labels,
      ownerReferences: [
        {
          apiVersion: API_GROUP_VERSION,
          kind: KIND_TASK,
          name: task.metadata.name,
          uid: task.metadata.uid ?? '',
          controller: false,
          blockOwnerDeletion: false,
        },
      ],
    },
    spec: {
      ttlSecondsAfterFinished: CLEANUP_JOB_TTL_SECONDS,
      backoffLimit: 0,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never',
          containers: [
            {
              name: 'cleanup',
              image,
              imagePullPolicy: 'IfNotPresent',
              command: ['/bin/sh', '-c'],
              args: [script],
              resources: {
                requests: { cpu: '50m', memory: '64Mi' },
                limits: { cpu: '200m', memory: '256Mi' },
              },
              volumeMounts: [{ name: 'data', mountPath: dataMountPath }],
            },
          ],
          volumes: [{ name: 'data', persistentVolumeClaim: { claimName: dataPvcName } }],
        },
      },
    },
  };

  await retryCreateJob(namespace, job, runName, jobName);
}

/**
 * Spawns a cleanup job that removes ALL worktrees for a task from the data PVC.
 * Used when a task moves to "done" to clean up all runs (retries/rework).
 *
 * The Job:
 *  1. Removes all /data/worktrees/{projectName}-* directories matching the
 *     deterministic worker-run suffix pattern for this task
 *  2. Removes each exact /data/worktrees/{name} directory in `runNames` —
 *     covers auxiliary (review/buildgen/merge) runs, whose names don't match
 *     the worker-prefix glob
 *  3. Calls `git worktree prune` on the bare mirror (if gitUrl is set)
 *
 * Fire-and-forget — errors are logged but not surfaced to avoid blocking task transitions.
 */
export async function spawnTaskWorktreeCleanupPod(opts: TaskWorktreeCleanupOptions): Promise<void> {
  const {
    task,
    projectName,
    namespace,
    image,
    dataMountPath = '/data',
    dataPvcName = `${projectName}-data`,
    gitUrl,
    runNames = [],
    branches = [],
    sshSecret,
    githubTokenSecret,
  } = opts;

  const taskName = task.metadata.name;
  const jobName = cleanupJobName('cleanup-task', taskName);
  const mirrorDir = gitUrl ? `${dataMountPath}/git-mirrors/${gitUrlHash(gitUrl)}` : undefined;
  const lockFile = gitUrl ? `${dataMountPath}/git-mirrors/${gitUrlHash(gitUrl)}.lock` : undefined;
  const worktreeDir = `${dataMountPath}/worktrees`;

  const sanitizedTaskName = taskName.toLowerCase().replace(/[^a-z0-9]/g, '-');
  const runPrefix = `${projectName}-${sanitizedTaskName}`;

  // Remove all deterministic worker worktrees for this task.
  const script = [
    'set -e',
    `echo "[cleanup] removing all worktrees for task ${taskName}"`,
    `cd ${shQuote(worktreeDir)} || exit 0`,
    // Seed with the explicitly passed branches — worktree-HEAD sniffing below
    // finds nothing when per-run cleanup jobs already removed the trees.
    `BRANCHES="${branches.map((b) => b.replace(/[^A-Za-z0-9/_.-]/g, '')).join(' ')}"`,
    `for dir in ${shQuote(runPrefix)}-*; do`,
    `  [ -e "$dir" ] || continue`,
    `  case "$dir" in`,
    `    ${runPrefix}-??????????) ;;`,
    `    *) continue ;;`,
    `  esac`,
    `    BRANCH=$(git -C "$dir" symbolic-ref HEAD 2>/dev/null || true)`,
    `    BRANCH="\${BRANCH#refs/heads/}"`,
    `    [ -n "$BRANCH" ] && BRANCHES="$BRANCHES $BRANCH"`,
    `    echo "[cleanup] removing $dir"`,
    // Concurrent run-level cleanup jobs may race on the same tree — see above.
    `    rm -rf "$dir" 2>/dev/null || true`,
    `done`,
    ...(runNames.length > 0
      ? [
          `for dir in ${runNames.map((name) => shQuote(`${worktreeDir}/${name}`)).join(' ')}; do`,
          `  [ -e "$dir" ] || continue`,
          `  BRANCH=$(git -C "$dir" symbolic-ref HEAD 2>/dev/null || true)`,
          `  BRANCH="\${BRANCH#refs/heads/}"`,
          `  [ -n "$BRANCH" ] && BRANCHES="$BRANCHES $BRANCH"`,
          `  echo "[cleanup] removing $dir"`,
          `  rm -rf "$dir" 2>/dev/null || true`,
          `done`,
        ]
      : []),
    ...(mirrorDir
      ? [
          `if [ -d "${mirrorDir}" ]; then`,
          `  mkdir -p "$(dirname "${lockFile}")"`,
          `  (`,
          `    flock -x 200`,
          `    echo "[cleanup] pruning mirror ${mirrorDir}"`,
          `    git -C "${mirrorDir}" worktree prune --expire=now 2>/dev/null || true`,
          `    for b in $BRANCHES; do`,
          `      echo "[cleanup] deleting branch ref $b"`,
          `      git -C "${mirrorDir}" branch -D "$b" 2>/dev/null || true`,
          `    done`,
          `    echo "[cleanup] repacking mirror objects"`,
          `    git -C "${mirrorDir}" gc --auto 2>/dev/null || true`,
          `  ) 200>"${lockFile}"`,
          // Delete the branches' namespaced remote refs (refs/percussionist/*,
          // published on run completion). Best-effort and outside the flock —
          // a slow network push must not block other runs' mirror fetches.
          `  export GIT_TERMINAL_PROMPT=0`,
          `  if [ -f /etc/git-ssh/id ]; then`,
          `    export GIT_SSH_COMMAND="ssh -i /etc/git-ssh/id -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"`,
          `  else`,
          `    export GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new"`,
          `  fi`,
          `  if [ -f /etc/git-github/token ]; then`,
          `    GITHUB_TOKEN=$(cat /etc/git-github/token); export GITHUB_TOKEN`,
          `    printf '#!/bin/sh\\ncase "$1" in Username*) echo x-access-token;; *) echo "$GITHUB_TOKEN";; esac\\n' > /tmp/askpass`,
          `    chmod +x /tmp/askpass; export GIT_ASKPASS=/tmp/askpass`,
          `  fi`,
          `  for b in $BRANCHES; do`,
          `    echo "[cleanup] deleting remote namespaced ref refs/percussionist/$b"`,
          `    git -C "${mirrorDir}" push origin ":refs/percussionist/$b" 2>&1 || true`,
          `  done`,
          `fi`,
        ]
      : []),
    `echo "[cleanup] done"`,
  ].join('\n');

  const labels = {
    [LABELS.managedBy]: MANAGED_BY,
    [LABELS.projectName]: projectName,
    'percussionist.dev/component': 'worktree-cleanup',
    [LABELS.taskId]: taskName,
  };

  const job = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace,
      labels,
      ownerReferences: [
        {
          apiVersion: API_GROUP_VERSION,
          kind: KIND_TASK,
          name: taskName,
          uid: task.metadata.uid ?? '',
          controller: false,
          blockOwnerDeletion: false,
        },
      ],
    },
    spec: {
      ttlSecondsAfterFinished: CLEANUP_JOB_TTL_SECONDS,
      backoffLimit: 0,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never',
          containers: [
            {
              name: 'cleanup',
              image,
              imagePullPolicy: 'IfNotPresent',
              command: ['/bin/sh', '-c'],
              args: [script],
              resources: {
                requests: { cpu: '50m', memory: '64Mi' },
                limits: { cpu: '200m', memory: '256Mi' },
              },
              volumeMounts: [
                { name: 'data', mountPath: dataMountPath },
                ...(sshSecret
                  ? [{ name: 'git-ssh', mountPath: '/etc/git-ssh', readOnly: true }]
                  : []),
                ...(githubTokenSecret
                  ? [{ name: 'git-github', mountPath: '/etc/git-github', readOnly: true }]
                  : []),
              ],
            },
          ],
          volumes: [
            { name: 'data', persistentVolumeClaim: { claimName: dataPvcName } },
            ...(sshSecret
              ? [
                  {
                    name: 'git-ssh',
                    secret: {
                      secretName: sshSecret.name,
                      items: [{ key: sshSecret.key ?? 'ssh-privatekey', path: 'id' }],
                      defaultMode: 0o400,
                    },
                  },
                ]
              : []),
            ...(githubTokenSecret
              ? [
                  {
                    name: 'git-github',
                    secret: {
                      secretName: githubTokenSecret.name,
                      items: [{ key: githubTokenSecret.key ?? 'token', path: 'token' }],
                    },
                  },
                ]
              : []),
          ],
        },
      },
    },
  };

  await retryCreateJob(namespace, job, taskName, jobName);
}
