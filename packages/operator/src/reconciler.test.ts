// reconciler.test.ts — Tests for the terminal-run dequeue behavior in
// reconcile(), and for the pure pieces of safeReconcileProject: the
// 4xx-vs-transient error classifier and the status-unchanged skip check.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { CoreV1Api } from '@kubernetes/client-node';
import { type Project, type Run, RunPhase } from '@percussionist/api';
import * as runKeyClient from './run-key-client.js';
import {
  classifyProjectReconcileError,
  hasReconcileStatusChanged,
  projectKey,
} from './reconciler.js';

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

describe('classifyProjectReconcileError', () => {
  it('classifies statusCode 422 (invalid spec) as permanent', () => {
    expect(classifyProjectReconcileError({ statusCode: 422 })).toBe('permanent');
  });

  it('classifies statusCode 400 as permanent', () => {
    expect(classifyProjectReconcileError({ statusCode: 400 })).toBe('permanent');
  });

  it('classifies statusCode 499 as permanent (upper 4xx boundary)', () => {
    expect(classifyProjectReconcileError({ statusCode: 499 })).toBe('permanent');
  });

  it('classifies statusCode 500 as transient', () => {
    expect(classifyProjectReconcileError({ statusCode: 500 })).toBe('transient');
  });

  it('classifies statusCode 399 as transient (below 4xx boundary)', () => {
    expect(classifyProjectReconcileError({ statusCode: 399 })).toBe('transient');
  });

  it('falls back to the `code` field when statusCode is absent', () => {
    expect(classifyProjectReconcileError({ code: 404 })).toBe('permanent');
  });

  it('prefers statusCode over code when both are present', () => {
    expect(classifyProjectReconcileError({ statusCode: 503, code: 404 })).toBe('transient');
  });

  it('defaults to transient when no numeric code is present (e.g. a network error)', () => {
    expect(classifyProjectReconcileError(new Error('ECONNREFUSED'))).toBe('transient');
  });

  it('defaults to transient for a plain non-error value', () => {
    expect(classifyProjectReconcileError('boom')).toBe('transient');
  });

  it('defaults to transient for null/undefined', () => {
    expect(classifyProjectReconcileError(undefined)).toBe('transient');
    expect(classifyProjectReconcileError(null)).toBe('transient');
  });
});

describe('hasReconcileStatusChanged', () => {
  it('returns true when current is undefined and next is Ready', () => {
    expect(hasReconcileStatusChanged(undefined, { state: 'Ready', observedGeneration: 1 })).toBe(
      true,
    );
  });

  it('returns false when state, message, and observedGeneration are all identical', () => {
    const current = { state: 'Error' as const, message: 'boom', observedGeneration: 3 };
    const next = { state: 'Error' as const, message: 'boom', observedGeneration: 3 };
    expect(hasReconcileStatusChanged(current, next)).toBe(false);
  });

  it('returns true when state differs', () => {
    const current = { state: 'Error' as const, message: 'boom', observedGeneration: 3 };
    const next = { state: 'Ready' as const, observedGeneration: 3 };
    expect(hasReconcileStatusChanged(current, next)).toBe(true);
  });

  it('returns true when message differs', () => {
    const current = { state: 'Error' as const, message: 'boom', observedGeneration: 3 };
    const next = { state: 'Error' as const, message: 'different failure', observedGeneration: 3 };
    expect(hasReconcileStatusChanged(current, next)).toBe(true);
  });

  it('returns true when observedGeneration differs', () => {
    const current = { state: 'Ready' as const, observedGeneration: 3 };
    const next = { state: 'Ready' as const, observedGeneration: 4 };
    expect(hasReconcileStatusChanged(current, next)).toBe(true);
  });

  it('returns false when both are Ready with the same generation and no message', () => {
    const current = { state: 'Ready' as const, observedGeneration: 5 };
    const next = { state: 'Ready' as const, observedGeneration: 5 };
    expect(hasReconcileStatusChanged(current, next)).toBe(false);
  });

  it('returns true when a successful reconcile must clear a stale error message', () => {
    // Same state and generation, only the stale `message` from a prior Error
    // needs clearing — this is the case that must trigger a patch, since a
    // JSON merge patch only clears a key if it's actually sent.
    const current = {
      state: 'Ready' as const,
      message: 'old 422 from a prior bad spec',
      observedGeneration: 5,
    };
    const next = { state: 'Ready' as const, observedGeneration: 5 };
    expect(hasReconcileStatusChanged(current, next)).toBe(true);
  });

  it('treats a null message the same as an absent one (post-clear apiserver echo)', () => {
    const current = {
      state: 'Ready' as const,
      message: null as unknown as string,
      observedGeneration: 5,
    };
    const next = { state: 'Ready' as const, observedGeneration: 5 };
    expect(hasReconcileStatusChanged(current, next)).toBe(false);
  });
});

describe('projectKey', () => {
  const project = (namespace: string | undefined, name: string) =>
    ({ metadata: { namespace, name } }) as Project;

  it('joins namespace and name', () => {
    expect(projectKey(project('team-a', 'my-project'))).toBe('team-a/my-project');
  });

  it('falls back to an empty namespace segment when namespace is missing', () => {
    expect(projectKey(project(undefined, 'my-project'))).toBe('/my-project');
  });
});
