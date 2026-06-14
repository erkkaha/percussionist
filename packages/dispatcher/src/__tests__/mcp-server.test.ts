import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Run } from '@percussionist/api';

// ---------------------------------------------------------------------------
// Mock @percussionist/kube before importing the MCP server.
// ---------------------------------------------------------------------------

const patchRunAnnotationsMock = mock(async () => ({ metadata: { annotations: {} } }) as Run);

mock.module('@percussionist/kube', () => ({
  buildTask: mock(() => ({}) as import('@percussionist/api').Task),
  createTask: mock(async () => ({}) as import('@percussionist/api').Task),
  getProject: mock(async () => ({ spec: { agents: [] } } as unknown as import('@percussionist/api').Project)),
  patchRunAnnotations: patchRunAnnotationsMock,
  patchTaskStatus: mock(async () => ({}) as import('@percussionist/api').Task),
  readAllSessionsFromConfigMap: mock(async () => null),
  readPlanFromConfigMap: mock(async () => null),
  writePlanToConfigMap: mock(async () => ({}) as import('@kubernetes/client-node').V1ConfigMap),
}));

import { startMcpServer, type McpServer } from '../mcp-server.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function postMcp(port: number, body: unknown): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return res.json();
}

function mcpCall(id: string | number, tool: string, args: Record<string, unknown>) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: tool, arguments: args },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dispatcher MCP server', () => {
  let server: McpServer;
  const completedSummaries: string[] = [];
  const completedPlans: string[] = [];
  const failureReasons: string[] = [];

  beforeEach(async () => {
    process.env.RUN_NAME = 'test-run';
    process.env.RUN_NAMESPACE = 'test-ns';
    completedSummaries.length = 0;
    completedPlans.length = 0;
    failureReasons.length = 0;
    patchRunAnnotationsMock.mockClear();

    server = await startMcpServer(
      (reason) => failureReasons.push(reason),
      (summary) => completedSummaries.push(summary),
      (summary) => completedPlans.push(summary),
      () => ({ phase: 'running', session: 'session-1' }),
      0,
    );
  });

  afterEach(() => {
    server.close();
    delete process.env.RUN_NAME;
    delete process.env.RUN_NAMESPACE;
  });

  it('lists complete_merge in exposed tools', async () => {
    const res = (await postMcp(server.port, {
      jsonrpc: '2.0',
      id: 'list-1',
      method: 'tools/list',
    })) as { result?: { tools?: { name: string }[] } };
    const names = res.result?.tools?.map((t) => t.name) ?? [];
    expect(names).toContain('complete_merge');
    expect(names).toContain('complete_run');
    expect(names).toContain('complete_review');
  });

  it('writes merge verdict annotation and signals completion', async () => {
    const res = await postMcp(
      server.port,
      mcpCall('merge-1', 'complete_merge', {
        outcome: 'merged',
        diagnosis: 'Fast-forward merge succeeded',
        details: 'No conflicts',
        sourceBranch: 'feature/plan-abc--build-123',
        targetBranch: 'feature/plan-abc',
        mergeCommitSha: 'abc123def456',
        requiresHuman: false,
      }),
    );
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 'merge-1',
      result: {
        content: [
          {
            type: 'text',
            text: 'Merge verdict submitted: merged. The orchestrator will process the verdict.',
          },
        ],
      },
    });
    expect(completedSummaries).toEqual(['merge merged: Fast-forward merge succeeded']);
    expect(completedPlans).toEqual([]);
    expect(failureReasons).toEqual([]);

    expect(patchRunAnnotationsMock).toHaveBeenCalledTimes(1);
    expect(patchRunAnnotationsMock).toHaveBeenCalledWith(
      'test-run',
      expect.objectContaining({
        'percussionist.dev/merge-verdict': expect.stringContaining('"outcome":"merged"'),
      }),
      'test-ns',
    );

    const callArgs = patchRunAnnotationsMock.mock.calls[0] as unknown as [string, Record<string, string>, string];
    const verdictRaw = callArgs[1]['percussionist.dev/merge-verdict'];
    if (!verdictRaw) throw new Error('missing verdict annotation');
    const verdict = JSON.parse(verdictRaw);
    expect(verdict).toEqual({
      outcome: 'merged',
      diagnosis: 'Fast-forward merge succeeded',
      details: 'No conflicts',
      sourceBranch: 'feature/plan-abc--build-123',
      targetBranch: 'feature/plan-abc',
      mergeCommitSha: 'abc123def456',
      requiresHuman: false,
    });
  });

  it('rejects complete_merge when diagnosis is missing', async () => {
    const res = await postMcp(
      server.port,
      mcpCall('merge-2', 'complete_merge', { outcome: 'merged' }),
    );
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 'merge-2',
      error: { code: -32602, message: 'diagnosis is required' },
    });
    expect(patchRunAnnotationsMock).toHaveBeenCalledTimes(0);
    expect(completedSummaries).toEqual([]);
  });

  it('rejects complete_merge when outcome is invalid', async () => {
    const res = await postMcp(
      server.port,
      mcpCall('merge-3', 'complete_merge', { outcome: 'unknown', diagnosis: 'something' }),
    );
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 'merge-3',
      error: {
        code: -32602,
        message:
          'outcome must be one of merged, already-merged, conflict, push-failed, transient-failure',
      },
    });
    expect(patchRunAnnotationsMock).toHaveBeenCalledTimes(0);
    expect(completedSummaries).toEqual([]);
  });

  it('keeps complete_run available for non-merge runs', async () => {
    const res = await postMcp(
      server.port,
      mcpCall('run-1', 'complete_run', { summary: 'Done with work' }),
    );
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 'run-1',
      result: {
        content: [
          {
            type: 'text',
            text: 'Run marked as complete. The orchestrator will review the result.',
          },
        ],
      },
    });
    expect(completedSummaries).toEqual(['Done with work']);
    expect(patchRunAnnotationsMock).toHaveBeenCalledTimes(0);
  });
});
