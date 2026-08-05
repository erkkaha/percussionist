// queue.test.ts — Tests for the operator's in-memory work queue: enqueue /
// dequeue semantics, the single-iteration reconcile loop (runWorkerOnce, with
// injectable delay + requeue scheduler so no infinite loop or real timers are
// spawned), and the periodic resync interval.
//
// co.getNamespacedCustomObject responses are scripted with the BUILD-1
// recording fake (test-helpers/fake-kube.ts); reconcile() itself is spied so
// the queue semantics are exercised without driving the full reconcile flow.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Run } from '@percussionist/api';
import * as reconciler from './reconciler.js';
import { installFakeKube, notFound, serverError } from './test-helpers/fake-kube.js';

function makeRun(name: string, overrides: Partial<Run> = {}): Run {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Run',
    metadata: { name, namespace: 'test-ns', uid: `uid-${name}` },
    spec: {
      project: 'test-project',
      task: 'test-task',
      interactive: false,
      image: 'ghcr.io/erkkaha/percussionist/runner:latest',
      timeoutSeconds: 3600,
    },
    status: {},
    ...overrides,
  } as Run;
}

const noDelay: reconciler.IdleSleep = async () => {};
const noRequeue: reconciler.RequeueScheduler = () => {};

function key(name: string): string {
  return `test-ns/${name}`;
}

describe('work queue', () => {
  let state: reconciler.WorkQueueStateForTests;
  let reconcileSpy: ReturnType<typeof spyOn>;
  let fake: ReturnType<typeof installFakeKube> | undefined;

  beforeEach(() => {
    state = reconciler.__queueStateForTests();
    state.queue.length = 0;
    state.pending.clear();
    state.processing.clear();
    state.dirty.clear();
    state.seen.clear();
    reconcileSpy = spyOn(reconciler, 'reconcile').mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    reconcileSpy.mockRestore();
    fake?.restore();
    state.queue.length = 0;
    state.pending.clear();
    state.processing.clear();
    state.dirty.clear();
    state.seen.clear();
  });

  // Install the recording fake with a scripted fresh-Run GET. Kept on the
  // shared `fake` slot so afterEach restores the prototypes.
  function fakeWithGet(value: unknown): ReturnType<typeof installFakeKube> {
    fake = installFakeKube({ getNamespacedCustomObject: { value } });
    return fake;
  }

  describe('enqueue()', () => {
    it('queues a new key exactly once', () => {
      const run = makeRun('run-1');
      reconciler.enqueue(run);
      expect(state.queue).toEqual([key('run-1')]);
      expect(state.pending.has(key('run-1'))).toBe(true);
      expect(state.seen.get(key('run-1'))).toBe(run);
      expect(state.processing.size).toBe(0);
      expect(state.dirty.size).toBe(0);
    });

    it('does not re-queue a duplicate while pending', () => {
      reconciler.enqueue(makeRun('run-1'));
      reconciler.enqueue(makeRun('run-1'));
      expect(state.queue).toEqual([key('run-1')]);
      expect(state.pending.size).toBe(1);
      expect(state.dirty.size).toBe(0);
    });

    it('marks dirty instead of re-queueing while processing', async () => {
      fakeWithGet(makeRun('run-1'));
      reconciler.enqueue(makeRun('run-1'));
      // runWorkerOnce runs synchronously until the fresh-GET await, so the
      // key is in `processing` when we re-enqueue it here (an informer update
      // racing the in-flight iteration).
      const p = reconciler.runWorkerOnce(noDelay, noRequeue);
      reconciler.enqueue(makeRun('run-1'));
      expect(state.dirty.has(key('run-1'))).toBe(true);
      expect(state.queue).toEqual([]); // not duplicated while processing
      await p;
      // The finally block consumed the dirty flag and re-enqueued exactly once.
      expect(state.dirty.size).toBe(0);
      expect(state.queue).toEqual([key('run-1')]);
    });
  });

  describe('dequeue()', () => {
    it('removes the key from queue, pending, processing, dirty, and seen', () => {
      reconciler.enqueue(makeRun('run-1'));
      // Simulate an in-flight iteration that also received a re-enqueue.
      state.processing.add(key('run-1'));
      state.dirty.add(key('run-1'));
      reconciler.dequeue(key('run-1'));
      expect(state.queue).toEqual([]);
      expect(state.pending.size).toBe(0);
      expect(state.processing.size).toBe(0);
      expect(state.dirty.size).toBe(0);
      expect(state.seen.size).toBe(0);
    });

    it('is idempotent — repeated calls for the same or unknown keys are safe', () => {
      reconciler.enqueue(makeRun('run-1'));
      reconciler.dequeue(key('run-1'));
      expect(() => reconciler.dequeue(key('run-1'))).not.toThrow();
      expect(() => reconciler.dequeue('never/queued')).not.toThrow();
    });
  });

  describe('runWorkerOnce()', () => {
    it('sleeps the idle delay and returns false when the queue is empty', async () => {
      let sleptMs = -1;
      const ok = await reconciler.runWorkerOnce(async (ms) => {
        sleptMs = ms;
      }, noRequeue);
      expect(ok).toBe(false);
      expect(sleptMs).toBe(reconciler.IDLE_SLEEP_MS);
      expect(state.queue).toEqual([]);
      expect(reconcileSpy).not.toHaveBeenCalled();
    });

    it('fetches a fresh Run via co.getNamespacedCustomObject and reconciles it', async () => {
      const cached = makeRun('run-1');
      const fresh = makeRun('run-1', { status: { phase: 'Running' } });
      const f = fakeWithGet(fresh);
      reconciler.enqueue(cached);

      const ok = await reconciler.runWorkerOnce(noDelay, noRequeue);

      expect(ok).toBe(true);
      expect(f.calls.map((c) => c.method)).toEqual(['getNamespacedCustomObject']);
      expect(reconcileSpy).toHaveBeenCalledTimes(1);
      expect(reconcileSpy).toHaveBeenCalledWith(fresh);
      expect(state.seen.get(key('run-1'))).toBe(fresh);
    });

    it('dequeues the key when reconcile throws 404 (run CR deleted)', async () => {
      fakeWithGet(makeRun('run-1'));
      reconcileSpy.mockRejectedValue(notFound('run deleted'));
      reconciler.enqueue(makeRun('run-1'));

      const ok = await reconciler.runWorkerOnce(noDelay, noRequeue);

      expect(ok).toBe(true);
      expect(reconcileSpy).toHaveBeenCalledTimes(1);
      expect(state.queue).toEqual([]);
      expect(state.pending.size).toBe(0);
      expect(state.processing.size).toBe(0);
      expect(state.seen.size).toBe(0);
    });

    it('schedules a requeue via scheduleRequeue when reconcile throws transiently', async () => {
      fakeWithGet(makeRun('run-1'));
      reconcileSpy.mockRejectedValue(serverError('boom'));
      reconciler.enqueue(makeRun('run-1'));
      const requeueCalls: Array<{ callback: () => void; delayMs: number }> = [];

      const ok = await reconciler.runWorkerOnce(noDelay, (callback, delayMs) => {
        requeueCalls.push({ callback, delayMs });
      });

      expect(ok).toBe(true);
      expect(requeueCalls).toHaveLength(1);
      expect(requeueCalls[0]?.delayMs).toBe(reconciler.ERROR_REQUEUE_DELAY_MS);
      // Nothing re-enqueued yet — the requeue is still inside its delay window.
      expect(state.queue).toEqual([]);
      expect(state.pending.size).toBe(0);
      // Firing the requeue re-enqueues the run.
      requeueCalls[0]?.callback();
      expect(state.queue).toEqual([key('run-1')]);
      expect(state.pending.has(key('run-1'))).toBe(true);
      // A second fire must not duplicate the now-pending key.
      requeueCalls[0]?.callback();
      expect(state.queue).toEqual([key('run-1')]);
      expect(state.pending.size).toBe(1);
    });

    it('marks a key enqueued during the requeue window dirty (no duplicate) and finally re-enqueues once', async () => {
      fakeWithGet(makeRun('run-1'));
      reconcileSpy.mockRejectedValue(serverError('boom'));
      reconciler.enqueue(makeRun('run-1'));
      const requeueCalls: Array<{ callback: () => void; delayMs: number }> = [];

      const p = reconciler.runWorkerOnce(noDelay, (callback, delayMs) => {
        requeueCalls.push({ callback, delayMs });
      });
      // Key is still processing while the requeue is armed — a concurrent
      // informer enqueue must mark dirty, never duplicate.
      expect(state.processing.has(key('run-1'))).toBe(true);
      reconciler.enqueue(makeRun('run-1'));
      expect(state.dirty.has(key('run-1'))).toBe(true);
      expect(state.queue).toEqual([]);
      await p;

      // The finally block consumed the dirty flag and re-enqueued exactly once.
      expect(requeueCalls).toHaveLength(1);
      expect(state.dirty.size).toBe(0);
      expect(state.processing.size).toBe(0);
      expect(state.queue).toEqual([key('run-1')]);
      expect(state.pending.size).toBe(1);
      // Firing the requeue must not duplicate the already-pending key.
      requeueCalls[0]?.callback();
      expect(state.queue).toEqual([key('run-1')]);
      expect(state.pending.size).toBe(1);
    });

    it('re-enqueues from the finally block when dirty is set on the success path', async () => {
      fakeWithGet(makeRun('run-1'));
      reconciler.enqueue(makeRun('run-1'));

      const p = reconciler.runWorkerOnce(noDelay, noRequeue);
      reconciler.enqueue(makeRun('run-1')); // re-entrant enqueue while processing
      expect(state.dirty.has(key('run-1'))).toBe(true);
      await p;

      expect(reconcileSpy).toHaveBeenCalledTimes(1);
      expect(state.processing.size).toBe(0);
      expect(state.dirty.size).toBe(0);
      expect(state.queue).toEqual([key('run-1')]);
    });

    it('skips a key that is in the queue but has no seen entry', async () => {
      // Only reachable via the test seam — enqueue always sets `seen`, so this
      // branch is purely defensive.
      state.queue.push('test-ns/orphan');

      const ok = await reconciler.runWorkerOnce(noDelay, noRequeue);

      expect(ok).toBe(true);
      expect(state.queue).toEqual([]);
      expect(state.processing.size).toBe(0);
      expect(reconcileSpy).not.toHaveBeenCalled();
    });

    it('uses the cached run when the key has no namespace/name split (no GET)', async () => {
      const cached = makeRun('cached', { metadata: { name: 'cached', namespace: '' } });
      const f = fakeWithGet(makeRun('cached', { status: { phase: 'Running' } }));
      reconciler.enqueue(cached); // key becomes "/cached"

      const ok = await reconciler.runWorkerOnce(noDelay, noRequeue);

      expect(ok).toBe(true);
      expect(f.calls.filter((c) => c.method === 'getNamespacedCustomObject')).toHaveLength(0);
      expect(reconcileSpy).toHaveBeenCalledTimes(1);
      expect(reconcileSpy).toHaveBeenCalledWith(cached);
    });
  });

  describe('startPeriodicResync()', () => {
    it('enqueues every seen run on each interval tick', () => {
      const captured: Array<() => void> = [];
      const mockInterval: typeof setInterval = (callback: () => void, _ms: number) => {
        captured.push(callback);
        return { unref: () => {} } as unknown as ReturnType<typeof setInterval>;
      };
      const intervalSpy = spyOn(globalThis, 'setInterval').mockImplementation(mockInterval);
      try {
        reconciler.startPeriodicResync();
        expect(intervalSpy).toHaveBeenCalledTimes(1);
        expect(captured).toHaveLength(1);
        const tick = captured[0];

        // Two runs that have already been processed: still in `seen`, but out
        // of `pending` and the queue (runWorkerOnce deletes pending on shift).
        reconciler.enqueue(makeRun('run-a'));
        reconciler.enqueue(makeRun('run-b'));
        expect(state.queue).toEqual([key('run-a'), key('run-b')]);
        state.pending.clear();
        state.queue.length = 0;

        tick?.(); // resync — must re-enqueue every seen run

        expect(state.queue).toEqual([key('run-a'), key('run-b')]);
        expect(state.pending.has(key('run-a'))).toBe(true);
        expect(state.pending.has(key('run-b'))).toBe(true);
      } finally {
        intervalSpy.mockRestore();
      }
    });
  });
});
