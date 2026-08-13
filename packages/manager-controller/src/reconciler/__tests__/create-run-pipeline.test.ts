// create-run-pipeline.test.ts
//
// Pipeline pin for the reworked `create_run` MCP tool (A3 / C7 from
// percussionist-dev-plan-4abf54): after the tool patches a task to
// `scheduled`, the reconciler's `decide()` emits the `scheduled →
// initializing` decision with a `ScheduleRun` effect, and `executeEffects()`
// creates the Run through `buildWorkerRun` + `createRun`. This pins the
// "all runs go through reconciliation" property end-to-end — `create_run`
// must never create Run CRs itself.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Run } from '@percussionist/api';
import * as kube from '@percussionist/kube';
import { __test } from '../../agent/tools.js';
import * as workerBuilder from '../../worker-builder.js';
import { decide } from '../decision.js';
import { executeEffects } from '../effects.js';
import { resolveFlow } from '../flow.js';
import { makeProject, makeRun, makeTask } from './fixtures.js';

const namespace = 'percussionist';
const now = '2026-05-29T00:00:00.000Z';

describe('create_run → reconciliation pipeline', () => {
  let getProjectSpy: ReturnType<typeof spyOn>;
  let getTaskSpy: ReturnType<typeof spyOn>;
  let patchTaskStatusSpy: ReturnType<typeof spyOn>;
  let createRunSpy: ReturnType<typeof spyOn>;
  let buildWorkerRunSpy: ReturnType<typeof spyOn>;
  let getRunSpy: ReturnType<typeof spyOn>;
  let listRunsSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    getProjectSpy = spyOn(kube, 'getProject').mockResolvedValue(makeProject('test-project'));
    getTaskSpy = spyOn(kube, 'getTask').mockResolvedValue(
      makeTask('task-1', 'test-project', { phase: 'pending', retryCount: 0 }),
    );
    patchTaskStatusSpy = spyOn(kube, 'patchTaskStatus').mockResolvedValue(undefined as never);
    createRunSpy = spyOn(kube, 'createRun').mockResolvedValue(undefined as never);
    buildWorkerRunSpy = spyOn(workerBuilder, 'buildWorkerRun').mockResolvedValue(
      makeRun('test-project-task-1-abc123') as Run,
    );
    getRunSpy = spyOn(kube, 'getRun').mockResolvedValue(undefined as never);
    listRunsSpy = spyOn(kube, 'listRuns').mockResolvedValue([] as never);
  });

  afterEach(() => {
    getProjectSpy.mockRestore();
    getTaskSpy.mockRestore();
    patchTaskStatusSpy.mockRestore();
    createRunSpy.mockRestore();
    buildWorkerRunSpy.mockRestore();
    getRunSpy.mockRestore();
    listRunsSpy.mockRestore();
  });

  it('tool patches to scheduled; decide emits scheduled → initializing + ScheduleRun; executeEffects creates the Run', async () => {
    // 1. The tool schedules the pending task — phase-only patch, no Run CR.
    const toolResponse = (await __test.handleMcp({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'create_run',
        arguments: { project: 'test-project', task: 'task-1' },
      },
    })) as {
      result?: { isError?: boolean; content?: Array<{ text: string }> };
    };

    expect(toolResponse.result?.isError).toBeUndefined();
    expect(patchTaskStatusSpy).toHaveBeenCalledWith('task-1', { phase: 'scheduled' }, namespace);
    expect(createRunSpy).not.toHaveBeenCalled();

    // 2. Reconcile observes the now-scheduled task: decide() emits the
    //    scheduled → initializing transition with a ScheduleRun effect.
    const project = makeProject('test-project');
    const flow = resolveFlow(project);
    const scheduled = makeTask('task-1', 'test-project', { phase: 'scheduled', retryCount: 0 });
    scheduled.metadata.resourceVersion = '1000';
    getTaskSpy.mockResolvedValue(scheduled);

    const decision = decide({
      task: scheduled,
      project,
      allTasks: [scheduled],
      observed: {},
      manualActions: {},
      flow,
      capacity: { activeCount: 0, maxParallel: 2 },
      now,
    });

    expect(decision.toPhase).toBe('initializing');
    expect(decision.effects).toHaveLength(1);
    expect(decision.effects[0]?.type).toBe('ScheduleRun');

    // 3. executeEffects() creates the Run through buildWorkerRun + createRun
    //    and applies the worker/phase status patch.
    const result = await executeEffects(
      scheduled,
      decision.toPhase,
      decision.effects,
      decision.statusPatch,
      namespace,
      project,
      flow,
      [scheduled],
    );

    expect(result.applied).toBe(true);
    expect(buildWorkerRunSpy).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ name: 'test-project' }) }),
      scheduled,
      expect.any(String),
      0,
      undefined,
      [scheduled],
    );
    expect(createRunSpy).toHaveBeenCalledTimes(1);
    expect(patchTaskStatusSpy).toHaveBeenLastCalledWith(
      'task-1',
      expect.objectContaining({
        phase: 'initializing',
        worker: expect.objectContaining({
          runName: expect.any(String),
          status: 'Running',
          retryCount: 0,
        }),
      }),
      namespace,
      3,
      '1000',
    );
  });
});
