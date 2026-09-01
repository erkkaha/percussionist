// findings-routes.test.ts — the findings routes that proxy to the manager's
// `update_finding` (PATCH) and `create_task_from_finding` (POST …/promote) MCP
// tools.
//
// Mirrors runs-upgrade-routes.test.ts: the manager-MCP helper is spied before
// the router is imported, so no cluster or manager is contacted. AUTH_DISABLED=1
// skips the adminAuth middleware. Covers the acceptance criteria for both
// routes: 400 on invalid input (manager never called), 502 when the manager
// answers with an HTTP error, 500 on a transport error, and the tool result JSON
// on success.

import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Hono } from 'hono';
import * as managerMcp from '../src/server/lib/manager-mcp.js';

const prevAuthDisabled = process.env.AUTH_DISABLED;
process.env.AUTH_DISABLED = '1';

let findingsApp: Hono;
let callManagerToolSpy: ReturnType<typeof spyOn>;

beforeAll(async () => {
  callManagerToolSpy = spyOn(managerMcp, 'callManagerTool');

  const { default: findingsRouter } = await import('../src/server/routes/findings.js');
  findingsApp = new Hono();
  findingsApp.route('/api/projects', findingsRouter);
});

afterAll(() => {
  callManagerToolSpy.mockRestore();
  if (prevAuthDisabled !== undefined) process.env.AUTH_DISABLED = prevAuthDisabled;
  else delete process.env.AUTH_DISABLED;
});

beforeEach(() => {
  callManagerToolSpy.mockReset();
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('PATCH /api/projects/:name/findings/:id validation', () => {
  it('rejects an empty body with 400', async () => {
    const res = await findingsApp.request('/api/projects/proj/findings/f1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('At least one of');
    expect(callManagerToolSpy).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON with 400 without calling the manager', async () => {
    const res = await findingsApp.request('/api/projects/proj/findings/f1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });
    expect(res.status).toBe(400);
    expect(callManagerToolSpy).not.toHaveBeenCalled();
  });

  it('rejects an invalid status enum value with 400', async () => {
    const res = await findingsApp.request('/api/projects/proj/findings/f1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'not-a-status' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Invalid status');
    expect(callManagerToolSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Manager proxying
// ---------------------------------------------------------------------------

describe('PATCH /api/projects/:name/findings/:id proxy', () => {
  it('returns the tool result JSON on success', async () => {
    callManagerToolSpy.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            project: 'proj',
            finding: { id: 'f1', status: 'resolved' },
            updated: true,
          }),
        },
      ],
    });

    const res = await findingsApp.request('/api/projects/proj/findings/f1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'resolved' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      project: string;
      finding: { id: string; status: string };
      updated: boolean;
    };
    expect(body.project).toBe('proj');
    expect(body.finding.status).toBe('resolved');
    expect(body.updated).toBe(true);
    expect(callManagerToolSpy).toHaveBeenCalledWith('update_finding', {
      project: 'proj',
      id: 'f1',
      status: 'resolved',
    });
  });

  it('maps a manager HTTP error to 502', async () => {
    callManagerToolSpy.mockRejectedValue(
      new managerMcp.ManagerMcpHttpError('Manager MCP service returned 500: boom'),
    );
    const res = await findingsApp.request('/api/projects/proj/findings/f1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'resolved' }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Manager MCP');
  });

  it('maps a non-HTTP transport error to 500', async () => {
    callManagerToolSpy.mockRejectedValue(new Error('fetch failed'));
    const res = await findingsApp.request('/api/projects/proj/findings/f1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'resolved' }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('fetch failed');
  });
});

// ---------------------------------------------------------------------------
// Promotion (create_task_from_finding)
// ---------------------------------------------------------------------------

function mockPromoteSuccess() {
  callManagerToolSpy.mockResolvedValue({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          project: 'proj',
          taskName: 'proj-build-find-abc123',
          findingId: 'f1',
          type: 'BUILD',
          agent: 'builder',
          priority: 'medium',
        }),
      },
    ],
  });
}

interface PromoteBody {
  project: string;
  taskName: string;
  findingId: string;
  type: string;
  agent: string;
  priority: string;
}

describe('POST /api/projects/:name/findings/:id/promote', () => {
  it('returns the tool result JSON and omits agent/priority for an empty body', async () => {
    mockPromoteSuccess();

    const res = await findingsApp.request('/api/projects/proj/findings/f1/promote', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PromoteBody;
    expect(body.taskName).toBe('proj-build-find-abc123');
    expect(body.findingId).toBe('f1');
    expect(body.type).toBe('BUILD');
    // The manager applies its own defaults, so no agent/priority is forwarded.
    expect(callManagerToolSpy).toHaveBeenCalledWith('create_task_from_finding', {
      project: 'proj',
      id: 'f1',
    });
  });

  it('forwards an explicit agent and priority', async () => {
    mockPromoteSuccess();

    const res = await findingsApp.request('/api/projects/proj/findings/f1/promote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'planner', priority: 'high' }),
    });
    expect(res.status).toBe(200);
    expect(callManagerToolSpy).toHaveBeenCalledWith('create_task_from_finding', {
      project: 'proj',
      id: 'f1',
      agent: 'planner',
      priority: 'high',
    });
  });

  it('rejects an invalid priority with 400 without calling the manager', async () => {
    const res = await findingsApp.request('/api/projects/proj/findings/f1/promote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority: 'urgent' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Invalid priority');
    expect(callManagerToolSpy).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON with 400 without calling the manager', async () => {
    const res = await findingsApp.request('/api/projects/proj/findings/f1/promote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });
    expect(res.status).toBe(400);
    expect(callManagerToolSpy).not.toHaveBeenCalled();
  });

  it('maps a manager HTTP error to 502', async () => {
    callManagerToolSpy.mockRejectedValue(
      new managerMcp.ManagerMcpHttpError('Manager MCP service returned 500: boom'),
    );
    const res = await findingsApp.request('/api/projects/proj/findings/f1/promote', {
      method: 'POST',
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Manager MCP');
  });

  it('maps a non-HTTP transport error to 500', async () => {
    callManagerToolSpy.mockRejectedValue(new Error('fetch failed'));
    const res = await findingsApp.request('/api/projects/proj/findings/f1/promote', {
      method: 'POST',
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('fetch failed');
  });
});
