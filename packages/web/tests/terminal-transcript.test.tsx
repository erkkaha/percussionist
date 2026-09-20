// terminal-transcript.test.tsx — the conversation view of the run terminal.
//
// The transcript renders session text inline but every structured part behind a
// one-line `<details>` accordion, and wraps the whole view in the shared
// ErrorBoundary so a malformed proxied part cannot blank the run page.
//
// Fixtures cover: inline user text + assistant markdown, a tool call that
// collapses to a summary and expands to its output, a file diff summary, an
// unknown part type (never dropped), and a malformed part (contained by the
// boundary). The snapshot banner is asserted for `source === 'snapshot'`.
//
// Runs under `bun test --isolate`; mock.module stays in this file (AGENTS.md).

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

// Shiki lazily loads a WASM grammar; the transcript tests never highlight.
mock.module(path.resolve('src/client/hooks/useShiki'), () => ({
  useShiki: () => ({ highlight: async () => '', isLoading: false }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeInfo(
  id: string,
  role: 'user' | 'assistant',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    sessionID: 'ses-1',
    role,
    time: { created: 1_700_000_000_000 },
    ...overrides,
  };
}

function makeMessage(
  info: Record<string, unknown>,
  parts: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return { info, parts };
}

function setMessages(messages: Array<Record<string, unknown>>, source = 'live'): void {
  sessionMock.data = { sessionID: 'ses-1', source, messages };
  sessionMock.error = null;
  sessionMock.isLoading = false;
  sessionMock.isFetching = false;
}

const BASH_TOOL_PART: Record<string, unknown> = {
  id: 'part-tool',
  messageID: 'msg-assistant',
  type: 'tool',
  callID: 'call-1',
  tool: 'bash',
  state: {
    status: 'completed',
    input: { command: 'echo hi' },
    output: 'line one\nline two',
    time: { start: 1_000, end: 2_200 },
  },
};

const SAMPLE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,2 +1,3 @@
-const x = 1;
+const x = 2;
+const y = 3;
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function renderTranscript(props: Record<string, unknown> = {}) {
  const { default: TerminalTranscript } = await import(
    '../src/client/components/run-terminal/TerminalTranscript'
  );
  return render(
    React.createElement(TerminalTranscript, {
      name: 'test-run',
      hasSession: true,
      active: false,
      sseConnected: false,
      eventTick: 0,
      localEntries: [],
      ...props,
    } as never),
  );
}

beforeEach(() => {
  sessionMock.data = null;
  sessionMock.error = null;
  sessionMock.isLoading = false;
  sessionMock.isFetching = false;
});

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TerminalTranscript rendering', () => {
  it('renders user text inline with a prompt prefix and assistant markdown', async () => {
    setMessages([
      makeMessage(makeInfo('msg-user', 'user'), [
        { id: 'part-user', messageID: 'msg-user', type: 'text', text: 'hello agent' },
      ]),
      makeMessage(
        makeInfo('msg-assistant', 'assistant', {
          providerID: 'anthropic',
          modelID: 'claude-sonnet-4',
          tokens: { input: 123, output: 45, reasoning: 0 },
          cost: 0.0012,
        }),
        [
          {
            id: 'part-md',
            messageID: 'msg-assistant',
            type: 'text',
            text: '## Heading\n\n**bold** statement',
          },
        ],
      ),
    ]);

    await renderTranscript();

    // User prompt prefix and text.
    expect(screen.getByText(/user ▸/)).toBeInTheDocument();
    expect(screen.getByText(/hello agent/)).toBeInTheDocument();

    // Assistant header carries provider/model, tokens and cost.
    expect(
      screen.getByText('assistant ▸ anthropic/claude-sonnet-4 · 123 in / 45 out · $0.0012'),
    ).toBeInTheDocument();

    // Markdown is rendered through the shared MessageText renderer.
    expect(screen.getByRole('heading', { name: 'Heading' })).toBeInTheDocument();
    expect(screen.getByText('bold')).toBeInTheDocument();
  });

  it('renders a tool call as a collapsed summary that expands to its output', async () => {
    setMessages([makeMessage(makeInfo('msg-assistant', 'assistant'), [BASH_TOOL_PART])]);

    await renderTranscript();

    const summary = screen.getByText('bash — completed · 1.2s');
    const outer = summary.closest('details') as HTMLDetailsElement;
    expect(outer).not.toBeNull();
    expect(outer.open).toBe(false);

    // Expanding the terminal summary reveals the full ToolCall view.
    fireEvent.click(summary);
    expect(outer.open).toBe(true);

    const toolSummary = screen.getByText('bash');
    const toolDetails = toolSummary.closest('details') as HTMLDetailsElement;
    expect(toolDetails.open).toBe(false);

    fireEvent.click(toolSummary);
    expect(toolDetails.open).toBe(true);
    expect(screen.getByText(/line one/)).toBeInTheDocument();
  });

  it('keeps the 50-line truncation and show-more control on long tool output', async () => {
    const longOutput = Array.from({ length: 60 }, (_, i) => `output line ${i + 1}`).join('\n');
    setMessages([
      makeMessage(makeInfo('msg-assistant', 'assistant'), [
        {
          ...BASH_TOOL_PART,
          state: { status: 'completed', input: {}, output: longOutput },
        },
      ]),
    ]);

    await renderTranscript();

    fireEvent.click(screen.getByText('bash — completed'));
    fireEvent.click(screen.getByText('bash'));
    // 60 lines → 10 hidden behind the show-more control.
    expect(screen.getByText('Show 10 more lines')).toBeInTheDocument();
  });

  it('renders a file diff as a one-line summary with added/removed counts', async () => {
    setMessages([
      makeMessage(makeInfo('msg-assistant', 'assistant'), [
        {
          id: 'part-file',
          messageID: 'msg-assistant',
          type: 'file',
          filename: 'foo.ts',
          path: 'src/foo.ts',
          diff: SAMPLE_DIFF,
        },
      ]),
    ]);

    await renderTranscript();

    expect(screen.getByText('diff src/foo.ts (+2 −1)')).toBeInTheDocument();
  });

  it('never drops an unknown part type', async () => {
    setMessages([
      makeMessage(makeInfo('msg-assistant', 'assistant'), [
        { id: 'part-mystery', messageID: 'msg-assistant', type: 'mystery', value: 42 },
      ]),
    ]);

    await renderTranscript();

    expect(screen.getByText('[mystery]')).toBeInTheDocument();
  });

  it('renders the local output tail after messages', async () => {
    setMessages([
      makeMessage(makeInfo('msg-user', 'user'), [
        { id: 'part-user', messageID: 'msg-user', type: 'text', text: 'hello' },
      ]),
    ]);

    await renderTranscript({
      localEntries: [
        { id: 'e1', kind: 'command', text: '/help', at: 1 },
        { id: 'e2', kind: 'output', text: 'available commands: logs', at: 2 },
        { id: 'e3', kind: 'error', text: 'unknown command: /nope', at: 3 },
      ],
    });

    const tail = screen.getByTestId('local-output');
    expect(tail).toBeInTheDocument();
    expect(screen.getByText('/help')).toBeInTheDocument();
    expect(screen.getByText('available commands: logs')).toBeInTheDocument();
    expect(screen.getByText('unknown command: /nope')).toBeInTheDocument();
  });

  it('shows the snapshot banner when the session source is a snapshot', async () => {
    setMessages(
      [
        makeMessage(makeInfo('msg-user', 'user'), [
          { id: 'part-user', messageID: 'msg-user', type: 'text', text: 'from snapshot' },
        ]),
      ],
      'snapshot',
    );

    await renderTranscript();

    expect(screen.getByText(/Loaded from snapshot/)).toBeInTheDocument();
    expect(screen.getByText('from snapshot')).toBeInTheDocument();
  });

  it('contains a malformed part with the shared ErrorBoundary fallback', async () => {
    setMessages([
      makeMessage(makeInfo('msg-user', 'user'), [
        // `text` must be a string; an object makes React throw while rendering
        // the prompt line.
        { id: 'part-bad', messageID: 'msg-user', type: 'text', text: { not: 'a string' } },
      ]),
    ]);

    await renderTranscript();

    expect(
      screen.getByText('Could not render this session — a malformed message part was received.'),
    ).toBeInTheDocument();
  });
});
