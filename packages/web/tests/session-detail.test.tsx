// session-detail.test.tsx — Regression tests for Bug 4 (dead session links).
//
// Sessions list rows come from the stats DB (30d retention), but the detail
// page used to fetch the Run CR, which is deleted after runTTLDays (default 7).
// Any row older than the TTL rendered "Failed to load session". The fix renders
// the detail from the stats-DB row first and treats the live Run CR as
// enrichment: a missing Run CR must NOT blank the page, and the conversation
// falls back to the stored-messages replay.
//
// Uses @testing-library/react with the happy-dom environment from tests/setup.ts.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

// ---------------------------------------------------------------------------
// Mutable mock state — changes propagate through captured object references
// ---------------------------------------------------------------------------

/** Stat row returned by GET /api/stats/sessions/:name. */
let statMock: Record<string, unknown> | null = null;
/** Status+body for GET /api/runs/:name (the Run CR fetch). */
let runStatus: { status: number; body: Record<string, unknown> } = {
  status: 404,
  body: { error: 'Run not found' },
};
/** Response for GET /api/runs/:name/session (the conversation). */
let sessionMock: { status: number; data: Record<string, unknown> | null } = {
  status: 200,
  data: null,
};

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
  default: ({ tokensIn, tokensOut }: { tokensIn?: number; tokensOut?: number }) =>
    React.createElement(
      'span',
      { 'data-testid': 'token-counter' },
      `${tokensIn ?? 0}/${tokensOut ?? 0}`,
    ),
}));

// SessionView's tool rendering lazily loads Shiki WASM; the replay messages in
// these tests are text-only, so stub it like the other SessionView tests do.
mock.module(path.resolve('src/client/hooks/useShiki'), () => ({
  useShiki: () => ({ highlight: async () => '', isLoading: false }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetMocks() {
  statMock = null;
  runStatus = { status: 404, body: { error: 'Run not found' } };
  sessionMock = { status: 200, data: null };
}

let originalFetch: typeof globalThis.fetch;

function mockFetch() {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: RequestInfo | URL): Promise<Response> => {
    const u = typeof url === 'string' ? url : String(url);
    const json = (data: unknown, status: number) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (u.startsWith('/api/stats/sessions/')) {
      return statMock ? json(statMock, 200) : json({ error: 'Session not found' }, 404);
    }
    if (u.startsWith('/api/runs/')) {
      if (u.endsWith('/session')) {
        return sessionMock.data
          ? json(sessionMock.data, sessionMock.status)
          : json({ error: 'Session unavailable' }, 502);
      }
      return json(runStatus.body, runStatus.status);
    }
    return json({ error: 'Not Found' }, 404);
  };
}

/** Wrap SessionDetail in MemoryRouter (route /sessions/:name) + QueryClient. */
async function renderDetail(name: string) {
  const { MemoryRouter, Routes, Route } = await import('react-router-dom');
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const { default: SessionDetail } = await import('../src/client/components/SessionDetail');
  return render(
    React.createElement(
      MemoryRouter,
      { initialEntries: [`/sessions/${encodeURIComponent(name)}`] },
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/sessions/:name',
            element: React.createElement(SessionDetail),
          }),
        ),
      ),
    ),
  );
}

const STAT_ROW = {
  id: 'ses-1',
  name: 'old-run',
  namespace: 'percussionist',
  task: 'task-1',
  model: 'openai/gpt-4o',
  agent: 'builder',
  phase: 'Succeeded',
  startedAt: '2025-01-01T00:00:00Z',
  completedAt: '2025-01-01T00:05:00Z',
  tokensIn: 1000,
  tokensOut: 500,
  cost: 0.02,
  error: null,
  createdAt: '2025-01-01T00:00:00Z',
  resolvedModel: 'openai/gpt-4o',
};

const DB_REPLAY = {
  sessionID: 'ses-1',
  source: 'db',
  messages: [
    {
      info: {
        id: 'ses-1-0',
        sessionID: 'ses-1',
        role: 'user',
        time: { created: 1_700_000_000_000 },
      },
      parts: [{ id: 'p-0', messageID: 'ses-1-0', type: 'text', text: 'restored user message' }],
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionDetail with deleted Run CR (older than run TTL)', () => {
  beforeEach(() => {
    resetMocks();
    mockFetch();
    // The Run CR is gone (deleted after runTTLDays) but the stats-DB row lives on.
    statMock = { ...STAT_ROW };
    runStatus = { status: 404, body: { error: 'runs.percussionist.dev "old-run" not found' } };
    sessionMock = { status: 200, data: { ...DB_REPLAY } };
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  it('renders header and cards from the DB stat instead of "Failed to load session"', async () => {
    await renderDetail('old-run');

    // The header renders the run name from the stat row.
    expect(await screen.findByRole('heading', { name: 'old-run' })).toBeInTheDocument();
    // Phase badge comes from the stat row.
    const badge = await screen.findByTestId('status-badge');
    expect(badge.textContent).toBe('Succeeded');
    // The token counter shows the stat's token counts.
    const counter = await screen.findByTestId('token-counter');
    expect(counter.textContent).toBe('1000/500');

    // The fatal error message must never appear for a deleted run.
    expect(screen.queryByText('Failed to load session')).toBeNull();
  });

  it('shows the archived notice when the Run CR is missing', async () => {
    await renderDetail('old-run');

    await screen.findByRole('heading', { name: 'old-run' });
    const notice = await screen.findByTestId('archived-notice');
    expect(notice).toBeInTheDocument();
    expect(notice.textContent).toContain('run TTL');
  });

  it('loads the conversation from the stored-messages replay', async () => {
    await renderDetail('old-run');

    await screen.findByRole('heading', { name: 'old-run' });
    // The replayed message (source: 'db') renders like any other session message.
    expect(await screen.findByText('restored user message')).toBeInTheDocument();
  });
});

describe('SessionDetail with both Run CR and stat present', () => {
  beforeEach(() => {
    resetMocks();
    mockFetch();
    statMock = { ...STAT_ROW, phase: 'Succeeded' };
    runStatus = {
      status: 200,
      body: {
        metadata: { name: 'old-run', creationTimestamp: '2025-01-01T00:00:00Z' },
        spec: { image: 'img:1', agent: 'builder', model: 'gpt-4o', interactive: false },
        status: {
          phase: 'Succeeded',
          sessionID: 'ses-1',
          podName: 'old-run-abc',
          startedAt: '2025-01-01T00:00:00Z',
          completedAt: '2025-01-01T00:05:00Z',
          tokensIn: 1000,
          tokensOut: 500,
        },
      },
    };
    sessionMock = { status: 200, data: { ...DB_REPLAY } };
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  it('renders pod/spec enrichment from the Run CR and no archived notice', async () => {
    await renderDetail('old-run');

    expect(await screen.findByRole('heading', { name: 'old-run' })).toBeInTheDocument();
    // Spec card from the live Run CR.
    expect(await screen.findByText('img:1')).toBeInTheDocument();
    expect(await screen.findByText('old-run-abc')).toBeInTheDocument();
    // No archived notice — the Run CR is still around.
    expect(screen.queryByTestId('archived-notice')).toBeNull();
    expect(screen.queryByText('Failed to load session')).toBeNull();
  });
});

describe('SessionDetail with neither stat nor Run CR', () => {
  beforeEach(() => {
    resetMocks();
    mockFetch();
    statMock = null;
    runStatus = { status: 404, body: { error: 'not found' } };
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  it('shows "Failed to load session" only when every source is gone', async () => {
    await renderDetail('gone-run');

    expect(await screen.findByText('Failed to load session')).toBeInTheDocument();
  });
});
