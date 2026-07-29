// run-detail-terminal.test.tsx — the Terminal section must not render an attach
// widget for the claude engine.
//
// Attach execs `opencode attach` inside the run pod (see server/attach-ws.ts).
// The claude engine's runner is a headless HTTP server with no TUI, so the
// terminal would retry and flicker for the whole run.
//
// Uses @testing-library/react with the happy-dom environment from tests/setup.ts.
// The heavy children (terminal, session view, log viewer) are mocked out — this
// is about which branch RunDetail takes, not about what they render.

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

// ---------------------------------------------------------------------------
// Module mocks
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
// Helpers
// ---------------------------------------------------------------------------

/** A Running run pod, which is the only state that renders the Terminal card. */
function makeRun(engine?: string): Record<string, unknown> {
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
      phase: 'Running',
      podName: 'test-run',
      podPhase: 'Running',
      sessionID: 'abc',
    },
  };
}

/**
 * RunDetail reads its run name from the route (`useParams`) and returns null
 * when it is absent, so a bare MemoryRouter renders nothing at all and every
 * "is it there" assertion passes or fails for the wrong reason. The matching
 * Route is required, not incidental.
 */
async function renderRunDetail() {
  const { MemoryRouter, Route, Routes } = await import('react-router-dom');
  const { default: RunDetail } = await import('../src/client/components/RunDetail');
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    React.createElement(
      MemoryRouter,
      { initialEntries: ['/runs/test-run'] },
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

describe('RunDetail terminal gating by engine', () => {
  beforeEach(() => {
    runMock.data = null;
    runMock.error = null;
    runMock.isLoading = false;
    eventsMock.connected = true;
  });
  afterEach(cleanup);

  it('renders the attach terminal for the default (opencode) engine', async () => {
    runMock.data = makeRun();
    await renderRunDetail();
    expect(screen.queryByTestId('terminal-tab')).not.toBeNull();
  });

  it('renders the attach terminal for an explicit opencode engine', async () => {
    runMock.data = makeRun('opencode');
    await renderRunDetail();
    expect(screen.queryByTestId('terminal-tab')).not.toBeNull();
  });

  it('does not render the attach terminal for the claude engine', async () => {
    runMock.data = makeRun('claude');
    await renderRunDetail();
    expect(screen.queryByTestId('terminal-tab')).toBeNull();
  });

  // A silently missing section reads as a bug; say why it is absent.
  it('explains the absence instead of dropping the section', async () => {
    runMock.data = makeRun('claude');
    await renderRunDetail();
    expect(screen.getByText(/Interactive attach is not available/)).toBeInTheDocument();
  });
});
