// run-detail-shell.test.tsx — RunDetail is an immersive terminal shell.
//
// The old tab bar is gone; the page is a single stage driven by slash commands
// and the `?view=` search param. This covers the shell wiring, not the panels'
// contents:
//   (a) the default stage is the conversation
//   (b) `/status` typed into the command bar switches the stage to status
//   (c) a `?view=logs` deep link selects the logs stage on first render
//   (d) a legacy `?tab=session` maps to the conversation stage
//   (e) an unavailable `?view=shell` clamps to the conversation
//   (f) the shell stage is absent for the claude engine, and for a non-Running
//       pod it clamps instead of rendering the attach widget
//   (g) the header keeps Copy and the two-step Cancel/Delete confirm
//   (h) a failed run shows the failed banner
//
// The web suite runs with `bun test --isolate`, so the module mocks below are
// contained to this file (AGENTS.md) — keep the mock.module calls above the SUT
// import. RunDetail is dynamic-imported inside renderRunDetail. The heavy
// children (transcript, log viewer, terminal) are mocked out; the command bar
// stays real so slash commands flow into the shell's `setView`.
//
// `git log --follow packages/web/tests/run-detail-tabs.test.tsx` for the tab
// shell this replaces.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const apiCalls: { delete: string[] } = { delete: [] };

// ---------------------------------------------------------------------------
// Module mocks — registered before the SUT import below (--isolate contains them)
// ---------------------------------------------------------------------------

mock.module(path.resolve('src/client/hooks/useRun'), () => ({
  useRun: () => runMock,
}));

mock.module(path.resolve('src/client/hooks/useRunEvents'), () => ({
  useRunEvents: () => eventsMock,
}));

// The real command bar calls these on server commands; the shell tests only
// drive UI commands, but the module must mock cleanly for the imports to load.
mock.module(path.resolve('src/client/lib/api'), () => ({
  deleteRun: async (name: string) => {
    apiCalls.delete.push(name);
  },
  replyToRun: async () => {},
  startRunSession: async () => ({ sessionID: 'ses_new' }),
  interruptRun: async () => {},
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
// Fixtures
// ---------------------------------------------------------------------------

/**
 * An active opencode run whose pod is Running with a session, i.e. the state
 * that offers every stage and renders the command bar.
 */
function makeRun(
  overrides: {
    engine?: string;
    phase?: string;
    podName?: string;
    podPhase?: string;
    sessionID?: string | null;
    message?: string;
  } = {},
): Record<string, unknown> {
  const {
    engine,
    phase = 'Running',
    podName = 'test-run',
    podPhase = 'Running',
    sessionID = 'sess-1',
    message,
  } = overrides;
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Run',
    metadata: {
      name: 'test-run',
      namespace: 'percussionist',
      creationTimestamp: new Date().toISOString(),
    },
    spec: {
      project: 'p',
      task: 't',
      interactive: false,
      image: 'img',
      timeoutSeconds: 600,
      ttlSecondsAfterFinished: 3600,
      ...(engine ? { engine } : {}),
    },
    status: {
      phase,
      podName,
      podPhase,
      ...(sessionID ? { sessionID } : {}),
      ...(message ? { message } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * RunDetail reads its run name from the route (`useParams`) and returns null
 * when it is absent, so a bare MemoryRouter renders nothing at all. The matching
 * Route is required, not incidental. `entry` carries the optional view param.
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

function prompt(): HTMLTextAreaElement {
  return screen.getByLabelText('Command or message to the agent') as HTMLTextAreaElement;
}

/**
 * Type a line and submit it. The slash menu completes the token on the first
 * Enter and the second Enter executes it; when the menu is closed (a line with
 * arguments) the first Enter already acts and the second is a harmless no-op.
 */
function submitLine(value: string) {
  const el = prompt();
  fireEvent.change(el, { target: { value } });
  fireEvent.keyDown(el, { key: 'Enter' });
  fireEvent.keyDown(el, { key: 'Enter' });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RunDetail terminal shell', () => {
  beforeEach(() => {
    runMock.data = null;
    runMock.error = null;
    runMock.isLoading = false;
    runMock.isFetching = false;
    eventsMock.connected = true;
    apiCalls.delete = [];
  });
  afterEach(cleanup);

  it('defaults to the conversation stage', async () => {
    runMock.data = makeRun();
    await renderRunDetail();

    expect(screen.getByTestId('transcript')).toBeInTheDocument();
    expect(screen.queryByText('LOGS')).toBeNull();
    // The status panel's "Spec" card is not rendered in the default stage.
    expect(screen.queryByText('Spec')).toBeNull();
  });

  it('switches to the status stage when /status is submitted', async () => {
    runMock.data = makeRun();
    await renderRunDetail();
    expect(screen.getByTestId('transcript')).toBeInTheDocument();

    submitLine('/status');

    // "Spec" is a card title unique to the status panel.
    await waitFor(() => expect(screen.getByText('Spec')).toBeInTheDocument());
    expect(screen.queryByTestId('transcript')).toBeNull();
  });

  it('selects the logs stage on first render from a ?view=logs deep link', async () => {
    runMock.data = makeRun();
    await renderRunDetail('/runs/test-run?view=logs');

    expect(screen.getByText('LOGS')).toBeInTheDocument();
    expect(screen.queryByTestId('transcript')).toBeNull();
  });

  it('maps a legacy ?tab=session deep link to the conversation stage', async () => {
    runMock.data = makeRun();
    await renderRunDetail('/runs/test-run?tab=session');

    expect(screen.getByTestId('transcript')).toBeInTheDocument();
    expect(screen.queryByText('LOGS')).toBeNull();
  });

  it('clamps an unavailable ?view=shell to the conversation', async () => {
    // Active run, but the pod is not Running, so the attach is unavailable.
    runMock.data = makeRun({ podPhase: 'Pending' });
    await renderRunDetail('/runs/test-run?view=shell');

    expect(screen.getByTestId('transcript')).toBeInTheDocument();
    expect(screen.queryByTestId('terminal-tab')).toBeNull();
  });

  it('does not attach for the claude engine and explains why', async () => {
    runMock.data = makeRun({ engine: 'claude' });
    await renderRunDetail('/runs/test-run?view=shell');

    expect(screen.queryByTestId('terminal-tab')).toBeNull();
    expect(screen.getByText(/Interactive attach is not available/)).toBeInTheDocument();
  });

  it('hides the shell stage entirely while the pod is not Running', async () => {
    runMock.data = makeRun({ podPhase: 'Pending' });
    await renderRunDetail();

    expect(screen.queryByTestId('terminal-tab')).toBeNull();
    // Still renders the conversation stage, not a blank shell.
    expect(screen.getByTestId('transcript')).toBeInTheDocument();
  });

  it('keeps the Copy action and the two-step Cancel confirm in the header', async () => {
    runMock.data = makeRun();
    await renderRunDetail();

    expect(screen.getByRole('link', { name: 'Copy run' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }));
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'No' })).toBeInTheDocument();

    // Backing out does not delete the run.
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(screen.getByRole('button', { name: 'Cancel run' })).toBeInTheDocument();
    expect(apiCalls.delete).toEqual([]);
  });

  it('shows the failed banner for a failed run', async () => {
    runMock.data = makeRun({ phase: 'Failed', podPhase: 'Failed', message: 'container exited 1' });
    await renderRunDetail();

    expect(screen.getByText('Run failed')).toBeInTheDocument();
    expect(screen.getByText('container exited 1')).toBeInTheDocument();
  });
});
