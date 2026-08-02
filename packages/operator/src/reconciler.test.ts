// reconciler.test.ts — Tests for the terminal-run dequeue behavior in reconcile().

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { CoreV1Api } from '@kubernetes/client-node';
import { type Run, RunPhase } from '@percussionist/api';
import * as runKeyClient from './run-key-client.js';

function makeTerminalRun(overrides: Partial<Run> = {}): Run {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Run',
    metadata: {
      name: 'test-run',
      namespace: 'test-ns',
      uid: 'test-uid',
    },
    spec: {
      project: 'test-project',
      task: 'test-task',
      interactive: false,
      image: 'ghcr.io/erkkaha/percussionist/runner:latest',
      timeoutSeconds: 3600,
    },
    status: { phase: RunPhase.Succeeded },
    ...overrides,
  } as Run;
}

function notFoundError(): Error {
  return Object.assign(new Error('pods "test-run" not found'), { statusCode: 404 });
}

describe('reconcile() terminal branch', () => {
  let readPodSpy: ReturnType<typeof spyOn>;
  let revokeRunKeySpy: ReturnType<typeof spyOn>;
  let deletePodSpy: ReturnType<typeof spyOn>;
  let deleteServiceSpy: ReturnType<typeof spyOn>;
  let dequeueSpy: ReturnType<typeof spyOn>;
  let reconciler: typeof import('./reconciler.js');

  beforeEach(async () => {
    revokeRunKeySpy = spyOn(runKeyClient, 'revokeRunKey').mockResolvedValue(undefined as any);
    deletePodSpy = spyOn(CoreV1Api.prototype, 'deleteNamespacedPod').mockResolvedValue(
      undefined as any,
    );
    deleteServiceSpy = spyOn(CoreV1Api.prototype, 'deleteNamespacedService').mockResolvedValue(
      undefined as any,
    );
    reconciler = await import('./reconciler.js');
    dequeueSpy = spyOn(reconciler, 'dequeue');
  });

  afterEach(() => {
    readPodSpy?.mockRestore();
    revokeRunKeySpy.mockRestore();
    deletePodSpy.mockRestore();
    deleteServiceSpy.mockRestore();
    dequeueSpy.mockRestore();
  });

  it('dequeues the run once the Pod GET 404s (child resources confirmed gone)', async () => {
    readPodSpy = spyOn(CoreV1Api.prototype, 'readNamespacedPod').mockRejectedValue(notFoundError());
    const run = makeTerminalRun();

    await reconciler.reconcile(run);

    expect(revokeRunKeySpy).toHaveBeenCalledWith('test-run');
    expect(dequeueSpy).toHaveBeenCalledTimes(1);
    expect(dequeueSpy).toHaveBeenCalledWith('test-ns/test-run');
    // Pod is already gone — no further cleanup calls should fire.
    expect(deletePodSpy).not.toHaveBeenCalled();
    expect(deleteServiceSpy).not.toHaveBeenCalled();
  });

  it('does not dequeue while the Pod still exists (cleans up instead)', async () => {
    readPodSpy = spyOn(CoreV1Api.prototype, 'readNamespacedPod').mockResolvedValue({} as any);
    const run = makeTerminalRun();

    await reconciler.reconcile(run);

    expect(revokeRunKeySpy).toHaveBeenCalledWith('test-run');
    expect(dequeueSpy).not.toHaveBeenCalled();
    expect(deletePodSpy).toHaveBeenCalled();
    expect(deleteServiceSpy).toHaveBeenCalled();
  });

  it('logs exactly once when dropping a terminal run from the resync set', async () => {
    readPodSpy = spyOn(CoreV1Api.prototype, 'readNamespacedPod').mockRejectedValue(notFoundError());
    const run = makeTerminalRun();

    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      await reconciler.reconcile(run);
    } finally {
      console.log = originalLog;
    }

    const dequeueLogs = lines.filter((l) => l.includes('dequeuing terminal run'));
    expect(dequeueLogs).toHaveLength(1);
    expect(dequeueLogs[0]).toContain('test-ns/test-run');
  });
});

describe('dequeue()', () => {
  // dequeue() clears seen/pending/processing/dirty state (and splices the
  // queue array) unconditionally — it has no preconditions on the key's
  // current state, so it is safe to call even if runWorker is mid-processing
  // that same key (its `finally` block only touches `processing`/`dirty`,
  // both of which dequeue() already clears).
  it('is idempotent and safe to call for keys not currently queued/processing', async () => {
    const { enqueue, dequeue } = await import('./reconciler.js');
    const run = makeTerminalRun();
    const key = 'test-ns/test-run';

    enqueue(run);
    expect(() => dequeue(key)).not.toThrow();
    // Calling again (e.g. a second resync pass racing with runWorker) must
    // also be a safe no-op.
    expect(() => dequeue(key)).not.toThrow();
    expect(() => dequeue('never-enqueued/run')).not.toThrow();
  });
});
