import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Project, Task } from '@percussionist/api';
import type { Hono } from 'hono';
import * as kube from '../src/server/kube.js';

const PROJECT_NAME = 'test-proj';

process.env.AUTH_DISABLED = '1';

const MOCK_PROJECT = {
  apiVersion: 'percussionist.dev/v1alpha1',
  kind: 'Project',
  metadata: { name: PROJECT_NAME },
  spec: { source: { local: true }, agents: [], maxParallel: 2 },
} as unknown as Project;

function makeTask(task: {
  name: string;
  title: string;
  type: 'PLAN' | 'BUILD';
  phase?: Task['status']['phase'];
  predecessorRef?: string;
  parentTaskRef?: string;
}): Task {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Task',
    metadata: { name: task.name, creationTimestamp: '2026-01-01T00:00:00Z' },
    spec: {
      projectRef: PROJECT_NAME,
      type: task.type,
      title: task.title,
      agent: 'builder',
      predecessorRef: task.predecessorRef,
      parentTaskRef: task.parentTaskRef,
    },
    status: { phase: task.phase ?? 'pending' },
  } as unknown as Task;
}

let app: Hono;
let getProjectSpy: ReturnType<typeof spyOn>;
let listTasksSpy: ReturnType<typeof spyOn>;

beforeAll(async () => {
  getProjectSpy = spyOn(kube, 'getProject').mockResolvedValue(MOCK_PROJECT);
  listTasksSpy = spyOn(kube, 'listTasks').mockResolvedValue([]);
  const { createApp } = await import('../src/server/app.js');
  app = createApp();
});

afterAll(() => {
  getProjectSpy.mockRestore();
  listTasksSpy.mockRestore();
  delete process.env.AUTH_DISABLED;
});

beforeEach(() => {
  getProjectSpy.mockResolvedValue(MOCK_PROJECT);
  listTasksSpy.mockResolvedValue([]);
});

describe('GET /api/projects/:project/board display refs', () => {
  it('uses predecessor title in blocked reason and keeps canonical predecessor ref', async () => {
    const predecessorName = `${PROJECT_NAME}-build-abcd01`;
    const blockedName = `${PROJECT_NAME}-build-abcd02`;

    listTasksSpy.mockResolvedValue([
      makeTask({
        name: predecessorName,
        type: 'BUILD',
        title: 'Prepare migration',
        phase: 'running',
      }),
      makeTask({
        name: blockedName,
        type: 'BUILD',
        title: 'Apply migration',
        predecessorRef: predecessorName,
      }),
    ]);

    const res = await app.request(`/api/projects/${PROJECT_NAME}/board`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      columns: {
        blocked?: Array<{
          status?: { blockedReason?: string };
          displayRefs?: {
            predecessorTask?: string | null;
            predecessorTaskCanonical?: string | null;
          };
        }>;
      };
    };

    const blockedTask = body.columns.blocked?.[0];
    expect(blockedTask).toBeDefined();
    expect(blockedTask?.status?.blockedReason).toBe('Waiting for: Prepare migration');
    expect(blockedTask?.displayRefs?.predecessorTask).toBe('Prepare migration');
    expect(blockedTask?.displayRefs?.predecessorTaskCanonical).toBe(predecessorName);
  });

  it('falls back to raw IDs for missing references', async () => {
    const missingPredecessor = `${PROJECT_NAME}-build-missing1`;
    const missingParent = `${PROJECT_NAME}-plan-missing2`;
    const taskName = `${PROJECT_NAME}-build-abcd03`;

    listTasksSpy.mockResolvedValue([
      makeTask({
        name: taskName,
        type: 'BUILD',
        title: 'Run checks',
        predecessorRef: missingPredecessor,
        parentTaskRef: missingParent,
      }),
    ]);

    const res = await app.request(`/api/projects/${PROJECT_NAME}/board`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      columns: {
        blocked?: Array<{
          status?: { blockedReason?: string };
          displayRefs?: {
            predecessorTask?: string | null;
            parentTask?: string | null;
            predecessorTaskCanonical?: string | null;
            parentTaskCanonical?: string | null;
          };
        }>;
      };
    };

    const blockedTask = body.columns.blocked?.[0];
    expect(blockedTask?.status?.blockedReason).toBe(`Waiting for: ${missingPredecessor}`);
    expect(blockedTask?.displayRefs?.predecessorTask).toBe(missingPredecessor);
    expect(blockedTask?.displayRefs?.parentTask).toBe(missingParent);
    expect(blockedTask?.displayRefs?.predecessorTaskCanonical).toBe(missingPredecessor);
    expect(blockedTask?.displayRefs?.parentTaskCanonical).toBe(missingParent);
  });

  it('adds aligned childProgress.childDisplayRefs ordered with childRefs', async () => {
    const planName = `${PROJECT_NAME}-plan-abcd04`;
    const childA = `${PROJECT_NAME}-build-abcd05`;
    const childB = `${PROJECT_NAME}-build-abcd06`;

    listTasksSpy.mockResolvedValue([
      makeTask({
        name: planName,
        type: 'PLAN',
        title: 'Plan release',
        phase: 'awaiting-children',
      }),
      makeTask({ name: childA, type: 'BUILD', title: 'Implement API', parentTaskRef: planName }),
      makeTask({
        name: childB,
        type: 'BUILD',
        title: 'Add tests',
        parentTaskRef: planName,
        phase: 'done',
      }),
    ]);

    const res = await app.request(`/api/projects/${PROJECT_NAME}/board`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      columns: {
        blocked?: Array<{
          childProgress?: {
            childRefs: string[];
            childDisplayRefs: string[];
            total: number;
            completed: number;
          };
        }>;
      };
    };

    const planTask = body.columns.blocked?.[0];
    expect(planTask?.childProgress?.total).toBe(2);
    expect(planTask?.childProgress?.completed).toBe(1);
    expect(planTask?.childProgress?.childRefs).toEqual([childA, childB]);
    expect(planTask?.childProgress?.childDisplayRefs).toEqual(['Implement API', 'Add tests']);
  });
});
