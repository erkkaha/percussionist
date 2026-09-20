// session-composer.test.tsx — the run page's interactive controls.
//
//   (a) an interactive run with no session offers "Start session" and calls
//       the start route; a prompt-mode run without a session offers nothing
//   (b) a run with a session shows the composer; Enter sends the trimmed text
//       through the reply route and clears the box, Shift+Enter does not send
//   (c) Stop calls the interrupt route
//   (d) a finished run renders nothing
//
// The api module is mocked; the web suite runs with --isolate so the mock
// stays in this file (AGENTS.md). Keep mock.module above the SUT import.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

const calls: { reply: Array<[string, string]>; interrupt: string[]; start: string[] } = {
  reply: [],
  interrupt: [],
  start: [],
};
let replyFails: Error | null = null;

mock.module(path.resolve('src/client/lib/api'), () => ({
  replyToRun: async (name: string, message: string) => {
    calls.reply.push([name, message]);
    if (replyFails) throw replyFails;
  },
  interruptRun: async (name: string) => {
    calls.interrupt.push(name);
  },
  startRunSession: async (name: string) => {
    calls.start.push(name);
    return { sessionID: 'ses_new' };
  },
}));

function makeRun(overrides: {
  phase?: string;
  sessionID?: string;
  interactive?: boolean;
  podPhase?: string;
}) {
  const { phase = 'Running', sessionID, interactive = false, podPhase = 'Running' } = overrides;
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Run',
    metadata: { name: 'r1', namespace: 'percussionist' },
    spec: { project: 'p', interactive, image: 'img', timeoutSeconds: 600 },
    status: { phase, podName: 'r1', podPhase, ...(sessionID ? { sessionID } : {}) },
  } as never;
}

async function renderComposer(run: unknown) {
  const { default: SessionComposer } = await import('../src/client/components/SessionComposer');
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(SessionComposer, { run } as never),
    ),
  );
}

beforeEach(() => {
  calls.reply = [];
  calls.interrupt = [];
  calls.start = [];
  replyFails = null;
});

afterEach(() => {
  cleanup();
});

describe('SessionComposer', () => {
  it('offers to start the session of an interactive run and calls the route', async () => {
    await renderComposer(makeRun({ interactive: true }));
    const button = screen.getByRole('button', { name: 'Start session' });
    fireEvent.click(button);
    await waitFor(() => expect(calls.start).toEqual(['r1']));
    expect(screen.queryByLabelText('Message to the agent')).toBeNull();
  });

  it('renders nothing for a prompt-mode run that has no session yet', async () => {
    const { container } = await renderComposer(makeRun({}));
    expect(container.textContent).toBe('');
  });

  it('renders nothing while an interactive run waits for its pod', async () => {
    const { container } = await renderComposer(makeRun({ interactive: true, podPhase: 'Pending' }));
    expect(container.textContent).toBe('');
  });

  it('sends on Enter, trims, clears, and keeps Shift+Enter as a newline', async () => {
    await renderComposer(makeRun({ sessionID: 'ses_1' }));
    const box = screen.getByLabelText('Message to the agent') as HTMLTextAreaElement;

    fireEvent.change(box, { target: { value: 'line one' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(calls.reply).toEqual([]);

    fireEvent.change(box, { target: { value: '  please continue  ' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(calls.reply).toEqual([['r1', 'please continue']]));
    await waitFor(() => expect(box.value).toBe(''));
  });

  it('sends via the button and surfaces a failure', async () => {
    replyFails = new Error('Failed to forward reply: OpenCode API 500');
    await renderComposer(makeRun({ sessionID: 'ses_1' }));
    const box = screen.getByLabelText('Message to the agent') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(calls.reply.length).toBe(1));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Failed to forward reply'),
    );
    // Text stays so the person can retry.
    expect(box.value).toBe('hi');
  });

  it('disables Send while the box is empty', async () => {
    await renderComposer(makeRun({ sessionID: 'ses_1' }));
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Stop calls the interrupt route', async () => {
    await renderComposer(makeRun({ sessionID: 'ses_1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(calls.interrupt).toEqual(['r1']));
  });

  it('tells the person when the agent is parked on their answer', async () => {
    await renderComposer(makeRun({ sessionID: 'ses_1', phase: 'WaitingForInput' }));
    expect(screen.getByText(/parked until you answer/)).toBeTruthy();
  });

  it('renders nothing once the run is over', async () => {
    const { container } = await renderComposer(makeRun({ sessionID: 'ses_1', phase: 'Succeeded' }));
    expect(container.textContent).toBe('');
  });
});
