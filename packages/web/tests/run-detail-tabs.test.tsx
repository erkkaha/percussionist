// run-detail-tabs.test.tsx — RunDetail is a full-height tabbed shell
// (Overview / Session / Logs / Terminal). This covers which panel is active:
//   (a) the default tab (Session for an active run with a session, else Overview),
//   (b) switching to Logs renders LogViewer and unmounts Session,
//   (c) the Terminal tab is absent for non-running / terminal-phase runs,
//   (d) a ?tab=logs deep link selects Logs on first render,
//   (e) an unavailable ?tab=terminal clamps to the fallback without crashing.
//
// Tab state is keyed off the ?tab= search param and the heavy children
// (terminal, session view, log viewer) are mocked out — this is about which
// panel renders, not about what they render.
//
// The web suite runs with `bun test --isolate`, so the module mocks below are
// contained to this file (AGENTS.md) — keep the mock.module calls above the SUT
// import. RunDetail is dynamic-imported inside renderRunDetail; useRun keeps the
// same fixed-object shape as run-detail-terminal.test.tsx.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

// ---------------------------------------------------------------------------
// Module mocks — registered before the SUT import below (--isolate contains them)
// ---------------------------------------------------------------------------

mock.module(path.resolve('src/client/hooks/useRun'), () => ({
  useRun: () => runMock,
}));

mock.module(path.resolve('src/client/hooks/useRunEvents'), () => ({
  useRunEvents: () => eventsMock,
}));

// Stand-ins that are trivially identifiable in the rendered output.
mock.module(path.resolve('src/client/components/TerminalTab'), () => ({
  default: () => React.createElement('div', { 'data-testid': 'terminal-tab' }, 'TERMINAL'),
}));

mock.module(path.resolve('src/client/components/SessionView'), () => ({
  default: () => React.createElement('div', null, 'SESSION'),
}));

mock.module(path.resolve('src/client/components/LogViewer'), () => ({
  default: () => React.createElement('div', null, 'LOGS'),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A run fixture. Defaults to an active opencode run whose pod is Running with a
 * session, i.e. the state that offers all four tabs and defaults to Session.
 */
function makeRun(
  overrides: {
    engine?: string;
    phase?: string;
    podName?: string;
    podPhase?: string;
    sessionID?: string | null;
  } = {},
): Record<string, unknown> {
  const {
    engine,
    phase = 'Running',
    podName = 'test-run',
    podPhase = 'Running',
    sessionID = 'sess-1',
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
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * RunDetail reads its run name from the route (`useParams`) and returns null
 * when it is absent, so a bare MemoryRouter renders nothing at all. The matching
 * Route is required, not incidental. `entry` carries the optional ?tab= param.
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

function tab(name: 'Overview' | 'Session' | 'Logs' | 'Terminal') {
  return screen.getByRole('tab', { name });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RunDetail tab shell', () => {
  beforeEach(() => {
    runMock.data = null;
    runMock.error = null;
    runMock.isLoading = false;
    runMock.isFetching = false;
    eventsMock.connected = true;
  });
  afterEach(cleanup);

  it('defaults to Session for an active run that has a session', async () => {
    runMock.data = makeRun();
    await renderRunDetail();

    expect(screen.getByText('SESSION')).toBeInTheDocument();
    expect(screen.queryByText('LOGS')).toBeNull();
    expect(tab('Session')).toHaveAttribute('aria-selected', 'true');
  });

  it('defaults to Overview when the run has no session', async () => {
    runMock.data = makeRun({ sessionID: null });
    await renderRunDetail();

    // "Spec" is a card title unique to the Overview panel.
    expect(screen.getByText('Spec')).toBeInTheDocument();
    expect(screen.queryByText('SESSION')).toBeNull();
    expect(tab('Overview')).toHaveAttribute('aria-selected', 'true');
  });

  it('swaps to Logs and unmounts Session when the Logs tab is selected', async () => {
    runMock.data = makeRun();
    await renderRunDetail();
    expect(screen.getByText('SESSION')).toBeInTheDocument();

    fireEvent.click(tab('Logs'));

    expect(screen.getByText('LOGS')).toBeInTheDocument();
    expect(screen.queryByText('SESSION')).toBeNull();
    expect(tab('Logs')).toHaveAttribute('aria-selected', 'true');
  });

  it('hides the Terminal tab for a terminal-phase run', async () => {
    runMock.data = makeRun({ phase: 'Succeeded', podPhase: 'Succeeded' });
    await renderRunDetail();

    expect(screen.queryByRole('tab', { name: 'Terminal' })).toBeNull();
    // The remaining tabs still render and the shell does not crash.
    expect(screen.getByText('Spec')).toBeInTheDocument();
  });

  it('hides the Terminal tab while the pod is not Running', async () => {
    runMock.data = makeRun({ podPhase: 'Pending' });
    await renderRunDetail();

    expect(screen.queryByRole('tab', { name: 'Terminal' })).toBeNull();
  });

  it('selects Logs on first render from a ?tab=logs deep link', async () => {
    runMock.data = makeRun();
    await renderRunDetail('/runs/test-run?tab=logs');

    expect(screen.getByText('LOGS')).toBeInTheDocument();
    expect(screen.queryByText('SESSION')).toBeNull();
    expect(tab('Logs')).toHaveAttribute('aria-selected', 'true');
  });

  it('clamps an unavailable ?tab=terminal to the fallback without crashing', async () => {
    // Active run, but the pod is not Running, so Terminal is not offered.
    runMock.data = makeRun({ podPhase: 'Pending' });
    await renderRunDetail('/runs/test-run?tab=terminal');

    expect(screen.queryByRole('tab', { name: 'Terminal' })).toBeNull();
    // Falls back to the default tab (Session: active run with a session).
    expect(screen.getByText('SESSION')).toBeInTheDocument();
    expect(tab('Session')).toHaveAttribute('aria-selected', 'true');
  });
});
