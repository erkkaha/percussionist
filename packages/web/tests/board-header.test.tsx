// board-header.test.tsx — Responsive behavior tests for BoardHeader.
//
// Uses @testing-library/react with happy-dom DOM environment. Mocks Button to
// avoid Radix Slot/cva complexity and mounts a real MemoryRouter, then asserts
// on rendered text content for desktop vs mobile modes.

import { afterEach, describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

// ---------------------------------------------------------------------------
// Module mocks — intercept at the module resolution level.
// ---------------------------------------------------------------------------

// Mock Button as a native <button> to avoid radix Slot / cva complexity
mock.module(path.resolve('src/client/components/ui/button'), () => ({
  Button: 'button',
}));

// react-router-dom is deliberately NOT mocked — renderHeader() supplies a real
// MemoryRouter instead.
//
// The previous stub set `Link: 'a'`, and the leak it tried to accommodate is
// real but cannot be papered over by listing more exports: `mock.module` is
// process-global and Bun patches the provided keys onto the real module, so
// every other file in the run also got `Link: 'a'`. That renders an anchor
// carrying `to` and no `href`, and an anchor without href has no implicit
// `link` role — so session-list.test.tsx's findByRole('link') queries could
// never match, failing on CI while passing in isolation.
//
// BoardHeader takes projectName as a prop and needs nothing from the router but
// Link, so a real router is both cheaper and more faithful: the rendered
// anchors now carry real hrefs.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// BoardHeader itself only knows about `codeServerUrl` — it has no concept of
// `settings.codeServer?.enabled`. That flag is collapsed into `codeServerUrl`
// by BoardView before this component ever sees it (BoardView.tsx), so the
// combined-condition coverage ("both enabled and url must be true") lives in
// board-view.test.tsx, which mounts the real BoardView and can actually drive
// that gate. `codeServerEnabled` here only documents, for each case in this
// file, what the URL prop would have been in the real app — it is not a
// substitute for that coverage.
async function renderHeader(
  overrides: Record<string, unknown> = {},
  { codeServerEnabled = false }: { codeServerEnabled?: boolean } = {},
) {
  const { BoardHeader } = await import('../src/client/components/board/BoardHeader');
  const { MemoryRouter } = await import('react-router-dom');
  return render(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(BoardHeader, {
        projectName: 'test-project',
        roster: ['agent-a', 'agent-b'],
        maxParallel: 3,
        phase: 'Active',
        sseConnected: true,
        metrics: undefined,
        findings: [],
        onAddTask: () => {},
        showAddTask: false,
        onToggleFindings: () => {},
        showFindings: false,
        isMobile: false,
        ...overrides,
        codeServerUrl: codeServerEnabled ? overrides.codeServerUrl : undefined,
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BoardHeader desktop mode', () => {
  afterEach(cleanup);

  it('renders breadcrumb navigation (Projects / name / Board)', async () => {
    await renderHeader();
    expect(screen.getByText('Projects')).toBeTruthy();
    // Use getAllByText because "test-project" appears in both breadcrumb link and h1
    const nameEls = screen.getAllByText('test-project');
    expect(nameEls.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Board')).toBeTruthy();
  });

  it('renders large project name as h1', async () => {
    await renderHeader();
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toBeTruthy();
    expect(heading.textContent).toBe('test-project');
  });

  it('renders team roster, parallel, and phase metadata', async () => {
    await renderHeader();
    expect(screen.getByText(/agent-a/)).toBeTruthy();
    expect(screen.getByText(/agent-b/)).toBeTruthy();
    expect(screen.getByText(/Parallel: 3/)).toBeTruthy();
    expect(screen.getByText(/Phase: Active/)).toBeTruthy();
  });

  it('renders live/polling indicator text', async () => {
    await renderHeader();
    expect(screen.getByText(/● live/)).toBeTruthy();
  });

  it('renders Findings and Add Task action buttons', async () => {
    await renderHeader();
    expect(screen.getByText('Findings')).toBeTruthy();
    expect(screen.getByText('+ Add Task')).toBeTruthy();
  });

  it('renders Code link when codeServerUrl is provided', async () => {
    await renderHeader(
      { codeServerUrl: 'http://ide-test.example.com' },
      { codeServerEnabled: true },
    );
    expect(screen.getByText('Code')).toBeTruthy();
  });

  it('does NOT render Code link without codeServerUrl', async () => {
    await renderHeader({ codeServerUrl: undefined }, { codeServerEnabled: false });
    expect(screen.queryByText('Code')).toBeNull();
  });

  it('renders metrics row when metrics are provided', async () => {
    await renderHeader({
      metrics: {
        lastReconcileAt: new Date().toISOString(),
        lastReconcileDurationMs: 1500,
        lastReconcileResult: 'success',
        tasksPulled: 5,
        workersMonitored: 3,
        tasksReworked: 0,
      },
    });
    expect(screen.getByText(/Pulled: 5/)).toBeTruthy();
    expect(screen.getByText(/Monitored: 3/)).toBeTruthy();
    expect(screen.getByText(/Reconciled/)).toBeTruthy();
  });

  it('renders auth warning when authWarning is provided', async () => {
    await renderHeader({ authWarning: 'GitHub token not configured' });
    expect(screen.getByText('⚠ Auth needed')).toBeTruthy();
  });

  it('renders polling indicator when sseConnected is false', async () => {
    await renderHeader({ sseConnected: false });
    expect(screen.getByText('○ polling')).toBeTruthy();
  });
});

describe('BoardHeader mobile compact mode', () => {
  afterEach(cleanup);

  it('does NOT render breadcrumb navigation', async () => {
    await renderHeader({ isMobile: true });
    expect(screen.queryByText('Projects')).toBeNull();
    expect(screen.queryByText('Board')).toBeNull();
  });

  it('does NOT render an h1 heading', async () => {
    await renderHeader({ isMobile: true });
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });

  it('does NOT render team roster, parallel, or phase metadata', async () => {
    await renderHeader({ isMobile: true });
    expect(screen.queryByText(/agent-a/)).toBeNull();
    expect(screen.queryByText(/agent-b/)).toBeNull();
    expect(screen.queryByText(/Parallel:/)).toBeNull();
    expect(screen.queryByText(/Phase:/)).toBeNull();
  });

  it('does NOT render verbose live/polling text ("● live" / "○ polling")', async () => {
    await renderHeader({ isMobile: true, sseConnected: true });
    // The text "● live" should not appear; the compact indicator uses just "●"
    expect(screen.queryByText('● live')).toBeNull();
    expect(screen.queryByText('○ polling')).toBeNull();
  });

  it('renders compact project name', async () => {
    await renderHeader({ isMobile: true });
    // In mobile mode, "test-project" appears exactly once (the compact label)
    expect(screen.getByText('test-project')).toBeTruthy();
  });

  it('renders Findings action button', async () => {
    await renderHeader({ isMobile: true });
    // The Findings label is inside <span class="hidden sm:inline"> — present
    // in the DOM even though visually hidden on very narrow screens
    expect(screen.getByText('Findings')).toBeTruthy();
  });

  it('renders + Add Task action button', async () => {
    await renderHeader({ isMobile: true });
    expect(screen.getByText('+ Add Task')).toBeTruthy();
  });

  it('renders compact SSE indicator dot', async () => {
    await renderHeader({ isMobile: true });
    // The compact indicator renders "●" as a single-character dot
    expect(screen.getByText('●')).toBeTruthy();
  });

  it('shows Findings count when findings are present', async () => {
    await renderHeader({
      isMobile: true,
      findings: [{ id: 'f1', title: 'Bug one', severity: 'high', category: 'bug' }],
    });
    // The count label is inside a span — present in the DOM
    expect(screen.getByText(/(1)/)).toBeTruthy();
  });

  it('shows Cancel when add task is active', async () => {
    await renderHeader({ isMobile: true, showAddTask: true });
    expect(screen.getByText('Cancel')).toBeTruthy();
    expect(screen.queryByText('+ Add Task')).toBeNull();
  });

  it('does NOT render metrics row when metrics are provided', async () => {
    await renderHeader({
      isMobile: true,
      metrics: {
        lastReconcileAt: new Date().toISOString(),
        lastReconcileDurationMs: 1500,
        lastReconcileResult: 'success',
        tasksPulled: 5,
        workersMonitored: 3,
        tasksReworked: 0,
      },
    });
    expect(screen.queryByText(/Pulled:/)).toBeNull();
    expect(screen.queryByText(/Monitored:/)).toBeNull();
    expect(screen.queryByText(/Reconciled/)).toBeNull();
  });

  it('does NOT render auth warning', async () => {
    await renderHeader({ isMobile: true, authWarning: 'GitHub token not configured' });
    expect(screen.queryByText('⚠ Auth needed')).toBeNull();
  });

  it('renders Code icon-only link when codeServerUrl is provided', async () => {
    await renderHeader(
      { isMobile: true, codeServerUrl: 'http://ide-test.example.com' },
      { codeServerEnabled: true },
    );
    const link = screen.getByTitle('Open code-server workspace');
    expect(link).toBeTruthy();
    expect(link.tagName).toBe('A');
  });

  it('does NOT render Code link when codeServerUrl is undefined', async () => {
    await renderHeader({ isMobile: true, codeServerUrl: undefined }, { codeServerEnabled: false });
    expect(screen.queryByTitle('Open code-server workspace')).toBeNull();
  });

  it('renders Plus icon in Add Task button on mobile', async () => {
    await renderHeader({ isMobile: true, showAddTask: false });
    const btn = screen.getByText('+ Add Task').closest('button');
    expect(btn?.querySelector('svg')).toBeTruthy();
  });

  it('renders X icon in Cancel button on mobile', async () => {
    await renderHeader({ isMobile: true, showAddTask: true });
    const btn = screen.getByText('Cancel').closest('button');
    expect(btn?.querySelector('svg')).toBeTruthy();
  });
});
