// SessionComposer — the dashboard's interactive controls for a run's session.
//
// Sits under the transcript on the run page. For an active run with a session
// it sends user turns (the same route the board's answer box uses to resume a
// WaitingForInput run) and can stop the current turn. For an interactive run
// (`spec.interactive`) that has no session yet it offers to start one: the
// dispatcher only adopts sessions, it never creates them in that mode, and this
// replaces the in-pod TUI as the thing that does. Renders nothing for a run
// that is over or that is still waiting for its pod.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type KeyboardEvent, useState } from 'react';
import { interruptRun, replyToRun, startRunSession } from '../lib/api';
import { type Run, TERMINAL_PHASES } from '../lib/types';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';

interface SessionComposerProps {
  run: Run;
}

export default function SessionComposer({ run }: SessionComposerProps) {
  const name = run.metadata.name;
  const phase = run.status?.phase;
  const active = !phase || !TERMINAL_PHASES.has(phase);
  const hasSession = !!run.status?.sessionID;
  const podRunning = run.status?.podPhase === 'Running';

  if (!active) return null;
  if (!hasSession) {
    return run.spec.interactive && podRunning ? <StartSession name={name} /> : null;
  }
  return <Composer name={name} waiting={phase === 'WaitingForInput'} />;
}

function StartSession({ name }: { name: string }) {
  const queryClient = useQueryClient();
  const start = useMutation({
    mutationFn: () => startRunSession(name),
    // The dispatcher publishes status.sessionID within a few seconds; the run
    // query polls every 3 s, so one eager refetch is enough here.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['run', name] }),
  });
  // Between a successful start and the dispatcher publishing the session the
  // run still reports none; keep the button parked so it cannot be pressed
  // again in that window (the server also refuses a duplicate, this is UX).
  const started = start.isSuccess;

  return (
    <div className="shrink-0 border-t border-border bg-surface pl-6 pr-20 py-3">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <p className="text-sm text-text-muted">
          {started
            ? 'Session started — waiting for the dispatcher to pick it up…'
            : 'Interactive run — the agent is idle until a session is started.'}
        </p>
        <Button size="sm" onClick={() => start.mutate()} disabled={start.isPending || started}>
          {start.isPending ? 'Starting…' : started ? 'Started' : 'Start session'}
        </Button>
      </div>
      {start.error && (
        <p className="mt-2 text-xs text-phase-failed" role="alert">
          {start.error.message}
        </p>
      )}
    </div>
  );
}

function Composer({ name, waiting }: { name: string; waiting: boolean }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState('');

  const send = useMutation({
    mutationFn: (message: string) => replyToRun(name, message),
    onSuccess: () => {
      setText('');
      queryClient.invalidateQueries({ queryKey: ['session', name] });
    },
  });
  const stop = useMutation({
    mutationFn: () => interruptRun(name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['session', name] }),
  });

  const trimmed = text.trim();
  const canSend = trimmed.length > 0 && !send.isPending;

  function submit() {
    if (canSend) send.mutate(trimmed);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter inserts a newline — the chat convention the
    // manager's agent chat already follows.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  const error = send.error ?? stop.error;

  return (
    // Right padding keeps the buttons clear of the floating agent-chat button
    // pinned to the viewport's bottom-right corner.
    <div className="shrink-0 border-t border-border bg-surface pl-6 pr-20 py-3 space-y-2">
      <div className="flex items-end gap-2">
        <Textarea
          aria-label="Message to the agent"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            waiting ? 'The agent is waiting for your answer…' : 'Message the agent (Enter to send)'
          }
          rows={2}
          className="min-h-[56px] max-h-40 flex-1"
          disabled={send.isPending}
        />
        <div className="flex items-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => stop.mutate()}
            disabled={stop.isPending}
            title="Stop the agent's current turn; the session stays open"
          >
            {stop.isPending ? 'Stopping…' : 'Stop'}
          </Button>
          <Button size="sm" onClick={submit} disabled={!canSend}>
            {send.isPending ? 'Sending…' : 'Send'}
          </Button>
        </div>
      </div>
      <div className="flex items-center justify-between gap-4 text-xs">
        <span className="text-text-dim">
          {waiting
            ? 'The agent asked for input and is parked until you answer.'
            : 'Enter to send, Shift+Enter for a new line.'}
        </span>
        {error && (
          <span className="text-phase-failed" role="alert">
            {error.message}
          </span>
        )}
      </div>
    </div>
  );
}
