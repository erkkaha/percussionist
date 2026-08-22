// task-detail-focus.test.tsx — focus-mode toggle on TaskDetailPanel.
//
// Verifies the single expand/collapse control (lucide Maximize2 / Minimize2)
// renders in the detail header and that clicking it invokes onToggleFocus
// exactly once. The overview tab is the default render; useTaskRuns /
// useTaskDiff / fetchPlan are mocked so the panel renders without network.
//
// Follows the task-detail-child-progress.test.tsx harness: lib/api is mocked
// via mock.module (spreading the real module so every other export the panel
// statically imports stays defined), wrapped in a real QueryClient +
// MemoryRouter. The web suite runs with --isolate, so the module mocks here
// are scoped to this file's module registry and cannot leak into other suites
// (in particular they do NOT touch TaskDetailPanel itself, which is the
// subject of this test).

import { afterEach, describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import * as realApi from '../src/client/lib/api';
import type { Task } from '../src/client/lib/types';

// Spread the real api module (captured before the mock below takes effect) so
// every export the panel statically imports (approveTask, deleteBoardTask,
// moveTask, …) stays defined; then override only the network calls the
// overview render can reach.
mock.module(path.resolve('src/client/lib/api'), () => ({
  ...realApi,
  fetchPlan: async () => ({ content: '', taskId: 'proj-build-1', project: 'test-project' }),
  fetchTaskDiff: async () => {
    throw new Error('not available in test');
  },
}));

// OverviewContent calls useTaskRuns; DiffContent (only mounted on the diff tab)
// calls useTaskDiff. Mock both hooks so the overview render needs no network.
mock.module(path.resolve('src/client/hooks/useTaskRuns'), () => ({
  useTaskRuns: () => ({ data: [] as unknown[] }),
}));

mock.module(path.resolve('src/client/hooks/useTaskDiff'), () => ({
  useTaskDiff: () => ({
    data: { files: [] as unknown[], commits: [] as unknown[], findings: [] as unknown[] },
    status: 'success',
    fetchStatus: 'idle',
    error: null,
  }),
}));

const PROJECT_NAME = 'test-project';
const TASK_NAME = 'proj-build-1';

function makeBuildTask(): Task {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Task',
    metadata: { name: TASK_NAME, creationTimestamp: '2026-01-01T00:00:00Z' },
    spec: {
      projectRef: PROJECT_NAME,
      type: 'BUILD',
      title: 'Build thing',
      agent: 'builder',
      description: 'A minimal BUILD task used for the focus-mode toggle test.',
    },
    status: {
      phase: 'done',
    },
  } as unknown as Task;
}

async function renderDetailPanel(onToggleFocus: () => void, focused = false) {
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
          task: makeBuildTask(),
          col: 'done',
          projectName: PROJECT_NAME,
          approvals: undefined,
          onDeleted: () => {},
          focused,
          onToggleFocus,
        }),
      ),
    ),
  );
}

describe('TaskDetailPanel focus-mode toggle', () => {
  afterEach(cleanup);

  it('renders the Maximize2 expand control bound to onToggleFocus', async () => {
    const onToggleFocus = mock(() => {});
    await renderDetailPanel(onToggleFocus);

    // Header affordance — the button is only rendered when onToggleFocus is
    // supplied, and shows Maximize2 (not yet focused).
    const button = screen.getByLabelText('Expand to full width');
    expect(button).toBeTruthy();

    fireEvent.click(button);

    expect(onToggleFocus).toHaveBeenCalledTimes(1);
  });

  it('shows the Minimize2 collapse control when focused and still calls onToggleFocus', async () => {
    const onToggleFocus = mock(() => {});
    // focused is parent-controlled (BoardView holds detailFocused); the panel
    // only reflects it. Drive it directly to assert the collapsed affordance.
    await renderDetailPanel(onToggleFocus, true);

    const button = screen.getByLabelText('Collapse task list');
    expect(button).toBeTruthy();

    fireEvent.click(button);
    expect(onToggleFocus).toHaveBeenCalledTimes(1);
  });
});
