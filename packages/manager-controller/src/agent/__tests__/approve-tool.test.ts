// approve-tool.test.ts — unit tests for the manager_approve MCP tool.
//
// Tests cover:
// 1. Tool schema definition (manager_approve exists with required args)
// 2. Approval outcome logic (computeApproveMergeOutcome)

import { describe, expect, it } from 'bun:test';
import type { Task, TaskPhase } from '@percussionist/api';
import { computeApproveMergeOutcome } from '../tools.js';

const { __test } = await import('../tools.js');

// ---------------------------------------------------------------------------
// Tool schema definition — assert against the actual inputSchema JSON served by
// tools/list (a real tool definition can fail these).
// ---------------------------------------------------------------------------

describe('manager_approve tool schema', () => {
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
    const tool = res.result?.tools?.find((t) => t.name === 'manager_approve');
    expect(tool, 'manager_approve is registered in the TOOLS array').toBeDefined();
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

  it('requires project and task args', async () => {
    const { required } = await toolSchema();
    expect(required).toEqual(expect.arrayContaining(['project', 'task']));
  });

  it('mentions canonical annotation behavior in description', async () => {
    const { description } = await toolSchema();
    expect(description).toContain('percussionist.dev/action-approved');
  });
});

// ---------------------------------------------------------------------------
// Approval outcome logic — pure helper behavior tests.
// ---------------------------------------------------------------------------

function makeTask(overrides: {
  name?: string;
  projectRef?: string;
  phase?: TaskPhase;
  annotations?: Record<string, string>;
}): Task {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Task',
    metadata: {
      name: overrides.name ?? 'BUILD-1',
      namespace: 'percussionist',
      annotations: overrides.annotations,
    },
    spec: {
      projectRef: overrides.projectRef ?? 'my-project',
      type: 'BUILD',
      title: 'Test task',
      agent: 'builder',
      priority: 'medium',
    },
    status: {
      phase: overrides.phase ?? 'awaiting-human',
    },
  } as Task;
}

describe('computeApproveMergeOutcome', () => {
  it('returns patch outcome for awaiting-human task without approval annotation', () => {
    const task = makeTask({ phase: 'awaiting-human', annotations: { 'other-key': 'value' } });
    const outcome = computeApproveMergeOutcome('my-project', task);

    expect(outcome.kind).toBe('patch');
    expect((outcome as Extract<typeof outcome, { kind: 'patch' }>).annotations).toEqual({
      'other-key': 'value',
      'percussionist.dev/action-approved': 'true',
      'percussionist.dev/action-request-changes': 'false',
    });
    expect(outcome.result).toMatchObject({
      project: 'my-project',
      task: 'BUILD-1',
      phase: 'awaiting-human',
      approved: true,
      alreadyApproved: false,
      alreadyProgressed: false,
      patched: true,
    });
  });

  it('returns no-op when task is already awaiting-merge', () => {
    const task = makeTask({ phase: 'awaiting-merge' });
    const outcome = computeApproveMergeOutcome('my-project', task);

    expect(outcome.kind).toBe('noop');
    expect(outcome.result).toMatchObject({
      project: 'my-project',
      task: 'BUILD-1',
      phase: 'awaiting-merge',
      approved: true,
      alreadyProgressed: true,
      patched: false,
    });
  });

  it('returns no-op when task is already done', () => {
    const task = makeTask({ phase: 'done' });
    const outcome = computeApproveMergeOutcome('my-project', task);

    expect(outcome.kind).toBe('noop');
    expect(outcome.result).toMatchObject({
      phase: 'done',
      approved: true,
      alreadyProgressed: true,
      patched: false,
    });
  });

  it('returns no-op when approval annotation is already true', () => {
    const task = makeTask({
      phase: 'awaiting-human',
      annotations: { 'percussionist.dev/action-approved': 'true' },
    });
    const outcome = computeApproveMergeOutcome('my-project', task);

    expect(outcome.kind).toBe('noop');
    expect(outcome.result).toMatchObject({
      approved: true,
      alreadyApproved: true,
      alreadyProgressed: false,
      patched: false,
    });
  });

  it('returns error for non-actionable phases', () => {
    for (const phase of [
      'pending',
      'running',
      'failed',
      'rework-requested',
      'idea',
    ] as TaskPhase[]) {
      const task = makeTask({ phase });
      const outcome = computeApproveMergeOutcome('my-project', task);
      expect(outcome.kind).toBe('error');
      expect((outcome as Extract<typeof outcome, { kind: 'error' }>).message).toContain(
        `Task phase is "${phase}", expected "awaiting-human"`,
      );
    }
  });

  it('returns error when projectRef does not match', () => {
    const task = makeTask({ projectRef: 'other-project', phase: 'awaiting-human' });
    const outcome = computeApproveMergeOutcome('my-project', task);

    expect(outcome.kind).toBe('error');
    expect((outcome as Extract<typeof outcome, { kind: 'error' }>).message).toContain(
      'belongs to project "other-project"',
    );
  });
});
