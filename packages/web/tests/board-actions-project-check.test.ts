// Tests for project-scoped board task actions.
//
// approve / request-changes / retry-review / answer used to call
// getTask(taskName) with the default namespace and never verified
// task.spec.projectRef. Tasks in non-default namespaces 404'd, and — worse —
// when a task with the same name existed in the default namespace, the
// annotation was patched on the wrong task while appendTaskEvent recorded the
// event under the URL project, corrupting the activity feed. (The abandon
// route shared the flaw until it was deleted as dead product surface.)
//
// These tests pin the getProjectTask() helper behaviour: tasks resolve via the
// project's namespace, projectRef mismatch returns 404 with no annotation patch
// and no task_events row, and the default-namespace happy path still works.

import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Project, Task } from '@percussionist/api';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { getDb, taskEvents } from '../src/server/db.js';
import * as kube from '../src/server/kube.js';

const PROJECT_NAME = 'test-proj';
const TEST_DATA_DIR = join('/tmp', `percussionist-board-actions-${process.pid}`);

process.env.DATA_DIR = TEST_DATA_DIR;
process.env.AUTH_DISABLED = '1';

function makeProject(namespace?: string): Project {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Project',
    metadata: { name: PROJECT_NAME, ...(namespace ? { namespace } : {}) },
    spec: { source: { local: true }, agents: [], maxParallel: 2 },
  } as unknown as Project;
}

function makeTask({
  name,
  namespace = 'percussionist',
  projectRef = PROJECT_NAME,
  labelProject = PROJECT_NAME,
  status,
}: {
  name: string;
  namespace?: string;
  projectRef?: string;
  labelProject?: string;
  status?: Task['status'];
}): Task {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Task',
    metadata: { name, namespace, labels: { 'percussionist.dev/project': labelProject } },
    spec: { projectRef, type: 'BUILD', title: 'Do a thing', agent: 'builder' },
    status,
  } as unknown as Task;
}

async function postAction(action: string, taskName: string, body?: unknown) {
  return app.request(`/api/projects/${PROJECT_NAME}/board/tasks/${taskName}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function eventRows(project: string, taskName: string): number {
  return getDb()
    .select()
    .from(taskEvents)
    .where(eq(taskEvents.project, project))
    .all()
    .filter((r) => r.taskName === taskName).length;
}

let app: Hono;
let getProjectSpy: ReturnType<typeof spyOn>;
let getTaskSpy: ReturnType<typeof spyOn>;
let patchTaskSpy: ReturnType<typeof spyOn>;
let patchTaskStatusSpy: ReturnType<typeof spyOn>;

beforeAll(async () => {
  mkdirSync(TEST_DATA_DIR, { recursive: true });
  getProjectSpy = spyOn(kube, 'getProject').mockResolvedValue(makeProject());
  getTaskSpy = spyOn(kube, 'getTask').mockResolvedValue(makeTask({ name: 'x' }) as never);
  patchTaskSpy = spyOn(kube, 'patchTask').mockResolvedValue(makeTask({ name: 'x' }) as never);
  patchTaskStatusSpy = spyOn(kube, 'patchTaskStatus').mockResolvedValue(
    makeTask({ name: 'x' }) as never,
  );
  const { createApp } = await import('../src/server/app.js');
  app = createApp();
});

afterAll(() => {
  getProjectSpy.mockRestore();
  getTaskSpy.mockRestore();
  patchTaskSpy.mockRestore();
  patchTaskStatusSpy.mockRestore();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.AUTH_DISABLED;
});

beforeEach(() => {
  getProjectSpy.mockResolvedValue(makeProject());
  getTaskSpy.mockClear();
  patchTaskSpy.mockClear();
  patchTaskStatusSpy.mockClear();
});

describe('board task actions resolve via the project namespace', () => {
  it('approve patches a task in a non-default namespace (project.metadata.namespace=other-ns)', async () => {
    getProjectSpy.mockResolvedValue(makeProject('other-ns'));
    getTaskSpy.mockResolvedValue(makeTask({ name: 'task-a', namespace: 'other-ns' }) as never);

    const res = await postAction('approve', 'task-a');

    expect(res.status).toBe(200);
    // getTask is called with the project-resolved namespace, not NAMESPACE.
    expect(getTaskSpy).toHaveBeenCalledWith('task-a', 'other-ns');
    // patchTask is called with the same resolved namespace.
    const patchArgs = patchTaskSpy.mock.calls[0];
    expect(patchArgs?.[0]).toBe('task-a');
    expect(patchArgs?.[2]).toBe('other-ns');
    // Annotation written, event recorded under the project.
    const annotations = (patchArgs?.[1] as { metadata: { annotations: Record<string, string> } })
      .metadata.annotations;
    expect(annotations['percussionist.dev/action-approved']).toBe('true');
    expect(eventRows(PROJECT_NAME, 'task-a')).toBe(1);
  });

  it('retry-review patches status of a task in a non-default namespace via patchTaskStatus', async () => {
    getProjectSpy.mockResolvedValue(makeProject('other-ns'));
    getTaskSpy.mockResolvedValue(
      makeTask({
        name: 'task-rr',
        namespace: 'other-ns',
        status: {
          phase: 'awaiting-human',
          worker: { status: 'Succeeded', reviewRunName: 'review-1', aiReworkCount: 0 },
        } as never,
      }) as never,
    );

    const res = await postAction('retry-review', 'task-rr');

    expect(res.status).toBe(200);
    const statusArgs = patchTaskStatusSpy.mock.calls[0];
    expect(statusArgs?.[0]).toBe('task-rr');
    expect(statusArgs?.[2]).toBe('other-ns');
    expect(eventRows(PROJECT_NAME, 'task-rr')).toBe(1);
  });

  it('approve still works for a default-namespace task', async () => {
    getTaskSpy.mockResolvedValue(makeTask({ name: 'task-c' }) as never);

    const res = await postAction('approve', 'task-c');

    expect(res.status).toBe(200);
    expect(getTaskSpy).toHaveBeenCalledWith('task-c', 'percussionist');
    const patchArgs = patchTaskSpy.mock.calls[0];
    expect(patchArgs?.[2]).toBe('percussionist');
    expect(eventRows(PROJECT_NAME, 'task-c')).toBe(1);
  });
});

describe('projectRef mismatch returns 404 with no write', () => {
  it('approve 404s and never patches or records an event', async () => {
    getTaskSpy.mockResolvedValue(
      makeTask({ name: 'task-b', projectRef: 'other-proj', labelProject: 'other-proj' }) as never,
    );

    const res = await postAction('approve', 'task-b');

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('Task not found in project');
    expect(patchTaskSpy).not.toHaveBeenCalled();
    expect(patchTaskStatusSpy).not.toHaveBeenCalled();
    expect(eventRows(PROJECT_NAME, 'task-b')).toBe(0);
  });

  it('retry-review 404s on projectRef mismatch with no status patch', async () => {
    getTaskSpy.mockResolvedValue(
      makeTask({
        name: 'task-b2',
        projectRef: 'other-proj',
        labelProject: 'other-proj',
        status: { phase: 'awaiting-human' } as never,
      }) as never,
    );

    const res = await postAction('retry-review', 'task-b2');

    expect(res.status).toBe(404);
    expect(patchTaskStatusSpy).not.toHaveBeenCalled();
    expect(eventRows(PROJECT_NAME, 'task-b2')).toBe(0);
  });

  it('answer 404s on projectRef mismatch even when the label matches the URL project', async () => {
    // projectRef is authoritative; a matching label cannot rescue a task whose
    // spec says it belongs to a different project.
    getTaskSpy.mockResolvedValue(
      makeTask({
        name: 'task-b3',
        projectRef: 'other-proj',
        labelProject: PROJECT_NAME,
        status: { phase: 'awaiting-human' } as never,
      }) as never,
    );

    const res = await postAction('answer', 'task-b3', { answer: 'do it' });

    expect(res.status).toBe(404);
    expect(patchTaskSpy).not.toHaveBeenCalled();
    expect(eventRows(PROJECT_NAME, 'task-b3')).toBe(0);
  });
});
