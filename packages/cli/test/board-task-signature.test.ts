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
  prNumbers: new Map<string, number>(),
  taskPatches: [] as Array<{ name: string; patch: unknown }>,
  statusPatches: [] as Array<{ name: string; patch: unknown }>,
  deleted: [] as string[],
};

mock.module('@percussionist/kube', () => ({
  ...realKube,
  NAMESPACE: 'percussionist',
  getTask: async (name: string) => {
    const prNumber = state.prNumbers.get(name);
    return {
      apiVersion: 'percussionist.dev/v1alpha1',
      kind: 'Task',
      metadata: { name, namespace: 'percussionist', uid: `uid-${name}` },
      spec: { projectRef: 'proj', type: 'BUILD', title: name },
      status: {
        phase: state.phases.get(name) ?? 'awaiting-human',
        worker: prNumber !== undefined ? { retryCount: 0, prNumber } : { retryCount: 0 },
      },
    } as Task;
  },
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

// The gating handlers exit the process (and print to stderr) on an ineligible
// task. Stub both so the rejection path can be asserted instead of killing the
// test runner, and always restore them between tests.
const realExit = process.exit;
const realError = console.error;
const errorLines: string[] = [];

function stubProcessExit(): void {
  process.exit = ((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as unknown as typeof process.exit;
}

beforeEach(() => {
  state.phases.clear();
  state.prNumbers.clear();
  state.taskPatches = [];
  state.statusPatches = [];
  state.deleted = [];
  errorLines.length = 0;
  stubProcessExit();
  console.error = (...args: unknown[]) => {
    errorLines.push(args.join(' '));
  };
});

afterEach(() => {
  state.phases.clear();
  state.prNumbers.clear();
  state.taskPatches = [];
  state.statusPatches = [];
  state.deleted = [];
  process.exit = realExit;
  console.error = realError;
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

describe('request-changes accepts the PR stage', () => {
  it('writes the annotation for an open-PR task parked in awaiting-feature-merge', async () => {
    state.phases.set('plan-1', 'awaiting-feature-merge');
    state.prNumbers.set('plan-1', 42);
    await runBoardTaskRequestChanges({ taskName: 'plan-1', feedback: 'widen the scope' });

    expect(state.taskPatches).toHaveLength(1);
    const annotations = (
      state.taskPatches[0]?.patch as { metadata: { annotations: Record<string, string> } }
    ).metadata.annotations;
    expect(annotations['percussionist.dev/action-request-changes']).toBe('true');
    expect(annotations['percussionist.dev/action-rework-feedback']).toBe('widen the scope');
  });

  it('refuses awaiting-feature-merge without a prNumber', async () => {
    state.phases.set('plan-1', 'awaiting-feature-merge');
    await expect(
      runBoardTaskRequestChanges({ taskName: 'plan-1', feedback: 'widen the scope' }),
    ).rejects.toThrow('process.exit(1)');

    expect(state.taskPatches).toHaveLength(0);
    expect(errorLines.join('\n')).toContain('awaiting-feature-merge');
    expect(errorLines.join('\n')).toContain('prNumber');
  });

  it('refuses a done task', async () => {
    state.phases.set('task-1', 'done');
    await expect(
      runBoardTaskRequestChanges({ taskName: 'task-1', feedback: 'redo it' }),
    ).rejects.toThrow('process.exit(1)');

    expect(state.taskPatches).toHaveLength(0);
    expect(errorLines.join('\n')).toContain('cannot request changes on');
  });

  it('refuses a running task', async () => {
    state.phases.set('task-1', 'running');
    await expect(
      runBoardTaskRequestChanges({ taskName: 'task-1', feedback: 'redo it' }),
    ).rejects.toThrow('process.exit(1)');

    expect(state.taskPatches).toHaveLength(0);
  });
});
