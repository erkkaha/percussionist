import { describe, expect, it } from 'bun:test';
import { __test } from './mcp-server.js';

type CompletionAuthorization = {
  context: 'plan-worker' | 'build-worker' | 'review-facilitator';
  allowedTool: 'complete_run' | 'complete_plan' | 'complete_review';
  requiredCapability: 'run.complete.build' | 'run.complete.plan' | 'run.complete.review';
  allowed: boolean;
  denialReason?: string;
};

const okAuth = (overrides: Partial<CompletionAuthorization> = {}): CompletionAuthorization => ({
  context: 'build-worker',
  allowedTool: 'complete_run',
  requiredCapability: 'run.complete.build',
  allowed: true,
  ...overrides,
});

async function callMcp(
  req: Record<string, unknown>,
  completionAuth: CompletionAuthorization,
): Promise<Record<string, unknown>> {
  const failCalls: string[] = [];
  const completeCalls: string[] = [];
  const planCalls: string[] = [];

  const response = (await __test.handleMcp(
    req as never,
    (reason) => failCalls.push(reason),
    (summary) => completeCalls.push(summary),
    (summary) => planCalls.push(summary),
    () => ({ phase: 'Running' }),
    async () => completionAuth,
  )) as Record<string, unknown>;

  response.__calls = { failCalls, completeCalls, planCalls };
  return response;
}

describe('dispatcher completion-tool gating', () => {
  it('tools/list advertises only context-allowed completion tool', async () => {
    const buildList = await callMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, okAuth());
    const buildTools = ((buildList.result as { tools: Array<{ name: string }> }).tools ?? []).map(
      (t) => t.name,
    );
    expect(buildTools).toContain('complete_run');
    expect(buildTools).not.toContain('complete_plan');
    expect(buildTools).not.toContain('complete_review');

    const reviewList = await callMcp(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      okAuth({
        context: 'review-facilitator',
        allowedTool: 'complete_review',
        requiredCapability: 'run.complete.review',
      }),
    );
    const reviewTools = ((reviewList.result as { tools: Array<{ name: string }> }).tools ?? []).map(
      (t) => t.name,
    );
    expect(reviewTools).toContain('complete_review');
    expect(reviewTools).not.toContain('complete_run');
    expect(reviewTools).not.toContain('complete_plan');
  });

  it('tools/list hides completion tools when authorization is denied', async () => {
    const denied = await callMcp(
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      okAuth({ allowed: false, denialReason: 'missing capability' }),
    );
    const tools = ((denied.result as { tools: Array<{ name: string }> }).tools ?? []).map(
      (t) => t.name,
    );
    expect(tools).not.toContain('complete_run');
    expect(tools).not.toContain('complete_plan');
    expect(tools).not.toContain('complete_review');
    expect(tools).toContain('fail_run');
  });

  it('tools/call rejects disallowed completion tool with -32602', async () => {
    const response = await callMcp(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'complete_review', arguments: { approved: true, diagnosis: 'ok' } },
      },
      okAuth({ context: 'build-worker', allowedTool: 'complete_run' }),
    );

    expect((response.error as { code: number }).code).toBe(-32602);
    expect((response.error as { message: string }).message).toContain('not allowed in context');
    const calls = response.__calls as {
      failCalls: string[];
      completeCalls: string[];
      planCalls: string[];
    };
    expect(calls.completeCalls.length).toBe(0);
    expect(calls.planCalls.length).toBe(0);
  });

  it('tools/call rejects all completion tools when capability check fails', async () => {
    const response = await callMcp(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'complete_run', arguments: { summary: 'done' } },
      },
      okAuth({ allowed: false, denialReason: 'agent "reviewer" missing required capability' }),
    );

    expect((response.error as { code: number }).code).toBe(-32602);
    expect((response.error as { message: string }).message).toContain(
      'missing required capability',
    );
  });
});
