// board-header.test.tsx — Responsive behavior tests for BoardHeader.
//
// Uses @testing-library/react with happy-dom DOM environment. Mocks Button
// and Link to avoid Radix Slot/router complexity, then asserts on rendered
// text content for desktop vs mobile modes.

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

// Mock react-router-dom Link as a simple <a> to avoid Router context.
// mock.module is file-scoped so other test files are unaffected.
mock.module('react-router-dom', () => ({
  Link: 'a',
  default: {},
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function renderHeader(overrides: Record<string, unknown> = {}) {
  const { BoardHeader } = await import('../src/client/components/board/BoardHeader');
  return render(
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
    }),
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
});
