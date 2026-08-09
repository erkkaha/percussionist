import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Project, Run, Task } from '@percussionist/api';
import type { Hono } from 'hono';
import * as kube from '../src/server/kube.js';

const PROJECT_NAME = 'test-proj';
const TASK_NAME = `${PROJECT_NAME}-build-abcd01`;
const RUN_NAME = `${TASK_NAME}-worker-01`;

process.env.AUTH_DISABLED = '1';

const MOCK_PROJECT = {
  apiVersion: 'percussionist.dev/v1alpha1',
  kind: 'Project',
  metadata: { name: PROJECT_NAME, namespace: 'percussionist' },
  spec: { source: { local: true }, agents: [], maxParallel: 2 },
} as unknown as Project;

function makeTask(phase: Task['status']['phase'], worker?: Task['status']['worker']): Task {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Task',
    metadata: { name: TASK_NAME, namespace: 'percussionist' },
    spec: { projectRef: PROJECT_NAME, type: 'BUILD', title: 'Do a thing', agent: 'builder' },
    status: { phase, worker },
  } as unknown as Task;
}

function makeRun(phase: Run['status']['phase'], message?: string): Run {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Run',
    metadata: { name: RUN_NAME, namespace: 'percussionist' },
    spec: { projectRef: PROJECT_NAME, interactive: false, task: TASK_NAME },
    status: { phase, ...(message ? { message } : {}) },
  } as unknown as Run;
}

let app: Hono;
let getProjectSpy: ReturnType<typeof spyOn>;
let listTasksSpy: ReturnType<typeof spyOn>;
let listRunsSpy: ReturnType<typeof spyOn>;

beforeAll(async () => {
  getProjectSpy = spyOn(kube, 'getProject').mockResolvedValue(MOCK_PROJECT);
  listTasksSpy = spyOn(kube, 'listTasks').mockResolvedValue([]);
  listRunsSpy = spyOn(kube, 'listRuns').mockResolvedValue([]);
  const { createApp } = await import('../src/server/app.js');
  app = createApp();
});

afterAll(() => {
  getProjectSpy.mockRestore();
  listTasksSpy.mockRestore();
  listRunsSpy.mockRestore();
  delete process.env.AUTH_DISABLED;
});

beforeEach(() => {
  getProjectSpy.mockResolvedValue(MOCK_PROJECT);
  listTasksSpy.mockResolvedValue([]);
  listRunsSpy.mockResolvedValue([]);
});

describe('GET /api/projects/:project/board worker run phase', () => {
  it('attaches workerRunPhase and workerRunMessage from the mocked run', async () => {
    listTasksSpy.mockResolvedValue([makeTask('failed', { runName: RUN_NAME, status: 'Failed' })]);
    listRunsSpy.mockResolvedValue([makeRun('WaitingForInput', 'waiting for user input')]);

    const res = await app.request(`/api/projects/${PROJECT_NAME}/board`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      columns: {
        review?: Array<{ workerRunPhase?: string; workerRunMessage?: string }>;
      };
    };

    const task = body.columns.review?.[0];
    expect(task).toBeDefined();
    expect(task?.workerRunPhase).toBe('WaitingForInput');
    expect(task?.workerRunMessage).toBe('waiting for user input');
  });

  it('queries runs for the project namespace with the project label selector', async () => {
    listTasksSpy.mockResolvedValue([makeTask('running', { runName: RUN_NAME, status: 'Running' })]);
    listRunsSpy.mockResolvedValue([makeRun('Running')]);

    await app.request(`/api/projects/${PROJECT_NAME}/board`);

    expect(listRunsSpy).toHaveBeenCalledWith(
      'percussionist',
      undefined,
      `percussionist.dev/project=${PROJECT_NAME}`,
    );
  });

  it('carries the run phase for a task in any column', async () => {
    listTasksSpy.mockResolvedValue([
      makeTask('succeeded', { runName: RUN_NAME, status: 'Succeeded' }),
    ]);
    listRunsSpy.mockResolvedValue([makeRun('Succeeded')]);

    const res = await app.request(`/api/projects/${PROJECT_NAME}/board`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      columns: {
        review?: Array<{ workerRunPhase?: string }>;
      };
    };

    expect(body.columns.review?.[0]?.workerRunPhase).toBe('Succeeded');
  });

  it('omits workerRunPhase when the task has no worker run', async () => {
    listTasksSpy.mockResolvedValue([makeTask('pending')]);

    const res = await app.request(`/api/projects/${PROJECT_NAME}/board`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      columns: {
        backlog?: Array<{ workerRunPhase?: string }>;
      };
    };

    expect(body.columns.backlog?.[0]?.workerRunPhase).toBeUndefined();
  });

  it('omits workerRunPhase when the worker run is not in the project run list', async () => {
    listTasksSpy.mockResolvedValue([makeTask('failed', { runName: RUN_NAME, status: 'Failed' })]);
    // No runs match — the run was deleted or belongs elsewhere.
    listRunsSpy.mockResolvedValue([]);

    const res = await app.request(`/api/projects/${PROJECT_NAME}/board`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      columns: {
        review?: Array<{ workerRunPhase?: string }>;
      };
    };

    expect(body.columns.review?.[0]?.workerRunPhase).toBeUndefined();
  });
});
