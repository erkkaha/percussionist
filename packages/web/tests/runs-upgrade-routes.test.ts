// runs-upgrade-routes.test.ts — C11: first route-level tests for routes that
// previously had no test file at all. Covers:
//
//   - routes/runs.ts — GET / list (sorting/pagination/task filter/stripping),
//     GET /:name, POST / create (schema validation + kube error mapping),
//     DELETE /:name, and POST /:name/reply (the human-answer path: session
//     gating, message validation, forwarding, failure mapping).
//   - routes/upgrade.ts — GET /status and POST /apply proxying to the
//     manager's MCP tools, including the ManagerMcpHttpError → 502 split.
//
// The kube and manager-MCP helpers are spied before the routers are imported;
// no cluster is touched. AUTH_DISABLED=1 skips the auth middleware.

import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Run } from '@percussionist/api';
import { Hono } from 'hono';
import * as kube from '../src/server/kube.js';
import * as managerMcp from '../src/server/lib/manager-mcp.js';

const prevAuthDisabled = process.env.AUTH_DISABLED;
process.env.AUTH_DISABLED = '1';

function makeRun(name: string, overrides?: Partial<Run>): Run {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Run',
    metadata: {
      name,
      namespace: 'percussionist',
      uid: `uid-${name}`,
      creationTimestamp: `2026-01-0${name.length % 9}T00:00:00Z`,
      resourceVersion: '1',
      generation: 1,
    },
    spec: {
      project: 'proj',
      boardTask: 'task-a',
      agent: 'builder',
      model: 'openai/gpt-4o',
      interactive: false,
    },
    status: {
      phase: 'Running',
      message: 'working',
      sessionID: `sess-${name}`,
      tokensIn: 10,
      tokensOut: 5,
      startedAt: '2026-01-01T00:00:00Z',
      completedAt: null,
      lastEventAt: '2026-01-01T00:00:01Z',
      podName: `pod-${name}`,
      serviceName: `svc-${name}`,
    },
    ...overrides,
  } as Run;
}

let runsApp: Hono;
let upgradeApp: Hono;

let listRunsSpy: ReturnType<typeof spyOn>;
let getRunSpy: ReturnType<typeof spyOn>;
let createRunSpy: ReturnType<typeof spyOn>;
let deleteRunSpy: ReturnType<typeof spyOn>;
let postSessionMessageSpy: ReturnType<typeof spyOn>;
let callManagerToolSpy: ReturnType<typeof spyOn>;

beforeAll(async () => {
  listRunsSpy = spyOn(kube, 'listRuns');
  getRunSpy = spyOn(kube, 'getRun');
  createRunSpy = spyOn(kube, 'createRun');
  deleteRunSpy = spyOn(kube, 'deleteRun');
  postSessionMessageSpy = spyOn(kube, 'postSessionMessage');
  callManagerToolSpy = spyOn(managerMcp, 'callManagerTool');

  const [{ default: runsRouter }, { default: upgradeRouter }] = await Promise.all([
    import('../src/server/routes/runs.js'),
    import('../src/server/routes/upgrade.js'),
  ]);

  runsApp = new Hono();
  runsApp.route('/api/runs', runsRouter);
  upgradeApp = new Hono();
  upgradeApp.route('/api/upgrade', upgradeRouter);
});

afterAll(() => {
  listRunsSpy.mockRestore();
  getRunSpy.mockRestore();
  createRunSpy.mockRestore();
  deleteRunSpy.mockRestore();
  postSessionMessageSpy.mockRestore();
  callManagerToolSpy.mockRestore();
  if (prevAuthDisabled !== undefined) process.env.AUTH_DISABLED = prevAuthDisabled;
  else delete process.env.AUTH_DISABLED;
});

beforeEach(() => {
  listRunsSpy.mockReset();
  getRunSpy.mockReset();
  createRunSpy.mockReset();
  deleteRunSpy.mockReset();
  postSessionMessageSpy.mockReset();
  callManagerToolSpy.mockReset();
});

// ===========================================================================
// routes/runs.ts
// ===========================================================================

describe('GET /api/runs', () => {
  it('sorts newest-first, filters by task, paginates and strips heavy fields', async () => {
    const old = makeRun('run-old', {
      metadata: {
        name: 'run-old',
        creationTimestamp: '2025-01-01T00:00:00Z',
        resourceVersion: '1',
        generation: 1,
        namespace: 'percussionist',
        uid: 'uid-run-old',
      },
      spec: { project: 'proj', boardTask: 'task-a', agent: 'builder', interactive: false },
    });
    const mid = makeRun('run-mid', {
      metadata: {
        name: 'run-mid',
        creationTimestamp: '2025-01-02T00:00:00Z',
        resourceVersion: '1',
        generation: 1,
        namespace: 'percussionist',
        uid: 'uid-run-mid',
      },
      spec: { project: 'proj', boardTask: 'task-b', agent: 'planner', interactive: false },
    });
    const newest = makeRun('run-newest', {
      metadata: {
        name: 'run-newest',
        creationTimestamp: '2025-01-03T00:00:00Z',
        resourceVersion: '1',
        generation: 1,
        namespace: 'percussionist',
        uid: 'uid-run-newest',
      },
      spec: { project: 'proj', boardTask: 'task-a', agent: 'builder', interactive: false },
    });
    listRunsSpy.mockResolvedValue([old, mid, newest]);

    const res = await runsApp.request('/api/runs?task=task-a&limit=1&offset=1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        metadata: { name: string };
        spec: { agent?: string };
        status?: { phase: string };
      }>;
      total: number;
    };

    // total counts the whole (filtered) list, page is offset+limit applied.
    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.metadata.name).toBe('run-old');
    expect(body.items[0]?.spec.agent).toBe('builder');
    expect(body.items[0]?.status?.phase).toBe('Running');

    // Heavy fields are stripped from the response — the status projection
    // keeps podName/sessionID but drops serviceName, and metadata loses
    // resourceVersion/generation.
    const json = JSON.stringify(body.items[0]);
    expect(json).not.toContain('serviceName');
    expect(json).not.toContain('resourceVersion');
    expect(json).not.toContain('generation');
    expect(json).toContain('"podName"');
  });

  it('applies limit/offset clamps and returns everything without limit', async () => {
    listRunsSpy.mockResolvedValue([
      makeRun('r1', {
        metadata: {
          name: 'r1',
          creationTimestamp: '2025-01-01T00:00:00Z',
          resourceVersion: '1',
          generation: 1,
          namespace: 'x',
          uid: 'u1',
        },
      }),
      makeRun('r2', {
        metadata: {
          name: 'r2',
          creationTimestamp: '2025-01-02T00:00:00Z',
          resourceVersion: '1',
          generation: 1,
          namespace: 'x',
          uid: 'u2',
        },
      }),
    ]);

    const all = (await (await runsApp.request('/api/runs')).json()) as {
      items: unknown[];
      total: number;
    };
    expect(all.total).toBe(2);
    expect(all.items).toHaveLength(2);

    const clamped = (await (await runsApp.request('/api/runs?limit=999&offset=-5')).json()) as {
      items: unknown[];
    };
    expect(clamped.items).toHaveLength(2);
  });
});

describe('GET /api/runs/:name', () => {
  it('returns the full run object (not stripped)', async () => {
    getRunSpy.mockResolvedValue(makeRun('run-detail'));
    const res = await runsApp.request('/api/runs/run-detail');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { metadata: { name: string }; status: { podName: string } };
    expect(body.metadata.name).toBe('run-detail');
    expect(body.status.podName).toBe('pod-run-detail');
  });

  it('maps a kube 404 to 404 and other failures to 500', async () => {
    getRunSpy.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    const missing = await runsApp.request('/api/runs/nope');
    expect(missing.status).toBe(404);

    getRunSpy.mockRejectedValue(new Error('api down'));
    const broken = await runsApp.request('/api/runs/nope');
    expect(broken.status).toBe(500);
  });
});

describe('POST /api/runs', () => {
  it('validates the spec and creates the run with a generated name', async () => {
    createRunSpy.mockResolvedValue(makeRun('run-created'));
    const res = await runsApp.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'proj', task: 't1', agent: 'builder' }),
    });
    expect(res.status).toBe(201);
    expect(createRunSpy).toHaveBeenCalledTimes(1);
    const created = createRunSpy.mock.calls[0]?.[0] as { metadata: { name: string } };
    expect(created.metadata.name).toMatch(/^run-[0-9a-f]{10}$/);
  });

  it('rejects an invalid spec with 400 and never calls createRun', async () => {
    const res = await runsApp.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'no project ref' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error.length).toBeGreaterThan(0);
    expect(createRunSpy).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON with 400', async () => {
    const res = await runsApp.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });
    expect(res.status).toBe(400);
  });

  it('maps kube create failures to their status code (409 AlreadyExists)', async () => {
    createRunSpy.mockRejectedValue(Object.assign(new Error('exists'), { statusCode: 409 }));
    const res = await runsApp.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'proj', task: 't1' }),
    });
    expect(res.status).toBe(409);
  });
});

describe('DELETE /api/runs/:name', () => {
  it('deletes and answers 204', async () => {
    deleteRunSpy.mockResolvedValue(undefined as never);
    const res = await runsApp.request('/api/runs/run-del', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(deleteRunSpy).toHaveBeenCalledWith('run-del');
  });

  it('maps a kube 404 to 404', async () => {
    deleteRunSpy.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    const res = await runsApp.request('/api/runs/nope', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/runs/:name/reply', () => {
  const activeRun = makeRun('run-reply', {
    status: {
      phase: 'WaitingForInput',
      sessionID: 'sess-reply',
      serviceName: 'svc-reply',
    },
  });

  it('forwards the human reply to the run service', async () => {
    getRunSpy.mockResolvedValue(activeRun);
    postSessionMessageSpy.mockResolvedValue(undefined as never);

    const res = await runsApp.request('/api/runs/run-reply/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Yes, continue' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(postSessionMessageSpy).toHaveBeenCalledWith('svc-reply', 'sess-reply', 'Yes, continue');
  });

  it('answers 404 when the run is missing', async () => {
    getRunSpy.mockRejectedValue(new Error('not found'));
    const res = await runsApp.request('/api/runs/ghost/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    });
    expect(res.status).toBe(404);
    expect(postSessionMessageSpy).not.toHaveBeenCalled();
  });

  it('answers 400 when the run has no active session', async () => {
    // Status present but no sessionID/serviceName (run still initializing).
    const idle = makeRun('run-idle', {
      status: { phase: 'Running', sessionID: undefined, serviceName: undefined } as never,
    });
    getRunSpy.mockResolvedValue(idle);
    const res = await runsApp.request('/api/runs/run-idle/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('No active session');
  });

  it('answers 400 when the message is missing or malformed', async () => {
    getRunSpy.mockResolvedValue(activeRun);

    const noMessage = await runsApp.request('/api/runs/run-reply/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(noMessage.status).toBe(400);

    const badJson = await runsApp.request('/api/runs/run-reply/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{nope',
    });
    expect(badJson.status).toBe(400);
    expect(postSessionMessageSpy).not.toHaveBeenCalled();
  });

  it('answers 502 when forwarding fails', async () => {
    getRunSpy.mockResolvedValue(activeRun);
    postSessionMessageSpy.mockRejectedValue(new Error('OpenCode API 500: boom'));

    const res = await runsApp.request('/api/runs/run-reply/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Failed to forward reply');
  });
});

// ===========================================================================
// routes/upgrade.ts
// ===========================================================================

describe('GET /api/upgrade/status', () => {
  it('returns the parsed upgrade status from the manager tool', async () => {
    callManagerToolSpy.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            current: { operator: 'v1.0.0', manager: 'v1.0.0', web: 'v1.0.0', dispatcher: 'v1.0.0' },
            latest: 'v1.0.1',
            updateAvailable: true,
            mode: 'deployments',
          }),
        },
      ],
    });

    const res = await upgradeApp.request('/api/upgrade/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      current: { manager: string };
      latest: string;
      updateAvailable: boolean;
      mode: string;
    };
    expect(body.current.manager).toBe('v1.0.0');
    expect(body.latest).toBe('v1.0.1');
    expect(body.updateAvailable).toBe(true);
    expect(body.mode).toBe('deployments');
    expect(callManagerToolSpy).toHaveBeenCalledWith('check_for_updates', {});
  });

  it('answers 500 with the tool error when the MCP result is an error', async () => {
    callManagerToolSpy.mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: 'boom' }],
    });
    const res = await upgradeApp.request('/api/upgrade/status');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('boom');
    expect(body.updateAvailable).toBe(false);
  });

  it('answers 500 on an empty tool response', async () => {
    callManagerToolSpy.mockResolvedValue({ content: [{ type: 'text', text: '' }] });
    const res = await upgradeApp.request('/api/upgrade/status');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Empty response from manager');
  });

  it('maps an HTTP failure from the manager to 502', async () => {
    callManagerToolSpy.mockRejectedValue(new managerMcp.ManagerMcpHttpError('Manager MCP 500'));
    const res = await upgradeApp.request('/api/upgrade/status');
    expect(res.status).toBe(502);
  });

  it('maps non-HTTP transport errors to 500', async () => {
    callManagerToolSpy.mockRejectedValue(new Error('fetch failed'));
    const res = await upgradeApp.request('/api/upgrade/status');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('fetch failed');
  });
});

describe('POST /api/upgrade/apply', () => {
  it('requires targetTag', async () => {
    const res = await upgradeApp.request('/api/upgrade/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('targetTag');
    expect(callManagerToolSpy).not.toHaveBeenCalled();
  });

  it('proxies the apply and returns the result', async () => {
    callManagerToolSpy.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            patched: ['manager'],
            errors: [],
            targetTag: 'v1.1.0',
            mode: 'deployments',
            warnings: ['CRDs not upgraded on the deployments path'],
          }),
        },
      ],
    });

    const res = await upgradeApp.request('/api/upgrade/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetTag: 'v1.1.0' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { targetTag: string; patched: string[] };
    expect(body.targetTag).toBe('v1.1.0');
    expect(body.patched).toEqual(['manager']);
    expect(callManagerToolSpy).toHaveBeenCalledWith('apply_upgrade', { targetTag: 'v1.1.0' });
  });

  it('answers 500 when the tool reports an error and 502 on HTTP failure', async () => {
    callManagerToolSpy.mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: 'denied' }],
    });
    const errRes = await upgradeApp.request('/api/upgrade/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetTag: 'v9.0.0' }),
    });
    expect(errRes.status).toBe(500);

    callManagerToolSpy.mockRejectedValue(new managerMcp.ManagerMcpHttpError('Manager MCP 503'));
    const httpRes = await upgradeApp.request('/api/upgrade/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetTag: 'v9.0.0' }),
    });
    expect(httpRes.status).toBe(502);
  });
});
