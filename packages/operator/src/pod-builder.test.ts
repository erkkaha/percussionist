// pod-builder.test.ts — Tests for workspace-init shell script generation

/**
 * Tests for pod-builder.ts rendered script content.
 *
 * These tests verify that the workspace-init init container generates
 * correct shell scripts with parent-baseline resolution logic.
 *
 * Manual verification notes:
 * - Run `bun test` to execute these unit tests
 * - Verify generated shell script contains `_PARENT_REMOTE_REF` and `_PARENT_BASE_REF`
 * - Check both worktreeReuse=true and worktreeReuse=false code paths have identical logic
 * - Log messages should show "using remote-tracking ref" or "falling back to local ref"
 */

import { describe, expect, it } from 'bun:test';
import {
  CLAUDE_RUNNER_DEFAULTS,
  deriveEngine,
  OPENCODE_RUNNER_DEFAULTS,
  RUNNER_CONTAINER,
  type Run,
  runnerDefaultsFor,
} from '@percussionist/api';
import { WEB_AUTH_TOKEN } from './config.js';
import { renderPod, resolveAuthSecretKey } from './pod-builder.js';

// Helper to create a minimal Run CR with all required fields
function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Run',
    metadata: {
      name: 'test-run-123',
      namespace: 'test-ns',
      uid: 'test-uid-123',
      labels: { 'percussionist.dev/project': 'test-project' },
      creationTimestamp: new Date().toISOString(),
    },
    spec: {
      project: 'test-project',
      task: 'test-task',
      interactive: false,
      ttlSecondsAfterFinished: 604800, // 7 days
      source: {
        git: {
          url: 'https://github.com/test/repo.git',
          ref: 'main',
        },
      },
      image: 'ghcr.io/erkkaha/percussionist/runner:latest',
      timeoutSeconds: 3600,
    },
    status: {} as any,
    ...overrides,
  } as Run;
}

// Helper to extract the workspace-init init container
function getWorkspaceInitContainer(run: Run) {
  const pod = renderPod(run, []);
  return pod.spec?.initContainers?.find((c) => c.name === 'workspace-init');
}

// Helper to extract and join the args of the workspace-init container
function getWorkspaceInitArgs(run: Run): string {
  const container = getWorkspaceInitContainer(run);
  if (!container?.args || container.args.length === 0) {
    throw new Error('No workspace-init container found or no args');
  }
  // The args is an array of strings that get joined by \n
  return Array.isArray(container.args)
    ? (container.args as string[]).join('\n')
    : String(container.args);
}

function getDispatcherEnv(run: Run): Array<{ name?: string; value?: string }> {
  const pod = renderPod(run, []);
  const dispatcher = pod.spec?.containers?.find((c) => c.name === 'dispatcher');
  return (dispatcher?.env as Array<{ name?: string; value?: string }>) ?? [];
}

function getWorkspaceInitEnv(run: Run): Array<{ name?: string; value?: string }> {
  const pod = renderPod(run, []);
  const init = pod.spec?.initContainers?.find((c) => c.name === 'workspace-init');
  return (init?.env as Array<{ name?: string; value?: string }>) ?? [];
}

describe('renderPod - workspace-init script generation', () => {
  // The parent-baseline snippet is rendered by the shared renderAddWorktree
  // helper, identically in both worktreeReuse modes (the BUILD-8 suite below
  // pins that sharing). One behavioral test suffices: branching from a
  // parentRef must resolve the baseline as remote-tracking ref first, then
  // fall back to the local ref.
  describe('remote git with parentRef', () => {
    it('renders parent-baseline resolution when creating a branch from parentRef', () => {
      const run = makeRun({
        spec: {
          project: 'test-project',
          task: 'build-task-1',
          interactive: false,
          ttlSecondsAfterFinished: 604800,
          source: {
            git: {
              url: 'https://github.com/test/repo.git',
              ref: 'feature/child-branch',
              parentRef: 'feature/my-feature',
            },
          },
        },
      });

      const args = getWorkspaceInitArgs(run);

      // Prefer the freshly fetched remote-tracking ref as the baseline.
      expect(args).toContain('_PARENT_REMOTE_REF="refs/remotes/origin/$GIT_PARENT_REF"');
      expect(args).toContain('refs/remotes/origin/');
      // Fall back to the local ref when the remote-tracking ref does not exist
      // yet (first BUILD before the parent branch is pushed).
      expect(args).toContain('_PARENT_BASE_REF="$GIT_PARENT_REF"');
      expect(args).toContain('rev-parse "refs/heads/$GIT_PARENT_REF"');
    });
  });

  describe('no parentRef scenario', () => {
    it('should work without parentRef (plain branch creation)', () => {
      const run = makeRun({
        spec: {
          project: 'test-project',
          task: 'build-task-1',
          interactive: false,
          ttlSecondsAfterFinished: 604800,
          source: {
            git: {
              url: 'https://github.com/test/repo.git',
              ref: 'main',
            },
          },
        },
      });

      const args = getWorkspaceInitArgs(run);

      // Should NOT contain parent baseline resolution when no parentRef
      expect(args).not.toContain('_PARENT_REMOTE_REF');
      expect(args).not.toContain('_PARENT_BASE_REF');
    });
  });

  describe('git fields shipped via env vars (shell-interpolation security fix)', () => {
    function branchingRun(): Run {
      return makeRun({
        spec: {
          project: 'test-project',
          task: 'build-task-1',
          interactive: false,
          ttlSecondsAfterFinished: 604800,
          source: {
            git: {
              url: 'https://github.com/test/repo.git',
              ref: 'feature/child-branch',
              parentRef: 'feature/my-feature',
            },
          },
        },
      });
    }

    it('passes GIT_URL/GIT_REF/GIT_PARENT_REF via env for a run with parentRef', () => {
      const env = getWorkspaceInitEnv(branchingRun());
      const byName = new Map(env.map((e) => [e.name, e.value]));
      expect(byName.get('GIT_URL')).toBe('https://github.com/test/repo.git');
      expect(byName.get('GIT_REF')).toBe('feature/child-branch');
      expect(byName.get('GIT_PARENT_REF')).toBe('feature/my-feature');
    });

    it('omits GIT_REF/GIT_PARENT_REF env when ref/parentRef are unset', () => {
      const run = makeRun({
        spec: {
          project: 'test-project',
          task: 'build-task-1',
          interactive: false,
          ttlSecondsAfterFinished: 604800,
          source: { git: { url: 'https://github.com/test/repo.git' } },
        },
      });
      const env = getWorkspaceInitEnv(run);
      const byName = new Map(env.map((e) => [e.name, e.value]));
      expect(byName.get('GIT_URL')).toBe('https://github.com/test/repo.git');
      expect(byName.has('GIT_REF')).toBe(false);
      expect(byName.has('GIT_PARENT_REF')).toBe(false);
    });

    it('omits all GIT_* env for local git', () => {
      const run = makeRun({
        spec: {
          project: 'test-project',
          task: 'build-task-1',
          interactive: false,
          ttlSecondsAfterFinished: 604800,
          source: { local: true },
        },
      });
      const env = getWorkspaceInitEnv(run);
      const names = env.map((e) => e.name);
      expect(names).not.toContain('GIT_URL');
      expect(names).not.toContain('GIT_REF');
      expect(names).not.toContain('GIT_PARENT_REF');
    });

    it('references $GIT_URL/$GIT_REF/$GIT_PARENT_REF in the rendered script', () => {
      const args = getWorkspaceInitArgs(branchingRun());
      expect(args).toContain('git clone --mirror "$GIT_URL" "$MIRROR_DIR"');
      expect(args).toContain('remote set-url origin "$GIT_URL"');
      expect(args).toContain('checkout "$GIT_REF"');
      expect(args).toContain('checkout -b "$GIT_REF" "origin/$GIT_REF"');
      expect(args).toContain('checkout -b "$GIT_REF" "$GIT_PARENT_REF"');
      expect(args).toContain('worktree add --force "$WORKTREE_DIR" "$GIT_REF"');
      expect(args).toContain('worktree add -b "$GIT_REF" "$WORKTREE_DIR" "$_PARENT_BASE_REF"');
    });

    it('renders no ${git.*} template remnants in the script', () => {
      const args = getWorkspaceInitArgs(branchingRun());
      expect(args).not.toContain('${git.');
    });
  });

  describe('local git mode', () => {
    it('should generate local workspace init script without remote refs', () => {
      const run = makeRun({
        spec: {
          project: 'test-project',
          task: 'build-task-1',
          interactive: false,
          ttlSecondsAfterFinished: 604800,
          source: { local: true },
        },
      });

      const args = getWorkspaceInitArgs(run);

      // Local git mode should not reference remote-tracking branches
      expect(args).not.toContain('refs/remotes/origin/');
      expect(args).not.toContain('_PARENT_REMOTE_REF');
      expect(args).toContain('git init "$WORKSPACE_DIR"');
    });

    // A bare `git init` names the first branch from init.defaultBranch, which is
    // unset in the runner image and falls back to "master". Merge runs target
    // "main" and review runs diff against it, so reviewers logged
    // "fatal: Not a valid object name main" and fell back to a bare SHA — the
    // review still ran, just against the wrong base, with no failure surfaced.
    it('points HEAD at main before the first commit', () => {
      const run = makeRun({
        spec: {
          project: 'test-project',
          task: 'build-task-1',
          interactive: false,
          ttlSecondsAfterFinished: 604800,
          source: { local: true },
        },
      });

      const args = getWorkspaceInitArgs(run);

      expect(args).toContain('symbolic-ref HEAD refs/heads/main');
      // Ordering matters: renaming HEAD after the first commit would leave the
      // commit on master and create an unborn main.
      expect(args.indexOf('symbolic-ref HEAD refs/heads/main')).toBeLessThan(
        args.indexOf('commit --allow-empty -m "Initial commit"'),
      );
    });

    // Local runs all share /data/workspace and its single branch — there is no
    // per-run worktree isolating them. A run that dies before committing leaves
    // its edits behind, and because the dispatcher refuses complete_run on a
    // dirty tree, the next worker has to commit them to finish its own task.
    // Observed live: 223 lines of one task's work landed on another task's
    // branch, attributed to it, and reached review as if the second worker had
    // written them.
    it('reports a dirty workspace on resume without cleaning it', () => {
      const run = makeRun({
        spec: {
          project: 'test-project',
          task: 'build-task-1',
          interactive: false,
          ttlSecondsAfterFinished: 604800,
          source: { local: true },
        },
      });

      const args = getWorkspaceInitArgs(run);

      expect(args).toContain('warning: workspace is dirty before');
      // Only on the resume path — a freshly initialised repo has nothing to warn
      // about.
      expect(args.indexOf('warning: workspace is dirty before')).toBeGreaterThan(
        args.indexOf('resuming existing local workspace'),
      );
    });

    // This briefly ran `git stash push -u` here to keep one run's leftovers off
    // the next run's branch. maxParallel allows concurrent runs and they all
    // share this one directory, so the stash reverted a live worker's in-flight
    // edits and its next commit came out empty — a whole run's work, for a
    // reporting improvement. Nothing may mutate the shared tree from here.
    it('never mutates the shared workspace during init', () => {
      const run = makeRun({
        spec: {
          project: 'test-project',
          task: 'build-task-1',
          interactive: false,
          ttlSecondsAfterFinished: 604800,
          source: { local: true },
        },
      });

      const args = getWorkspaceInitArgs(run);

      expect(args).not.toContain('stash');
      expect(args).not.toContain('reset --hard');
      expect(args).not.toContain('checkout --');
      expect(args).not.toContain('clean -');
    });
  });

  describe('single shared copy of the worktree-setup shell (BUILD 8)', () => {
    function branchingRun(gitCache?: { worktreeReuse?: boolean }): Run {
      return makeRun({
        spec: {
          project: 'test-project',
          task: 'build-task-1',
          interactive: false,
          ttlSecondsAfterFinished: 604800,
          source: {
            git: {
              url: 'https://github.com/test/repo.git',
              ref: 'feature/child-branch',
              parentRef: 'feature/my-feature',
            },
          },
          ...(gitCache ? { gitCache } : {}),
        },
      });
    }

    // The reset-to-remote-tip stanza used to be copy-pasted five times into
    // every rendered script (resume branch, force-add path, normal-add path,
    // across both modes). It now renders exactly once, after the mode block, so
    // every path flows through it.
    it('renders the reset-to-remote-tip stanza exactly once for a ref run', () => {
      const argsReuse = getWorkspaceInitArgs(branchingRun());
      expect((argsReuse.match(/reset to origin\//g) ?? []).length).toBe(1);

      const argsFresh = getWorkspaceInitArgs(branchingRun({ worktreeReuse: false }));
      expect((argsFresh.match(/reset to origin\//g) ?? []).length).toBe(1);
    });

    // The force-add / normal-add / parent-baseline / error chain is shared
    // verbatim by both modes, so the add-worktree content after the mode-
    // specific prologue is identical.
    it('renders identical add-worktree content in worktreeReuse fresh-create and freshWorktree modes', () => {
      const argsReuse = getWorkspaceInitArgs(branchingRun());
      const argsFresh = getWorkspaceInitArgs(branchingRun({ worktreeReuse: false }));

      const startMarker = '# Re-sync refs/heads from remotes/origin';
      // The hoisted reset stanza is the first `rev-parse origin/$GIT_REF` after
      // the add chain; it is not part of the add-worktree content.
      const endMarker =
        'if git -C "$WORKTREE_DIR" rev-parse "origin/$GIT_REF" >/dev/null 2>&1; then';

      const startReuse = argsReuse.indexOf(startMarker);
      const startFresh = argsFresh.indexOf(startMarker);
      expect(startReuse).toBeGreaterThan(-1);
      expect(startFresh).toBeGreaterThan(-1);

      const chainReuse = argsReuse.slice(startReuse, argsReuse.indexOf(endMarker));
      const chainFresh = argsFresh.slice(startFresh, argsFresh.indexOf(endMarker));

      // worktreeReuse wraps the chain in an outer if/else, so its script has a
      // standalone `fi` after the chain that freshWorktree does not.
      expect(chainReuse.replace(/\nfi\n$/, '\n')).toBe(chainFresh);
    });
  });

  describe('dispatcher RUN_CONTEXT env', () => {
    it('sets RUN_CONTEXT=review-facilitator for success-review facilitation runs', () => {
      const run = makeRun({
        spec: {
          project: 'test-project',
          task: 'review-task',
          interactive: false,
          ttlSecondsAfterFinished: 604800,
          boardTask: 'test-project-build-123',
          agent: 'reviewer',
          facilitation: {
            targetRunName: 'worker-run-1',
            targetTaskId: 'test-project-build-123',
            failureReason: 'completed',
            sessionSummary: 'summary',
            successReview: true,
          },
          source: { local: true },
        },
      });

      const env = getDispatcherEnv(run);
      const runContext = env.find((e) => e.name === 'RUN_CONTEXT');
      expect(runContext?.value).toBe('review-facilitator');
    });

    it('sets RUN_CONTEXT=facilitator for non-review facilitation runs', () => {
      const run = makeRun({
        spec: {
          project: 'test-project',
          task: 'facilitation-task',
          interactive: false,
          ttlSecondsAfterFinished: 604800,
          boardTask: 'test-project-build-123',
          agent: 'buildgen',
          facilitation: {
            targetRunName: 'worker-run-1',
            targetTaskId: 'test-project-build-123',
            failureReason: 'failure',
            sessionSummary: 'summary',
            successReview: false,
          },
          source: { local: true },
        },
      });

      const env = getDispatcherEnv(run);
      const runContext = env.find((e) => e.name === 'RUN_CONTEXT');
      expect(runContext?.value).toBe('facilitator');
    });

    it('sets RUN_CONTEXT from spec.runContext for merge runs', () => {
      const run = makeRun({
        spec: {
          project: 'test-project',
          task: 'merge-task',
          interactive: false,
          ttlSecondsAfterFinished: 604800,
          boardTask: 'test-project-build-123',
          agent: 'integrator',
          runContext: 'merge-worker',
          source: { local: true },
        },
      });

      const env = getDispatcherEnv(run);
      const runContext = env.find((e) => e.name === 'RUN_CONTEXT');
      expect(runContext?.value).toBe('merge-worker');
    });

    it('spec.runContext takes precedence over facilitation', () => {
      const run = makeRun({
        spec: {
          project: 'test-project',
          task: 'conflict-run',
          interactive: false,
          ttlSecondsAfterFinished: 604800,
          boardTask: 'test-project-build-123',
          agent: 'integrator',
          facilitation: {
            targetRunName: 'worker-run-1',
            targetTaskId: 'test-project-build-123',
            failureReason: 'completed',
            sessionSummary: 'summary',
            successReview: true,
          },
          runContext: 'merge-worker',
          source: { local: true },
        },
      });

      const env = getDispatcherEnv(run);
      // Merge runs must observe spec.runContext rather than the
      // facilitation-derived value. K8s resolves duplicate env names with the
      // last entry, so the effective value is the final RUN_CONTEXT — and that
      // must hold whether the duplication is present or removed (a fixed
      // builder emits a single merge-worker entry, whose "last" is also
      // merge-worker). Do not pin the duplicate-entry count.
      const runContextEntries = env.filter((e) => e.name === 'RUN_CONTEXT');
      expect(runContextEntries.length).toBeGreaterThan(0);
      expect(runContextEntries[runContextEntries.length - 1]?.value).toBe('merge-worker');
    });

    it('omits RUN_CONTEXT when neither runContext nor facilitation is set', () => {
      const run = makeRun({
        spec: {
          project: 'test-project',
          task: 'build-task',
          interactive: false,
          ttlSecondsAfterFinished: 604800,
          boardTask: 'test-project-build-123',
          agent: 'builder',
          source: { local: true },
        },
      });

      const env = getDispatcherEnv(run);
      const runContext = env.find((e) => e.name === 'RUN_CONTEXT');
      expect(runContext).toBeUndefined();
    });
  });
});

describe('renderPod - security hardening', () => {
  it('does not auto-mount the ServiceAccount token pod-wide', () => {
    const pod = renderPod(makeRun(), []);
    expect(pod.spec?.automountServiceAccountToken).toBe(false);
  });

  it('projects the SA token into the dispatcher container ONLY, not the runner', () => {
    const pod = renderPod(makeRun(), []);
    const runner = pod.spec?.containers?.find((c) => c.name === 'opencode');
    const dispatcher = pod.spec?.containers?.find((c) => c.name === 'dispatcher');

    const runnerMounts = (runner?.volumeMounts ?? []).map((m) => m.name);
    const dispatcherMounts = (dispatcher?.volumeMounts ?? []).map((m) => m.name);

    expect(runnerMounts).not.toContain('kube-api-access');
    expect(dispatcherMounts).toContain('kube-api-access');

    // The projected token volume must exist at the pod level.
    const volNames = (pod.spec?.volumes ?? []).map((v) => v.name);
    expect(volNames).toContain('kube-api-access');
  });

  it('sets a seccomp RuntimeDefault profile on the pod', () => {
    const pod = renderPod(makeRun(), []);
    expect(pod.spec?.securityContext?.seccompProfile?.type).toBe('RuntimeDefault');
  });

  it('drops all capabilities and blocks escalation on the runner and dispatcher', () => {
    const pod = renderPod(makeRun(), []);
    for (const name of ['opencode', 'dispatcher']) {
      const c = pod.spec?.containers?.find((x) => x.name === name);
      expect(c?.securityContext?.allowPrivilegeEscalation).toBe(false);
      expect(c?.securityContext?.capabilities?.drop).toEqual(['ALL']);
    }
  });

  it('leaves the init container privileged enough to run apk add', () => {
    const run = makeRun();
    (run.spec as { runner?: { packages?: string[] } }).runner = { packages: ['jq'] };
    const pod = renderPod(run, []);
    const init = pod.spec?.initContainers?.find((c) => c.name === 'workspace-init');
    // Installing Alpine packages needs root + capabilities; the hardening above
    // must not be applied here or package installation breaks.
    expect(init).toBeDefined();
    expect(init?.securityContext?.capabilities?.drop).toBeUndefined();
  });

  it('defaults activeDeadlineSeconds to 3600 when timeoutSeconds is omitted', () => {
    const run = makeRun();
    delete (run.spec as { timeoutSeconds?: number }).timeoutSeconds;
    const pod = renderPod(run, []);
    expect(pod.spec?.activeDeadlineSeconds).toBe(3600);
  });

  it('strips a privileged sidecar securityContext by default', () => {
    const sidecars = [
      {
        name: 'dind',
        image: 'docker:dind',
        securityContext: { privileged: true, runAsUser: 0, allowPrivilegeEscalation: true },
      },
    ];
    const pod = renderPod(makeRun(), [], sidecars);
    const dind = pod.spec?.containers?.find((c) => c.name === 'dind');
    // All dangerous fields dropped → no securityContext left at all.
    expect(dind?.securityContext).toBeUndefined();
  });

  it('honors a privileged sidecar when explicitly allowed', () => {
    const sidecars = [
      { name: 'dind', image: 'docker:dind', securityContext: { privileged: true } },
    ];
    const pod = renderPod(makeRun(), [], sidecars, undefined, undefined, true);
    const dind = pod.spec?.containers?.find((c) => c.name === 'dind');
    expect(dind?.securityContext?.privileged).toBe(true);
  });
});

describe('renderPod - per-run stats key', () => {
  function webAuthTokenOf(pod: ReturnType<typeof renderPod>): string | undefined {
    const dispatcher = pod.spec?.containers?.find((c) => c.name === 'dispatcher');
    return dispatcher?.env?.find((e) => e.name === 'WEB_AUTH_TOKEN')?.value;
  }

  it('passes the per-run key to the dispatcher as WEB_AUTH_TOKEN', () => {
    const pod = renderPod(makeRun(), [], [], undefined, undefined, false, 'pcn_run_scoped_key');
    expect(webAuthTokenOf(pod)).toBe('pcn_run_scoped_key');
  });

  it('falls back to the shared token when no per-run key was minted', () => {
    const pod = renderPod(makeRun(), []);
    expect(webAuthTokenOf(pod)).toBe(WEB_AUTH_TOKEN);
  });

  it('never leaks the run key into the runner container', () => {
    const pod = renderPod(makeRun(), [], [], undefined, undefined, false, 'pcn_run_scoped_key');
    const runner = pod.spec?.containers?.find((c) => c.name === 'opencode');
    const runnerEnv = (runner?.env ?? []).map((e) => e.value ?? '');
    expect(runnerEnv).not.toContain('pcn_run_scoped_key');
  });
});

// `spec.image` has a CRD-level default pointing at the opencode runner, so it is
// never absent. Without an explicit override, `engine: claude` would silently run
// the opencode image — which is exactly what happened the first time this was
// deployed to minikube.
describe('renderPod - engine image precedence', () => {
  const CRD_DEFAULT = 'ghcr.io/erkkaha/percussionist/runner:latest';

  function runnerImage(run: Run): string | undefined {
    const pod = renderPod(run, [], [], runnerDefaultsFor(run.spec.engine));
    return pod.spec?.containers?.find((c) => c.name !== 'dispatcher')?.image;
  }

  it('lets engine: claude win over the CRD-defaulted spec.image', () => {
    const run = makeRun();
    run.spec.engine = 'claude';
    run.spec.image = CRD_DEFAULT;
    expect(runnerImage(run)).toBe(CLAUDE_RUNNER_DEFAULTS.image);
  });

  it('keeps spec.image authoritative when no engine is set', () => {
    const run = makeRun();
    run.spec.image = CRD_DEFAULT;
    expect(runnerImage(run)).toBe(CRD_DEFAULT);
  });

  it('treats engine: opencode like the default engine', () => {
    const run = makeRun();
    run.spec.engine = 'opencode';
    run.spec.image = CRD_DEFAULT;
    expect(runnerImage(run)).toBe(CRD_DEFAULT);
  });
});

// Engine selection normally rides the model field, so the prefix must reach the
// image choice — not just the `engine` field that few callers set.
describe('renderPod - engine from model prefix', () => {
  const CRD_DEFAULT = 'ghcr.io/erkkaha/percussionist/runner:latest';

  function runnerImage(run: Run): string | undefined {
    const pod = renderPod(run, [], [], runnerDefaultsFor(deriveEngine(run.spec)));
    return pod.spec?.containers?.find((c) => c.name !== 'dispatcher')?.image;
  }

  it('a claude-code model selects the claude runner image', () => {
    const run = makeRun();
    run.spec.image = CRD_DEFAULT;
    run.spec.model = 'claude-code/claude-opus-5';
    expect(runnerImage(run)).toBe(CLAUDE_RUNNER_DEFAULTS.image);
  });

  it('another provider keeps the opencode image', () => {
    const run = makeRun();
    run.spec.image = CRD_DEFAULT;
    run.spec.model = 'github-copilot/claude-sonnet-4.5';
    expect(runnerImage(run)).toBe(CRD_DEFAULT);
  });

  it('a claude-code model injects the subscription token env var', () => {
    const run = makeRun();
    run.spec.model = 'claude-code/claude-opus-5';
    run.spec.secrets = { authSecret: { name: 'claude-oat', key: 'CLAUDE_CODE_OAUTH_TOKEN' } };
    const pod = renderPod(run, [], [], runnerDefaultsFor(deriveEngine(run.spec)));
    const env = pod.spec?.containers?.find((c) => c.name !== 'dispatcher')?.env ?? [];
    expect(env.some((e) => e.name === 'CLAUDE_CODE_OAUTH_TOKEN')).toBe(true);
  });

  it('an explicit engine still overrides the model prefix', () => {
    const run = makeRun();
    run.spec.image = CRD_DEFAULT;
    run.spec.engine = 'opencode';
    run.spec.model = 'claude-code/claude-opus-5';
    expect(runnerImage(run)).toBe(CRD_DEFAULT);
  });
});

// authSecret.key is CRD-defaulted to opencode's `auth.json`, so it is never
// absent. A claude Secret holds a raw token under CLAUDE_CODE_OAUTH_TOKEN, and
// mounting `auth.json` fails the pod with CreateContainerConfigError — which is
// exactly how the first board-dispatched claude run died.
describe('resolveAuthSecretKey', () => {
  it('keeps auth.json for the opencode engine', () => {
    expect(resolveAuthSecretKey('auth.json', 'opencode', OPENCODE_RUNNER_DEFAULTS)).toBe(
      'auth.json',
    );
    expect(resolveAuthSecretKey(undefined, 'opencode', OPENCODE_RUNNER_DEFAULTS)).toBe('auth.json');
  });

  it('replaces the CRD-defaulted auth.json with the engine auth env var', () => {
    expect(resolveAuthSecretKey('auth.json', 'claude', CLAUDE_RUNNER_DEFAULTS)).toBe(
      'CLAUDE_CODE_OAUTH_TOKEN',
    );
  });

  it('uses the engine auth env var when no key is given', () => {
    expect(resolveAuthSecretKey(undefined, 'claude', CLAUDE_RUNNER_DEFAULTS)).toBe(
      'CLAUDE_CODE_OAUTH_TOKEN',
    );
  });

  it('respects a genuinely custom key', () => {
    expect(resolveAuthSecretKey('my-token', 'claude', CLAUDE_RUNNER_DEFAULTS)).toBe('my-token');
  });

  it('mounts the token key for a board-style run that never set one', () => {
    const run = makeRun();
    run.spec.model = 'claude-code/claude-opus-5';
    // Shaped like what the manager writes: the CRD default fills in the key.
    run.spec.secrets = { authSecret: { name: 'claude-oat', key: 'auth.json' } };
    const pod = renderPod(run, [], [], runnerDefaultsFor(deriveEngine(run.spec)));
    const env = pod.spec?.containers?.find((c) => c.name !== 'dispatcher')?.env ?? [];
    const ref = env.find((e) => e.name === 'CLAUDE_CODE_OAUTH_TOKEN')?.valueFrom?.secretKeyRef;
    expect(ref?.key).toBe('CLAUDE_CODE_OAUTH_TOKEN');
  });
});

// Claude Code reads one settings.json per pod, so the denial set has to be
// attributed to the agent that actually drives the session. Rendering it from
// every mounted agent let the reviewer's `edit: deny` reach the planner:
// an observed PLAN run logged "No `Write` tool is available in this run" and
// wrote its plan artifact through a bash heredoc instead. The adapter's own unit
// tests all passed — the mistake was in what pod-builder handed it, so the
// assertion belongs at this seam.
describe('renderPod - claude settings scope', () => {
  const PLANNER = {
    name: 'planner',
    content: '---\nname: planner\nmode: primary\npermission:\n  edit: allow\n---\nplan things',
  };
  const REVIEWER = {
    name: 'reviewer',
    content:
      '---\nname: reviewer\nmode: primary\npermission:\n  edit: deny\n  webfetch: deny\n---\nreview things',
  };

  function settingsFor(agentName: string | undefined, agents = [PLANNER, REVIEWER]) {
    const run = makeRun();
    run.spec.model = 'claude-code/claude-opus-5';
    run.spec.agent = agentName;
    const pod = renderPod(run, agents, [], runnerDefaultsFor(deriveEngine(run.spec)));
    const env = pod.spec?.containers?.find((c) => c.name !== 'dispatcher')?.env ?? [];
    return JSON.parse(env.find((e) => e.name === 'CLAUDE_SETTINGS_CONTENT')?.value ?? '{}');
  }

  it('does not deny the primary agent a tool only another mounted agent forbids', () => {
    expect(settingsFor('planner')).toEqual({ includeCoAuthoredBy: false });
  });

  it('still applies the denials of the agent that is driving', () => {
    expect(settingsFor('reviewer').permissions.deny).toEqual(['Edit', 'WebFetch', 'Write']);
  });

  it('writes no restrictions when the driving agent is ambiguous', () => {
    expect(settingsFor(undefined)).toEqual({ includeCoAuthoredBy: false });
  });
});

describe('renderPod - SSH host key verification mounts', () => {
  function sshRun(verification: 'no' | 'strict' | 'accept-new', withKnownHostsSecret = true): Run {
    const run = makeRun();
    run.spec.source = {
      git: {
        url: 'git@github.com:test/repo.git',
        ref: 'main',
        sshSecret: { name: 'git-ssh-key', key: 'ssh-privatekey' },
        sshHostKeyVerification: verification,
        ...(withKnownHostsSecret
          ? { known_hostsSecret: { name: 'git-known-hosts', key: 'known_hosts' } }
          : {}),
      },
    };
    return run;
  }

  function mountsOf(run: Run, container: string) {
    const pod = renderPod(run, []);
    const all = [...(pod.spec?.initContainers ?? []), ...(pod.spec?.containers ?? [])];
    return all.find((c) => c.name === container)?.volumeMounts ?? [];
  }

  // Regression: mounting known_hosts at /etc/git-ssh/known_hosts nests a subPath
  // mount inside the read-only git-ssh secret tmpfs. runc cannot create the
  // target file there, so the container dies at creation with exit 128
  // ("error mounting ... not a directory").
  for (const container of ['workspace-init', RUNNER_CONTAINER]) {
    it(`does not nest the known_hosts mount inside /etc/git-ssh in ${container}`, () => {
      const mounts = mountsOf(sshRun('accept-new'), container);
      const knownHosts = mounts.find((m) => m.name === 'git-known-hosts');
      expect(knownHosts).toBeDefined();
      expect(knownHosts?.mountPath).toBe('/etc/git-known-hosts');
      expect(knownHosts?.mountPath.startsWith('/etc/git-ssh/')).toBe(false);
      expect(knownHosts?.subPath).toBeUndefined();
    });
  }

  it('omits the known_hosts mount entirely when verification is disabled', () => {
    for (const container of ['workspace-init', RUNNER_CONTAINER]) {
      const mounts = mountsOf(sshRun('no'), container);
      expect(mounts.find((m) => m.name === 'git-known-hosts')).toBeUndefined();
    }
  });

  it('points UserKnownHostsFile at the standalone known_hosts path', () => {
    const script = getWorkspaceInitArgs(sshRun('strict'));
    expect(script).toContain('-o StrictHostKeyChecking=strict');
    expect(script).toContain('-o UserKnownHostsFile=/etc/git-known-hosts/known_hosts');
    expect(script).not.toContain('UserKnownHostsFile=/etc/git-ssh/known_hosts');
  });

  it('disables host key checking and discards known_hosts when verification is off', () => {
    const script = getWorkspaceInitArgs(sshRun('no'));
    expect(script).toContain('-o StrictHostKeyChecking=no');
    expect(script).toContain('-o UserKnownHostsFile=/dev/null');
  });

  it('falls back to an emptyDir when verification is on but no secret is provided', () => {
    const pod = renderPod(sshRun('accept-new', false), []);
    const volume = pod.spec?.volumes?.find((v) => v.name === 'git-known-hosts');
    expect(volume?.emptyDir).toBeDefined();
    expect(volume?.secret).toBeUndefined();
  });
});

describe('renderPod - parent baseline resolution failure', () => {
  function branchingRun(): Run {
    const run = makeRun();
    run.spec.source = {
      git: {
        url: 'https://github.com/test/repo.git',
        ref: 'feature/plan-1--build-2',
        parentRef: 'feature/plan-1',
      },
    };
    return run;
  }

  // Regression: the fallback baseline was used without checking it resolves. When
  // neither the remote-tracking nor the local ref existed, `git worktree add -b`
  // died on an unresolvable ref — a bare exit 128 naming nothing. This happens
  // for real when source.git.url changes: the mirror path is derived from the
  // URL, so runs move to a fresh clone and any branch that only lived in the old
  // mirror is gone.
  it('checks the local fallback ref before using it as a baseline', () => {
    const script = getWorkspaceInitArgs(branchingRun());
    expect(script).toContain('rev-parse "refs/heads/$GIT_PARENT_REF"');
  });

  it('names the missing parent branch and the mirror instead of failing bare', () => {
    const script = getWorkspaceInitArgs(branchingRun());
    expect(script).toContain('parent branch $GIT_PARENT_REF not found in mirror');
    expect(script).toContain('refs/remotes/origin/$GIT_PARENT_REF');
    expect(script).toContain('source.git.url changed');
  });

  it('exits non-zero rather than continuing to worktree add', () => {
    const script = getWorkspaceInitArgs(branchingRun());
    const errIdx = script.indexOf('not found in mirror');
    const addIdx = script.indexOf('worktree add -b');
    expect(errIdx).toBeGreaterThan(-1);
    expect(addIdx).toBeGreaterThan(errIdx);
    expect(script.slice(errIdx, addIdx)).toContain('exit 1');
  });
});
