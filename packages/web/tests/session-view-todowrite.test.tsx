// session-view-todowrite.test.tsx — the Session card must survive malformed
// `todowrite` tool parts.
//
// Session payloads are proxied straight from the runner without validation, so
// `part.state` or `part.state.input` can be missing on a `todowrite` part.
// SessionView used to read `part.state.input.todos` unguarded, so one such
// part threw a TypeError and blanked the whole run/session page. The fix
// optional-chains down to `todos` and adds a render ErrorBoundary around the
// whole SessionView so a single bad part can never unmount the page.
//
// Uses @testing-library/react with the happy-dom environment from tests/setup.ts.

import { afterEach, describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

// ---------------------------------------------------------------------------
// Mutable mock state
// ---------------------------------------------------------------------------

const sessionMock: {
  data: Record<string, unknown> | null;
  error: Error | null;
  isLoading: boolean;
  isFetching: boolean;
} = { data: null, error: null, isLoading: false, isFetching: false };

mock.module(path.resolve('src/client/hooks/useSession'), () => ({
  useSession: () => sessionMock,
}));

// Shiki lazily loads a WASM grammar; the todowrite paths never highlight anything.
mock.module(path.resolve('src/client/hooks/useShiki'), () => ({
  useShiki: () => ({ highlight: async () => '', isLoading: false }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(parts: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    info: {
      id: 'msg-1',
      sessionID: 'ses-1',
      role: 'assistant',
      time: { created: 1_700_000_000_000 },
    },
    parts,
  };
}

function makeTodoWrite(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'part-1',
    messageID: 'msg-1',
    type: 'tool',
    tool: 'todowrite',
    callID: 'call-1',
    ...overrides,
  };
}

async function renderSessionView() {
  const { default: SessionView } = await import('../src/client/components/SessionView');
  return render(
    React.createElement(SessionView, {
      name: 'test-run',
      hasSession: true,
      active: false,
      sseConnected: false,
      eventTick: 0,
    }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionView todowrite parts', () => {
  afterEach(cleanup);

  it('renders a well-formed todowrite part as a task list', async () => {
    sessionMock.data = {
      sessionID: 'ses-1',
      source: 'live',
      messages: [
        makeMessage([
          makeTodoWrite({
            state: {
              status: 'completed',
              input: {
                todos: [
                  { content: 'first todo', status: 'in_progress', priority: 'high' },
                  { content: 'second todo', status: 'pending', priority: 'low' },
                ],
              },
            },
          }),
        ]),
      ],
    };
    await renderSessionView();
    expect(screen.getByText('Tasks')).toBeInTheDocument();
    expect(screen.getByText('0 of 2 completed')).toBeInTheDocument();
    // in_progress/pending sections are expanded by default, so both render.
    expect(screen.getByText('first todo')).toBeInTheDocument();
    expect(screen.getByText('second todo')).toBeInTheDocument();
  });

  it('does not throw when state.input is missing on a todowrite part', async () => {
    sessionMock.data = {
      sessionID: 'ses-1',
      source: 'live',
      messages: [
        makeMessage([
          makeTodoWrite({
            state: { status: 'completed' },
          }),
        ]),
      ],
    };
    await renderSessionView();
    // The message bubble still renders — no TypeError, no boundary fallback.
    expect(screen.getByText('assistant')).toBeInTheDocument();
    expect(screen.queryByText('Tasks')).toBeNull();
  });

  it('does not throw when state itself is missing on a todowrite part', async () => {
    sessionMock.data = {
      sessionID: 'ses-1',
      source: 'live',
      messages: [makeMessage([makeTodoWrite({})])],
    };
    await renderSessionView();
    expect(screen.getByText('assistant')).toBeInTheDocument();
    expect(screen.queryByText('Tasks')).toBeNull();
  });

  it('skips a todowrite part with an empty todos array', async () => {
    sessionMock.data = {
      sessionID: 'ses-1',
      source: 'live',
      messages: [
        makeMessage([
          makeTodoWrite({
            state: { status: 'completed', input: { todos: [] } },
          }),
        ]),
      ],
    };
    await renderSessionView();
    // Empty array passes Array.isArray but not `length > 0`, so no TaskList
    // renders — the bubble still shows its header.
    expect(screen.getByText('assistant')).toBeInTheDocument();
    expect(screen.queryByText('Tasks')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ErrorBoundary — the shared boundary that keeps one bad part from blanking
// the page. SessionView wraps itself in it, so a render error anywhere in the
// view shows the fallback instead of unmounting the run/session page.
// ---------------------------------------------------------------------------

describe('ErrorBoundary', () => {
  afterEach(cleanup);

  it('renders the fallback when a child throws', async () => {
    const { default: ErrorBoundary } = await import('../src/client/components/ErrorBoundary');
    function Thrower() {
      throw new Error('boom');
    }
    render(
      React.createElement(
        ErrorBoundary,
        { fallback: React.createElement('div', null, 'fallback shown') },
        React.createElement(Thrower),
      ),
    );
    expect(screen.getByText('fallback shown')).toBeInTheDocument();
  });

  it('renders children untouched when nothing throws', async () => {
    const { default: ErrorBoundary } = await import('../src/client/components/ErrorBoundary');
    render(
      React.createElement(
        ErrorBoundary,
        { fallback: React.createElement('div', null, 'fallback shown') },
        React.createElement('div', null, 'healthy content'),
      ),
    );
    expect(screen.getByText('healthy content')).toBeInTheDocument();
    expect(screen.queryByText('fallback shown')).toBeNull();
  });
});
