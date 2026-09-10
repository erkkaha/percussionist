// git-publish.ts — publish the run's branch to a namespaced remote ref.
//
// On worker-run completion the dispatcher pushes HEAD to
// refs/percussionist/<branch> on the real remote. That makes the remote the
// durable copy of in-flight task branches (which otherwise exist only in the
// node-local git mirror), so review/merge/child runs can reconstruct them on
// any mirror. The push is soft-fail by design: the mirror path keeps working
// exactly as before, and a project running with read-only credentials (e.g.
// `manual` integration mode) must not have every run bricked by a rejected
// push. Callers surface the failure in the completion summary instead.
//
// Security: this code runs in the dispatcher container, which holds the pod's
// only ServiceAccount token, while the repo config and hooks it touches live
// in the agent-writable shared mirror. Every git invocation therefore disables
// config-driven code execution (fsmonitor, hooks) and config-defined
// credential helpers; auth comes only from the GIT_SSH_COMMAND env var (which
// overrides core.sshCommand config) or the GITHUB_TOKEN env var via an inline
// helper.

import { execFile } from 'node:child_process';

export const DEFAULT_WORKSPACE = '/workspace';
const PUSH_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2_000;

/**
 * Resolve the workspace root used for git operations.
 *
 * Precedence: explicit `cwd` override, then the `WORKSPACE_DIR` env var, then
 * the production default `/workspace`. Resolution happens per call (not at
 * module load) so callers and tests can override it at runtime.
 */
export function resolveWorkspaceRoot(override?: string): string {
  return override ?? process.env.WORKSPACE_DIR ?? DEFAULT_WORKSPACE;
}

/** Hardening flags for running git in the agent-writable workspace. */
export function gitHardeningFlags(): string[] {
  const flags = [
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'credential.helper=',
  ];
  if (process.env.GITHUB_TOKEN) {
    flags.push(
      '-c',
      'credential.helper=!f() { echo "username=x-access-token"; echo "password=$GITHUB_TOKEN"; }; f',
    );
  }
  return flags;
}

function git(
  args: string[],
  timeoutMs: number,
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...gitHardeningFlags(), ...args],
      { maxBuffer: 1024 * 1024, timeout: timeoutMs, cwd },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`${(err as Error).message}\n${stderr ?? ''}`.trim()));
          return;
        }
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type PublishResult = { ok: true; skipped?: string } | { ok: false; error: string };

/**
 * Push the workspace HEAD to refs/percussionist/<RUN_GIT_BRANCH> on origin.
 * No-ops (ok, skipped) when RUN_GIT_BRANCH is unset — local-git and
 * no-source runs — or when the workspace is not a git repository.
 *
 * The workspace root is resolved per call from the optional `cwd` override,
 * then the `WORKSPACE_DIR` env var, then `/workspace` (see
 * `resolveWorkspaceRoot`); the production default is unchanged.
 *
 * Exported as a mutable object property so tests can replace it without
 * module-level mocking (ESM live bindings limitation, same as gitCheck).
 */
export const gitPublish = {
  publishWorkerBranch: async (options?: { cwd?: string }): Promise<PublishResult> => {
    const branch = process.env.RUN_GIT_BRANCH;
    if (!branch) return { ok: true, skipped: 'RUN_GIT_BRANCH not set' };

    const cwd = resolveWorkspaceRoot(options?.cwd);

    try {
      await git(['rev-parse', '--is-inside-work-tree'], 10_000, cwd);
    } catch {
      return { ok: true, skipped: 'not a git worktree' };
    }

    let lastError = '';
    for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
      try {
        await git(['push', 'origin', `HEAD:refs/percussionist/${branch}`], 60_000, cwd);
        console.log(`[git-publish] pushed HEAD to refs/percussionist/${branch}`);
        return { ok: true };
      } catch (e) {
        lastError = (e as Error).message;
        console.error(
          `[git-publish] push attempt ${attempt}/${PUSH_ATTEMPTS} failed: ${lastError}`,
        );
        if (attempt < PUSH_ATTEMPTS) await sleep(RETRY_DELAY_MS * attempt);
      }
    }
    return { ok: false, error: lastError };
  },
};
