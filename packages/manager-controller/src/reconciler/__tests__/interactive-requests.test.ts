// interactive-requests.test.ts
//
// Unit coverage for the interactive-run reconcile pass (BUILD B). The pass
// consumes `percussionist.dev/action-interactive` annotations written by the
// board/CLI/MCP tool and creates an auxiliary Run via buildWorkerRun. These
// tests pin:
//   - create + annotation clear (null merge-patch value);
//   - idempotent adoption of an existing Run (AlreadyExists 409);
//   - invalid / malformed payloads clear the annotation without a Run;
//   - done/idea tasks clear the annotation without a Run;
//   - per-task failure isolation (one bad task must not starve the rest);
//   - the deterministic run name derived from the request id.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Run, Task } from '@percussionist/api';
import { INTERACTIVE_RUN_ANNOTATION, interactiveRunName } from '@percussionist/api';
import * as kube from '@percussionist/kube';
import * as events from '../../events.js';
import * as workerBuilder from '../../worker-builder.js';
import * as audit from '../audit.js';
import { processInteractiveRequests } from '../interactive-requests.js';
import { makeProject, makeTask } from './fixtures.js';

const namespace = 'percussionist';
const requestId = 'abcd1234';

function withAnnotation(task: Task, payload: unknown): Task {
  return {
    ...task,
    metadata: {
      ...task.metadata,
      annotations: {
        ...(task.metadata.annotations ?? {}),
        [INTERACTIVE_RUN_ANNOTATION]:
          typeof payload === 'string' ? payload : JSON.stringify(payload),
      },
    },
  } as Task;
}

let buildWorkerRunSpy: ReturnType<typeof spyOn>;
let createRunSpy: ReturnType<typeof spyOn>;
let patchTaskSpy: ReturnType<typeof spyOn>;
let persistEventSpy: ReturnType<typeof spyOn>;
let emitEventSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  buildWorkerRunSpy = spyOn(workerBuilder, 'buildWorkerRun').mockResolvedValue({
    metadata: { name: 'run-1' },
    spec: {},
  } as Run);
  createRunSpy = spyOn(kube, 'createRun').mockResolvedValue({} as Run);
  patchTaskSpy = spyOn(kube, 'patchTask').mockResolvedValue({} as Task);
  persistEventSpy = spyOn(audit, 'persistEvent').mockResolvedValue(undefined);
  emitEventSpy = spyOn(events, 'emitEvent').mockReturnValue(undefined);
});

afterEach(() => {
  buildWorkerRunSpy.mockRestore();
  createRunSpy.mockRestore();
  patchTaskSpy.mockRestore();
  persistEventSpy.mockRestore();
  emitEventSpy.mockRestore();
});

const expectedClearPatch = {
  metadata: {
    name: 'task-1',
    annotations: { [INTERACTIVE_RUN_ANNOTATION]: null },
  },
};

describe('processInteractiveRequests', () => {
  it('creates an interactive run and clears the annotation', async () => {
    const project = makeProject('proj');
    const task = withAnnotation(makeTask('task-1', 'proj', { phase: 'pending' }), {
      id: requestId,
      timeoutSeconds: 120,
    });

    await processInteractiveRequests(project, [task], namespace);

    expect(buildWorkerRunSpy).toHaveBeenCalledTimes(1);
    const call = buildWorkerRunSpy.mock.calls[0] as unknown[];
    expect(call[0]).toBe(project);
    expect(call[1]).toBe(task);
    expect(call[2]).toBe(interactiveRunName('proj', 'task-1', requestId));
    expect(call[3]).toBe(0);
    expect(call[4]).toBeUndefined();
    expect(call[5]).toEqual([task]);
    expect(call[6]).toMatchObject({ interactive: true, timeoutSeconds: 120 });

    expect(createRunSpy).toHaveBeenCalledTimes(1);
    expect(patchTaskSpy).toHaveBeenCalledWith('task-1', expectedClearPatch, namespace);
    expect(emitEventSpy).toHaveBeenCalledTimes(1);
  });

  it('adopts an existing run when createRun reports AlreadyExists (409)', async () => {
    createRunSpy.mockRejectedValueOnce(
      Object.assign(new Error('runs.percussionist.dev "run-1" already exists'), {
        statusCode: 409,
      }),
    );

    const project = makeProject('proj');
    const task = withAnnotation(makeTask('task-1', 'proj'), { id: requestId });

    await processInteractiveRequests(project, [task], namespace);

    expect(createRunSpy).toHaveBeenCalledTimes(1);
    // The annotation is still consumed, so the pass does not retry forever.
    expect(patchTaskSpy).toHaveBeenCalledWith('task-1', expectedClearPatch, namespace);
  });

  it('clears a malformed (non-JSON) payload without creating a run', async () => {
    const project = makeProject('proj');
    const task = withAnnotation(makeTask('task-1', 'proj'), 'not-json');

    await processInteractiveRequests(project, [task], namespace);

    expect(buildWorkerRunSpy).not.toHaveBeenCalled();
    expect(createRunSpy).not.toHaveBeenCalled();
    expect(patchTaskSpy).toHaveBeenCalledWith('task-1', expectedClearPatch, namespace);
  });

  it('clears a schema-invalid payload without creating a run', async () => {
    const project = makeProject('proj');
    // `id` must match /^[a-z0-9]{4,16}$/.
    const task = withAnnotation(makeTask('task-1', 'proj'), { id: 'NOT VALID!' });

    await processInteractiveRequests(project, [task], namespace);

    expect(createRunSpy).not.toHaveBeenCalled();
    expect(patchTaskSpy).toHaveBeenCalledWith('task-1', expectedClearPatch, namespace);
  });

  it.each([
    'done',
    'idea',
  ] as const)('clears the annotation on a %s task without creating a run', async (phase) => {
    const project = makeProject('proj');
    const task = withAnnotation(makeTask('task-1', 'proj', { phase }), { id: requestId });

    await processInteractiveRequests(project, [task], namespace);

    expect(buildWorkerRunSpy).not.toHaveBeenCalled();
    expect(createRunSpy).not.toHaveBeenCalled();
    expect(patchTaskSpy).toHaveBeenCalledWith('task-1', expectedClearPatch, namespace);
  });

  it('isolates a failing task and still processes the rest', async () => {
    buildWorkerRunSpy.mockRejectedValueOnce(new Error('boom'));

    const project = makeProject('proj');
    const bad = withAnnotation(makeTask('bad-task', 'proj'), { id: requestId });
    const good = withAnnotation(makeTask('good-task', 'proj'), { id: requestId });

    await processInteractiveRequests(project, [bad, good], namespace);

    expect(buildWorkerRunSpy).toHaveBeenCalledTimes(2);
    expect(createRunSpy).toHaveBeenCalledTimes(1);
    // Only the healthy task's annotation is consumed; the failed task keeps
    // its annotation so the next cycle retries with the same run name.
    expect(patchTaskSpy).toHaveBeenCalledTimes(1);
    expect(patchTaskSpy).toHaveBeenCalledWith(
      'good-task',
      {
        metadata: {
          name: 'good-task',
          annotations: { [INTERACTIVE_RUN_ANNOTATION]: null },
        },
      },
      namespace,
    );
  });

  it('ignores tasks without a request annotation', async () => {
    const project = makeProject('proj');
    const task = makeTask('task-1', 'proj');

    await processInteractiveRequests(project, [task], namespace);

    expect(buildWorkerRunSpy).not.toHaveBeenCalled();
    expect(createRunSpy).not.toHaveBeenCalled();
    expect(patchTaskSpy).not.toHaveBeenCalled();
  });
});
