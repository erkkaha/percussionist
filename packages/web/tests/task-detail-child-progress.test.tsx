// task-detail-child-progress.test.tsx — the Child Tasks list in
// TaskDetailPanel renders a green checkmark for done children and the wrench
// for non-done children (per-child status from childProgress.childPhases).
//
// Follows the task-detail-answer.test.tsx harness: mocks src/client/lib/api
// via mock.module (no real network), real QueryClient + MemoryRouter. The web
// suite runs with --isolate so no static top-level stubs — the mock below is
// scoped to this file's module registry.

import { afterEach, describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import * as realApi from '../src/client/lib/api';
import type { Task } from '../src/client/lib/types';

const PROJECT_NAME = 'test-project';
const TASK_NAME = 'proj-plan-1';

// Spread the real module (captured above, before the mock below takes effect)
// so every export other modules statically import stays defined, then override
// the calls the panel's subtree can trigger so no real network access happens.
mock.module(path.resolve('src/client/lib/api'), () => ({
  ...realApi,
  fetchTaskRuns: async () => [],
  fetchPlan: async () => ({ content: '', taskId: TASK_NAME, project: PROJECT_NAME }),
  fetchTaskDiff: async () => {
    throw new Error('not available in test');
  },
  approveTask: async () => {},
  deleteBoardTask: async () => {},
  moveTask: async () => {},
  requestChangesTask: async () => {},
  retryEscalatedTask: async () => {},
  retryReviewTask: async () => {},
  replyToRun: async () => {},
  answerTask: async () => {},
}));

function makePlanTask(overrides: Partial<Task>): Task {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Task',
    metadata: { name: TASK_NAME, creationTimestamp: '2026-01-01T00:00:00Z' },
    spec: {
      projectRef: PROJECT_NAME,
      type: 'PLAN',
      title: 'Plan task',
      agent: 'planner',
    },
    status: {
      phase: 'awaiting-children',
    },
    childProgress: {
      total: 2,
      completed: 1,
      childRefs: ['proj-build-a', 'proj-build-b'],
      childDisplayRefs: ['Implement API', 'Wire UI'],
      childPhases: ['done', 'running'],
    },
    ...overrides,
  } as unknown as Task;
}

async function renderDetailPanel(task: Task) {
  const { TaskDetailPanel } = await import('../src/client/components/board/TaskDetailPanel');
  const { MemoryRouter } = await import('react-router-dom');
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(TaskDetailPanel, {
          task,
          col: 'awaiting-children',
          projectName: PROJECT_NAME,
          approvals: undefined,
          onDeleted: () => {},
        }),
      ),
    ),
  );
}

describe('TaskDetailPanel child task progress', () => {
  afterEach(cleanup);

  it('renders a green checkmark for the done child and a wrench for the non-done child', async () => {
    await renderDetailPanel(makePlanTask());

    // Summary line (existing behavior unchanged).
    expect(screen.getByText('Child Tasks (1/2 complete)')).toBeTruthy();
    // Both children listed.
    expect(screen.getByText('Implement API')).toBeTruthy();
    expect(screen.getByText('Wire UI')).toBeTruthy();

    // Done child → green checkmark with accessible name "Done".
    const doneIcon = screen.getByLabelText('Done');
    expect(doneIcon.className).toContain('text-green-500');
    // Non-done child → wrench with accessible name "In progress".
    const inProgressIcon = screen.getByLabelText('In progress');
    expect(inProgressIcon.className).toContain('lucide-wrench');
    expect(inProgressIcon.className).not.toContain('text-green-500');
  });

  it('degrades to the wrench for every child when childPhases is missing', async () => {
    await renderDetailPanel(
      makePlanTask({
        childProgress: {
          total: 2,
          completed: 1,
          childRefs: ['proj-build-a', 'proj-build-b'],
          childDisplayRefs: ['Implement API', 'Wire UI'],
        },
      } as Partial<Task>),
    );

    expect(screen.queryByLabelText('Done')).toBeNull();
    expect(screen.getAllByLabelText('In progress')).toHaveLength(2);
  });
});
