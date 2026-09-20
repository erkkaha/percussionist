// Unit tests for the reconciler's interactive-run request pass.
//
// Covers the annotation-driven flow end to end at the module boundary:
// parse → build → create (adopt 409) → clear annotation, plus terminal-phase
// clearing, invalid payloads, and per-task failure isolation.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Run, Task } from '@percussionist/api';
import { INTERACTIVE_RUN_ANNOTATION, interactiveRunName } from '@percussionist/api';
import * as kube from '@percussionist/kube';
import * as events from '../../events.js';
import * as workerBuilder from '../../worker-builder.js';
import * as audit from '../audit.js';
import { processInteractiveRequests } from '../interactive-requests.js';
import { makeProject, makeRun, makeTask } from './fixtures.js';

const namespace = 'percussionist';

let buildWorkerRunSpy: ReturnType<typeof spyOn>;
let createRunSpy: ReturnType<typeof spyOn>;
let patchTaskSpy: ReturnType<typeof spyOn>;
let persistEventSpy: ReturnType<typeof spyOn>;
let emitEventSpy: ReturnType<typeof spyOn>;

function withAnnotation(task: Task, payload: unknown): Task {
  task.metadata.annotations = {
    ...(task.metadata.annotations ?? {}),
    [INTERACTIVE_RUN_ANNOTATION]: typeof payload === 'string' ? payload : JSON.stringify(payload),
  };
  return task;
}

function clearPatchValue(): string | null | undefined {
  for (const call of patchTaskSpy.mock.calls) {
    const metadata = (call[1] as { metadata?: { annotations?: Record<string, unknown> } }).metadata;
    const value = metadata?.annotations?.[INTERACTIVE_RUN_ANNOTATION];
    if (value !== undefined) return value as string | null;
  }
  return undefined;
}

beforeEach(() => {
  buildWorkerRunSpy = spyOn(workerBuilder, 'buildWorkerRun').mockImplementation(
    async (_project: unknown, _task: unknown, runName: string) => makeRun(runName) as Run,
  );
  createRunSpy = spyOn(kube, 'createRun').mockResolvedValue({} as Run);
  patchTaskSpy = spyOn(kube, 'patchTask').mockResolvedValue({} as Task);
  persistEventSpy = spyOn(audit, 'persistEvent').mockResolvedValue(undefined as never);
  emitEventSpy = spyOn(events, 'emitEvent').mockImplementation(() => {});
});

afterEach(() => {
  buildWorkerRunSpy.mockRestore();
  createRunSpy.mockRestore();
  patchTaskSpy.mockRestore();
  persistEventSpy.mockRestore();
  emitEventSpy.mockRestore();
});

describe('processInteractiveRequests', () => {
  it('creates a run for a valid request and clears the annotation', async () => {
    const project = makeProject('test-project');
    const task = withAnnotation(
      makeTask('task-1', 'test-project', { phase: 'running', gitBranch: 'feature/task-1' }),
      { id: 'abcd1234', agent: 'reviewer', model: 'gpt-x', timeoutSeconds: 120 },
    );

    await processInteractiveRequests(project, [task], namespace);

    const expectedName = interactiveRunName('test-project', 'task-1', 'abcd1234');
    expect(buildWorkerRunSpy).toHaveBeenCalledTimes(1);
    const args = buildWorkerRunSpy.mock.calls[0] as unknown[];
    expect(args[2]).toBe(expectedName);
    expect(args[3]).toBe(0);
    expect(args[4]).toBeUndefined();
    expect(args[5]).toEqual([task]);
    expect(args[6]).toEqual({
      interactive: true,
      agent: 'reviewer',
      model: 'gpt-x',
      timeoutSeconds: 120,
    });

    expect(createRunSpy).toHaveBeenCalledTimes(1);
    expect((createRunSpy.mock.calls[0] as unknown[])[1]).toBe(namespace);

    // Annotation cleared with an explicit null (undefined would be dropped).
    expect(clearPatchValue()).toBeNull();
    expect(persistEventSpy).toHaveBeenCalledTimes(1);
    expect(emitEventSpy).toHaveBeenCalledTimes(1);
  });

  it('adopts an existing run on AlreadyExists (409) and clears the annotation', async () => {
    const project = makeProject('test-project');
    const task = withAnnotation(makeTask('task-1', 'test-project', { phase: 'failed' }), {
      id: 'abcd1234',
    });
    createRunSpy.mockRejectedValue(Object.assign(new Error('already exists'), { statusCode: 409 }));

    await processInteractiveRequests(project, [task], namespace);

    expect(createRunSpy).toHaveBeenCalledTimes(1);
    expect(clearPatchValue()).toBeNull();
  });

  it('does not fail the pass when the audit event throws', async () => {
    const project = makeProject('test-project');
    const task = withAnnotation(makeTask('task-1', 'test-project', { phase: 'running' }), {
      id: 'abcd1234',
    });
    persistEventSpy.mockRejectedValue(new Error('audit down'));

    await processInteractiveRequests(project, [task], namespace);

    // The run was created and the annotation cleared; audit failure is logged
    // but never surfaces as a request failure.
    expect(createRunSpy).toHaveBeenCalledTimes(1);
    expect(clearPatchValue()).toBeNull();
  });

  it('clears the annotation and skips invalid JSON payloads', async () => {
    const project = makeProject('test-project');
    const task = withAnnotation(
      makeTask('task-1', 'test-project', { phase: 'running' }),
      'not-json{',
    );

    await processInteractiveRequests(project, [task], namespace);

    expect(buildWorkerRunSpy).not.toHaveBeenCalled();
    expect(createRunSpy).not.toHaveBeenCalled();
    expect(clearPatchValue()).toBeNull();
  });

  it('clears the annotation and skips schema-invalid payloads', async () => {
    const project = makeProject('test-project');
    const task = withAnnotation(makeTask('task-1', 'test-project', { phase: 'running' }), {
      id: 'BAD!',
      timeoutSeconds: -5,
    });

    await processInteractiveRequests(project, [task], namespace);

    expect(buildWorkerRunSpy).not.toHaveBeenCalled();
    expect(createRunSpy).not.toHaveBeenCalled();
    expect(clearPatchValue()).toBeNull();
  });

  for (const phase of ['done', 'idea'] as const) {
    it(`clears the annotation and skips ${phase} tasks`, async () => {
      const project = makeProject('test-project');
      const task = withAnnotation(makeTask('task-1', 'test-project', { phase }), {
        id: 'abcd1234',
      });

      await processInteractiveRequests(project, [task], namespace);

      expect(buildWorkerRunSpy).not.toHaveBeenCalled();
      expect(createRunSpy).not.toHaveBeenCalled();
      expect(clearPatchValue()).toBeNull();
    });
  }

  it('isolates a failing task, leaves its annotation, and still processes later tasks', async () => {
    const project = makeProject('test-project');
    const bad = withAnnotation(makeTask('task-bad', 'test-project', { phase: 'running' }), {
      id: 'bad11111',
    });
    const good = withAnnotation(makeTask('task-good', 'test-project', { phase: 'running' }), {
      id: 'good2222',
    });
    createRunSpy.mockImplementation(async (run: Run) => {
      if (run.metadata.name?.includes('task-bad')) {
        throw new Error('boom');
      }
      return {} as Run;
    });

    await processInteractiveRequests(project, [bad, good], namespace);

    // Both tasks were attempted; the bad task's failure did not abort the pass.
    expect(buildWorkerRunSpy).toHaveBeenCalledTimes(2);
    expect(createRunSpy).toHaveBeenCalledTimes(2);
    // Only the good task's annotation was cleared.
    const patchedNames = patchTaskSpy.mock.calls.map((c) => (c as unknown[])[0]);
    expect(patchedNames).toContain('task-good');
    expect(patchedNames).not.toContain('task-bad');
  });

  it('ignores tasks without the annotation', async () => {
    const project = makeProject('test-project');
    const task = makeTask('task-1', 'test-project', { phase: 'running' });

    await processInteractiveRequests(project, [task], namespace);

    expect(buildWorkerRunSpy).not.toHaveBeenCalled();
    expect(createRunSpy).not.toHaveBeenCalled();
    expect(patchTaskSpy).not.toHaveBeenCalled();
  });
});
