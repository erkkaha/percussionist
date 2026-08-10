// task-detail-pr.test.tsx — TaskDetailPanel Overview PR chip + merge error block.
//
// Mocks src/client/lib/api so no real network calls are attempted (the panel's
// OverviewContent mounts useTaskRuns, and — for phases where canShowDiff is
// true — a hidden DiffContent mounts useTaskDiff too; both go through this
// module). A real QueryClient and MemoryRouter are used, matching the pattern
// in board-view.test.tsx.

import { afterEach, describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import * as realApi from '../src/client/lib/api';
import type { Task } from '../src/client/lib/types';

const PROJECT_NAME = 'test-project';
const REPO_WEB_URL = 'https://github.com/org/repo';

// Spread the real module (captured above, before the mock below takes effect)
// so every export other modules statically import (fetchTaskEvents, fetchRun,
// fetchLogs, ...) stays defined, then override just the calls
// OverviewContent's subtree can trigger during render so no real network
// access is attempted.
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
}));

function makeTask(overrides: {
  phase: string;
  worker?: Task['status'] extends { worker?: infer W } ? W : never;
}): Task {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Task',
    metadata: { name: 'proj-build-1', creationTimestamp: '2026-01-01T00:00:00Z' },
    spec: {
      projectRef: PROJECT_NAME,
      type: 'BUILD',
      title: 'Build task',
      agent: 'builder',
    },
    status: {
      phase: overrides.phase,
      worker: overrides.worker,
    },
  } as unknown as Task;
}

async function renderDetailPanel(task: Task, repoWebUrl?: string) {
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
          repoWebUrl,
          onDeleted: () => {},
        }),
      ),
    ),
  );
}

describe('TaskDetailPanel Overview PR chip', () => {
  afterEach(cleanup);

  it('renders the PR chip with the correct href for an open PR', async () => {
    const task = makeTask({ phase: 'awaiting-feature-merge', worker: { prNumber: 7 } });
    await renderDetailPanel(task, REPO_WEB_URL);

    const link = await screen.findByTitle('Open PR #7 on GitHub');
    expect(link.getAttribute('href')).toBe('https://github.com/org/repo/pull/7');
    expect(link.textContent).toContain('PR #7');
    expect(link.textContent).toContain('open');
  });

  it('renders the merged-state variant when mergedAt is set', async () => {
    const task = makeTask({
      phase: 'done',
      worker: { prNumber: 7, mergedAt: '2026-01-02T00:00:00Z' },
    });
    await renderDetailPanel(task, REPO_WEB_URL);

    const link = await screen.findByTitle('Open PR #7 on GitHub');
    expect(link.textContent).toContain('merged');
  });

  it('renders the closed-state variant with the merge error block when mergeError is set', async () => {
    const task = makeTask({
      phase: 'awaiting-human',
      worker: { prNumber: 7, mergeError: 'PR #7 was closed without merging' },
    });
    await renderDetailPanel(task, REPO_WEB_URL);

    const link = await screen.findByTitle('Open PR #7 on GitHub');
    expect(link.textContent).toContain('closed');

    expect(await screen.findByText('Merge Error')).toBeTruthy();
    expect(screen.getByText('PR #7 was closed without merging')).toBeTruthy();
  });

  it('renders no PR chip when prNumber is absent', async () => {
    const task = makeTask({ phase: 'in-progress' });
    await renderDetailPanel(task, REPO_WEB_URL);

    expect(screen.queryByText('Pull Request')).toBeNull();
    expect(screen.queryByTitle(/Open PR #/)).toBeNull();
  });
});
