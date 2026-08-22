// findings-routes.test.ts — PATCH /api/projects/:name/findings/:id proxy to the
// manager's `update_finding` MCP tool.
//
// Mirrors runs-upgrade-routes.test.ts: the manager-MCP helper is spied before
// the router is imported, so no cluster or manager is contacted. AUTH_DISABLED=1
// skips the adminAuth middleware. Covers the acceptance criteria for the route:
// 400 on an empty body, 502 when the manager answers with an HTTP error, and the
// tool result JSON on success.

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
