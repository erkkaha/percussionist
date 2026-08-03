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

let app: Hono;
let getProjectSpy: ReturnType<typeof spyOn>;
let listTasksSpy: ReturnType<typeof spyOn>;

beforeAll(async () => {
  getProjectSpy = spyOn(kube, 'getProject').mockResolvedValue(
    makeProject({ source: { local: true } }),
  );
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
  listTasksSpy.mockResolvedValue([]);
});

describe('GET /api/projects/:project/board settings', () => {
  it('derives repoWebUrl and integrationMode for a GitHub-backed project in pr mode', async () => {
    getProjectSpy.mockResolvedValue(
      makeProject({
        source: {
          git: {
            url: 'git@github.com:erkkaha/percussionist.git',
            sshSecret: { name: 'my-ssh-secret', key: 'ssh-privatekey' },
            githubTokenSecret: { name: 'my-gh-token', key: 'token' },
          },
        },
        featureBranchingEnabled: true,
        flow: { preset: 'plan-build-review-merge', integration: { mode: 'pr' } },
      }),
    );

    const res = await app.request(`/api/projects/${PROJECT_NAME}/board`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      settings: Record<string, unknown>;
    };

    expect(body.settings.repoWebUrl).toBe('https://github.com/erkkaha/percussionist');
    expect(body.settings.integrationMode).toBe('pr');

    const settingsJson = JSON.stringify(body.settings);
    expect(settingsJson).not.toContain('my-ssh-secret');
    expect(settingsJson).not.toContain('my-gh-token');
    expect(settingsJson).not.toContain('sshSecret');
    expect(settingsJson).not.toContain('githubTokenSecret');
    expect(settingsJson).not.toContain('git@github.com');
  });

  it('returns undefined repoWebUrl and disabled integrationMode for a local project', async () => {
    getProjectSpy.mockResolvedValue(makeProject({ source: { local: true } }));

    const res = await app.request(`/api/projects/${PROJECT_NAME}/board`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      settings: Record<string, unknown>;
    };

    expect(body.settings.repoWebUrl).toBeUndefined();
    expect(body.settings.integrationMode).toBe('disabled');
  });
});
