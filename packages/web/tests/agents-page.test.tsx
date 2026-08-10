// agents-page.test.tsx — Regression tests for the Agents table scroll wrapper.
//
// BUILD A removed the breakpoint-gated settings-table-scroll class from
// AgentsPage (it only applied inside a (max-width: 768px) media query and only
// set horizontal overflow) in favor of the shared .table-scroll utility, which
// provides both-axis overflow plus a responsive max-height. On medium+ widths
// the old wrapper was left with only overflow-hidden, so long row sets were
// clipped instead of scrollable. These tests pin the wrapper class contract so
// that regression cannot return, and verify the wrapper in both the full-page
// route and the headerless settings embedding.
//
// Uses @testing-library/react with happy-dom DOM environment (configured in
// tests/setup.ts). Mocks useAgents/useAgentsEvents hooks and Button, and wraps
// components in MemoryRouter + QueryClientProvider for router/query context.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

// ---------------------------------------------------------------------------
// Mutable mock state — changes propagate through captured object references
// ---------------------------------------------------------------------------

const agentsMock: {
  data: Array<Record<string, unknown>> | null;
  error: Error | null;
  isLoading: boolean;
  isFetching: boolean;
} = {
  data: null,
  error: null,
  isLoading: false,
  isFetching: false,
};

const eventsMock: { connected: boolean; eventTick: number } = {
  connected: true,
  eventTick: 0,
};

// ---------------------------------------------------------------------------
// Module mocks — intercept imports at the module resolution level
// ---------------------------------------------------------------------------

mock.module(path.resolve('src/client/hooks/useAgents'), () => ({
  useAgents: () => agentsMock,
}));

mock.module(path.resolve('src/client/hooks/useAgentsEvents'), () => ({
  useAgentsEvents: () => eventsMock,
}));

// Mock Button as a native <button> to avoid radix Slot / cva complexity
mock.module(path.resolve('src/client/components/ui/button'), () => ({
  Button: 'button',
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetMocks() {
  agentsMock.data = null;
  agentsMock.error = null;
  agentsMock.isLoading = false;
  agentsMock.isFetching = false;
  eventsMock.connected = true;
  eventsMock.eventTick = 0;
}

const MOCK_AGENT: Record<string, unknown> = {
  name: 'builder',
  content: 'Implements BUILD tasks from approved plans.',
  model: 'gpt-4',
  capabilities: ['task.build.execute', 'run.complete.build'],
};

async function renderWithProviders(element: React.ReactElement) {
  const { MemoryRouter } = await import('react-router-dom');
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(QueryClientProvider, { client: queryClient }, element),
    ),
  );
}

/**
 * Assert the wrapper carries the shared both-axis table-scroll contract and
 * none of the classes that would reintroduce the Agents regression.
 *
 * .table-scroll (see src/client/index.css) sets overflow: auto on both axes
 * plus a responsive max-height so vertical overflow can actually occur. It is
 * defined at the top level of index.css — not inside a @media query — so the
 * behavior is not breakpoint-gated.
 */
function expectScrollableTableWrapper(wrapper: HTMLElement) {
  // Both-axis overflow + bounded max-height come from the shared utility.
  expect(wrapper.className).toContain('table-scroll');
  // No reliance on the removed breakpoint-gated class (the original regression).
  expect(wrapper.className).not.toContain('settings-table-scroll');
  // No Tailwind breakpoint variants on the wrapper: scroll behavior must not
  // be gated to a viewport range.
  expect(wrapper.className).not.toMatch(/(^|\s)(sm|md|lg|xl|2xl):/);
  // Vertical overflow must be scrollable, not clipped — overflow-hidden would
  // hide rows that exceed the wrapper height.
  expect(wrapper.className).not.toContain('overflow-hidden');
  // The inner table keeps its min-width so narrow widths still pan horizontally.
  const table = wrapper.querySelector('table');
  expect(table).not.toBeNull();
  expect(table?.className ?? '').toMatch(/\bmin-w-/);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Agents table scroll wrapper behavior', () => {
  beforeEach(resetMocks);
  afterEach(cleanup);

  it('full-page mode (showHeader=true) renders wrapper with shared table-scroll pattern', async () => {
    agentsMock.data = [MOCK_AGENT];
    const { default: AgentsPage } = await import('../src/client/components/AgentsPage');

    await renderWithProviders(React.createElement(AgentsPage, { showHeader: true }));

    // Header content is present in full-page mode
    expect(screen.getByText('+ New Agent')).toBeTruthy();

    const wrapper = screen.getByTestId('agents-table-wrapper');
    expectScrollableTableWrapper(wrapper);

    // The wrapper contains the agent rows
    expect(wrapper.querySelectorAll('tbody tr').length).toBe(1);
  });

  it('headerless settings embedding (showHeader=false) keeps the same scroll wrapper', async () => {
    agentsMock.data = [MOCK_AGENT];
    const { default: AgentsPage } = await import('../src/client/components/AgentsPage');

    await renderWithProviders(React.createElement(AgentsPage, { showHeader: false }));

    // No header CTA / heading in the settings embedding
    expect(screen.queryByText('+ New Agent')).toBeNull();

    const wrapper = screen.getByTestId('agents-table-wrapper');
    expectScrollableTableWrapper(wrapper);
  });

  it('empty agents list does not render a table wrapper', async () => {
    agentsMock.data = [];
    const { default: AgentsPage } = await import('../src/client/components/AgentsPage');

    const { container } = await renderWithProviders(
      React.createElement(AgentsPage, { showHeader: false }),
    );

    expect(container.querySelector('[data-testid="agents-table-wrapper"]')).toBeNull();
    // Empty state keeps the create path accessible
    expect(screen.getByText('Create one')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// CSS contract — the scroll behavior lives in index.css, so pin it at the
// source level: .table-scroll must enable vertical scrolling (bounded height +
// both-axis overflow) and must not be breakpoint-gated.
// ---------------------------------------------------------------------------

/** True when the character index falls inside an `@media ... { ... }` block. */
function isInsideMediaQuery(css: string, needleIndex: number): boolean {
  const mediaPattern = /@media\b[^{]*\{/g;
  let match = mediaPattern.exec(css);
  while (match !== null) {
    const openBrace = match.index + match[0].length - 1;
    let depth = 1;
    for (let i = openBrace + 1; i < css.length; i++) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          if (needleIndex > match.index && needleIndex < i) return true;
          break;
        }
      }
    }
    match = mediaPattern.exec(css);
  }
  return false;
}

describe('table-scroll CSS utility', () => {
  const css = readFileSync(new URL('../src/client/index.css', import.meta.url), 'utf8');

  it('defines both-axis overflow and a bounded max-height for vertical scrolling', () => {
    const rule = css.match(/\.table-scroll\s*\{([^}]*)\}/)?.[1];
    expect(rule).toBeTruthy();
    // overflow: auto enables horizontal AND vertical scrolling.
    expect(rule).toContain('overflow: auto');
    // A bounded max-height is required so vertical overflow can actually occur.
    expect(rule).toContain('max-height');
    expect(rule).toContain('-webkit-overflow-scrolling: touch');
  });

  it('is not nested inside a @media query (not breakpoint-gated)', () => {
    const ruleIndex = css.indexOf('.table-scroll');
    expect(ruleIndex).toBeGreaterThanOrEqual(0);
    // The old settings-table-scroll class was only defined inside a
    // (max-width: 768px) media query, which is exactly why Agents lost vertical
    // scrolling on medium+ screens. .table-scroll must stay top-level.
    expect(isInsideMediaQuery(css, ruleIndex)).toBe(false);
  });

  it('no longer references the obsolete settings-table-scroll class', () => {
    expect(css).not.toContain('settings-table-scroll');
  });
});
