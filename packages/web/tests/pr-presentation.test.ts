import { describe, expect, it } from 'bun:test';
import { getPrPresentation } from '../src/client/components/board/pr-presentation.js';
import type { Task, WorkerStatus } from '../src/client/lib/types.js';

function makeTask(worker?: WorkerStatus): Task {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Task',
    metadata: {
      name: 'proj-build-1',
      creationTimestamp: '2026-01-01T00:00:00Z',
    },
    spec: {
      projectRef: 'proj',
      type: 'BUILD',
      title: 'Build task',
      agent: 'builder',
    },
    status: {
      phase: 'awaiting-feature-merge',
      worker,
    },
  } as unknown as Task;
}

describe('getPrPresentation', () => {
  it('returns null when no prNumber is set', () => {
    const task = makeTask({});
    expect(getPrPresentation(task, 'https://github.com/org/repo')).toBeNull();
  });

  it('derives "open" state for a bare prNumber', () => {
    const task = makeTask({ prNumber: 7 });
    const pr = getPrPresentation(task, 'https://github.com/org/repo');
    expect(pr).toEqual({
      prNumber: 7,
      url: 'https://github.com/org/repo/pull/7',
      state: 'open',
    });
  });

  it('derives "merged" state when mergedAt is set', () => {
    const task = makeTask({ prNumber: 7, mergedAt: '2026-01-02T00:00:00Z' });
    const pr = getPrPresentation(task, 'https://github.com/org/repo');
    expect(pr?.state).toBe('merged');
  });

  it('derives "closed" state when mergeError is set', () => {
    const task = makeTask({ prNumber: 7, mergeError: 'PR #7 was closed without merging' });
    const pr = getPrPresentation(task, 'https://github.com/org/repo');
    expect(pr?.state).toBe('closed');
  });

  it('prefers "merged" over "closed" when both mergedAt and mergeError are set', () => {
    const task = makeTask({
      prNumber: 7,
      mergedAt: '2026-01-02T00:00:00Z',
      mergeError: 'stale error',
    });
    const pr = getPrPresentation(task, 'https://github.com/org/repo');
    expect(pr?.state).toBe('merged');
  });

  it('omits url when repoWebUrl is not provided', () => {
    const task = makeTask({ prNumber: 7 });
    const pr = getPrPresentation(task, undefined);
    expect(pr?.url).toBeUndefined();
    expect(pr?.prNumber).toBe(7);
  });
});
