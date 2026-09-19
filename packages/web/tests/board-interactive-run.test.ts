// board-interactive-run.test.ts — POST
// /api/projects/:project/board/tasks/:taskName/interactive-run
//
// The route is the web-side half of the interactive-run request flow: it writes
// the percussionist.dev/action-interactive annotation (the reconciler creates
// the Run) and returns the deterministic run name so callers can poll for it.
// Terminal tasks (`done`/`idea`) have no branch or in-flight work to
// investigate, so they are rejected without a write.

import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  INTERACTIVE_RUN_ANNOTATION,
  interactiveRunName,
  type Project,
  type Task,
} from '@percussionist/api';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { getDb, taskEvents } from '../src/server/db.js';
import * as kube from '../src/server/kube.js';

const PROJECT_NAME = 'test-proj';
const TASK_NAME = `${PROJECT_NAME}-build-abcd01`;
const TEST_DATA_DIR = join('/tmp', `percussionist-board-interactive-${process.pid}`);

process.env.DATA_DIR = TEST_DATA_DIR;
process.env.AUTH_DISABLED = '1';

const MOCK_PROJECT = {
  apiVersion: 'percussionist.dev/v1alpha1',
  kind: 'Project',
  metadata: { name: PROJECT_NAME, namespace: 'percussionist' },
  spec: { source: { local: true }, agents: [], maxParallel: 2 },
} as unknown as Project;

function makeTask(
  phase: string,
  annotations: Record<string, string> = {},
  status: Task['status'] = { phase } as Task['status'],
): Task {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Task',
    metadata: {
      name: TASK_NAME,
      namespace: 'percussionist',
      labels: { 'percussionist.dev/project': PROJECT_NAME },
      annotations,
    },
    spec: { projectRef: PROJECT_NAME, type: 'BUILD', title: 'Do a thing', agent: 'builder' },
    status,
  } as unknown as Task;
}

async function postInteractiveRun(body?: unknown) {
  return app.request(`/api/projects/${PROJECT_NAME}/board/tasks/${TASK_NAME}/interactive-run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function eventRows(taskName: string): number {
  return getDb()
    .select()
    .from(taskEvents)
    .where(eq(taskEvents.project, PROJECT_NAME))
    .all()
    .filter((r) => r.taskName === taskName).length;
}

let app: Hono;
let getProjectSpy: ReturnType<typeof spyOn>;
let getTaskSpy: ReturnType<typeof spyOn>;
let patchTaskSpy: ReturnType<typeof spyOn>;

beforeAll(async () => {
  mkdirSync(TEST_DATA_DIR, { recursive: true });
  getProjectSpy = spyOn(kube, 'getProject').mockResolvedValue(MOCK_PROJECT);
  getTaskSpy = spyOn(kube, 'getTask').mockResolvedValue(makeTask('running'));
  patchTaskSpy = spyOn(kube, 'patchTask').mockResolvedValue(makeTask('running') as never);
  const { createApp } = await import('../src/server/app.js');
  app = createApp();
});

afterAll(() => {
  getProjectSpy.mockRestore();
  getTaskSpy.mockRestore();
  patchTaskSpy.mockRestore();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.AUTH_DISABLED;
});

beforeEach(() => {
  getProjectSpy.mockResolvedValue(MOCK_PROJECT);
  getTaskSpy.mockResolvedValue(makeTask('running'));
  patchTaskSpy.mockClear();
  getDb().delete(taskEvents).run();
});

describe('POST /api/projects/:project/board/tasks/:taskName/interactive-run', () => {
  it('writes the annotation, records an event, and returns the deterministic run name', async () => {
    const res = await postInteractiveRun();

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; runName: string };
    expect(body.success).toBe(true);

    const patchArgs = patchTaskSpy.mock.calls[0];
    expect(patchArgs?.[0]).toBe(TASK_NAME);
    expect(patchArgs?.[2]).toBe('percussionist');
    const annotations = (patchArgs?.[1] as { metadata: { annotations: Record<string, string> } })
      .metadata.annotations;
    const stored = JSON.parse(annotations[INTERACTIVE_RUN_ANNOTATION] ?? '{}') as { id?: string };
    expect(stored.id).toMatch(/^[a-z0-9]{8}$/);
    expect(body.runName).toBe(interactiveRunName(PROJECT_NAME, TASK_NAME, stored.id ?? ''));

    expect(eventRows(TASK_NAME)).toBe(1);
  });

  it('preserves existing annotations and forwards agent/model/timeout overrides', async () => {
    getTaskSpy.mockResolvedValue(makeTask('running', { 'percussionist.dev/keep': 'me' }));

    const res = await postInteractiveRun({
      agent: 'planner',
      model: 'openai/gpt-5',
      timeoutSeconds: 1800,
    });

    expect(res.status).toBe(200);
    const annotations = (
      patchTaskSpy.mock.calls[0]?.[1] as {
        metadata: { annotations: Record<string, string> };
      }
    ).metadata.annotations;
    expect(annotations['percussionist.dev/keep']).toBe('me');
    const stored = JSON.parse(annotations[INTERACTIVE_RUN_ANNOTATION] ?? '{}') as {
      agent?: string;
      model?: string;
      timeoutSeconds?: number;
    };
    expect(stored.agent).toBe('planner');
    expect(stored.model).toBe('openai/gpt-5');
    expect(stored.timeoutSeconds).toBe(1800);
  });

  it('rejects a done task with 400 and no write', async () => {
    getTaskSpy.mockResolvedValue(makeTask('done'));

    const res = await postInteractiveRun();

    expect(res.status).toBe(400);
    expect(patchTaskSpy).not.toHaveBeenCalled();
    expect(eventRows(TASK_NAME)).toBe(0);
  });

  it('rejects an idea task with 400 and no write', async () => {
    getTaskSpy.mockResolvedValue(makeTask('idea'));

    const res = await postInteractiveRun();

    expect(res.status).toBe(400);
    expect(patchTaskSpy).not.toHaveBeenCalled();
    expect(eventRows(TASK_NAME)).toBe(0);
  });

  it('rejects an invalid timeout override with 400', async () => {
    const res = await postInteractiveRun({ timeoutSeconds: -5 });

    expect(res.status).toBe(400);
    expect(patchTaskSpy).not.toHaveBeenCalled();
  });

  it('404s on a projectRef mismatch with no write', async () => {
    getTaskSpy.mockResolvedValue({
      ...makeTask('running'),
      spec: {
        projectRef: 'other-proj',
        type: 'BUILD',
        title: 'Do a thing',
        agent: 'builder',
      },
    } as unknown as Task);

    const res = await postInteractiveRun();

    expect(res.status).toBe(404);
    expect(patchTaskSpy).not.toHaveBeenCalled();
    expect(eventRows(TASK_NAME)).toBe(0);
  });
});
