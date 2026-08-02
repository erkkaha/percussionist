import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Task } from '@percussionist/api';
import * as kube from '@percussionist/kube';
import { spawnTaskWorktreeCleanupPod } from '../worktree-cleanup.js';

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
  let coreSpy: ReturnType<typeof spyOn>;
  let capturedScript: string;

  beforeEach(() => {
    capturedScript = '';
    const fakeCore = {
      createNamespacedPod: async ({ body }: { body: any }) => {
        capturedScript = body.spec.containers[0].args[0];
        return body;
      },
    };
    coreSpy = spyOn(kube, 'core').mockReturnValue(fakeCore as any);
  });

  afterEach(() => {
    coreSpy.mockRestore();
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
});
