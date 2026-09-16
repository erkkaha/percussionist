// request-changes-tool.test.ts — unit tests for the request_changes MCP tool.
//
// Tests cover:
// 1. Tool schema definition (request_changes exists with required args)
// 2. Eligibility predicate (isRequestChangesEligible)
// 3. Request-changes outcome logic (computeRequestChangesOutcome)
//
// The gate mirrors the CLI's `beatctl board task request-changes` semantics:
// `awaiting-human`, or a PR-stage `awaiting-feature-merge` with an open
// `worker.prNumber`.

import { describe, expect, it } from 'bun:test';
import type { Task, TaskPhase } from '@percussionist/api';
import { computeRequestChangesOutcome, isRequestChangesEligible } from '../tools.js';

const { __test } = await import('../tools.js');

// ---------------------------------------------------------------------------
// Tool schema definition — assert against the actual inputSchema JSON served by
// tools/list (a real tool definition can fail these).
// ---------------------------------------------------------------------------

describe('request_changes tool schema', () => {
  async function toolSchema(): Promise<{
    description?: string;
    required: string[];
    properties: Record<string, unknown>;
  }> {
    const res = (await __test.handleMcp({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })) as {
      result?: { tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> };
    };
    const tool = res.result?.tools?.find((t) => t.name === 'request_changes');
    expect(tool, 'request_changes is registered in the TOOLS array').toBeDefined();
    const schema = tool?.inputSchema as
      | { properties?: Record<string, unknown>; required?: string[] }
      | undefined;
    return {
      description: tool?.description,
      required: schema?.required ?? [],
      properties: schema?.properties ?? {},
    };
  }

  it('is registered in the TOOLS array', async () => {
    const { required } = await toolSchema();
    expect(required).toBeDefined();
  });

  it('requires project, task and feedback args', async () => {
    const { required } = await toolSchema();
    expect(required).toEqual(expect.arrayContaining(['project', 'task', 'feedback']));
  });

  it('mentions both canonical annotations in the description', async () => {
    const { description } = await toolSchema();
    expect(description).toContain('percussionist.dev/action-request-changes');
    expect(description).toContain('percussionist.dev/action-rework-feedback');
  });
});

// ---------------------------------------------------------------------------
// Pure helper behavior tests.
// ---------------------------------------------------------------------------

function makeTask(overrides: {
  name?: string;
  projectRef?: string;
  phase?: TaskPhase;
  type?: 'BUILD' | 'PLAN';
  prNumber?: number;
  annotations?: Record<string, string>;
}): Task {
  const worker =
    overrides.prNumber === undefined
      ? { status: 'Running' as const, retryCount: 0, aiReworkCount: 0 }
      : {
          status: 'Running' as const,
          retryCount: 0,
          aiReworkCount: 0,
          prNumber: overrides.prNumber,
        };
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Task',
    metadata: {
      name: overrides.name ?? 'PLAN-1',
      namespace: 'percussionist',
      annotations: overrides.annotations,
    },
    spec: {
      projectRef: overrides.projectRef ?? 'my-project',
      type: overrides.type ?? 'PLAN',
      title: 'Test task',
      agent: 'planner',
      priority: 'medium',
    },
    status: {
      phase: overrides.phase ?? 'awaiting-human',
      worker,
    },
  } as Task;
}

describe('isRequestChangesEligible', () => {
  it('is eligible in awaiting-human', () => {
    expect(isRequestChangesEligible(makeTask({ phase: 'awaiting-human' }))).toBe(true);
  });

  it('is eligible in PR-stage awaiting-feature-merge with prNumber', () => {
    expect(
      isRequestChangesEligible(makeTask({ phase: 'awaiting-feature-merge', prNumber: 42 })),
    ).toBe(true);
  });

  it('is not eligible in awaiting-feature-merge without prNumber', () => {
    expect(isRequestChangesEligible(makeTask({ phase: 'awaiting-feature-merge' }))).toBe(false);
  });

  it('is not eligible in other phases', () => {
    for (const phase of ['pending', 'running', 'failed', 'done', 'awaiting-merge'] as TaskPhase[]) {
      expect(isRequestChangesEligible(makeTask({ phase }))).toBe(false);
    }
  });
});

describe('computeRequestChangesOutcome', () => {
  it('patches the annotations for an awaiting-human task', () => {
    const task = makeTask({ phase: 'awaiting-human', annotations: { 'other-key': 'value' } });
    const outcome = computeRequestChangesOutcome('my-project', task, '  please add tests  ');

    expect(outcome.kind).toBe('patch');
    expect((outcome as Extract<typeof outcome, { kind: 'patch' }>).annotations).toEqual({
      'other-key': 'value',
      'percussionist.dev/action-request-changes': 'true',
      'percussionist.dev/action-rework-feedback': 'please add tests',
    });
    expect(outcome.result).toMatchObject({
      project: 'my-project',
      task: 'PLAN-1',
      phase: 'awaiting-human',
      requestChanges: true,
      prStage: false,
      patched: true,
    });
  });

  it('patches the annotations for a PR-stage task and flags prStage', () => {
    const task = makeTask({ phase: 'awaiting-feature-merge', prNumber: 42 });
    const outcome = computeRequestChangesOutcome('my-project', task, 'change the scope');

    expect(outcome.kind).toBe('patch');
    expect(outcome.result).toMatchObject({
      phase: 'awaiting-feature-merge',
      requestChanges: true,
      prStage: true,
      patched: true,
    });
  });

  it('errors for awaiting-feature-merge without a prNumber', () => {
    const task = makeTask({ phase: 'awaiting-feature-merge' });
    const outcome = computeRequestChangesOutcome('my-project', task, 'feedback');

    expect(outcome.kind).toBe('error');
    expect((outcome as Extract<typeof outcome, { kind: 'error' }>).message).toContain(
      'awaiting-feature-merge',
    );
  });

  it('errors for non-actionable phases', () => {
    for (const phase of ['pending', 'running', 'failed', 'done', 'awaiting-merge'] as TaskPhase[]) {
      const outcome = computeRequestChangesOutcome('my-project', makeTask({ phase }), 'feedback');
      expect(outcome.kind).toBe('error');
      expect((outcome as Extract<typeof outcome, { kind: 'error' }>).message).toContain(
        'expected "awaiting-human"',
      );
    }
  });

  it('errors when feedback is empty or whitespace', () => {
    for (const feedback of ['', '   ']) {
      const outcome = computeRequestChangesOutcome(
        'my-project',
        makeTask({ phase: 'awaiting-human' }),
        feedback,
      );
      expect(outcome.kind).toBe('error');
      expect((outcome as Extract<typeof outcome, { kind: 'error' }>).message).toContain(
        'feedback is required',
      );
    }
  });

  it('errors when projectRef does not match', () => {
    const task = makeTask({ projectRef: 'other-project', phase: 'awaiting-human' });
    const outcome = computeRequestChangesOutcome('my-project', task, 'feedback');

    expect(outcome.kind).toBe('error');
    expect((outcome as Extract<typeof outcome, { kind: 'error' }>).message).toContain(
      'belongs to project "other-project"',
    );
  });
});
