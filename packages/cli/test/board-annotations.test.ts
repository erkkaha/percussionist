// board-annotations.test.ts — approve / request-changes / retry annotation and
// status-patch semantics (C21).
//
// board-move.test.ts covers resolveTaskMove; these tests pin the pure patch
// builders behind the human-in-the-loop commands. The patch payloads are the
// contract the manager's reconciler consumes on its next pass (writes the
// canonical annotations rather than patching status.phase directly), so a
// regression here silently breaks approve/rework flows.

import { describe, expect, it } from 'bun:test';
import type { Task } from '@percussionist/api';
import {
  approveTaskMetadataPatch,
  requestChangesTaskMetadataPatch,
  retryTaskStatusPatch,
} from '../src/board.ts';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Task',
    metadata: {
      name: 'task-1',
      namespace: 'percussionist',
      uid: 'task-uid',
      annotations: { 'pre-existing': 'keep' },
      resourceVersion: '42',
    },
    spec: {
      projectRef: 'proj',
      type: 'BUILD',
      title: 'task',
    },
    status: { phase: 'awaiting-human' },
    ...overrides,
  } as Task;
}

describe('approveTaskMetadataPatch', () => {
  it('writes the canonical approval annotation and clears request-changes', () => {
    const patch = approveTaskMetadataPatch(makeTask());
    const annotations = patch.metadata.annotations ?? {};
    expect(annotations['percussionist.dev/action-approved']).toBe('true');
    expect(annotations['percussionist.dev/action-request-changes']).toBe('false');
  });

  it('preserves the rest of the task metadata and pre-existing annotations', () => {
    const task = makeTask();
    const patch = approveTaskMetadataPatch(task);
    expect(patch.metadata.name).toBe('task-1');
    expect(patch.metadata.resourceVersion).toBe('42'); // kept for conditional writes
    expect(patch.metadata.annotations?.['pre-existing']).toBe('keep');
    // The annotations object is an extension — no existing key is dropped.
    expect(Object.keys(patch.metadata.annotations ?? {}).sort()).toEqual([
      'percussionist.dev/action-approved',
      'percussionist.dev/action-request-changes',
      'pre-existing',
    ]);
  });

  it('works when the task has no annotations yet', () => {
    const task = makeTask({ metadata: { name: 'bare', namespace: 'ns' } });
    const patch = approveTaskMetadataPatch(task);
    expect(patch.metadata.annotations?.['percussionist.dev/action-approved']).toBe('true');
  });
});

describe('requestChangesTaskMetadataPatch', () => {
  it('marks the task for rework and attaches the human feedback', () => {
    const patch = requestChangesTaskMetadataPatch(makeTask(), 'please add tests');
    const annotations = patch.metadata.annotations ?? {};
    expect(annotations['percussionist.dev/action-request-changes']).toBe('true');
    expect(annotations['percussionist.dev/action-rework-feedback']).toBe('please add tests');
  });

  it('preserves pre-existing annotations like approve does', () => {
    const patch = requestChangesTaskMetadataPatch(makeTask(), 'redo');
    expect(patch.metadata.annotations?.['pre-existing']).toBe('keep');
    expect(patch.metadata.name).toBe('task-1');
  });
});

describe('retryTaskStatusPatch', () => {
  it('re-dispatches a failed task to pending and bumps the worker retryCount for a fresh run name', () => {
    const task = makeTask({
      status: {
        phase: 'failed',
        worker: { runName: 'run-old', status: 'Failed', retryCount: 2, aiReworkCount: 0 },
      },
    });
    const patch = retryTaskStatusPatch(task, false);
    expect(patch.phase).toBe('pending');
    expect(patch.worker?.retryCount).toBe(3);
    // The rest of the worker record is carried over for the reconciler.
    expect(patch.worker?.runName).toBe('run-old');
  });

  it('leaves the retryCount alone when there is no recorded worker', () => {
    const task = makeTask({ status: { phase: 'failed' } });
    const patch = retryTaskStatusPatch(task, false);
    expect(patch.phase).toBe('pending');
    expect(patch.worker).toBeUndefined();
  });

  it('sends the task straight to awaiting-human on --review without bumping the counter', () => {
    const task = makeTask({
      status: {
        phase: 'failed',
        worker: { runName: 'run-old', status: 'Failed', retryCount: 4, aiReworkCount: 1 },
      },
    });
    const patch = retryTaskStatusPatch(task, true);
    expect(patch.phase).toBe('awaiting-human');
    expect(patch.worker).toBeUndefined();
  });

  it('never touches the legacy status.column field', () => {
    const task = makeTask({ status: { phase: 'failed', column: 'reviewing' } as never });
    for (const review of [false, true]) {
      const patch = retryTaskStatusPatch(task, review);
      expect('column' in patch).toBe(false);
    }
  });
});
