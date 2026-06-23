import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ClusterAgent, Run } from '@percussionist/api';

// ---------------------------------------------------------------------------
// Mock @percussionist/kube before importing the MCP server.
// ---------------------------------------------------------------------------

const patchRunAnnotationsMock = mock(async () => ({ metadata: { annotations: {} } }) as Run);

function mockClusterAgent(name: string, capabilities: string[]): ClusterAgent {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'ClusterAgent',
    metadata: { name },
    spec: { content: '', capabilities: capabilities as never[] },
  };
}

const getClusterAgentMock = mock(async (name: string) => {
  if (name === 'integrator') return mockClusterAgent('integrator', ['task.merge.execute']);
  if (name === 'builder') return mockClusterAgent('builder', ['run.complete.build']);
  if (name === 'planner')
    return mockClusterAgent('planner', ['task.plan.execute', 'run.complete.plan']);
  if (name === 'reviewer') return mockClusterAgent('reviewer', ['run.complete.review']);
  return mockClusterAgent(name, []);
});

mock.module('@percussionist/kube', () => ({
  appendFindingToConfigMap: mock(async () => {}),
  buildTask: mock(() => ({}) as import('@percussionist/api').Task),
  createTask: mock(async () => ({}) as import('@percussionist/api').Task),
  getClusterAgent: getClusterAgentMock,
  getProject: mock(
    async () => ({ spec: { agents: [] } }) as unknown as import('@percussionist/api').Project,
  ),
  getRun: mock(async () => ({ spec: { facilitation: undefined } })),
  getTask: mock(async () => ({ spec: { type: 'BUILD' } })),
  patchRunAnnotations: patchRunAnnotationsMock,
  patchTaskStatus: mock(async () => ({}) as import('@percussionist/api').Task),
  readAllSessionsFromConfigMap: mock(async () => null),
  readPlanFromConfigMap: mock(async () => null),
  validateAgentTaskCapability: mock(async () => ({ ok: true })),
  writePlanToConfigMap: mock(async () => ({}) as import('@kubernetes/client-node').V1ConfigMap),
}));

import { gitCheck, type McpServer, startMcpServer } from '../mcp-server.js';

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
// Merge-worker context tests
// ---------------------------------------------------------------------------

describe('dispatcher MCP server — merge-worker context', () => {
  let server: McpServer;
  const completedSummaries: string[] = [];
  const completedPlans: string[] = [];
  const failureReasons: string[] = [];

  beforeEach(async () => {
    process.env.RUN_NAME = 'test-run';
    process.env.RUN_NAMESPACE = 'test-ns';
    process.env.RUN_AGENT = 'integrator';
    process.env.RUN_CONTEXT = 'merge-worker';
    completedSummaries.length = 0;
    completedPlans.length = 0;
    failureReasons.length = 0;
    patchRunAnnotationsMock.mockClear();
    getClusterAgentMock.mockClear();

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
    delete process.env.RUN_AGENT;
    delete process.env.RUN_CONTEXT;
  });

  it('lists complete_merge as the only completion tool', async () => {
    const res = (await postMcp(server.port, {
      jsonrpc: '2.0',
      id: 'list-1',
      method: 'tools/list',
    })) as { result?: { tools?: { name: string }[] } };
    const names = res.result?.tools?.map((t) => t.name) ?? [];
    expect(names).toContain('complete_merge');
    expect(names).not.toContain('complete_run');
    expect(names).not.toContain('complete_plan');
    expect(names).not.toContain('complete_review');
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

    const callArgs = patchRunAnnotationsMock.mock.calls[0] as unknown as [
      string,
      Record<string, string>,
      string,
    ];
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

  it('rejects complete_merge with -32603 when annotation patch fails', async () => {
    patchRunAnnotationsMock.mockImplementationOnce(async () => {
      throw new Error('apiserver down');
    });
    const res = await postMcp(
      server.port,
      mcpCall('merge-4', 'complete_merge', {
        outcome: 'merged',
        diagnosis: 'Fast-forward merge succeeded',
      }),
    );
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 'merge-4',
      error: { code: -32603, message: expect.stringContaining('failed to persist merge verdict') },
    });
    expect(completedSummaries).toEqual([]);
    expect(failureReasons).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Review-worker context tests
// ---------------------------------------------------------------------------

describe('dispatcher MCP server — review-facilitator context', () => {
  let server: McpServer;
  const completedSummaries: string[] = [];
  const completedPlans: string[] = [];
  const failureReasons: string[] = [];

  beforeEach(async () => {
    process.env.RUN_NAME = 'test-review-run';
    process.env.RUN_NAMESPACE = 'test-ns';
    process.env.RUN_AGENT = 'reviewer';
    process.env.RUN_CONTEXT = 'review-facilitator';
    process.env.RUN_BOARD_TASK = 'test-task-1';
    completedSummaries.length = 0;
    completedPlans.length = 0;
    failureReasons.length = 0;
    patchRunAnnotationsMock.mockClear();
    getClusterAgentMock.mockClear();

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
    delete process.env.RUN_AGENT;
    delete process.env.RUN_CONTEXT;
    delete process.env.RUN_BOARD_TASK;
  });

  it('lists complete_review as the only completion tool', async () => {
    const res = (await postMcp(server.port, {
      jsonrpc: '2.0',
      id: 'list-1',
      method: 'tools/list',
    })) as { result?: { tools?: { name: string }[] } };
    const names = res.result?.tools?.map((t) => t.name) ?? [];
    expect(names).toContain('complete_review');
    expect(names).not.toContain('complete_run');
    expect(names).not.toContain('complete_plan');
    expect(names).not.toContain('complete_merge');
  });

  it('approves a review and signals completion', async () => {
    const res = await postMcp(
      server.port,
      mcpCall('review-1', 'complete_review', {
        approved: true,
        diagnosis: 'Code looks good, tests pass',
        feedback: 'Minor nit: use const instead of let',
      }),
    );
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 'review-1',
      result: {
        content: [
          {
            type: 'text',
            text: 'Review submitted: approved. The orchestrator will process the verdict.',
          },
        ],
      },
    });
    expect(completedSummaries).toEqual([
      'reviewer approved test-task-1 — Code looks good, tests pass',
    ]);
    expect(completedPlans).toEqual([]);
    expect(failureReasons).toEqual([]);

    expect(patchRunAnnotationsMock).toHaveBeenCalledTimes(1);
    expect(patchRunAnnotationsMock).toHaveBeenCalledWith(
      'test-review-run',
      expect.objectContaining({
        'percussionist.dev/review-verdict': expect.stringContaining('"action":"approve"'),
      }),
      'test-ns',
    );

    const callArgs = patchRunAnnotationsMock.mock.calls[0] as unknown as [
      string,
      Record<string, string>,
      string,
    ];
    const verdictRaw = callArgs[1]['percussionist.dev/review-verdict'];
    if (!verdictRaw) throw new Error('missing review verdict annotation');
    const verdict = JSON.parse(verdictRaw);
    expect(verdict.action).toBe('approve');
    expect(verdict.diagnosis).toBe('Code looks good, tests pass');
    expect(verdict.feedback).toBe('Minor nit: use const instead of let');
  });

  it('rejects complete_review when diagnosis is missing', async () => {
    const res = await postMcp(
      server.port,
      mcpCall('review-2', 'complete_review', { approved: true }),
    );
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 'review-2',
      error: { code: -32602, message: 'diagnosis is required' },
    });
    expect(patchRunAnnotationsMock).toHaveBeenCalledTimes(0);
    expect(completedSummaries).toEqual([]);
  });

  it('rejects complete_review with -32603 when annotation patch fails', async () => {
    patchRunAnnotationsMock.mockImplementationOnce(async () => {
      throw new Error('apiserver down');
    });
    const res = await postMcp(
      server.port,
      mcpCall('review-3', 'complete_review', {
        approved: true,
        diagnosis: 'Good work',
      }),
    );
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 'review-3',
      error: { code: -32603, message: expect.stringContaining('failed to persist review verdict') },
    });
    expect(completedSummaries).toEqual([]);
    expect(failureReasons).toEqual([]);
  });

  it('handles request_changes verdict', async () => {
    const res = await postMcp(
      server.port,
      mcpCall('review-4', 'complete_review', {
        approved: false,
        diagnosis: 'Need to fix the error handling',
        feedback: 'Wrap the async call in try/catch',
      }),
    );
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 'review-4',
      result: {
        content: [
          {
            type: 'text',
            text: 'Review submitted: requested changes on. The orchestrator will process the verdict.',
          },
        ],
      },
    });
    expect(completedSummaries).toEqual([
      'reviewer requested changes on test-task-1 — Need to fix the error handling',
    ]);
    expect(patchRunAnnotationsMock).toHaveBeenCalledTimes(1);
    expect(patchRunAnnotationsMock).toHaveBeenCalledWith(
      'test-review-run',
      expect.objectContaining({
        'percussionist.dev/review-verdict': expect.stringContaining('"action":"request_changes"'),
      }),
      'test-ns',
    );

    const callArgs = patchRunAnnotationsMock.mock.calls[0] as unknown as [
      string,
      Record<string, string>,
      string,
    ];
    const verdictRaw = callArgs[1]['percussionist.dev/review-verdict'];
    if (!verdictRaw) throw new Error('missing review verdict annotation');
    const verdict = JSON.parse(verdictRaw);
    expect(verdict.action).toBe('request_changes');
    expect(verdict.diagnosis).toBe('Need to fix the error handling');
    expect(verdict.feedback).toBe('Wrap the async call in try/catch');
  });
});

// ---------------------------------------------------------------------------
// Build-worker context tests
// ---------------------------------------------------------------------------

describe('dispatcher MCP server — build-worker context', () => {
  let server: McpServer;
  const completedSummaries: string[] = [];
  const completedPlans: string[] = [];
  const failureReasons: string[] = [];
  const originalIsClean = gitCheck.isClean;

  beforeEach(async () => {
    process.env.RUN_NAME = 'test-run';
    process.env.RUN_NAMESPACE = 'test-ns';
    process.env.RUN_AGENT = 'builder';
    process.env.RUN_CONTEXT = 'build-worker';
    completedSummaries.length = 0;
    completedPlans.length = 0;
    failureReasons.length = 0;
    patchRunAnnotationsMock.mockClear();
    getClusterAgentMock.mockClear();
    gitCheck.isClean = originalIsClean;

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
    delete process.env.RUN_AGENT;
    delete process.env.RUN_CONTEXT;
  });

  it('lists complete_run as the only completion tool', async () => {
    const res = (await postMcp(server.port, {
      jsonrpc: '2.0',
      id: 'list-1',
      method: 'tools/list',
    })) as { result?: { tools?: { name: string }[] } };
    const names = res.result?.tools?.map((t) => t.name) ?? [];
    expect(names).toContain('complete_run');
    expect(names).not.toContain('complete_merge');
    expect(names).not.toContain('complete_plan');
    expect(names).not.toContain('complete_review');
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

  it('rejects complete_run when working tree has uncommitted changes', async () => {
    gitCheck.isClean = async () => ' M src/foo.ts\n?? src/bar.ts\n';
    const res = await postMcp(
      server.port,
      mcpCall('run-dirty-1', 'complete_run', { summary: 'Dirty work' }),
    );
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 'run-dirty-1',
      error: {
        code: -32602,
        message: expect.stringContaining('uncommitted changes'),
      },
    });
    expect(completedSummaries).toEqual([]);
  });

  it('accepts complete_run with force:true even when working tree is dirty', async () => {
    gitCheck.isClean = async () => ' M src/foo.ts\n?? src/bar.ts\n';
    const res = await postMcp(
      server.port,
      mcpCall('run-force-1', 'complete_run', {
        summary: 'Forced completion',
        force: true,
      }),
    );
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 'run-force-1',
      result: {
        content: [
          {
            type: 'text',
            text: expect.stringContaining('complete'),
          },
        ],
      },
    });
    expect(completedSummaries).toEqual(['Forced completion']);
  });

  it('accepts complete_run when working tree is clean', async () => {
    gitCheck.isClean = async () => null;
    const res = await postMcp(
      server.port,
      mcpCall('run-clean-1', 'complete_run', { summary: 'Clean work' }),
    );
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 'run-clean-1',
      result: {
        content: [
          {
            type: 'text',
            text: expect.stringContaining('complete'),
          },
        ],
      },
    });
    expect(completedSummaries).toEqual(['Clean work']);
  });
});
