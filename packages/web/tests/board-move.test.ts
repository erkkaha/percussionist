import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Project, Task } from '@percussionist/api';
import type { Hono } from 'hono';
import * as kube from '../src/server/kube.js';

const PROJECT_NAME = 'test-proj';
const TASK_NAME = `${PROJECT_NAME}-build-abcd01`;
const TEST_DATA_DIR = join('/tmp', `percussionist-board-move-${process.pid}`);

process.env.DATA_DIR = TEST_DATA_DIR;
process.env.AUTH_DISABLED = '1';

const MOCK_PROJECT = {
  apiVersion: 'percussionist.dev/v1alpha1',
  kind: 'Project',
  metadata: { name: PROJECT_NAME, namespace: 'percussionist' },
  spec: { source: { local: true }, agents: [], maxParallel: 2 },
} as unknown as Project;

function makeTask(status: Task['status']): Task {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Task',
    metadata: { name: TASK_NAME, namespace: 'percussionist' },
    spec: { projectRef: PROJECT_NAME, type: 'BUILD', title: 'Do a thing', agent: 'builder' },
    status,
  } as unknown as Task;
}

async function move(column: string) {
  return app.request(`/api/projects/${PROJECT_NAME}/board/tasks/${TASK_NAME}/move`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ column }),
  });
}

let app: Hono;
let getProjectSpy: ReturnType<typeof spyOn>;
let getTaskSpy: ReturnType<typeof spyOn>;
let patchTaskStatusSpy: ReturnType<typeof spyOn>;

beforeAll(async () => {
  mkdirSync(TEST_DATA_DIR, { recursive: true });
  getProjectSpy = spyOn(kube, 'getProject').mockResolvedValue(MOCK_PROJECT);
  getTaskSpy = spyOn(kube, 'getTask').mockResolvedValue(makeTask({ phase: 'idea' } as never));
  patchTaskStatusSpy = spyOn(kube, 'patchTaskStatus').mockResolvedValue(undefined as never);
  const { createApp } = await import('../src/server/app.js');
  app = createApp();
});

afterAll(() => {
  getProjectSpy.mockRestore();
  getTaskSpy.mockRestore();
  patchTaskStatusSpy.mockRestore();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.AUTH_DISABLED;
});

beforeEach(() => {
  getProjectSpy.mockResolvedValue(MOCK_PROJECT);
  patchTaskStatusSpy.mockClear();
});

describe('POST /api/projects/:project/board/tasks/:taskName/move', () => {
  it('promotes an idea to the backlog without a worker status', async () => {
    getTaskSpy.mockResolvedValue(makeTask({ phase: 'idea' } as never));

    const res = await move('backlog');

    expect(res.status).toBe(200);
    const patch = patchTaskStatusSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(patch.phase).toBe('pending');
    expect(patch.blocked).toBe(false);
    expect(patch.worker).toBeUndefined();
  });

  it('increments retryCount when the task already ran', async () => {
    getTaskSpy.mockResolvedValue(
      makeTask({
        phase: 'failed',
        worker: { runName: 'run-1', status: 'Failed', retryCount: 2 },
      } as never),
    );

    const res = await move('backlog');

    expect(res.status).toBe(200);
    const patch = patchTaskStatusSpy.mock.calls[0]?.[1] as {
      worker?: { retryCount?: number; runName?: string };
    };
    expect(patch.worker?.retryCount).toBe(3);
    expect(patch.worker?.runName).toBe('run-1');
  });

  it('rejects an unsupported column', async () => {
    const res = await move('done');
    expect(res.status).toBe(400);
  });
});
