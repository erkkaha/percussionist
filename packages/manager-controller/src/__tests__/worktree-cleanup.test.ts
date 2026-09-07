import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Task } from '@percussionist/api';
import * as kube from '@percussionist/kube';
import { spawnTaskWorktreeCleanupPod, spawnWorktreeCleanupPod } from '../worktree-cleanup.js';

function makeTask(name: string): Task {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Task',
    metadata: { name, namespace: 'percussionist', uid: `uid-${name}` },
    spec: {
      projectRef: 'proj',
      type: 'BUILD',
      title: name,
      description: '',
      agent: 'builder',
      priority: 'medium',
    },
    status: { phase: 'succeeded' },
  } as Task;
}

describe('spawnTaskWorktreeCleanupPod — script content', () => {
  let batchSpy: ReturnType<typeof spyOn>;
  let capturedScript: string;

  beforeEach(() => {
    capturedScript = '';
    const fakeBatch = {
      createNamespacedJob: async ({ body }: { body: any }) => {
        capturedScript = body.spec.template.spec.containers[0].args[0];
        return body;
      },
    };
    batchSpy = spyOn(kube, 'batch').mockReturnValue(fakeBatch as any);
  });

  afterEach(() => {
    batchSpy.mockRestore();
  });

  it('creates a TTL-reaped Job owned by the Task, not a bare Pod', async () => {
    const task = makeTask('build-123');
    let capturedJob: any;
    batchSpy.mockRestore();
    batchSpy = spyOn(kube, 'batch').mockReturnValue({
      createNamespacedJob: async ({ body }: { body: any }) => {
        capturedJob = body;
        return body;
      },
    } as any);

    await spawnTaskWorktreeCleanupPod({
      task,
      projectName: 'proj',
      namespace: 'percussionist',
      image: 'alpine/git',
    });

    expect(capturedJob.apiVersion).toBe('batch/v1');
    expect(capturedJob.kind).toBe('Job');
    expect(capturedJob.metadata.name.length).toBeLessThanOrEqual(63);
    // The job controller deletes the finished Job and its pod; without this,
    // Completed cleanup pods accumulate indefinitely.
    expect(capturedJob.spec.ttlSecondsAfterFinished).toBe(3600);
    expect(capturedJob.spec.backoffLimit).toBe(0);
    expect(capturedJob.spec.template.spec.restartPolicy).toBe('Never');
    // Labels reach the pod template so `-l percussionist.dev/component=worktree-cleanup` still selects the pods.
    expect(capturedJob.spec.template.metadata.labels['percussionist.dev/component']).toBe(
      'worktree-cleanup',
    );
    expect(capturedJob.metadata.ownerReferences[0]).toMatchObject({
      kind: 'Task',
      name: 'build-123',
    });
  });

  it('removes explicit runNames paths in addition to the worker-prefix glob', async () => {
    const task = makeTask('build-123');

    await spawnTaskWorktreeCleanupPod({
      task,
      projectName: 'proj',
      namespace: 'percussionist',
      image: 'alpine/git',
      runNames: ['proj-review-abc-1a2b3c', 'proj-buildgen-abc-4d5e6f'],
    });

    // Existing worker-prefix glob match is untouched.
    expect(capturedScript).toContain(`for dir in 'proj-build-123'-*; do`);
    expect(capturedScript).toContain('proj-build-123-??????????) ;;');

    // Explicit auxiliary run names removed by exact, shell-quoted path.
    expect(capturedScript).toContain(
      `for dir in '/data/worktrees/proj-review-abc-1a2b3c' '/data/worktrees/proj-buildgen-abc-4d5e6f'; do`,
    );
  });

  it('collects branches from explicit runNames removals for mirror pruning', async () => {
    const task = makeTask('build-123');

    await spawnTaskWorktreeCleanupPod({
      task,
      projectName: 'proj',
      namespace: 'percussionist',
      image: 'alpine/git',
      gitUrl: 'https://example.com/repo.git',
      runNames: ['proj-review-abc-1a2b3c'],
    });

    const runNamesLoopIndex = capturedScript.indexOf(
      `for dir in '/data/worktrees/proj-review-abc-1a2b3c'; do`,
    );
    expect(runNamesLoopIndex).toBeGreaterThan(-1);
    const loopBody = capturedScript.slice(runNamesLoopIndex);
    expect(loopBody).toContain('BRANCHES="$BRANCHES $BRANCH"');
    expect(capturedScript).toContain('for b in $BRANCHES; do');
  });

  it('omits the explicit-runNames loop when runNames is empty', async () => {
    const task = makeTask('build-456');

    await spawnTaskWorktreeCleanupPod({
      task,
      projectName: 'proj',
      namespace: 'percussionist',
      image: 'alpine/git',
    });

    expect(capturedScript).not.toContain('/data/worktrees/proj-review');
    expect(capturedScript.match(/for dir in/g)?.length).toBe(1);
  });

  it('deletes remote namespaced refs best-effort for explicit branches, with secret mounts', async () => {
    const task = makeTask('build-123');
    let capturedPod: any;
    const fakeBatch = {
      createNamespacedJob: async ({ body }: { body: any }) => {
        capturedPod = body;
        capturedScript = body.spec.template.spec.containers[0].args[0];
        return body;
      },
    };
    batchSpy.mockRestore();
    batchSpy = spyOn(kube, 'batch').mockReturnValue(fakeBatch as any);

    await spawnTaskWorktreeCleanupPod({
      task,
      projectName: 'proj',
      namespace: 'percussionist',
      image: 'alpine/git',
      gitUrl: 'https://example.com/repo.git',
      branches: ['feature/plan-abc--build-123'],
      sshSecret: { name: 'git-ssh-key' },
      githubTokenSecret: { name: 'git-github-token' },
    });

    // Explicit branch seeds $BRANCHES so the remote delete runs even when
    // per-run pods already removed the worktrees.
    expect(capturedScript).toContain('BRANCHES="feature/plan-abc--build-123"');
    // Best-effort remote delete of the namespaced ref, never blocking done.
    expect(capturedScript).toContain('push origin ":refs/percussionist/$b" 2>&1 || true');
    // Auth material mounted for the push.
    const mounts = capturedPod.spec.template.spec.containers[0].volumeMounts.map(
      (m: any) => m.name,
    );
    expect(mounts).toContain('git-ssh');
    expect(mounts).toContain('git-github');
    const volumes = capturedPod.spec.template.spec.volumes.map((v: any) => v.name);
    expect(volumes).toContain('git-ssh');
    expect(volumes).toContain('git-github');
  });

  it('omits secret mounts when no secrets are supplied', async () => {
    const task = makeTask('build-123');
    let capturedPod: any;
    const fakeBatch = {
      createNamespacedJob: async ({ body }: { body: any }) => {
        capturedPod = body;
        capturedScript = body.spec.template.spec.containers[0].args[0];
        return body;
      },
    };
    batchSpy.mockRestore();
    batchSpy = spyOn(kube, 'batch').mockReturnValue(fakeBatch as any);

    await spawnTaskWorktreeCleanupPod({
      task,
      projectName: 'proj',
      namespace: 'percussionist',
      image: 'alpine/git',
      gitUrl: 'https://example.com/repo.git',
    });

    const mounts = capturedPod.spec.template.spec.containers[0].volumeMounts.map(
      (m: any) => m.name,
    );
    expect(mounts).toEqual(['data']);
    const volumes = capturedPod.spec.template.spec.volumes.map((v: any) => v.name);
    expect(volumes).toEqual(['data']);
  });

  it('tolerates a concurrent cleanup deleting the same tree (rm must not abort the script)', async () => {
    const task = makeTask('build-123');

    await spawnTaskWorktreeCleanupPod({
      task,
      projectName: 'proj',
      namespace: 'percussionist',
      image: 'alpine/git',
      runNames: ['proj-review-abc-1a2b3c'],
    });

    // Both removal loops run under `set -e`; a racing pod making entries
    // vanish mid-rm returns non-zero from rm, so every rm must be `|| true`.
    expect(capturedScript).toContain('set -e');
    expect(capturedScript).not.toMatch(/rm -rf [^\n]*(?<!\|\| true)$/m);
  });
});

describe('spawnWorktreeCleanupPod — script content', () => {
  let batchSpy: ReturnType<typeof spyOn>;
  let capturedScript: string;

  beforeEach(() => {
    capturedScript = '';
    const fakeBatch = {
      createNamespacedJob: async ({ body }: { body: any }) => {
        capturedScript = body.spec.template.spec.containers[0].args[0];
        return body;
      },
    };
    batchSpy = spyOn(kube, 'batch').mockReturnValue(fakeBatch as any);
  });

  afterEach(() => {
    batchSpy.mockRestore();
  });

  it('tolerates a concurrent task-level cleanup deleting the same tree', async () => {
    const task = makeTask('build-123');

    await spawnWorktreeCleanupPod({
      task,
      runName: 'proj-merge-build-123-1a2b3c',
      projectName: 'proj',
      namespace: 'percussionist',
      image: 'alpine/git',
    });

    expect(capturedScript).toContain('set -e');
    expect(capturedScript).not.toMatch(/rm -rf [^\n]*(?<!\|\| true)$/m);
  });

  it('never deletes remote namespaced refs (the task is still in flight)', async () => {
    const task = makeTask('build-123');

    await spawnWorktreeCleanupPod({
      task,
      runName: 'proj-merge-build-123-1a2b3c',
      projectName: 'proj',
      namespace: 'percussionist',
      image: 'alpine/git',
      gitUrl: 'https://example.com/repo.git',
    });

    // Per-run cleanup fires on retries/rework; the branch (and its
    // refs/percussionist/* remote copy) must survive until the task is done.
    expect(capturedScript).not.toContain('refs/percussionist/');
    expect(capturedScript).not.toContain('push origin');
  });
});
