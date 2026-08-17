// board-task-signature.test.ts — E item: `board task move|remove|approve|retry|
// request-changes` used to accept a `<project>` positional argument and silently
// ignore it (Task CR names are unique within a namespace, so the handlers only
// ever needed --task-name). The `<project>` positional is gone; these tests pin
// that each handler is callable with just its options object and resolves the
// task purely by name.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Task } from '@percussionist/api';

// board.ts imports the CLI's kube facade; mock it so the handlers run without a
// cluster. The factory spreads the real module and overrides the handful of
// functions the tested handlers touch.
const realKube = await import('@percussionist/kube');

const state = {
  phases: new Map<string, string>(),
  taskPatches: [] as Array<{ name: string; patch: unknown }>,
  statusPatches: [] as Array<{ name: string; patch: unknown }>,
  deleted: [] as string[],
};

mock.module('@percussionist/kube', () => ({
  ...realKube,
  NAMESPACE: 'percussionist',
  getTask: async (name: string) =>
    ({
      apiVersion: 'percussionist.dev/v1alpha1',
      kind: 'Task',
      metadata: { name, namespace: 'percussionist', uid: `uid-${name}` },
      spec: { projectRef: 'proj', type: 'BUILD', title: name },
      status: {
        phase: state.phases.get(name) ?? 'awaiting-human',
        worker: { retryCount: 0 },
      },
    }) as Task,
  patchTask: async (name: string, patch: unknown) => {
    state.taskPatches.push({ name, patch });
  },
  patchTaskStatus: async (name: string, patch: unknown) => {
    state.statusPatches.push({ name, patch });
  },
  deleteTask: async (name: string) => {
    state.deleted.push(name);
  },
  fatal: (msg: string) => {
    throw new Error(msg);
  },
}));

const {
  runBoardTaskApprove,
  runBoardTaskMove,
  runBoardTaskRemove,
  runBoardTaskRequestChanges,
  runBoardTaskRetry,
} = await import('../src/board.js');

beforeEach(() => {
  state.phases.clear();
  state.taskPatches = [];
  state.statusPatches = [];
  state.deleted = [];
});

afterEach(() => {
  state.phases.clear();
  state.taskPatches = [];
  state.statusPatches = [];
  state.deleted = [];
});

describe('board task handlers are addressed by --task-name only', () => {
  it('move patches the task named in opts with no project argument', async () => {
    state.phases.set('task-1', 'pending');
    await runBoardTaskMove({ taskName: 'task-1', to: 'scheduled' });

    expect(state.statusPatches).toEqual([{ name: 'task-1', patch: { phase: 'scheduled' } }]);
  });

  it('remove deletes the task named in opts', async () => {
    await runBoardTaskRemove({ taskName: 'task-1' });

    expect(state.deleted).toEqual(['task-1']);
  });

  it('approve writes the canonical annotation on the awaiting-human task', async () => {
    state.phases.set('task-1', 'awaiting-human');
    await runBoardTaskApprove({ taskName: 'task-1' });

    expect(state.taskPatches).toHaveLength(1);
    const annotations = (
      state.taskPatches[0]?.patch as { metadata: { annotations: Record<string, string> } }
    ).metadata.annotations;
    expect(annotations['percussionist.dev/action-approved']).toBe('true');
  });

  it('request-changes writes the rework annotation with the feedback', async () => {
    state.phases.set('task-1', 'awaiting-human');
    await runBoardTaskRequestChanges({ taskName: 'task-1', feedback: 'make it clearer' });

    expect(state.taskPatches).toHaveLength(1);
    const annotations = (
      state.taskPatches[0]?.patch as { metadata: { annotations: Record<string, string> } }
    ).metadata.annotations;
    expect(annotations['percussionist.dev/action-request-changes']).toBe('true');
    expect(annotations['percussionist.dev/action-rework-feedback']).toBe('make it clearer');
  });

  it('retry moves a failed task back to pending and bumps the retry counter', async () => {
    state.phases.set('task-1', 'failed');
    await runBoardTaskRetry({ taskName: 'task-1' });

    expect(state.statusPatches).toHaveLength(1);
    const patch = state.statusPatches[0]?.patch as {
      phase: string;
      worker?: { retryCount: number };
    };
    expect(patch.phase).toBe('pending');
    expect(patch.worker?.retryCount).toBe(1);
  });
});
