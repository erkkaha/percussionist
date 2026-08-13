import { describe, expect, it, spyOn } from 'bun:test';
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

async function callMcpWithAuth(
  req: Record<string, unknown>,
  getCompletionAuth: () => Promise<CompletionAuthorization>,
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
    getCompletionAuth,
  )) as Record<string, unknown>;

  response.__calls = { failCalls, completeCalls, planCalls };
  return response;
}

async function callMcp(
  req: Record<string, unknown>,
  completionAuth: CompletionAuthorization,
): Promise<Record<string, unknown>> {
  return callMcpWithAuth(req, async () => completionAuth);
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

  // The rename exists to stop agents confusing this tool with complete_review's
  // `findings` array, so advertising both names would defeat the point.
  it('tools/list advertises report_unrelated_issue and not the old report_finding name', async () => {
    const list = await callMcp({ jsonrpc: '2.0', id: 10, method: 'tools/list' }, okAuth());
    const tools = ((list.result as { tools: Array<{ name: string }> }).tools ?? []).map(
      (t) => t.name,
    );
    expect(tools).toContain('report_unrelated_issue');
    expect(tools).not.toContain('report_finding');
  });

  it('rejects an unknown tool but still dispatches the legacy report_finding name', async () => {
    const unknown = await callMcp(
      { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'report_findings' } },
      okAuth(),
    );
    expect((unknown.error as { message: string }).message).toContain('unknown tool');

    // A run that cached the tool list before the rename keeps working: both names
    // reach the same handler, so they fail identically on the request itself
    // rather than on the tool name.
    const messages = [];
    for (const name of ['report_unrelated_issue', 'report_finding']) {
      const res = await callMcp(
        { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name, arguments: {} } },
        okAuth(),
      );
      const message = (res.error as { message?: string } | undefined)?.message ?? '';
      expect(message).not.toContain('unknown tool');
      messages.push(message);
    }
    expect(messages[0]).toBe(messages[1]);
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

describe('createCompletionAuthCache retry semantics', () => {
  it('clears the cache on rejection so the next call re-resolves, then caches success', async () => {
    let calls = 0;
    const get = __test.createCompletionAuthCache(async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient blip');
      return okAuth();
    });

    await expect(get()).rejects.toThrow('transient blip');
    expect(calls).toBe(1);

    const first = await get();
    expect(first.allowed).toBe(true);
    expect(calls).toBe(2);

    const second = await get();
    expect(second.allowed).toBe(true);
    expect(calls).toBe(2); // success cached — resolve did not run again
  });

  it('caches an allowed:true outcome (resolve runs once)', async () => {
    let calls = 0;
    const get = __test.createCompletionAuthCache(async () => {
      calls += 1;
      return okAuth();
    });
    await get();
    await get();
    await get();
    expect(calls).toBe(1);
  });

  it('caches a capability-denial outcome (resolve runs once)', async () => {
    let calls = 0;
    const get = __test.createCompletionAuthCache(async () => {
      calls += 1;
      return okAuth({ allowed: false, denialReason: 'missing required capability' });
    });
    await get();
    await get();
    expect(calls).toBe(1);
  });

  it('caches a RUN_AGENT-missing denial (resolve runs once)', async () => {
    let calls = 0;
    const get = __test.createCompletionAuthCache(async () => {
      calls += 1;
      return okAuth({ allowed: false, denialReason: 'RUN_AGENT not set' });
    });
    await get();
    await get();
    expect(calls).toBe(1);
  });

  it('clears the cache on TransientAuthError (same as any rejection)', async () => {
    let calls = 0;
    const get = __test.createCompletionAuthCache(async () => {
      calls += 1;
      if (calls === 1) {
        throw new __test.TransientAuthError('failed to resolve cluster agent "builder": boom');
      }
      return okAuth();
    });

    await expect(get()).rejects.toBeInstanceOf(__test.TransientAuthError);
    expect(calls).toBe(1);

    const auth = await get();
    expect(auth.allowed).toBe(true);
    expect(calls).toBe(2); // cache was cleared — lookup retried
  });
});

describe('handleMcp graceful degradation on transient auth failure', () => {
  const throwingAuth = async (): Promise<CompletionAuthorization> => {
    throw new __test.TransientAuthError('failed to resolve cluster agent "builder": boom');
  };

  it('tools/list resolves with completion tools included optimistically (no rejection)', async () => {
    const list = await callMcpWithAuth(
      { jsonrpc: '2.0', id: 20, method: 'tools/list' },
      throwingAuth,
    );
    expect(list.error).toBeUndefined();
    const tools = ((list.result as { tools: Array<{ name: string }> }).tools ?? []).map(
      (t) => t.name,
    );
    expect(tools).toContain('complete_run');
    expect(tools).toContain('complete_plan');
    expect(tools).toContain('complete_review');
    expect(tools).toContain('complete_merge');
    expect(tools).toContain('fail_run');
  });

  it('tools/call complete_run returns -32000 with "transiently", not "not allowed"', async () => {
    const response = await callMcpWithAuth(
      {
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: { name: 'complete_run', arguments: { summary: 'done' } },
      },
      throwingAuth,
    );
    expect((response.error as { code: number }).code).toBe(-32000);
    const message = (response.error as { message: string }).message;
    expect(message).toContain('transiently');
    expect(message).toContain('please retry');
    expect(message).not.toContain('not allowed');
    const calls = response.__calls as {
      failCalls: string[];
      completeCalls: string[];
      planCalls: string[];
    };
    expect(calls.completeCalls.length).toBe(0);
  });

  it('tools/list with a definitive denial hides completion tools (existing behavior preserved)', async () => {
    const denied = await callMcp(
      { jsonrpc: '2.0', id: 22, method: 'tools/list' },
      okAuth({ allowed: false, denialReason: 'missing capability' }),
    );
    const tools = ((denied.result as { tools: Array<{ name: string }> }).tools ?? []).map(
      (t) => t.name,
    );
    expect(tools).not.toContain('complete_run');
    expect(tools).not.toContain('complete_plan');
    expect(tools).not.toContain('complete_review');
    expect(tools).not.toContain('complete_merge');
    expect(tools).toContain('fail_run');
  });
});

describe('handleSearchCode structured errors', () => {
  it('invalid regex returns a structured result containing "search failed" (no rejection)', async () => {
    const response = await callMcp(
      {
        jsonrpc: '2.0',
        id: 30,
        method: 'tools/call',
        params: { name: 'search_code', arguments: { query: '[' } },
      },
      okAuth(),
    );
    expect(response.error).toBeUndefined();
    const content = (response.result as { content: Array<{ type: string; text: string }> }).content;
    const parsed = JSON.parse(content[0]?.text ?? '{}') as Record<string, unknown>;
    expect(parsed.error).toBe('search failed');
    expect(parsed.query).toBe('[');
    expect(parsed.detail).toBeTruthy();
  });
});

describe('dispatchNotification swallows handler rejections', () => {
  it('a rejecting notification handler is caught and logged (no unhandled rejection)', async () => {
    const spy = spyOn(console, 'error').mockImplementation(() => {});
    const getCompletionAuth = async (): Promise<never> => {
      throw new Error('plain unexpected failure');
    };

    // Notifications have no id; the handler must never reject unhandled.
    let returned = false;
    __test.dispatchNotification(
      {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'complete_run', arguments: { summary: 'x' } },
      } as never,
      () => {},
      () => {},
      () => {},
      () => ({ phase: 'Running' }),
      getCompletionAuth,
    );
    returned = true;
    expect(returned).toBe(true);

    // Give the async rejection a chance to surface.
    await new Promise((r) => setTimeout(r, 50));
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('notification handler failed'),
      'plain unexpected failure',
    );
    spy.mockRestore();
  });
});
