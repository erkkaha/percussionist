// Tests for the HITL inbox selection logic: phase predicate, reason/detail
// mapping, oldest-first sorting, and WaitingForInput run promotion parity.

import { describe, expect, it } from 'bun:test';
import type { Task } from '@percussionist/api';
import {
  ATTENTION_PHASES,
  attentionDetail,
  attentionReason,
  attentionSince,
  collectAttention,
  isAttentionPhase,
} from '../src/server/lib/attention.js';

interface TaskOverrides {
  name?: string;
  project?: string;
  type?: 'PLAN' | 'BUILD';
  title?: string;
  phase?: string;
  worker?: Record<string, unknown>;
  lastFailureReason?: string;
  /** Message on status (the shape named by the selection spec). */
  statusRunMessage?: string;
  /** Message at the top level (the shape the board actually emits). */
  runMessage?: string;
  creationTimestamp?: string;
}

function makeTask(overrides: TaskOverrides = {}): Task {
  const {
    name = 't1',
    project = 'proj',
    type = 'BUILD',
    title = 'Do the thing',
    phase = 'awaiting-human',
    worker,
    lastFailureReason,
    statusRunMessage,
    runMessage,
    creationTimestamp,
  } = overrides;

  return {
    metadata: { name, ...(creationTimestamp ? { creationTimestamp } : {}) },
    spec: { projectRef: project, type, title },
    status: {
      phase,
      ...(worker ? { worker } : {}),
      ...(lastFailureReason ? { lastFailureReason } : {}),
      ...(statusRunMessage ? { workerRunMessage: statusRunMessage } : {}),
    },
    ...(runMessage ? { workerRunMessage: runMessage } : {}),
  } as unknown as Task;
}

describe('isAttentionPhase', () => {
  it('accepts exactly the human-gate phases', () => {
    for (const phase of ATTENTION_PHASES) {
      expect(isAttentionPhase(phase)).toBe(true);
    }
  });

  it('rejects routine and unrelated phases', () => {
    for (const phase of [
      'idea',
      'pending',
      'scheduled',
      'initializing',
      'running',
      'succeeded',
      'reviewing',
      'awaiting-merge',
      'awaiting-children',
      'awaiting-feature-merge',
      'rework-requested',
      'generating-builds',
      'done',
    ]) {
      expect(isAttentionPhase(phase)).toBe(false);
    }
    expect(isAttentionPhase(undefined)).toBe(false);
  });
});

describe('attentionReason', () => {
  it('maps each attention phase to an operator instruction', () => {
    expect(attentionReason(makeTask({ phase: 'waiting-for-input' }))).toBe('Answer agent question');
    expect(attentionReason(makeTask({ phase: 'awaiting-human', type: 'PLAN' }))).toBe(
      'Review plan and approve',
    );
    expect(attentionReason(makeTask({ phase: 'awaiting-human', type: 'BUILD' }))).toBe(
      'Review and approve',
    );
    expect(attentionReason(makeTask({ phase: 'failed' }))).toBe('Failed — retry or abandon');
  });
});

describe('attentionDetail', () => {
  it('returns the worker run message for waiting-for-input', () => {
    expect(attentionDetail(makeTask({ phase: 'waiting-for-input', statusRunMessage: 'Q?' }))).toBe(
      'Q?',
    );
    // The board emits the message at the top level; accept that too.
    expect(attentionDetail(makeTask({ phase: 'waiting-for-input', runMessage: 'Q?' }))).toBe('Q?');
  });

  it('prefers lastFailureReason, falling back to the merge error', () => {
    expect(attentionDetail(makeTask({ phase: 'failed', lastFailureReason: 'boom' }))).toBe('boom');
    expect(
      attentionDetail(
        makeTask({ phase: 'failed', worker: { status: 'Failed', mergeError: 'conflict' } }),
      ),
    ).toBe('conflict');
    expect(attentionDetail(makeTask({ phase: 'failed' }))).toBeUndefined();
  });

  it('has no detail for awaiting-human and never throws on bad input', () => {
    expect(attentionDetail(makeTask({ phase: 'awaiting-human' }))).toBeUndefined();
    expect(attentionDetail(null as unknown as Task)).toBeUndefined();
  });
});

describe('attentionSince', () => {
  it('prefers completedAt, then startedAt, then creationTimestamp', () => {
    expect(
      attentionSince(
        makeTask({
          phase: 'failed',
          creationTimestamp: '2024-01-01T00:00:00Z',
          worker: {
            status: 'Failed',
            startedAt: '2024-02-01T00:00:00Z',
            completedAt: '2024-03-01T00:00:00Z',
          },
        }),
      ),
    ).toBe('2024-03-01T00:00:00Z');
    expect(
      attentionSince(
        makeTask({
          phase: 'failed',
          creationTimestamp: '2024-01-01T00:00:00Z',
          worker: { status: 'Failed', startedAt: '2024-02-01T00:00:00Z' },
        }),
      ),
    ).toBe('2024-02-01T00:00:00Z');
    expect(
      attentionSince(makeTask({ phase: 'failed', creationTimestamp: '2024-01-01T00:00:00Z' })),
    ).toBe('2024-01-01T00:00:00Z');
  });
});

describe('collectAttention', () => {
  it('keeps only attention phases and maps the summary fields', () => {
    const items = collectAttention([
      makeTask({
        name: 'approved',
        project: 'my project',
        phase: 'awaiting-human',
        type: 'PLAN',
        title: 'Ship it',
      }),
      makeTask({ name: 'working', phase: 'running' }),
      makeTask({ name: 'broken', phase: 'failed', lastFailureReason: 'tests failed' }),
    ]);

    expect(items.map((item) => item.taskName)).toEqual(['approved', 'broken']);
    expect(items[0]).toMatchObject({
      project: 'my project',
      taskName: 'approved',
      title: 'Ship it',
      phase: 'awaiting-human',
      reason: 'Review plan and approve',
      url: '/projects/my%20project/board?task=approved',
    });
    expect(items[0]?.detail).toBeUndefined();
    expect(items[1]).toMatchObject({
      taskName: 'broken',
      phase: 'failed',
      reason: 'Failed — retry or abandon',
      detail: 'tests failed',
    });
  });

  it('falls back to the task name when the title is empty', () => {
    const [item] = collectAttention([makeTask({ name: 'fallback', title: '' })]);
    expect(item?.title).toBe('fallback');
  });

  it('sorts oldest-waiting first, then by project and task name', () => {
    const items = collectAttention([
      makeTask({ name: 'new', creationTimestamp: '2024-03-01T00:00:00Z' }),
      makeTask({ name: 'old', creationTimestamp: '2024-01-01T00:00:00Z' }),
      makeTask({ name: 'mid', creationTimestamp: '2024-02-01T00:00:00Z' }),
    ]);
    expect(items.map((item) => item.taskName)).toEqual(['old', 'mid', 'new']);

    const tied = collectAttention([
      makeTask({ name: 'b', project: 'p2', creationTimestamp: '2024-01-01T00:00:00Z' }),
      makeTask({ name: 'a', project: 'p2', creationTimestamp: '2024-01-01T00:00:00Z' }),
      makeTask({ name: 'c', project: 'p1', creationTimestamp: '2024-01-01T00:00:00Z' }),
    ]);
    expect(tied.map((item) => item.taskName)).toEqual(['c', 'a', 'b']);
  });

  it('promotes a running task whose worker run is WaitingForInput', () => {
    const tasks = [
      makeTask({ name: 'lagging', phase: 'running', worker: { status: 'Running', runName: 'r1' } }),
      makeTask({ name: 'active', phase: 'running', worker: { status: 'Running', runName: 'r2' } }),
    ];

    const items = collectAttention(tasks, { r1: 'WaitingForInput', r2: 'Running' });
    expect(items.map((item) => item.taskName)).toEqual(['lagging']);
    expect(items[0]).toMatchObject({
      phase: 'waiting-for-input',
      reason: 'Answer agent question',
    });
  });

  it('handles a Map for run phases and requires the WaitingForInput value', () => {
    const tasks = [
      makeTask({ name: 'lagging', phase: 'running', worker: { status: 'Running', runName: 'r1' } }),
    ];
    expect(collectAttention(tasks, new Map([['r1', 'WaitingForInput']]))).toHaveLength(1);
    expect(collectAttention(tasks, new Map([['r1', 'Running']]))).toHaveLength(0);
    // Without a lookup the task stays running and is not selected.
    expect(collectAttention(tasks)).toHaveLength(0);
  });

  it('does not override a task that is already in an attention phase', () => {
    const [item] = collectAttention(
      [
        makeTask({
          name: 'gated',
          phase: 'awaiting-human',
          worker: { status: 'Running', runName: 'r1' },
        }),
      ],
      { r1: 'WaitingForInput' },
    );
    expect(item?.phase).toBe('awaiting-human');
    expect(item?.reason).toBe('Review and approve');
  });
});
