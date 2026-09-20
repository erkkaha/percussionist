// run-command-bar.test.tsx — the run terminal's prompt and slash-command bar.
//
// Ports every case from tests/session-composer.test.tsx against the new
// `aria-label` ("Command or message to the agent") and adds the slash-command
// surface:
//   (a) an interactive run with no session offers "Start session" and calls the
//       start route; a prompt-mode run without a session (or one whose pod is
//       not Running) offers nothing
//   (b) a run with a session: Enter sends the trimmed text through the reply
//       route and clears the box, Shift+Enter does not send; the Send button
//       surfaces a failure and retains the text
//   (c) Stop calls the interrupt route, and the bar reports a parked agent
//   (d) a finished run renders nothing
//   (e) typing `/` opens a filtering listbox and Enter completes the selection
//   (f) plain text is an implicit reply; `/help` hits no API; `/stop` interrupts
//   (g) `/cancel` needs a second confirmation before deleteRun + navigate
//   (h) an unknown `/foo` prints an error and is never forwarded
//
// The api module is mocked; the web suite runs with --isolate so the mock stays
// in this file (AGENTS.md). Keep mock.module above the SUT import.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

const LABEL = 'Command or message to the agent';

const calls: {
  reply: Array<[string, string]>;
  interrupt: string[];
  start: string[];
  delete: string[];
} = { reply: [], interrupt: [], start: [], delete: [] };
const entries: Array<{ kind: string; text: string }> = [];
const navigated: string[] = [];
const views: string[] = [];
const containers: Array<string | undefined> = [];
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
  deleteRun: async (name: string) => {
    calls.delete.push(name);
  },
}));

function makeRun(overrides: {
  phase?: string;
  sessionID?: string;
  interactive?: boolean;
  podPhase?: string;
  engine?: string;
}) {
  const {
    phase = 'Running',
    sessionID,
    interactive = false,
    podPhase = 'Running',
    engine,
  } = overrides;
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Run',
    metadata: { name: 'r1', namespace: 'percussionist' },
    spec: {
      project: 'p',
      interactive,
      image: 'img',
      timeoutSeconds: 600,
      ...(engine ? { engine } : {}),
    },
    status: { phase, podName: 'r1', podPhase, ...(sessionID ? { sessionID } : {}) },
  } as never;
}

async function renderBar(run: unknown, props: Record<string, unknown> = {}) {
  const { default: RunCommandBar } = await import(
    '../src/client/components/run-terminal/RunCommandBar'
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(RunCommandBar, {
        run,
        appendEntry: (entry: { kind: string; text: string }) => entries.push(entry),
        navigate: (to: string) => navigated.push(to),
        setView: (view: string) => views.push(view),
        setLogContainer: (container: string | undefined) => containers.push(container),
        ...props,
      } as never),
    ),
  );
}

function box(): HTMLTextAreaElement {
  return screen.getByLabelText(LABEL) as HTMLTextAreaElement;
}

/**
 * Type a line and submit it. The slash menu completes the token on the first
 * Enter and the second Enter executes it; when the menu is closed (plain text,
 * an unknown command, or a line with arguments) the first Enter already acts
 * and the second is a no-op because the box is empty.
 */
function submitLine(value: string) {
  const el = box();
  fireEvent.change(el, { target: { value } });
  fireEvent.keyDown(el, { key: 'Enter' });
  fireEvent.keyDown(el, { key: 'Enter' });
}

beforeEach(() => {
  calls.reply = [];
  calls.interrupt = [];
  calls.start = [];
  calls.delete = [];
  entries.length = 0;
  navigated.length = 0;
  views.length = 0;
  containers.length = 0;
  replyFails = null;
});

afterEach(() => {
  cleanup();
});

describe('RunCommandBar', () => {
  it('offers to start the session of an interactive run and calls the route', async () => {
    await renderBar(makeRun({ interactive: true }));
    const button = screen.getByRole('button', { name: 'Start session' });
    fireEvent.click(button);
    await waitFor(() => expect(calls.start).toEqual(['r1']));
    // The prompt parks once the session start is accepted: the dispatcher has
    // not published the session yet, so there is nothing to send.
    await waitFor(() => expect(screen.queryByLabelText(LABEL)).toBeNull());
    // Parked until the dispatcher publishes the session: no second click.
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Started' }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Started' }));
    expect(calls.start).toEqual(['r1']);
  });

  it('renders nothing for a prompt-mode run that has no session yet', async () => {
    const { container } = await renderBar(makeRun({}));
    expect(container.textContent).toBe('');
  });

  it('renders nothing while an interactive run waits for its pod', async () => {
    const { container } = await renderBar(makeRun({ interactive: true, podPhase: 'Pending' }));
    expect(container.textContent).toBe('');
  });

  it('sends on Enter, trims, clears, and keeps Shift+Enter as a newline', async () => {
    await renderBar(makeRun({ sessionID: 'ses_1' }));
    const el = box();

    fireEvent.change(el, { target: { value: 'line one' } });
    fireEvent.keyDown(el, { key: 'Enter', shiftKey: true });
    expect(calls.reply).toEqual([]);

    fireEvent.change(el, { target: { value: '  please continue  ' } });
    fireEvent.keyDown(el, { key: 'Enter' });
    await waitFor(() => expect(calls.reply).toEqual([['r1', 'please continue']]));
    await waitFor(() => expect(box().value).toBe(''));
  });

  it('sends via Enter and surfaces a failure', async () => {
    replyFails = new Error('Failed to forward reply: OpenCode API 500');
    await renderBar(makeRun({ sessionID: 'ses_1' }));
    fireEvent.change(box(), { target: { value: 'hi' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(calls.reply.length).toBe(1));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Failed to forward reply'),
    );
    // Text stays so the person can retry.
    expect(box().value).toBe('hi');
  });

  it('does not send while the box is empty', async () => {
    await renderBar(makeRun({ sessionID: 'ses_1' }));
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(calls.reply).toEqual([]);
  });

  it('/stop calls the interrupt route', async () => {
    await renderBar(makeRun({ sessionID: 'ses_1' }));
    submitLine('/stop');
    await waitFor(() => expect(calls.interrupt).toEqual(['r1']));
  });

  it('hints when the agent is parked on their answer via placeholder', async () => {
    await renderBar(makeRun({ sessionID: 'ses_1', phase: 'WaitingForInput' }));
    expect(box().placeholder).toMatch(/waiting for your answer/);
  });

  it('renders nothing once the run is over', async () => {
    const { container } = await renderBar(makeRun({ sessionID: 'ses_1', phase: 'Succeeded' }));
    expect(container.textContent).toBe('');
  });

  // -------------------------------------------------------------------------
  // Slash commands

  it('opens the command menu on `/` and filters as the token grows', async () => {
    await renderBar(makeRun({ sessionID: 'ses_1' }));
    fireEvent.change(box(), { target: { value: '/' } });
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getAllByRole('option').length).toBeGreaterThan(1);

    fireEvent.change(box(), { target: { value: '/log' } });
    const options = screen.getAllByRole('option');
    expect(options.length).toBe(1);
    expect(options[0]?.textContent).toContain('/logs');
  });

  it('completes the highlighted command on Enter and closes the menu', async () => {
    await renderBar(makeRun({ sessionID: 'ses_1' }));
    const el = box();
    fireEvent.change(el, { target: { value: '/log' } });
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(el.value).toBe('/logs ');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('sends a plain message through replyToRun', async () => {
    await renderBar(makeRun({ sessionID: 'ses_1' }));
    submitLine('status please');
    await waitFor(() => expect(calls.reply).toEqual([['r1', 'status please']]));
  });

  it('/help lists the commands without calling the API', async () => {
    await renderBar(makeRun({ sessionID: 'ses_1' }));
    submitLine('/help');
    await waitFor(() => expect(entries.some((e) => e.text.includes('/status'))).toBe(true));
    expect(calls.reply).toEqual([]);
    expect(calls.interrupt).toEqual([]);
    expect(calls.start).toEqual([]);
    expect(calls.delete).toEqual([]);
  });

  it('/status switches the stage and prints a phase summary', async () => {
    await renderBar(makeRun({ sessionID: 'ses_1' }));
    submitLine('/status');
    await waitFor(() => expect(views).toEqual(['status']));
    expect(entries.some((e) => e.text.includes('phase=Running'))).toBe(true);
  });

  it('/logs pins the optional container and switches the stage', async () => {
    await renderBar(makeRun({ sessionID: 'ses_1' }));
    submitLine('/logs engine');
    await waitFor(() => expect(views).toEqual(['logs']));
    expect(containers).toEqual(['engine']);
  });

  it('/stop calls the interrupt route', async () => {
    await renderBar(makeRun({ sessionID: 'ses_1' }));
    submitLine('/stop');
    await waitFor(() => expect(calls.interrupt).toEqual(['r1']));
  });

  it('/cancel requires a second confirmation before deleting', async () => {
    await renderBar(makeRun({ sessionID: 'ses_1' }));
    submitLine('/cancel');
    await waitFor(() =>
      expect(entries.some((e) => e.text.includes('Re-run /cancel to confirm'))).toBe(true),
    );
    expect(calls.delete).toEqual([]);
    expect(navigated).toEqual([]);

    submitLine('/cancel');
    await waitFor(() => expect(calls.delete).toEqual(['r1']));
    expect(navigated).toEqual(['/runs']);
  });

  it('unknown /foo is reported and never forwarded', async () => {
    await renderBar(makeRun({ sessionID: 'ses_1' }));
    submitLine('/frobnicate');
    await waitFor(() => expect(entries.some((e) => e.text.includes('unknown command'))).toBe(true));
    expect(calls.reply).toEqual([]);
  });
});
