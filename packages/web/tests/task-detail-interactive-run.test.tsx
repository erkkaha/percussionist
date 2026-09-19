// task-detail-interactive-run.test.tsx — board action: "Start Interactive Run"
// in TaskDetailPanel.
//
// The button requests an auxiliary interactive Run for a task whose phase is
// neither `idea` nor `done`. The mutation must call startInteractiveRun with
// the project/task names, invalidate the board + task-runs queries, and switch
// the panel to the Runs tab so the polling list can surface the new run.
//
// src/client/lib/api is mocked via mock.module (spreading the real module so
// every other export the panel statically imports stays defined). TaskRunsPanel
// is replaced with a marker: the real panel mounts a WS terminal and is not the
// subject here — its presence proves the tab switched. The web suite runs with
// `bun test --isolate`, so these mocks cannot leak into other suites.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import * as realApi from '../src/client/lib/api';
import type { Task } from '../src/client/lib/types';

const PROJECT_NAME = 'test-project';
const TASK_NAME = 'proj-build-1';
const RUN_NAME = 'test-project-interactive-proj-buil-deadbeef';

const startInteractiveRun = mock(async (_project: string, _taskName: string) => ({
  success: true,
  runName: RUN_NAME,
}));

// Spread the real module (captured above, before the mock below takes effect)
// so every export other modules statically import stays defined, then override
// just the calls the panel's subtree can trigger so no real network is used.
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
  answerTask: async () => {},
  startInteractiveRun,
}));

mock.module(path.resolve('src/client/components/board/TaskRunsPanel'), () => ({
  default: () => React.createElement('div', { 'data-testid': 'task-runs-panel' }, 'RUNS'),
}));

function makeTask(phase: string): Task {
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
    status: { phase },
  } as unknown as Task;
}

async function renderDetailPanel(task: Task, col = 'in-progress') {
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
          col,
          projectName: PROJECT_NAME,
          approvals: undefined,
          onDeleted: () => {},
        }),
      ),
    ),
  );
}

describe('TaskDetailPanel start interactive run', () => {
  beforeEach(() => {
    startInteractiveRun.mock.calls.length = 0;
    startInteractiveRun.mockImplementation(async () => ({ success: true, runName: RUN_NAME }));
  });
  afterEach(cleanup);

  it('calls the API and switches to the Runs tab', async () => {
    await renderDetailPanel(makeTask('running'));

    const button = screen.getByRole('button', { name: 'Start Interactive Run' });
    fireEvent.click(button);

    await waitFor(() => expect(startInteractiveRun).toHaveBeenCalled());
    expect(startInteractiveRun).toHaveBeenCalledWith(PROJECT_NAME, TASK_NAME);
    // The mutation's onSuccess sets tab to 'runs', so the (mocked) panel mounts.
    expect(await screen.findByTestId('task-runs-panel')).toBeTruthy();
  });

  it('disables the button and shows the pending label while starting', async () => {
    let resolveRun: ((value: { success: boolean; runName: string }) => void) | undefined;
    startInteractiveRun.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRun = resolve;
        }),
    );

    await renderDetailPanel(makeTask('running'));
    fireEvent.click(screen.getByRole('button', { name: 'Start Interactive Run' }));

    const pending = await screen.findByRole('button', { name: 'Starting…' });
    expect((pending as HTMLButtonElement).disabled).toBe(true);

    resolveRun?.({ success: true, runName: RUN_NAME });
    await waitFor(() => expect(screen.getByTestId('task-runs-panel')).toBeTruthy());
  });

  it('hides the button for done and idea tasks', async () => {
    const done = await renderDetailPanel(makeTask('done'), 'done');
    expect(screen.queryByRole('button', { name: 'Start Interactive Run' })).toBeNull();
    done.unmount();

    await renderDetailPanel(makeTask('idea'), 'ideas');
    expect(screen.queryByRole('button', { name: 'Start Interactive Run' })).toBeNull();
  });
});
