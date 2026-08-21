import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Project } from '@percussionist/api';
import type { Hono } from 'hono';
import * as kube from '../src/server/kube.js';

const PROJECT_NAME = 'test-proj';

process.env.AUTH_DISABLED = '1';

function makeProject(spec: Partial<Project['spec']>): Project {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Project',
    metadata: { name: PROJECT_NAME },
    spec: { source: { local: true }, agents: [], maxParallel: 2, ...spec },
  } as unknown as Project;
}

function secretName(filename: string): string {
  const slug = filename
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `${PROJECT_NAME}-inject-${slug}`;
}

let app: Hono;
let getProjectSpy: ReturnType<typeof spyOn>;
let updateProjectSpy: ReturnType<typeof spyOn>;
let coreSpy: ReturnType<typeof spyOn>;

let deletedSecrets: string[];
let createdSecrets: string[];
let existingProject: Project;

const mockCore = {
  readNamespacedSecret: async () => {
    throw new Error('not found');
  },
  createNamespacedSecret: async ({ body }: { body: { metadata: { name: string } } }) => {
    createdSecrets.push(body.metadata.name);
    return {};
  },
  replaceNamespacedSecret: async () => ({}),
  deleteNamespacedSecret: async ({ name }: { name: string }) => {
    deletedSecrets.push(name);
  },
};

beforeAll(async () => {
  deletedSecrets = [];
  createdSecrets = [];
  getProjectSpy = spyOn(kube, 'getProject').mockImplementation(async () => existingProject);
  updateProjectSpy = spyOn(kube, 'updateProject').mockImplementation(async (_name, spec) =>
    makeProject(spec as Partial<Project['spec']>),
  );
  coreSpy = spyOn(kube, 'core').mockReturnValue(
    mockCore as unknown as ReturnType<typeof kube.core>,
  );
  const { createApp } = await import('../src/server/app.js');
  app = createApp();
});

afterAll(() => {
  getProjectSpy.mockRestore();
  updateProjectSpy.mockRestore();
  coreSpy.mockRestore();
  delete process.env.AUTH_DISABLED;
});

beforeEach(() => {
  deletedSecrets = [];
  createdSecrets = [];
  updateProjectSpy.mockClear();
});

describe('PUT /api/projects/:name injectFiles handling', () => {
  it('leaves existing inject-file Secrets intact when injectFiles is omitted', async () => {
    const existingRef = {
      filename: 'notes.txt',
      secretRef: { name: secretName('notes.txt'), key: 'content' },
    };
    existingProject = makeProject({
      maxParallel: 2,
      injectFiles: [existingRef],
    });

    const res = await app.request(`/api/projects/${PROJECT_NAME}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxParallel: 5 }),
    });

    expect(res.status).toBe(200);

    // No orphan deletion should have run (the field was absent).
    expect(deletedSecrets).toEqual([]);
    expect(createdSecrets).toEqual([]);

    // updateProject must still carry the preserved injectFiles ref.
    const updatedSpec = updateProjectSpy.mock.lastCall?.[1] as { injectFiles?: unknown };
    expect(updatedSpec.injectFiles).toEqual([existingRef]);
  });

  it('deletes an orphan inject-file Secret when injectFiles IS present', async () => {
    const orphanRef = {
      filename: 'current.txt',
      secretRef: { name: secretName('current.txt'), key: 'content' },
    };
    existingProject = makeProject({
      maxParallel: 2,
      injectFiles: [orphanRef],
    });

    const res = await app.request(`/api/projects/${PROJECT_NAME}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        maxParallel: 3,
        injectFiles: [{ filename: 'new.txt', content: 'hello' }],
      }),
    });

    expect(res.status).toBe(200);

    // The orphan (current.txt) Secret is deleted, the new (new.txt) one is created.
    expect(deletedSecrets).toEqual([secretName('current.txt')]);
    expect(createdSecrets).toEqual([secretName('new.txt')]);

    const updatedSpec = updateProjectSpy.mock.lastCall?.[1] as { injectFiles?: Array<unknown> };
    expect(updatedSpec.injectFiles).toHaveLength(1);
    expect((updatedSpec.injectFiles as Array<{ filename: string }>)[0].filename).toBe('new.txt');
  });

  it('clears injectFiles (and deletes orphans) on an explicit empty array', async () => {
    const orphanRef = {
      filename: 'current.txt',
      secretRef: { name: secretName('current.txt'), key: 'content' },
    };
    existingProject = makeProject({
      maxParallel: 2,
      injectFiles: [orphanRef],
    });

    const res = await app.request(`/api/projects/${PROJECT_NAME}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxParallel: 3, injectFiles: [] }),
    });

    expect(res.status).toBe(200);

    expect(deletedSecrets).toEqual([secretName('current.txt')]);
    const updatedSpec = updateProjectSpy.mock.lastCall?.[1] as { injectFiles?: unknown };
    expect(updatedSpec.injectFiles).toBeUndefined();
  });
});
