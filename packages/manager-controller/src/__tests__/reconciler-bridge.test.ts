// reconciler-bridge.test.ts
//
// Per-project pause coverage for the reconciler bridge (finding A4 / test gap
// C4 from percussionist-dev-plan-4abf54). Pins:
//   - pausing one project never freezes another (per-project map, no module
//     global);
//   - resume clears only the addressed project;
//   - expiry: pause is honored, then auto-expires with real elapsedMs /
//     remainingMs;
//   - the `percussionist.dev/reconcile-paused` annotations are honored by
//     reconcile()/getPauseStatus() with no in-memory state — i.e. the pause
//     survives a manager restart;
//   - lastReconcile is a real timestamp recorded only after a successful
//     reconcile, never fabricated.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Project } from '@percussionist/api';
import * as kube from '@percussionist/kube';
import { makeProject } from '../reconciler/__tests__/fixtures.js';
import * as reconciler from '../reconciler/index.js';
import {
  dequeue,
  enqueue,
  getLastReconcile,
  getPauseStatus,
  reconcile,
  runWorker,
  setPaused,
} from '../reconciler-bridge.js';

const NS = 'percussionist';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function projectWithAnnotations(
  name: string,
  annotations: Record<string, string>,
): ReturnType<typeof makeProject> {
  return {
    ...makeProject(name),
    metadata: {
      ...makeProject(name).metadata,
      annotations,
    },
  };
}

describe('per-project pause (in-memory map)', () => {
  beforeEach(() => {
    setPaused('proj-a', false, 0, NS);
    setPaused('proj-b', false, 0, NS);
  });

  afterEach(() => {
    setPaused('proj-a', false, 0, NS);
    setPaused('proj-b', false, 0, NS);
  });

  it('pausing one project does not pause another', () => {
    setPaused('proj-a', true, 60_000, NS);

    expect(getPauseStatus(makeProject('proj-a')).paused).toBe(true);
    expect(getPauseStatus(makeProject('proj-b')).paused).toBe(false);
  });

  it('reports real remainingMs/elapsedMs while paused', () => {
    setPaused('proj-a', true, 60_000, NS);

    const status = getPauseStatus(makeProject('proj-a'));
    expect(status.paused).toBe(true);
    expect(status.remainingMs).toBeGreaterThan(0);
    expect(status.remainingMs).toBeLessThanOrEqual(60_000);
    expect(status.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(status.elapsedMs).toBeLessThan(1_000);
  });

  it('resume clears only the addressed project', () => {
    setPaused('proj-a', true, 60_000, NS);
    setPaused('proj-b', true, 60_000, NS);

    setPaused('proj-a', false, 0, NS);

    expect(getPauseStatus(makeProject('proj-a')).paused).toBe(false);
    expect(getPauseStatus(makeProject('proj-b')).paused).toBe(true);
  });

  it('a project with no pause state reports not paused with zero times', () => {
    const status = getPauseStatus(makeProject('proj-never'));
    expect(status).toEqual({ paused: false, elapsedMs: 0, remainingMs: 0 });
  });

  it('pause auto-expires: paused → not paused with full elapsedMs and 0 remainingMs', async () => {
    setPaused('proj-a', true, 30, NS);
    expect(getPauseStatus(makeProject('proj-a')).paused).toBe(true);

    await sleep(80);

    const status = getPauseStatus(makeProject('proj-a'));
    expect(status.paused).toBe(false);
    expect(status.remainingMs).toBe(0);
    expect(status.elapsedMs).toBeGreaterThanOrEqual(30);
  });
});

describe('reconcile() pause gating', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let reconcileProjectSpy: any;

  beforeEach(() => {
    reconcileProjectSpy = spyOn(reconciler, 'reconcileProject').mockResolvedValue(undefined);
    setPaused('proj-a', false, 0, NS);
    setPaused('proj-b', false, 0, NS);
  });

  afterEach(() => {
    reconcileProjectSpy.mockRestore();
    setPaused('proj-a', false, 0, NS);
    setPaused('proj-b', false, 0, NS);
  });

  it('skips reconcileProject while the project is paused', async () => {
    setPaused('proj-a', true, 60_000, NS);

    await reconcile(makeProject('proj-a'));

    expect(reconcileProjectSpy).not.toHaveBeenCalled();
  });

  it('calls reconcileProject once the pause expires', async () => {
    setPaused('proj-a', true, 30, NS);
    await sleep(80);

    await reconcile(makeProject('proj-a'));

    expect(reconcileProjectSpy).toHaveBeenCalledTimes(1);
  });

  it('a paused project does not block other projects', async () => {
    setPaused('proj-a', true, 60_000, NS);

    await reconcile(makeProject('proj-a'));
    await reconcile(makeProject('proj-b'));

    expect(reconcileProjectSpy).toHaveBeenCalledTimes(1);
    expect(reconcileProjectSpy).toHaveBeenCalledWith(makeProject('proj-b'), NS);
  });

  it('records lastReconcile only after a successful reconcile', async () => {
    expect(getLastReconcile(makeProject('rec-proj'))).toBeUndefined();

    await reconcile(makeProject('rec-proj'));

    const ts = getLastReconcile(makeProject('rec-proj'));
    expect(ts).toBeDefined();
    expect(Number.isNaN(new Date(ts as string).getTime())).toBe(false);
    expect(new Date(ts as string).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('does not record lastReconcile when reconcile is skipped due to pause', async () => {
    setPaused('skip-proj', true, 60_000, NS);

    await reconcile(makeProject('skip-proj'));

    expect(reconcileProjectSpy).not.toHaveBeenCalled();
    expect(getLastReconcile(makeProject('skip-proj'))).toBeUndefined();
  });
});

describe('annotation-based pause survives a manager restart', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let reconcileProjectSpy: any;

  beforeEach(() => {
    reconcileProjectSpy = spyOn(reconciler, 'reconcileProject').mockResolvedValue(undefined);
  });

  afterEach(() => {
    reconcileProjectSpy.mockRestore();
  });

  // Simulates a fresh manager process: setPaused was never called (the
  // in-memory map is empty) — only the project CR carries the annotations
  // written by the previous process.
  const restartedPausedProject = (name: string, pausedAt: string, durationSeconds: number) =>
    projectWithAnnotations(name, {
      'percussionist.dev/reconcile-paused': 'true',
      'percussionist.dev/reconcile-paused-at': pausedAt,
      'percussionist.dev/reconcile-paused-duration': String(durationSeconds),
    });

  it('getPauseStatus honors the annotation with real elapsed/remaining', () => {
    const pausedAt = Date.now() - 10_000; // started 10s ago, 60s duration
    const project = restartedPausedProject('proj-a', new Date(pausedAt).toISOString(), 60);

    const status = getPauseStatus(project);
    expect(status.paused).toBe(true);
    expect(status.elapsedMs).toBeGreaterThanOrEqual(10_000);
    expect(status.remainingMs).toBeGreaterThan(0);
    expect(status.remainingMs).toBeLessThanOrEqual(50_000);
  });

  it('reconcile() skips a project whose annotation says paused', async () => {
    const project = restartedPausedProject('proj-a', new Date(Date.now()).toISOString(), 60);

    await reconcile(project);

    expect(reconcileProjectSpy).not.toHaveBeenCalled();
  });

  it('an expired annotation no longer blocks reconciliation and reports 0 remaining', async () => {
    const project = restartedPausedProject(
      'proj-a',
      new Date(Date.now() - 120_000).toISOString(), // expired 60s ago
      60,
    );

    const status = getPauseStatus(project);
    expect(status.paused).toBe(false);
    expect(status.remainingMs).toBe(0);
    expect(status.elapsedMs).toBe(60_000);

    await reconcile(project);
    expect(reconcileProjectSpy).toHaveBeenCalledTimes(1);
  });

  it('malformed annotations are ignored', () => {
    const noTimestamp = projectWithAnnotations('proj-a', {
      'percussionist.dev/reconcile-paused': 'true',
    });
    expect(getPauseStatus(noTimestamp).paused).toBe(false);

    const badDuration = projectWithAnnotations('proj-a', {
      'percussionist.dev/reconcile-paused': 'true',
      'percussionist.dev/reconcile-paused-at': new Date().toISOString(),
      'percussionist.dev/reconcile-paused-duration': 'abc',
    });
    expect(getPauseStatus(badDuration).paused).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runWorker — worker loop behavior (404-vs-other-errors, pause gating).
//
// runWorker loops forever in production; the options object (injectable delays
// + maxIterations) lets the tests drive it with tiny timings and terminate it
// deterministically.
// ---------------------------------------------------------------------------

describe('runWorker — 404-vs-other backoff', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let getProjectSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let reconcileProjectSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let consoleLogSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let consoleErrorSpy: any;

  const fast = { queueEmptyDelayMs: 1, errorBackoffMs: 1, interProjectDelayMs: 0 };

  const logContains = (spy: { mock: { calls: unknown[][] } }, needle: string) =>
    spy.mock.calls.some((call: unknown[]) => call.some((a) => String(a).includes(needle)));

  beforeEach(() => {
    getProjectSpy = spyOn(kube, 'getProject');
    reconcileProjectSpy = spyOn(reconciler, 'reconcileProject').mockResolvedValue(undefined);
    consoleLogSpy = spyOn(console, 'log');
    consoleErrorSpy = spyOn(console, 'error');
    // Clear any queue/pause residue between runs.
    dequeue('percussionist/proj-a');
    dequeue('percussionist/proj-b');
    setPaused('proj-a', false, 0, NS);
    setPaused('proj-b', false, 0, NS);
  });

  afterEach(() => {
    getProjectSpy.mockRestore();
    reconcileProjectSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    dequeue('percussionist/proj-a');
    dequeue('percussionist/proj-b');
    setPaused('proj-a', false, 0, NS);
    setPaused('proj-b', false, 0, NS);
  });

  it('drops a 404 project from the queue instead of retrying it', async () => {
    enqueue(makeProject('proj-a'));
    getProjectSpy.mockRejectedValue(Object.assign(new Error('gone'), { statusCode: 404 }));

    await runWorker({ ...fast, maxIterations: 4 });

    // Exactly one lookup — the key is forgotten, not re-enqueued.
    expect(getProjectSpy).toHaveBeenCalledTimes(1);
    expect(getProjectSpy).toHaveBeenCalledWith('proj-a', 'percussionist');
    expect(reconcileProjectSpy).not.toHaveBeenCalled();
    // Reported as a drop, not as an error.
    expect(logContains(consoleLogSpy, 'dropping from queue')).toBe(true);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('drops a NotFound-by-reason error (no statusCode) the same way', async () => {
    enqueue(makeProject('proj-a'));
    getProjectSpy.mockRejectedValue({ body: { reason: 'NotFound' } });

    await runWorker({ ...fast, maxIterations: 4 });

    expect(getProjectSpy).toHaveBeenCalledTimes(1);
    expect(logContains(consoleLogSpy, 'dropping from queue')).toBe(true);
  });

  it('skips (without error) when getProject returns undefined', async () => {
    enqueue(makeProject('proj-a'));
    getProjectSpy.mockResolvedValue(undefined as never);

    await runWorker({ ...fast, maxIterations: 3 });

    expect(getProjectSpy).toHaveBeenCalledTimes(1);
    expect(reconcileProjectSpy).not.toHaveBeenCalled();
    expect(logContains(consoleLogSpy, 'not found, skipping')).toBe(true);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('re-enqueues a project on a genuine error and backs off before retrying', async () => {
    enqueue(makeProject('proj-a'));
    getProjectSpy.mockRejectedValue(Object.assign(new Error('boom'), { statusCode: 500 }));

    await runWorker({ ...fast, maxIterations: 4 });

    // Re-enqueued after the error: the project is picked up again on a later iteration.
    expect(getProjectSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(reconcileProjectSpy).not.toHaveBeenCalled();
    expect(logContains(consoleErrorSpy, 'boom')).toBe(true);
    expect(logContains(consoleLogSpy, 'dropping from queue')).toBe(false);
  });

  it('reconciles a healthy queued project and drops it from the queue', async () => {
    enqueue(makeProject('proj-a'));
    getProjectSpy.mockResolvedValue(makeProject('proj-a'));

    await runWorker({ ...fast, maxIterations: 4 });

    expect(getProjectSpy).toHaveBeenCalledTimes(1);
    expect(reconcileProjectSpy).toHaveBeenCalledTimes(1);
    expect(reconcileProjectSpy).toHaveBeenCalledWith(makeProject('proj-a'), 'percussionist');
  });

  it('skips a paused project inside the loop without freezing another project', async () => {
    setPaused('proj-a', true, 60_000, NS);
    enqueue(makeProject('proj-a'));
    enqueue(makeProject('proj-b'));
    getProjectSpy.mockImplementation(async (name: string) => makeProject(name) as Project);

    await runWorker({ ...fast, maxIterations: 4 });

    // proj-a was fetched but its reconcile was skipped by the pause gate;
    // proj-b reconciled normally.
    expect(getProjectSpy).toHaveBeenCalledTimes(2);
    expect(reconcileProjectSpy).toHaveBeenCalledTimes(1);
    expect(reconcileProjectSpy).toHaveBeenCalledWith(makeProject('proj-b'), 'percussionist');
  });

  it('polls quietly while the queue is empty, without touching the cluster', async () => {
    getProjectSpy.mockResolvedValue(makeProject('proj-a'));

    await runWorker({ queueEmptyDelayMs: 1, maxIterations: 3 });

    expect(getProjectSpy).not.toHaveBeenCalled();
    expect(reconcileProjectSpy).not.toHaveBeenCalled();
  });
});
