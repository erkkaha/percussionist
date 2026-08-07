// session-list.test.tsx — Regression tests for sessions table structure and overflow.
//
// Uses @testing-library/react with happy-dom DOM environment (configured in
// tests/setup.ts). Mocks globalThis.fetch to return controlled session data,
// and mocks sub-components (StatusBadge, TokenCounter) to avoid Radix/cva
// complexity. Uses real QueryClient + MemoryRouter for full component context.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

// ---------------------------------------------------------------------------
// Mutable mock state — changes propagate through captured object references
// ---------------------------------------------------------------------------

interface MockSession {
  id: string;
  name: string;
  phase: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  startedAt: string;
  completedAt: string;
  error: string | null;
  agent: string | null;
  task: string | null;
  namespace: string | null;
  createdAt: string;
  resolvedModel: string;
}

const sessionsMock: {
  sessions: MockSession[];
  total: number;
  limit: number;
  offset: number;
} = {
  sessions: [],
  total: 0,
  limit: 50,
  offset: 0,
};

// Store the original fetch so we can restore it
let originalFetch: typeof globalThis.fetch;

// ---------------------------------------------------------------------------
// Module mocks — intercept imports at the module resolution level
// ---------------------------------------------------------------------------

mock.module(path.resolve('src/client/lib/auth'), () => ({
  authHeaders: () => ({}),
}));

mock.module(path.resolve('src/client/components/StatusBadge'), () => ({
  default: ({ phase }: { phase?: string }) =>
    React.createElement('span', { 'data-testid': 'status-badge' }, phase ?? 'unknown'),
}));

mock.module(path.resolve('src/client/components/TokenCounter'), () => ({
  default: ({ tokensIn, tokensOut }: { tokensIn: number; tokensOut: number }) =>
    React.createElement('span', { 'data-testid': 'token-counter' }, `${tokensIn}/${tokensOut}`),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetMocks() {
  sessionsMock.sessions = [];
  sessionsMock.total = 0;
  sessionsMock.limit = 50;
  sessionsMock.offset = 0;
}

const MOCK_SESSION: MockSession = {
  id: 'session-1',
  name: 'test-session',
  phase: 'running',
  model: 'gpt-4',
  tokensIn: 100,
  tokensOut: 50,
  cost: 0.005,
  startedAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
  error: null,
  agent: 'test-agent',
  task: 'test-task',
  namespace: 'default',
  createdAt: new Date().toISOString(),
  resolvedModel: 'gpt-4',
};

/** Wrap component in MemoryRouter + QueryClientProvider for router and query context. */
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionList table structure', () => {
  beforeEach(() => {
    resetMocks();
    // Override fetch to respond to the sessions API endpoint
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (typeof url === 'string' && url.startsWith('/api/stats/sessions')) {
        return new Response(JSON.stringify(sessionsMock), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(url, init);
    };
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  it('table wrapper uses shared table-scroll pattern (both-axis overflow)', async () => {
    sessionsMock.sessions = [{ ...MOCK_SESSION }];
    sessionsMock.total = 1;
    const { default: SessionList } = await import('../src/client/components/SessionList');

    await renderWithProviders(React.createElement(SessionList));

    // Wait for data to load — the table contains a link with the session name
    const link = await screen.findByRole('link', { name: 'test-session' });
    expect(link).toBeInTheDocument();

    // The wrapper (found by data-testid) has the shared table-scroll class,
    // which provides both horizontal and vertical overflow.
    const wrapper = screen.getByTestId('sessions-table-wrapper');
    expect(wrapper.className).toContain('table-scroll');
    // No reliance on the removed breakpoint-gated class or vertical clipping —
    // scroll behavior must not be gated to a viewport range.
    expect(wrapper.className).not.toContain('settings-table-scroll');
    expect(wrapper.className).not.toMatch(/(^|\s)(sm|md|lg|xl|2xl):/);
    expect(wrapper.className).not.toContain('overflow-hidden');

    // Verify the wrapper contains the table, which keeps its min-width so
    // narrow widths still pan horizontally.
    const table = wrapper.querySelector('table');
    expect(table).not.toBeNull();
    expect(table?.className ?? '').toMatch(/\bmin-w-/);
  });

  it('session rows render as direct tr elements under tbody (no a/div as direct tbody child)', async () => {
    sessionsMock.sessions = [
      { ...MOCK_SESSION },
      { ...MOCK_SESSION, id: 'session-2', name: 'test-session-2' },
    ];
    sessionsMock.total = 2;
    const { default: SessionList } = await import('../src/client/components/SessionList');

    const { container } = await renderWithProviders(React.createElement(SessionList));

    // Wait for rows to render
    const rows = await screen.findAllByRole('row');
    // Header row + 2 data rows = 3 rows
    expect(rows.length).toBe(3);

    const tbody = container.querySelector('tbody');
    expect(tbody).not.toBeNull();

    // Every direct child of tbody must be a tr element
    const directChildren = Array.from(tbody?.childNodes);
    expect(directChildren.length).toBe(2);
    for (const child of directChildren) {
      expect(child.nodeName).toBe('TR');
    }

    // No a or div elements as direct tbody children
    expect(tbody?.querySelector(':scope > a')).toBeNull();
    expect(tbody?.querySelector(':scope > div')).toBeNull();
  });

  it('Name cell contains a Link to the expected session detail route', async () => {
    const sessionName = 'my-session';
    sessionsMock.sessions = [{ ...MOCK_SESSION, name: sessionName }];
    sessionsMock.total = 1;
    const { default: SessionList } = await import('../src/client/components/SessionList');

    await renderWithProviders(React.createElement(SessionList));

    // Wait for the link to appear and verify its href
    const link = await screen.findByRole('link', { name: sessionName });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', `/sessions/${encodeURIComponent(sessionName)}`);
  });

  it('uses URL encoding for session names with special characters', async () => {
    const sessionName = 'session with spaces and spéçial chars';
    sessionsMock.sessions = [{ ...MOCK_SESSION, name: sessionName }];
    sessionsMock.total = 1;
    const { default: SessionList } = await import('../src/client/components/SessionList');

    await renderWithProviders(React.createElement(SessionList));

    const link = await screen.findByRole('link', { name: sessionName });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', `/sessions/${encodeURIComponent(sessionName)}`);
  });
});
