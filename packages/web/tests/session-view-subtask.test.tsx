// session-view-subtask.test.tsx — the Session card must survive both engines'
// `subtask` parts.
//
// The two runners synthesise `subtask` differently: opencode carries a todo
// checklist, the claude runner carries `description`/`agentType` for a spawned
// subagent (runner-claude/src/translate.ts). SessionView used to hand
// `part.todos` straight to TaskList, so a claude-engine Task/Agent call threw
// "Cannot read properties of undefined (reading 'filter')" and blanked the whole
// run detail page.
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

// Shiki lazily loads a WASM grammar; the subtask paths never highlight anything.
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

describe('SessionView subtask parts', () => {
  afterEach(cleanup);

  it('renders a claude-engine subtask (no todos) as a subagent row', async () => {
    sessionMock.data = {
      sessionID: 'ses-1',
      source: 'live',
      messages: [
        makeMessage([
          {
            id: 'part-1',
            messageID: 'msg-1',
            type: 'subtask',
            description: 'Audit the auth routes',
            agentType: 'Explore',
          },
        ]),
      ],
    };
    await renderSessionView();
    expect(screen.getByText('Explore')).toBeInTheDocument();
    expect(screen.getByText('Audit the auth routes')).toBeInTheDocument();
  });

  it('does not fall through to the "(no content)" placeholder', async () => {
    sessionMock.data = {
      sessionID: 'ses-1',
      source: 'live',
      messages: [
        makeMessage([
          { id: 'part-1', messageID: 'msg-1', type: 'subtask', agentType: 'general-purpose' },
        ]),
      ],
    };
    await renderSessionView();
    expect(screen.queryByText('(no content)')).toBeNull();
    expect(screen.getByText('general-purpose')).toBeInTheDocument();
  });

  it('labels a subtask with neither description nor agentType', async () => {
    sessionMock.data = {
      sessionID: 'ses-1',
      source: 'live',
      messages: [makeMessage([{ id: 'part-1', messageID: 'msg-1', type: 'subtask' }])],
    };
    await renderSessionView();
    expect(screen.getByText('subagent')).toBeInTheDocument();
  });

  it('still renders an opencode-engine subtask as a todo checklist', async () => {
    sessionMock.data = {
      sessionID: 'ses-1',
      source: 'live',
      messages: [
        makeMessage([
          {
            id: 'part-1',
            messageID: 'msg-1',
            type: 'subtask',
            todos: [
              { content: 'first todo', status: 'in_progress', priority: 'high' },
              { content: 'second todo', status: 'completed', priority: 'low' },
            ],
          },
        ]),
      ],
    };
    await renderSessionView();
    expect(screen.getByText('Tasks')).toBeInTheDocument();
    expect(screen.getByText('1 of 2 completed')).toBeInTheDocument();
    expect(screen.getByText('first todo')).toBeInTheDocument();
  });

  it('treats a message with no parts array as empty instead of throwing', async () => {
    sessionMock.data = {
      sessionID: 'ses-1',
      source: 'live',
      messages: [
        {
          info: {
            id: 'msg-1',
            sessionID: 'ses-1',
            role: 'assistant',
            time: { created: 1_700_000_000_000 },
          },
        },
      ],
    };
    await renderSessionView();
    expect(screen.getByText('(no content)')).toBeInTheDocument();
  });
});
