// approve-tool.test.ts — unit tests for the manager_approve MCP tool.
//
// Tests cover:
// 1. Tool schema definition (manager_approve exists with required args)
// 2. Approval outcome logic (computeApproveMergeOutcome)

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import pathMod from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Task, TaskPhase } from '@percussionist/api';
import { computeApproveMergeOutcome } from '../tools.js';

const __dirname = pathMod.dirname(fileURLToPath(import.meta.url));
const toolsSource = fs.readFileSync(pathMod.join(__dirname, '../tools.ts'), 'utf-8');

// ---------------------------------------------------------------------------
// Tool schema definitions — verify TOOLS array contains manager_approve.
// ---------------------------------------------------------------------------

describe('manager_approve tool schema', () => {
  function extractToolBlock(name: string): string | null {
    const nameIdx = toolsSource.indexOf(`name: '${name}'`);
    if (nameIdx < 0) return null;

    let openBrace = -1;
    for (let i = nameIdx - 1; i >= Math.max(0, nameIdx - 200); i--) {
      if (toolsSource[i] === '{') {
        openBrace = i;
        break;
      }
    }
    if (openBrace < 0) return null;

    let depth = 0;
    for (let i = openBrace; i < toolsSource.length; i++) {
      if (toolsSource[i] === '{') depth++;
      else if (toolsSource[i] === '}') {
        depth--;
        if (depth === 0) {
          return toolsSource.slice(openBrace, i + 1);
        }
      }
    }
    return null;
  }

  it('should define manager_approve in the TOOLS array', () => {
    const block = extractToolBlock('manager_approve');
    expect(block).not.toBeNull();
  });

  it('should require project and task args', () => {
    const block = extractToolBlock('manager_approve');
    expect(block).not.toBeNull();
    expect(block).toContain("'project'");
    expect(block).toContain("'task'");
  });

  it('should mention canonical annotation behavior in description', () => {
    const block = extractToolBlock('manager_approve');
    expect(block).not.toBeNull();
    expect(block).toContain('percussionist.dev/action-approved');
  });

  it('should have a callTool switch case for manager_approve', () => {
    expect(toolsSource).toContain("case 'manager_approve':");
  });

  it('should import patchTask from @percussionist/kube', () => {
    expect(toolsSource).toContain('patchTask,');
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
