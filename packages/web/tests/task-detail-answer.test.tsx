// task-detail-answer.test.tsx — board answer flow: the "Answer" box in
// TaskDetailPanel for a task whose worker run is WaitingForInput.
//
// The box must (1) forward the human's reply into the run session via
// replyToRun and (2) write the percussionist.dev/action-answer annotation via
// answerTask — the two calls decideWaitingForInput consumes to resume the
// parked task. Mocks src/client/lib/api so no real network calls are attempted
// (the panel's OverviewContent mounts useTaskRuns, and for phases where
// canShowDiff is true a hidden DiffContent mounts useTaskDiff too). A real
// QueryClient and MemoryRouter are used, matching task-detail-pr.test.tsx.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import * as realApi from '../src/client/lib/api';
import type { Task } from '../src/client/lib/types';

const PROJECT_NAME = 'test-project';
const TASK_NAME = 'proj-build-1';
const RUN_NAME = 'proj-build-1-run-42';

// Call-order tracker — replyToRun must fire before answerTask (the reply has
// to reach the parked agent before the annotation tells the reconciler the
// task is answerable).
const callOrder: string[] = [];
const replyToRun = mock(async (_runName: string, _message: string) => {
  callOrder.push('reply');
});
const answerTask = mock(async (_project: string, _taskName: string, _answer: string) => {
  callOrder.push('answer');
});

// Spread the real module (captured above, before the mock below takes effect)
// so every export other modules statically import (fetchTaskEvents, fetchRun,
// fetchLogs, ...) stays defined, then override just the calls the panel's
// subtree can trigger so no real network access is attempted.
mock.module(path.resolve('src/client/lib/api'), () => ({
  ...realApi,
  fetchTaskRuns: async () => [],
  fetchTaskDiff: async () => {
    throw new Error('not available in test');
  },
  fetchPlan: async () => {
    throw new Error('not available in test');
  },
  approveTask: async () => {},
  deleteBoardTask: async () => {},
  moveTask: async () => {},
  requestChangesTask: async () => {},
  retryEscalatedTask: async () => {},
  retryReviewTask: async () => {},
  replyToRun,
  answerTask,
}));

function makeTask(overrides: Partial<Task>): Task {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Task',
    metadata: { name: TASK_NAME, creationTimestamp: '2026-01-01T00:00:00Z' },
    spec: {
      projectRef: PROJECT_NAME,
      type: 'BUILD',
      title: 'Build task',
      agent: 'builder',
    },
    status: {
      phase: 'waiting-for-input',
      worker: { runName: RUN_NAME, status: 'Running' },
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
          col: 'in-progress',
          projectName: PROJECT_NAME,
          approvals: undefined,
          onDeleted: () => {},
        }),
      ),
    ),
  );
}

describe('TaskDetailPanel answer flow (waiting for input)', () => {
  beforeEach(() => {
    // Clear recorded calls without resetting implementations (mockReset()
    // strips the push-to-callOrder side effects the order assertion relies on).
    replyToRun.mock.calls.length = 0;
    answerTask.mock.calls.length = 0;
    callOrder.length = 0;
  });
  afterEach(cleanup);

  it('renders the Answer box only for a task whose worker run is WaitingForInput', async () => {
    const waiting = makeTask({ workerRunPhase: 'WaitingForInput' });
    await renderDetailPanel(waiting);
    expect(screen.getByText('Answer — run is waiting for input')).toBeTruthy();
    expect(screen.getByPlaceholderText('Type your answer for the agent…')).toBeTruthy();
  });

  it('hides the Answer box when the run is not waiting for input', async () => {
    const running = makeTask({ workerRunPhase: 'Running' });
    await renderDetailPanel(running);
    expect(screen.queryByText('Answer — run is waiting for input')).toBeNull();
    expect(screen.queryByPlaceholderText('Type your answer for the agent…')).toBeNull();
  });

  it('forwards the typed answer to the run session and writes the answer annotation', async () => {
    const waiting = makeTask({ workerRunPhase: 'WaitingForInput' });
    await renderDetailPanel(waiting);

    const textarea = screen.getByPlaceholderText('Type your answer for the agent…');
    fireEvent.change(textarea, { target: { value: 'Please proceed with the plan' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send Answer' }));

    await waitFor(() => expect(replyToRun).toHaveBeenCalled());
    await waitFor(() => expect(answerTask).toHaveBeenCalled());

    expect(replyToRun).toHaveBeenCalledWith(RUN_NAME, 'Please proceed with the plan');
    expect(answerTask).toHaveBeenCalledWith(
      PROJECT_NAME,
      TASK_NAME,
      'Please proceed with the plan',
    );
    // The reply must reach the parked session before the annotation is written.
    expect(callOrder).toEqual(['reply', 'answer']);
  });

  it('does not fire any API call when the answer is blank', async () => {
    const waiting = makeTask({ workerRunPhase: 'WaitingForInput' });
    await renderDetailPanel(waiting);

    const textarea = screen.getByPlaceholderText('Type your answer for the agent…');
    fireEvent.change(textarea, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send Answer' }));

    expect(replyToRun).not.toHaveBeenCalled();
    expect(answerTask).not.toHaveBeenCalled();
  });
});
