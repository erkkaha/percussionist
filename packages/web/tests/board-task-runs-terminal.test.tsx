// board-task-runs-terminal.test.tsx — the TaskRunsPanel sub-tab bar must expose
// a Terminal tab only for active opencode-engine runs whose pod is Running.
//
// Covers the gating logic from the SelectedRunTabs extraction (BUILD 1): the
// Terminal button appears only when the full run CR (fetched via useRun) reports
// a non-terminal phase, a podName, and podPhase === 'Running'. A claude-engine
// run shows the explanation instead of an attach widget. Selecting a run defaults
// to Session; switching runs while the Terminal tab is open resets to Session; a
// run that completes while the Terminal tab is open falls back to Session.
//
// Uses @testing-library/react with the happy-dom environment from tests/setup.ts.
// The heavy children (terminal, session view, log viewer) are mocked out — this
// is about which sub-tab renders, not about what they render.
//
// The web suite runs with `bun test --isolate`, so the module mocks below are
// contained to this file (AGENTS.md) — keep the mock.module calls above the SUT
// import. useRun is mocked name-resolving because both the SelectedRunTabs gate
// and the sub-panels fetch the selected run via useRun; a single fixed-object
// mock (as in run-detail-terminal.test.tsx) cannot serve both consumers.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

// ---------------------------------------------------------------------------
// Fixtures — full Run shape (spec.engine, status.podName, status.podPhase).
// ---------------------------------------------------------------------------

interface RunFixture {
  apiVersion: string;
  kind: string;
  metadata: { name: string; creationTimestamp: string };
  spec: { project: string; task: string; interactive: boolean; engine?: 'opencode' | 'claude' };
  status: {
    phase: string;
    podName?: string;
    podPhase?: string;
    sessionID?: string;
    startedAt?: string;
  };
}

function makeRun(
  name: string,
  overrides: {
    engine?: 'opencode' | 'claude';
    phase: string;
    podName?: string;
    podPhase?: string;
  },
): RunFixture {
  const { engine, phase, podName, podPhase } = overrides;
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Run',
    metadata: { name, creationTimestamp: '2026-01-01T00:00:00Z' },
    spec: {
      project: 'p',
      task: 't',
      interactive: false,
      ...(engine ? { engine } : {}),
    },
    status: {
      phase,
      ...(podName ? { podName } : {}),
      ...(podPhase ? { podPhase } : {}),
      sessionID: `sess-${name}`,
      startedAt: '2026-01-01T00:00:00Z',
    },
  };
}

// One shared fixture map: useTaskRuns returns the list, useRun resolves a single
// entry by name from the same objects, so the SelectedRunTabs gate and the
// sub-panels always see identical status.
const RUNS: RunFixture[] = [
  // Active opencode run with the engine field unset (defaults to opencode).
  makeRun('run-opencode-default', {
    phase: 'Running',
    podName: 'run-opencode-default',
    podPhase: 'Running',
  }),
  // Active opencode run with the engine pinned explicitly.
  makeRun('run-opencode-explicit', {
    engine: 'opencode',
    phase: 'Running',
    podName: 'run-opencode-explicit',
    podPhase: 'Running',
  }),
  // Active claude run: the Terminal tab shows the explanation, never an attach widget.
  makeRun('run-claude', {
    engine: 'claude',
    phase: 'Running',
    podName: 'run-claude',
    podPhase: 'Running',
  }),
  // Terminal-phase run: no Terminal tab at all.
  makeRun('run-succeeded', {
    engine: 'opencode',
    phase: 'Succeeded',
    podName: 'run-succeeded',
    podPhase: 'Succeeded',
  }),
  // Active run whose pod is not Running yet.
  makeRun('run-pod-pending', {
    engine: 'opencode',
    phase: 'Running',
    podName: 'run-pod-pending',
    podPhase: 'Pending',
  }),
  // Active run with no podPhase reported at all.
  makeRun('run-pod-unknown', {
    engine: 'opencode',
    phase: 'Running',
    podName: 'run-pod-unknown',
  }),
];

// ---------------------------------------------------------------------------
// Module mocks — registered before the SUT import below (--isolate contains them).
// ---------------------------------------------------------------------------

mock.module(path.resolve('src/client/hooks/useTaskRuns'), () => ({
  useTaskRuns: () => ({ data: RUNS, isLoading: false, error: null }),
}));

mock.module(path.resolve('src/client/hooks/useRun'), () => ({
  useRun: (name: string) => ({
    data: RUNS.find((r) => r.metadata.name === name) ?? null,
    error: null,
    isLoading: false,
    isFetching: false,
  }),
}));

mock.module(path.resolve('src/client/hooks/useRunEvents'), () => ({
  useRunEvents: () => ({ connected: true, eventTick: 0 }),
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

/** The run row button for `name` in the run list. */
function runRow(name: string) {
  return screen.getByRole('button', { name: new RegExp(name) });
}

async function renderTaskRunsPanel() {
  const { default: TaskRunsPanel } = await import('../src/client/components/board/TaskRunsPanel');
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(TaskRunsPanel, { projectName: 'test-project', taskName: 'test-task' }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskRunsPanel terminal gating', () => {
  beforeEach(() => {
    // The completion-fallback test mutates run-opencode-default; restore it so
    // the file is order-independent.
    const run = RUNS.find((r) => r.metadata.name === 'run-opencode-default');
    if (run) {
      run.status.phase = 'Running';
      run.status.podPhase = 'Running';
    }
  });
  afterEach(cleanup);

  it('shows the Terminal tab for an active opencode run with engine unset', async () => {
    await renderTaskRunsPanel();
    fireEvent.click(runRow('run-opencode-default'));
    const terminal = screen.getByRole('button', { name: 'Terminal' });
    expect(terminal).toBeTruthy();
    fireEvent.click(terminal);
    expect(screen.getByTestId('terminal-tab')).toBeTruthy();
  });

  it('shows the Terminal tab for an active opencode run with engine pinned', async () => {
    await renderTaskRunsPanel();
    fireEvent.click(runRow('run-opencode-explicit'));
    const terminal = screen.getByRole('button', { name: 'Terminal' });
    expect(terminal).toBeTruthy();
    fireEvent.click(terminal);
    expect(screen.getByTestId('terminal-tab')).toBeTruthy();
  });

  it('shows the Terminal tab but explains the absence for the claude engine', async () => {
    await renderTaskRunsPanel();
    fireEvent.click(runRow('run-claude'));
    const terminal = screen.getByRole('button', { name: 'Terminal' });
    expect(terminal).toBeTruthy();
    fireEvent.click(terminal);
    expect(screen.getByText(/Interactive attach is not available for the/)).toBeTruthy();
    expect(screen.queryByTestId('terminal-tab')).toBeNull();
  });

  it('shows no Terminal tab for a terminal-phase run', async () => {
    await renderTaskRunsPanel();
    fireEvent.click(runRow('run-succeeded'));
    expect(screen.queryByRole('button', { name: 'Terminal' })).toBeNull();
    // The Session sub-tab still renders.
    expect(screen.getByText('SESSION')).toBeTruthy();
  });

  it('shows no Terminal tab while the pod is not Running', async () => {
    await renderTaskRunsPanel();
    fireEvent.click(runRow('run-pod-pending'));
    expect(screen.queryByRole('button', { name: 'Terminal' })).toBeNull();
  });

  it('shows no Terminal tab when podPhase is absent', async () => {
    await renderTaskRunsPanel();
    fireEvent.click(runRow('run-pod-unknown'));
    expect(screen.queryByRole('button', { name: 'Terminal' })).toBeNull();
  });

  it('defaults to Session on selection and resets to Session when switching runs', async () => {
    await renderTaskRunsPanel();
    // Selection defaults to the Session sub-tab.
    fireEvent.click(runRow('run-opencode-default'));
    expect(screen.getByText('SESSION')).toBeTruthy();
    expect(screen.queryByTestId('terminal-tab')).toBeNull();
    // Open the Terminal tab…
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
    expect(screen.getByTestId('terminal-tab')).toBeTruthy();
    // …then select a different run: the sub-tab resets to Session.
    fireEvent.click(runRow('run-claude'));
    expect(screen.getByText('SESSION')).toBeTruthy();
    expect(screen.queryByTestId('terminal-tab')).toBeNull();
  });

  it('falls back to Session when the selected run completes while the Terminal tab is open', async () => {
    const view = await renderTaskRunsPanel();
    fireEvent.click(runRow('run-opencode-default'));
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
    expect(screen.getByTestId('terminal-tab')).toBeTruthy();

    // The run transitions to a terminal phase; mutate the shared fixture and
    // re-render. The Terminal button disappears and the panel falls back to the
    // Session sub-tab via the SelectedRunTabs reset effect.
    const run = RUNS.find((r) => r.metadata.name === 'run-opencode-default');
    if (run) {
      run.status.phase = 'Succeeded';
      run.status.podPhase = 'Succeeded';
    }

    const { default: TaskRunsPanel } = await import('../src/client/components/board/TaskRunsPanel');
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    view.rerender(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(TaskRunsPanel, { projectName: 'test-project', taskName: 'test-task' }),
      ),
    );

    expect(screen.queryByRole('button', { name: 'Terminal' })).toBeNull();
    expect(await screen.findByText('SESSION')).toBeTruthy();
    expect(screen.queryByTestId('terminal-tab')).toBeNull();
  });
});
