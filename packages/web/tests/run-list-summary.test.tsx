// run-list-summary.test.tsx — the runs table's Summary column.
//
// Replaces the old Session column with a derived summary block: purpose (task
// board link when the run's boardTask resolves), mode badge, and the latest
// phase/status activity + relative age. The list has no session messages, so
// activity comes only from purpose + phase/status facts.
//
// The api module and the run-list SSE hook are mocked; the web suite runs with
// `bun test --isolate`, so the mocks stay in this file (see AGENTS.md). Keep the
// mock.module calls above the SUT import.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

interface RunFixture {
  apiVersion: string;
  kind: string;
  metadata: { name: string; creationTimestamp: string };
  spec: {
    project: string;
    agent?: string;
    model?: string;
    boardTask?: string;
    interactive?: boolean;
    runContext?: string;
    taskPreview?: string;
  };
  status: {
    phase: string;
    message?: string;
    sessionID?: string;
    startedAt?: string;
    completedAt?: string;
    lastEventAt?: string;
  };
  relatedTask?: { name: string; title: string; type: 'PLAN' | 'BUILD'; phase?: string };
}

// Mutable list the mocked fetcher serves — reset per test.
const listMock: { items: RunFixture[]; total: number } = { items: [], total: 0 };

mock.module(path.resolve('src/client/lib/api'), () => ({
  fetchRunsPaginated: async () => ({ items: listMock.items, total: listMock.total }),
}));

mock.module(path.resolve('src/client/hooks/useRunsEvents'), () => ({
  useRunsEvents: () => ({ connected: false, eventTick: 0 }),
}));

mock.module(path.resolve('src/client/components/StatusBadge'), () => ({
  default: ({ phase }: { phase?: string }) =>
    React.createElement('span', { 'data-testid': 'status-badge' }, phase ?? 'unknown'),
}));

mock.module(path.resolve('src/client/components/TokenCounter'), () => ({
  default: ({ tokensIn, tokensOut }: { tokensIn?: number; tokensOut?: number }) =>
    React.createElement(
      'span',
      { 'data-testid': 'token-counter' },
      `${tokensIn ?? 0}/${tokensOut ?? 0}`,
    ),
}));

function makeRun(
  name: string,
  overrides: {
    spec?: Partial<RunFixture['spec']>;
    status?: Partial<RunFixture['status']>;
    relatedTask?: RunFixture['relatedTask'];
  } = {},
): RunFixture {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Run',
    metadata: { name, creationTimestamp: new Date().toISOString() },
    spec: { project: 'proj', agent: 'builder', model: 'test-model', ...overrides.spec },
    status: { phase: 'Running', ...overrides.status },
    ...(overrides.relatedTask ? { relatedTask: overrides.relatedTask } : {}),
  };
}

async function renderRunList() {
  const { default: RunList } = await import('../src/client/components/RunList');
  const { MemoryRouter } = await import('react-router-dom');
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(RunList),
      ),
    ),
  );
}

describe('RunList Summary column', () => {
  beforeEach(() => {
    listMock.items = [];
    listMock.total = 0;
  });
  afterEach(cleanup);

  it('renders a Summary header instead of a Session column', async () => {
    listMock.items = [makeRun('run-a')];
    listMock.total = 1;

    await renderRunList();

    expect(await screen.findByText('Summary')).toBeInTheDocument();
    expect(screen.queryByText('Session')).toBeNull();
  });

  it('shows task type + title and an Automated badge for a task-linked run', async () => {
    const run = makeRun('run-build-1', {
      spec: { boardTask: 'task-1' },
      status: {
        phase: 'Running',
        lastEventAt: new Date(Date.now() - 42_000).toISOString(),
      },
      relatedTask: { name: 'task-1', title: 'Add run summary API', type: 'BUILD' },
    });
    listMock.items = [run];
    listMock.total = 1;

    await renderRunList();

    const purpose = await screen.findByRole('link', { name: /BUILD · Add run summary API/ });
    expect(purpose).toHaveAttribute('href', '/projects/proj/board?task=task-1');
    expect(screen.getByText('Automated')).toBeInTheDocument();
    expect(screen.getByText(/Working · \d+s ago/)).toBeInTheDocument();
  });

  it('shows an Interactive badge for an interactive run with no task', async () => {
    listMock.items = [
      makeRun('run-interactive-1', {
        spec: { interactive: true },
        status: { phase: 'Running', lastEventAt: new Date().toISOString() },
      }),
    ];
    listMock.total = 1;

    await renderRunList();

    expect(await screen.findByText('Interactive session')).toBeInTheDocument();
    expect(screen.getByText('Interactive')).toBeInTheDocument();
  });

  it('renders the explicit muted no-summary state when there is no purpose source', async () => {
    listMock.items = [
      makeRun('run-no-source', {
        spec: { interactive: false },
        status: { phase: 'Pending' },
      }),
    ];
    listMock.total = 1;

    await renderRunList();

    const noSummary = await screen.findByText('No summary available');
    expect(noSummary).toBeInTheDocument();
    expect(noSummary.className).toContain('text-text-dim');
    expect(screen.getByText('Automated')).toBeInTheDocument();
  });

  it('shows the failure reason once, not duplicated under the run name', async () => {
    listMock.items = [
      makeRun('run-failed-1', {
        spec: { boardTask: 'task-2' },
        status: {
          phase: 'Failed',
          message: 'OOMKilled',
          completedAt: new Date(Date.now() - 60_000).toISOString(),
        },
        relatedTask: { name: 'task-2', title: 'Retry policy', type: 'BUILD' },
      }),
    ];
    listMock.total = 1;

    await renderRunList();

    expect(await screen.findByText(/Failed — OOMKilled/)).toBeInTheDocument();
    // The under-name duplicate is suppressed once the summary carries the reason.
    expect(screen.getAllByText(/OOMKilled/).length).toBe(1);
  });

  it('truncates long purpose titles with a full-text tooltip', async () => {
    const longTitle = 'Implement an extremely long summary title that will not fit in the column';
    listMock.items = [
      makeRun('run-long', {
        spec: { boardTask: 'task-3' },
        status: { phase: 'Running' },
        relatedTask: { name: 'task-3', title: longTitle, type: 'BUILD' },
      }),
    ];
    listMock.total = 1;

    await renderRunList();

    const link = await screen.findByRole('link', { name: /BUILD · Implement/ });
    expect(link).toHaveAttribute('title', `BUILD · ${longTitle}`);
    expect(link.className).toContain('truncate');
  });

  it('renders a terminal run with a completion activity, never an in-progress verb', async () => {
    listMock.items = [
      makeRun('run-succeeded', {
        status: {
          phase: 'Succeeded',
          startedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
          completedAt: new Date().toISOString(),
        },
      }),
    ];
    listMock.total = 1;

    await renderRunList();

    expect(await screen.findByText(/Completed in 12m/)).toBeInTheDocument();
    expect(screen.queryByText(/Working/)).toBeNull();
  });
});
