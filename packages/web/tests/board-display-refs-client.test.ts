import { describe, expect, it } from 'bun:test';
import {
  getBlockedReasonPresentation,
  getChildRefPresentation,
  getParentRefPresentation,
} from '../src/client/components/board/display-refs.js';
import type { Task } from '../src/client/lib/types.js';

function makeTask(overrides?: Partial<Task>): Task {
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
      ...(overrides?.spec ?? {}),
    },
    status: {
      phase: 'blocked',
      blockedReason: 'Waiting for: proj-build-0',
      ...(overrides?.status ?? {}),
    },
    ...(overrides ?? {}),
  } as Task;
}

describe('board client display ref presentation helpers', () => {
  it('uses display parent label with canonical tooltip', () => {
    const task = makeTask({
      spec: { parentTaskRef: 'proj-plan-abc123' } as Task['spec'],
      displayRefs: {
        parentTask: 'Plan release',
        parentTaskCanonical: 'proj-plan-abc123',
      },
    });

    const parent = getParentRefPresentation(task);
    expect(parent.text).toBe('Plan release');
    expect(parent.tooltip).toBe('Task ID: proj-plan-abc123');
  });

  it('falls back to raw parent ID when display refs missing', () => {
    const task = makeTask({
      spec: { parentTaskRef: 'proj-plan-raw999' } as Task['spec'],
    });

    const parent = getParentRefPresentation(task);
    expect(parent.text).toBe('proj-plan-raw999');
    expect(parent.tooltip).toBe('proj-plan-raw999');
  });

  it('adds blocked tooltip with canonical predecessor when label differs', () => {
    const task = makeTask({
      status: {
        phase: 'blocked',
        blockedReason: 'Waiting for: Prepare migration',
      } as Task['status'],
      displayRefs: {
        predecessorTask: 'Prepare migration',
        predecessorTaskCanonical: 'proj-build-0',
      },
    });

    const blocked = getBlockedReasonPresentation(task, 'blocked');
    expect(blocked.text).toBe('Waiting for: Prepare migration');
    expect(blocked.tooltip).toContain('Task ID: proj-build-0');
  });

  it('returns empty blocked presentation outside blocked column', () => {
    const task = makeTask();
    const blocked = getBlockedReasonPresentation(task, 'done');
    expect(blocked.text).toBeUndefined();
  });

  it('uses child display refs with canonical-id tooltip and raw fallback', () => {
    const task = makeTask({
      status: { phase: 'awaiting-children' } as Task['status'],
      childProgress: {
        total: 2,
        completed: 1,
        childRefs: ['proj-build-a', 'proj-build-b'],
        childDisplayRefs: ['Implement API', 'proj-build-b'],
      },
    });

    const first = getChildRefPresentation(task, 'proj-build-a', 0);
    expect(first.text).toBe('Implement API');
    expect(first.tooltip).toBe('Task ID: proj-build-a');

    const second = getChildRefPresentation(task, 'proj-build-b', 1);
    expect(second.text).toBe('proj-build-b');
    expect(second.tooltip).toBe('proj-build-b');
  });
});
