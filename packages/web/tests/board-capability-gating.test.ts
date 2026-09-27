import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as kube from '../src/server/kube.js';
import { closeTestDb, createTestDb } from './helpers/pglite.js';

process.env.AUTH_DISABLED = '1';

const PROJECT = {
  apiVersion: 'percussionist.dev/v1alpha1',
  kind: 'Project',
  metadata: { name: 'proj', namespace: 'percussionist', uid: 'uid-1' },
  spec: {
    displayName: 'proj',
    agents: [{ name: 'builder' }, { name: 'reviewer' }],
    secrets: { llmKeysSecret: 'llm-keys' },
  },
} as any;

let app: Awaited<ReturnType<typeof import('../src/server/app.js')['createApp']>>;
let getProjectSpy: ReturnType<typeof spyOn>;
let validateSpy: ReturnType<typeof spyOn>;
let createTaskSpy: ReturnType<typeof spyOn>;

beforeAll(async () => {
  await createTestDb();

  getProjectSpy = spyOn(kube, 'getProject').mockResolvedValue(PROJECT);
  validateSpy = spyOn(kube, 'validateAgentTaskCapability').mockResolvedValue({
    ok: false,
    requiredCapability: 'task.build.execute',
    error: 'agent "reviewer" missing required capability "task.build.execute" for BUILD tasks',
  });
  createTaskSpy = spyOn(kube, 'createTask').mockResolvedValue({
    metadata: { name: 'never' },
  } as any);

  const server = await import('../src/server/app.js');
  app = server.createApp();
});

beforeEach(() => {
  getProjectSpy.mockResolvedValue(PROJECT);
  validateSpy.mockResolvedValue({
    ok: false,
    requiredCapability: 'task.build.execute',
    error: 'agent "reviewer" missing required capability "task.build.execute" for BUILD tasks',
  });
  createTaskSpy.mockClear();
});

afterAll(async () => {
  await closeTestDb();
  delete process.env.AUTH_DISABLED;
  getProjectSpy.mockRestore();
  validateSpy.mockRestore();
  createTaskSpy.mockRestore();
});

describe('board create task capability enforcement', () => {
  it('rejects incompatible BUILD assignment with clear error and parity semantics', async () => {
    const res = await app.request('/api/projects/proj/board/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'BUILD',
        title: 'bad assignment',
        agent: 'reviewer',
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain('missing required capability "task.build.execute"');
    expect(validateSpy).toHaveBeenCalledWith(PROJECT, 'BUILD', 'reviewer');
    expect(createTaskSpy).not.toHaveBeenCalled();
  });
});
