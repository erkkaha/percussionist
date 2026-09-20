// Tests for GET /api/attention — the global HITL inbox route.
//
// Follows the board-move.test.ts pattern: build the real Hono app and spy on
// the kube module so no cluster is contacted. AUTH_DISABLED=1 for the happy
// path; the auth-required case flips it off and sends a credential-less request.

import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Run, Task } from '@percussionist/api';
import type { Hono } from 'hono';
import * as kube from '../src/server/kube.js';

const TEST_DATA_DIR = join('/tmp', `percussionist-attention-routes-${process.pid}`);

process.env.DATA_DIR = TEST_DATA_DIR;
process.env.AUTH_DISABLED = '1';

interface TaskOverrides {
  name: string;
  project?: string;
  type?: 'PLAN' | 'BUILD';
  title?: string;
  phase?: string;
  worker?: Record<string, unknown>;
  lastFailureReason?: string;
  statusRunMessage?: string;
  creationTimestamp?: string;
}

function makeTask(overrides: TaskOverrides): Task {
  const {
    name,
    project = 'test-proj',
    type = 'BUILD',
    title = 'Do a thing',
    phase = 'awaiting-human',
    worker,
    lastFailureReason,
    statusRunMessage,
    creationTimestamp,
  } = overrides;

  return {
    metadata: { name, ...(creationTimestamp ? { creationTimestamp } : {}) },
    spec: { projectRef: project, type, title },
    status: {
      phase,
      ...(worker ? { worker } : {}),
      ...(lastFailureReason ? { lastFailureReason } : {}),
      ...(statusRunMessage ? { workerRunMessage: statusRunMessage } : {}),
    },
  } as unknown as Task;
}

function makeRun(name: string, phase: string): Run {
  return {
    metadata: { name },
    status: { phase },
  } as unknown as Run;
}

let app: Hono;
let listTasksSpy: ReturnType<typeof spyOn>;
let listRunsSpy: ReturnType<typeof spyOn>;

beforeAll(async () => {
  mkdirSync(TEST_DATA_DIR, { recursive: true });
  listTasksSpy = spyOn(kube, 'listTasks').mockResolvedValue([]);
  listRunsSpy = spyOn(kube, 'listRuns').mockResolvedValue([]);
  const { createApp } = await import('../src/server/app.js');
  app = createApp();
});

afterAll(() => {
  listTasksSpy.mockRestore();
  listRunsSpy.mockRestore();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.AUTH_DISABLED;
});

afterEach(() => {
  process.env.AUTH_DISABLED = '1';
  listTasksSpy.mockReset();
  listTasksSpy.mockResolvedValue([]);
  listRunsSpy.mockReset();
  listRunsSpy.mockResolvedValue([]);
});

function get() {
  return app.request('/api/attention');
}

describe('GET /api/attention', () => {
  it('returns every human-gated task with the push deep link and a matching count', async () => {
    listTasksSpy.mockResolvedValue([
      makeTask({
        name: 'proj-plan-abcd01',
        project: 'my project',
        type: 'PLAN',
        title: 'Plan the thing',
        phase: 'awaiting-human',
      }),
      makeTask({
        name: 'proj-build-abcd02',
        project: 'my project',
        title: 'Answer me',
        phase: 'waiting-for-input',
        statusRunMessage: 'Which database?',
      }),
      makeTask({
        name: 'proj-build-abcd03',
        project: 'my project',
        title: 'Broke',
        phase: 'failed',
        lastFailureReason: 'tests failed',
      }),
      // Not human-gated — must be excluded.
      makeTask({ name: 'proj-build-abcd04', project: 'my project', phase: 'running' }),
      makeTask({ name: 'proj-build-abcd05', project: 'my project', phase: 'done' }),
    ]);

    const res = await get();

    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; count: number; generatedAt: string };
    expect(body.count).toBe(3);
    expect(body.items).toHaveLength(3);
    expect(typeof body.generatedAt).toBe('string');

    const byName = new Map(
      (body.items as { taskName: string; [key: string]: unknown }[]).map((item) => [
        item.taskName,
        item,
      ]),
    );

    // Deep link is identical to the push payload's url.
    const pushUrl = (name: string) =>
      `/projects/${encodeURIComponent('my project')}/board?task=${encodeURIComponent(name)}`;
    expect(byName.get('proj-plan-abcd01')).toMatchObject({
      project: 'my project',
      taskName: 'proj-plan-abcd01',
      title: 'Plan the thing',
      phase: 'awaiting-human',
      reason: 'Review plan and approve',
      url: pushUrl('proj-plan-abcd01'),
    });
    expect(byName.get('proj-build-abcd02')).toMatchObject({
      phase: 'waiting-for-input',
      reason: 'Answer agent question',
      detail: 'Which database?',
      url: pushUrl('proj-build-abcd02'),
    });
    expect(byName.get('proj-build-abcd03')).toMatchObject({
      phase: 'failed',
      reason: 'Failed — retry or abandon',
      detail: 'tests failed',
      url: pushUrl('proj-build-abcd03'),
    });
  });

  it('includes open-PR awaiting-feature-merge tasks that push deliberately omits', async () => {
    listTasksSpy.mockResolvedValue([
      makeTask({
        name: 'proj-build-pr01',
        phase: 'awaiting-feature-merge',
        worker: { status: 'Succeeded', prNumber: 7, mergeError: 'checks failing' },
      }),
      // Merged or PR-less tasks are not waiting on a human.
      makeTask({
        name: 'proj-build-merged',
        phase: 'awaiting-feature-merge',
        worker: { status: 'Succeeded', prNumber: 8, mergedAt: '2024-05-01T00:00:00Z' },
      }),
      makeTask({ name: 'proj-build-nopr', phase: 'awaiting-feature-merge' }),
    ]);

    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { taskName: string; phase: string; reason: string; detail?: string }[];
      count: number;
    };
    expect(body.items.map((item) => item.taskName)).toEqual(['proj-build-pr01']);
    expect(body.items[0]).toMatchObject({
      phase: 'awaiting-feature-merge',
      reason: 'Merge PR #7 on GitHub',
      detail: 'checks failing',
    });
    expect(body.count).toBe(body.items.length);
  });

  it('promotes a running task whose worker run is WaitingForInput', async () => {
    listTasksSpy.mockResolvedValue([
      makeTask({
        name: 'lagging',
        phase: 'running',
        worker: { status: 'Running', runName: 'run-lagging' },
      }),
      makeTask({
        name: 'active',
        phase: 'running',
        worker: { status: 'Running', runName: 'run-active' },
      }),
    ]);
    listRunsSpy.mockResolvedValue([
      makeRun('run-lagging', 'WaitingForInput'),
      makeRun('run-active', 'Running'),
    ]);

    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { taskName: string; phase: string }[] };
    expect(body.items.map((item) => item.taskName)).toEqual(['lagging']);
    expect(body.items[0]?.phase).toBe('waiting-for-input');
  });

  it('sorts oldest-waiting first', async () => {
    listTasksSpy.mockResolvedValue([
      makeTask({ name: 'new', creationTimestamp: '2024-03-01T00:00:00Z' }),
      makeTask({ name: 'old', creationTimestamp: '2024-01-01T00:00:00Z' }),
      makeTask({ name: 'mid', creationTimestamp: '2024-02-01T00:00:00Z' }),
    ]);

    const res = await get();
    const body = (await res.json()) as { items: { taskName: string }[] };
    expect(body.items.map((item) => item.taskName)).toEqual(['old', 'mid', 'new']);
  });

  it('requires an authenticated session', async () => {
    delete process.env.AUTH_DISABLED;
    const res = await get();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns { error } with a 5xx when the kube list fails', async () => {
    listTasksSpy.mockRejectedValue(
      Object.assign(new Error('etcd unavailable'), { body: { message: 'etcd unavailable' } }),
    );
    const res = await get();
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.status).toBeLessThan(600);
    expect(await res.json()).toEqual({ error: 'etcd unavailable' });
  });
});
