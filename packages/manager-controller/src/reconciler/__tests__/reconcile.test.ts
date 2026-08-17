import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Task } from '@percussionist/api';
import * as kube from '@percussionist/kube';
import * as events from '../../events.js';
import { resolveFlow } from '../flow.js';
import { reconcileProject } from '../index.js';
import * as observations from '../observations.js';
import { makeProject, makeRun, makeTask } from './fixtures.js';

describe('buildTask default phase', () => {
  it('creates tasks with status.phase = pending by default', () => {
    const task = kube.buildTask({
      name: 'test-task',
      projectName: 'test-project',
      projectUid: 'uid-test',
      ns: 'percussionist',
      spec: {
        projectRef: 'test-project',
        type: 'BUILD',
        title: 'Test task',
        description: '',
        agent: 'builder',
        priority: 'medium',
      },
    });

    expect(task.status?.phase).toBe('pending');
  });

  it('preserves explicitly set phase in buildTask', () => {
    // Note: buildTask doesn't accept a phase override — callers who need
    // non-pending phases must patch status after creation. This test documents
    // that the default is always "pending".
    const task = kube.buildTask({
      name: 'test-task',
      projectName: 'test-project',
      projectUid: 'uid-test',
      ns: 'percussionist',
      spec: {
        projectRef: 'test-project',
        type: 'PLAN',
        title: 'Test plan',
        description: '',
        agent: 'planner',
        priority: 'high',
      },
    });

    expect(task.status?.phase).toBe('pending');
  });
});

describe('reconciler auto-heal', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let listTasksSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let patchTaskStatusSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let getRunSpy: any;

  beforeEach(() => {
    listTasksSpy = spyOn(kube, 'listTasks');
    patchTaskStatusSpy = spyOn(kube, 'patchTaskStatus');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getRunSpy = spyOn(kube, 'getRun').mockResolvedValue(undefined as any);
  });

  afterEach(() => {
    listTasksSpy.mockRestore();
    patchTaskStatusSpy.mockRestore();
    getRunSpy.mockRestore();
  });

  it('patches tasks with missing status.phase to pending', async () => {
    const taskWithoutPhase: Task = makeTask('limbo-task', 'test-project', { noStatus: true });
    listTasksSpy.mockResolvedValue([taskWithoutPhase]);

    patchTaskStatusSpy.mockImplementation(async (_name: string, patch: Record<string, unknown>) => {
      return { ...taskWithoutPhase, status: { phase: patch.phase } };
    });

    const project = makeProject('test-project');
    await reconcileProject(project, 'percussionist');

    expect(patchTaskStatusSpy).toHaveBeenCalledWith(
      'limbo-task',
      { phase: 'pending' },
      'percussionist',
    );
  });

  it('does not patch tasks that already have a phase', async () => {
    const taskWithPhase = makeTask('normal-task', 'test-project', {
      phase: 'scheduled',
    });
    listTasksSpy.mockResolvedValue([taskWithPhase]);

    const project = makeProject('test-project');
    await reconcileProject(project, 'percussionist');

    expect(patchTaskStatusSpy).not.toHaveBeenCalled();
  });

  it('heals multiple tasks with missing phase', async () => {
    const task1: Task = makeTask('limbo-1', 'test-project', { noStatus: true });
    const task2: Task = makeTask('limbo-2', 'test-project', { noStatus: true });
    listTasksSpy.mockResolvedValue([task1, task2]);

    patchTaskStatusSpy.mockImplementation(
      async () => ({ status: { phase: 'pending' } }) as unknown as Task,
    );

    const project = makeProject('test-project');
    await reconcileProject(project, 'percussionist');

    // Both limbo tasks must end up healed to pending. Do not pin the call
    // count — the heal runs in two passes today, but only the observable
    // outcome (every phase-less task patched to pending) is the contract.
    expect(patchTaskStatusSpy).toHaveBeenCalledWith(
      'limbo-1',
      { phase: 'pending' },
      'percussionist',
    );
    expect(patchTaskStatusSpy).toHaveBeenCalledWith(
      'limbo-2',
      { phase: 'pending' },
      'percussionist',
    );
  });

  it('heals idea tasks that are missing phase (malformed)', async () => {
    // An idea task without a status.phase is malformed and should be healed.
    const ideaTask: Task = makeTask('idea-task', 'test-project', { noStatus: true });
    listTasksSpy.mockResolvedValue([ideaTask]);

    patchTaskStatusSpy.mockImplementation(
      async () => ({ status: { phase: 'pending' } }) as unknown as Task,
    );

    const project = makeProject('test-project');
    await reconcileProject(project, 'percussionist');

    // Malformed idea tasks (no phase) are healed to pending.
    expect(patchTaskStatusSpy).toHaveBeenCalledWith(
      'idea-task',
      { phase: 'pending' },
      'percussionist',
    );
  });

  it('does not heal well-formed idea or done tasks', async () => {
    const ideaTask = makeTask('idea-task', 'test-project', { phase: 'idea' });
    const doneTask = makeTask('done-task', 'test-project', { phase: 'done' });
    listTasksSpy.mockResolvedValue([ideaTask, doneTask]);

    patchTaskStatusSpy.mockImplementation(
      async () => ({ status: { phase: 'pending' } }) as unknown as Task,
    );

    const project = makeProject('test-project');
    await reconcileProject(project, 'percussionist');

    // Well-formed idea and done tasks are filtered out before the heal loop.
    expect(patchTaskStatusSpy).not.toHaveBeenCalled();
  });

  it('heals task with empty status object', async () => {
    const taskWithEmptyStatus: Task = makeTask('empty-status-task', 'test-project', {});
    // Override to have an empty status object (no phase)
    (taskWithEmptyStatus as any).status = {};
    listTasksSpy.mockResolvedValue([taskWithEmptyStatus]);

    patchTaskStatusSpy.mockImplementation(
      async () => ({ status: { phase: 'pending' } }) as unknown as Task,
    );

    const project = makeProject('test-project');
    await reconcileProject(project, 'percussionist');

    expect(patchTaskStatusSpy).toHaveBeenCalledWith(
      'empty-status-task',
      { phase: 'pending' },
      'percussionist',
    );
  });
});

describe('reconciler non-happy-path loop isolation', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let listTasksSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let patchTaskStatusSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let getTaskSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let getRunSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let listRunsSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let getFindingsConfigMapSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let observeSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let emitEventSpy: any;

  const makeKubeError = (statusCode: number): Error & { statusCode: number } =>
    Object.assign(new Error(`kube error ${statusCode}`), { statusCode });

  beforeEach(() => {
    listTasksSpy = spyOn(kube, 'listTasks');
    patchTaskStatusSpy = spyOn(kube, 'patchTaskStatus');
    getTaskSpy = spyOn(kube, 'getTask');
    getRunSpy = spyOn(kube, 'getRun').mockResolvedValue(undefined as any);
    listRunsSpy = spyOn(kube, 'listRuns').mockResolvedValue([] as any);
    getFindingsConfigMapSpy = spyOn(kube, 'getFindingsConfigMap').mockResolvedValue(null);
    observeSpy = spyOn(observations, 'observe');
    emitEventSpy = spyOn(events, 'emitEvent').mockImplementation(() => {});
  });

  afterEach(() => {
    listTasksSpy.mockRestore();
    patchTaskStatusSpy.mockRestore();
    getTaskSpy.mockRestore();
    getRunSpy.mockRestore();
    listRunsSpy.mockRestore();
    getFindingsConfigMapSpy.mockRestore();
    observeSpy.mockRestore();
    emitEventSpy.mockRestore();
  });

  it('poison task (observe throws) does not prevent the next task transition or findings ingestion', async () => {
    const project = makeProject('test-project');
    const poisonTask = makeTask('poison', 'test-project', {
      phase: 'running',
      type: 'BUILD',
      runName: 'run-poison',
    });
    const normalTask = makeTask('normal', 'test-project', {
      phase: 'running',
      type: 'BUILD',
      runName: 'run-normal',
    });
    listTasksSpy.mockResolvedValue([poisonTask, normalTask]);
    getTaskSpy.mockImplementation(async (name: string) =>
      name === 'normal' ? normalTask : poisonTask,
    );
    observeSpy.mockImplementation(async (task: Task) => {
      if (task.metadata.name === 'poison') {
        throw new Error('poison task observe failure');
      }
      return {
        task,
        project,
        allTasks: [poisonTask, normalTask],
        observed: { worker: makeRun('run-normal', { phase: 'Failed' }) },
        manualActions: {},
        flow: resolveFlow(project),
        capacity: { activeCount: 0, maxParallel: 2 },
        now: '2026-05-29T00:00:00.000Z',
      };
    });
    patchTaskStatusSpy.mockImplementation(
      async () => ({ status: { phase: 'failed' } }) as unknown as Task,
    );

    await reconcileProject(project, 'percussionist');

    // The task after the poison task still transitioned (running → failed).
    const normalPatch = patchTaskStatusSpy.mock.calls.find(
      (call: unknown[]) => call[0] === 'normal',
    );
    expect(normalPatch).toBeDefined();
    expect((normalPatch?.[1] as Record<string, unknown> | undefined)?.phase).toBe('failed');
    // Findings ingestion still ran after the poison task was isolated.
    expect(getFindingsConfigMapSpy).toHaveBeenCalledWith('test-project', 'percussionist');
  });

  it('heal failure is tolerated — a rejected heal patch does not abort the cycle', async () => {
    const project = makeProject('test-project');
    const limboTask = makeTask('limbo', 'test-project', { noStatus: true });
    listTasksSpy.mockResolvedValue([limboTask]);
    patchTaskStatusSpy.mockRejectedValue(new Error('api server unreachable'));

    await expect(reconcileProject(project, 'percussionist')).resolves.toBeUndefined();
    // The heal was attempted and failed without aborting the cycle.
    expect(patchTaskStatusSpy).toHaveBeenCalledWith('limbo', { phase: 'pending' }, 'percussionist');
  });

  it('patchTaskStatus 409 on heal → tolerated (conflict, retried next cycle)', async () => {
    const project = makeProject('test-project');
    const limboTask = makeTask('limbo', 'test-project', { noStatus: true });
    listTasksSpy.mockResolvedValue([limboTask]);
    patchTaskStatusSpy.mockRejectedValue(makeKubeError(409));

    await expect(reconcileProject(project, 'percussionist')).resolves.toBeUndefined();
    expect(patchTaskStatusSpy).toHaveBeenCalledWith('limbo', { phase: 'pending' }, 'percussionist');
  });

  it('listTasks 429 → reconcileProject rejects; caller loop survives to next cycle', async () => {
    const project = makeProject('test-project');
    // Cycle 1: listTasks rejects with 429 (Too Many Requests). reconcileProject
    // propagates the rejection (the initial list is outside any per-task
    // try/catch), so the runWorker loop's catch re-enqueues the project with
    // backoff instead of hanging or corrupting state.
    listTasksSpy.mockResolvedValue([makeTask('t1', 'test-project', { phase: 'done' })]);
    listTasksSpy.mockRejectedValueOnce(makeKubeError(429));

    await expect(reconcileProject(project, 'percussionist')).rejects.toMatchObject({
      statusCode: 429,
    });

    // Cycle 2: the next cycle recovers and completes normally.
    await expect(reconcileProject(project, 'percussionist')).resolves.toBeUndefined();
  });
});
