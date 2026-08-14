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
import { makeProject } from '../reconciler/__tests__/fixtures.js';
import * as reconciler from '../reconciler/index.js';
import { getLastReconcile, getPauseStatus, reconcile, setPaused } from '../reconciler-bridge.js';

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
