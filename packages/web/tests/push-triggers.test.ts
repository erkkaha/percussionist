// Tests for push trigger decisions: phase-transition detection and the
// push/don't-push policy for tasks and runs.

import { describe, expect, it } from 'bun:test';
import type { Run, Task } from '@percussionist/api';
import { diffPhases, runPush, taskPush } from '../src/server/lib/push-triggers.js';

function makeTask(name: string, phase: string, title = 'Do the thing'): Task {
  return {
    metadata: { name },
    spec: { projectRef: 'proj', type: 'BUILD', title },
    status: { phase },
  } as unknown as Task;
}

function makeRun(name: string, phase: string, boardTask?: string): Run {
  return {
    metadata: { name },
    spec: { task: 'do something', ...(boardTask ? { boardTask } : {}) },
    status: { phase },
  } as unknown as Run;
}

describe('diffPhases', () => {
  it('fires nothing on the first pass, then only on actual transitions', () => {
    const first = diffPhases(null, [
      { name: 'a', phase: 'running' },
      { name: 'b', phase: 'awaiting-human' }, // pre-existing gate: no push on restart
    ]);
    expect(first.transitions).toEqual([]);

    const second = diffPhases(first.next, [
      { name: 'a', phase: 'awaiting-human' },
      { name: 'b', phase: 'awaiting-human' }, // unchanged
    ]);
    expect(second.transitions).toEqual([{ name: 'a', from: 'running', to: 'awaiting-human' }]);
  });

  it('does not fire for objects that appear after the first pass', () => {
    const first = diffPhases(null, [{ name: 'a', phase: 'running' }]);
    // A brand-new task created directly into failed state: no transition seen.
    const second = diffPhases(first.next, [
      { name: 'a', phase: 'running' },
      { name: 'new', phase: 'failed' },
    ]);
    expect(second.transitions).toEqual([]);
    // ...but it transitions normally from here on.
    const third = diffPhases(second.next, [{ name: 'new', phase: 'awaiting-human' }]);
    expect(third.transitions).toEqual([{ name: 'new', from: 'failed', to: 'awaiting-human' }]);
  });

  it('drops deleted objects from the carried map', () => {
    const first = diffPhases(null, [{ name: 'a', phase: 'running' }]);
    const second = diffPhases(first.next, []);
    expect(second.next.size).toBe(0);
  });

  it('ignores objects with no phase yet', () => {
    const { transitions, next } = diffPhases(null, [{ name: 'a', phase: undefined }]);
    expect(transitions).toEqual([]);
    expect(next.size).toBe(0);
  });
});

describe('taskPush policy', () => {
  it('pushes on the human-gate phases with a task deep link', () => {
    for (const phase of ['awaiting-human', 'waiting-for-input', 'failed']) {
      const payload = taskPush(makeTask('t1', phase), phase);
      expect(payload).not.toBeNull();
      expect(payload?.body).toBe('Do the thing in proj');
      expect(payload?.tag).toBe('task:proj:t1');
      expect(payload?.url).toBe('/projects/proj/board?task=t1');
    }
  });

  it('stays quiet on routine progress', () => {
    for (const phase of ['scheduled', 'running', 'succeeded', 'reviewing', 'done']) {
      expect(taskPush(makeTask('t1', phase), phase)).toBeNull();
    }
  });
});

describe('runPush policy', () => {
  it('pushes terminal phases and input requests for standalone runs', () => {
    for (const phase of ['Succeeded', 'Failed', 'Cancelled', 'WaitingForInput']) {
      const payload = runPush(makeRun('r1', phase), phase);
      expect(payload).not.toBeNull();
      expect(payload?.tag).toBe('run:r1');
      expect(payload?.url).toBe('/runs/r1');
    }
  });

  it('stays quiet for board-owned runs — the task transition covers those', () => {
    expect(runPush(makeRun('r1', 'Failed', 'task-1'), 'Failed')).toBeNull();
  });

  it('stays quiet on non-terminal phases', () => {
    for (const phase of ['Pending', 'Initializing', 'Running']) {
      expect(runPush(makeRun('r1', phase), phase)).toBeNull();
    }
  });
});
