// run-detail-summary.test.tsx — the run detail summary strip and Summary card.
//
// The strip sits under the header's first row (replacing the bare status.message
// subtitle); the card sits at the top of the status view. Both derive from the
// same pure `deriveRunSummary` view model, so purpose, mode and activity can
// never disagree between them.
//
// The web suite runs with `bun test --isolate`, so the module mocks below are
// contained to this file (AGENTS.md) — keep the mock.module calls above the SUT
// import. RunDetail is dynamic-imported inside renderRunDetail, and the heavy
// children (transcript, log viewer, terminal) are mocked out.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

// ---------------------------------------------------------------------------
// Mutable mock state
// ---------------------------------------------------------------------------

const runMock: {
  data: Record<string, unknown> | null;
  error: Error | null;
  isLoading: boolean;
  isFetching: boolean;
} = { data: null, error: null, isLoading: false, isFetching: false };

const eventsMock: { connected: boolean; eventTick: number } = {
  connected: true,
  eventTick: 0,
};

const sessionMock: { data: { sessionID: string; messages: unknown[] } | null } = { data: null };

// ---------------------------------------------------------------------------
// Module mocks — registered before the SUT import (--isolate contains them)
// ---------------------------------------------------------------------------

mock.module(path.resolve('src/client/hooks/useRun'), () => ({
  useRun: () => runMock,
}));

mock.module(path.resolve('src/client/hooks/useRunEvents'), () => ({
  useRunEvents: () => eventsMock,
}));

// The summary reuses the session hook for session-derived activity; returning a
// plain object is enough because only `.data` is read.
mock.module(path.resolve('src/client/hooks/useSession'), () => ({
  useSession: () => sessionMock,
}));

// The real command bar imports these; mock the whole api module so nothing
// reaches the network.
mock.module(path.resolve('src/client/lib/api'), () => ({
  deleteRun: async () => {},
  interruptRun: async () => {},
  replyToRun: async () => {},
  startRunSession: async () => ({ sessionID: 'ses_new' }),
}));

// Stand-ins that are trivially identifiable in the rendered output.
mock.module(path.resolve('src/client/components/run-terminal/TerminalTranscript'), () => ({
  default: () => React.createElement('div', { 'data-testid': 'transcript' }, 'TRANSCRIPT'),
}));

mock.module(path.resolve('src/client/components/LogViewer'), () => ({
  default: () => React.createElement('div', null, 'LOGS'),
}));

mock.module(path.resolve('src/client/components/TerminalTab'), () => ({
  default: () => React.createElement('div', { 'data-testid': 'terminal-tab' }, 'TERMINAL'),
}));

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

interface RunFixtureOverrides {
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
  relatedTask?: { name: string; title: string; type: 'PLAN' | 'BUILD'; phase?: string };
}

function makeRun(overrides: RunFixtureOverrides = {}): Record<string, unknown> {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Run',
    metadata: {
      name: 'test-run',
      namespace: 'percussionist',
      creationTimestamp: new Date().toISOString(),
    },
    spec: {
      project: 'proj',
      interactive: false,
      image: 'img',
      timeoutSeconds: 600,
      ttlSecondsAfterFinished: 3600,
      ...overrides.spec,
    },
    status: { phase: 'Running', ...overrides.status },
    ...(overrides.relatedTask ? { relatedTask: overrides.relatedTask } : {}),
  };
}

/**
 * RunDetail reads its run name from the route (`useParams`) and returns null
 * when it is absent, so the matching Route is required. `entry` carries the
 * optional `?view=` param used to reach the status stage directly.
 */
async function renderRunDetail(entry = '/runs/test-run') {
  const { MemoryRouter, Route, Routes } = await import('react-router-dom');
  const { default: RunDetail } = await import('../src/client/components/RunDetail');
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    React.createElement(
      MemoryRouter,
      { initialEntries: [entry] },
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/runs/:name',
            element: React.createElement(RunDetail),
          }),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RunDetail summary strip + Summary card', () => {
  beforeEach(() => {
    runMock.data = null;
    runMock.error = null;
    runMock.isLoading = false;
    runMock.isFetching = false;
    eventsMock.connected = true;
    sessionMock.data = null;
  });
  afterEach(cleanup);

  it('shows purpose, mode and activity with a board link in the header strip', async () => {
    runMock.data = makeRun({
      spec: { boardTask: 'task-1' },
      status: { phase: 'Running', sessionID: 'sess-1', lastEventAt: new Date().toISOString() },
      relatedTask: { name: 'task-1', title: 'Add run summary API', type: 'BUILD' },
    });

    await renderRunDetail();

    const purpose = await screen.findByRole('link', { name: /BUILD · Add run summary API/ });
    expect(purpose).toHaveAttribute('href', '/projects/proj/board?task=task-1');
    expect(screen.getByText('Automated')).toBeInTheDocument();
    expect(screen.getByText('Working')).toBeInTheDocument();
    expect(screen.getByText(/ago/)).toBeInTheDocument();
  });

  it('derives the activity from structured session tool parts', async () => {
    sessionMock.data = {
      sessionID: 'sess-1',
      messages: [
        {
          info: {
            id: 'm1',
            sessionID: 'sess-1',
            role: 'assistant',
            time: { created: Date.now() - 3_000 },
          },
          parts: [
            {
              id: 'p1',
              messageID: 'm1',
              type: 'tool',
              callID: 'c1',
              tool: 'read',
              state: {
                status: 'completed',
                input: { filePath: '/workspace/src/client/components/foo.ts' },
              },
            },
          ],
        },
      ],
    };
    runMock.data = makeRun({
      spec: { boardTask: 'task-1' },
      status: { phase: 'Running', sessionID: 'sess-1' },
      relatedTask: { name: 'task-1', title: 'Add run summary API', type: 'BUILD' },
    });

    await renderRunDetail();

    expect(await screen.findByText('Reading foo.ts')).toBeInTheDocument();
    expect(screen.getByText(/ago/)).toBeInTheDocument();
  });

  it('distinguishes an interactive run in the strip', async () => {
    runMock.data = makeRun({
      spec: { interactive: true },
      status: { phase: 'Running' },
    });

    await renderRunDetail();

    expect(await screen.findByText('Interactive session')).toBeInTheDocument();
    expect(screen.getByText('Interactive')).toBeInTheDocument();
  });

  it('renders the explicit muted no-summary state when there is no purpose source', async () => {
    runMock.data = makeRun({
      spec: { interactive: false },
      status: { phase: 'Pending' },
    });

    await renderRunDetail();

    const noSummary = await screen.findByText(/No summary available/);
    expect(noSummary).toBeInTheDocument();
    expect(noSummary.className).toContain('text-text-dim');
    expect(noSummary).toHaveAttribute('title');
  });

  it('falls back to the prompt when the linked task has been deleted', async () => {
    // boardTask is set but relatedTask is omitted (Task CR gone) — must not throw.
    runMock.data = makeRun({
      spec: { boardTask: 'task-deleted', task: 'TASK: Fix the importer\n\nDetails…' },
      status: { phase: 'Running' },
    });

    await renderRunDetail();

    expect(await screen.findByText('Fix the importer')).toBeInTheDocument();
  });

  it('shows the linked task and activity in the status-view Summary card', async () => {
    runMock.data = makeRun({
      spec: { boardTask: 'task-1' },
      status: { phase: 'Running', sessionID: 'sess-1', lastEventAt: new Date().toISOString() },
      relatedTask: {
        name: 'task-1',
        title: 'Add run summary API',
        type: 'BUILD',
        phase: 'running',
      },
    });

    await renderRunDetail('/runs/test-run?view=status');

    expect(await screen.findByText('Summary')).toBeInTheDocument();
    // Purpose + mode appear in both the strip and the card.
    const purposeLinks = screen.getAllByRole('link', { name: /BUILD · Add run summary API/ });
    expect(purposeLinks.length).toBe(2);
    for (const link of purposeLinks) {
      expect(link).toHaveAttribute('href', '/projects/proj/board?task=task-1');
    }
    // Card-specific linked-task fields.
    expect(screen.getByText('Task')).toBeInTheDocument();
    expect(screen.getByText('task-1')).toBeInTheDocument();
    expect(screen.getByText('Task phase')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
  });

  it('shows the no-summary state in the status-view Summary card', async () => {
    runMock.data = makeRun({
      spec: { interactive: false },
      status: { phase: 'Pending' },
    });

    await renderRunDetail('/runs/test-run?view=status');

    expect(screen.getByText('Summary')).toBeInTheDocument();
    // Strip and card both render the explicit state.
    expect(screen.getAllByText(/No summary available/).length).toBe(2);
  });
});
