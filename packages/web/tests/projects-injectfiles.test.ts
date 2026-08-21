import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Project } from '@percussionist/api';
import type { Hono } from 'hono';
import * as kube from '../src/server/kube.js';
import { injectFileSecretName } from '../src/server/routes/projects.js';

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

// Use the real name function so the test stays aligned with the server's
// (hash-suffixed) naming.
function secretName(filename: string): string {
  return injectFileSecretName(PROJECT_NAME, filename);
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

describe('injectFileSecretName disambiguation', () => {
  it('produces distinct names for colliding slug filenames', () => {
    expect(injectFileSecretName(PROJECT_NAME, 'notes.md')).not.toBe(
      injectFileSecretName(PROJECT_NAME, 'notes_md'),
    );
  });

  it('is stable across calls for the same filename', () => {
    expect(injectFileSecretName(PROJECT_NAME, 'notes.md')).toBe(
      injectFileSecretName(PROJECT_NAME, 'notes.md'),
    );
    expect(injectFileSecretName(PROJECT_NAME, 'notes_md')).toBe(
      injectFileSecretName(PROJECT_NAME, 'notes_md'),
    );
  });

  it('uses the project name and a hash-suffixed slug', () => {
    const name = injectFileSecretName(PROJECT_NAME, 'notes.md');
    expect(name).toMatch(/^test-proj-inject-notes-md-[0-9a-f]{8}$/);
  });
});
