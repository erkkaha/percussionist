// RunCommandBar — the run page's interactive terminal prompt.
//
// Evolved from SessionComposer, it keeps every behavior that component had:
//   - an interactive run (`spec.interactive`) with no session yet offers to
//     start one. The dispatcher only adopts sessions, it never creates them in
//     that mode, and this replaces the in-pod TUI as the thing that does. After
//     a successful start the control parks until the dispatcher publishes the
//     session (the run query polls every 3 s), so it cannot double-fire.
//   - a run with a session sends user turns (Enter sends, Shift+Enter inserts a
//     newline), stops the current turn, surfaces errors via `role="alert"`, and
//     retains the text on failure so it can be retried.
//   - a run that is over renders nothing.
//
// On top of that it is the terminal's command surface. A leading `/` with no
// whitespace after the token opens a listbox of matching commands; Enter
// executes the resolved command from ./commands.ts, and plain text is an
// implicit `/reply`. Slash commands apply here, not inside the raw xterm
// attach: once `/shell` attaches a PTY the browser forwards keystrokes and can
// no longer intercept them.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ChangeEvent, type KeyboardEvent, useMemo, useRef, useState } from 'react';
import { deleteRun, interruptRun, replyToRun, startRunSession } from '../../lib/api';
import { type Run, TERMINAL_PHASES } from '../../lib/types';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import {
  COMMANDS,
  matchCommands,
  type ParsedCommand,
  parseSlashInput,
  type RunView,
  resolveCommand,
  type SlashCommand,
} from './commands';

/** The outcome kinds the transcript's local output tail renders. */
export type CommandOutputKind = 'command' | 'output' | 'error';

/** A line the command bar asks the shell to append after the transcript. */
export interface CommandOutputEntry {
  kind: CommandOutputKind;
  text: string;
}

export interface RunCommandBarProps {
  run: Run;
  /** Current stage, passed through to the shell so commands can switch it. */
  view?: RunView;
  /** Switch the stage (`/status`, `/logs`, `/conversation`, `/shell`). */
  setView?: (view: RunView) => void;
  /** Pin the log viewer to a container (`/logs engine`). */
  setLogContainer?: (container: string | undefined) => void;
  /** Append a line to the transcript's local output tail. */
  appendEntry?: (entry: CommandOutputEntry) => void;
  /** Empty the local output tail (`/clear`). Never touches session messages. */
  clearEntries?: () => void;
  /** Invalidate a react-query key (`/refresh`). */
  invalidate?: (queryKey: readonly unknown[]) => void;
  /** Navigate the SPA (`/cancel` redirects to /runs). */
  navigate?: (to: string) => void;
  /**
   * The shell's delete-run flow. When omitted the command bar deletes the run
   * itself and redirects to /runs. Invoked only after `/cancel` is confirmed.
   */
  confirmCancel?: () => void;
}

export default function RunCommandBar({
  run,
  setView: setViewProp,
  setLogContainer: setLogContainerProp,
  appendEntry: appendEntryProp,
  clearEntries: clearEntriesProp,
  invalidate: invalidateProp,
  navigate: navigateProp,
  confirmCancel: confirmCancelProp,
}: RunCommandBarProps) {
  const name = run.metadata.name;
  const phase = run.status?.phase;
  const active = !phase || !TERMINAL_PHASES.has(phase);
  const hasSession = !!run.status?.sessionID;
  const podRunning = run.status?.podPhase === 'Running';

  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [cancelArmed, setCancelArmed] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Shell callbacks default to no-ops so the component can render standalone;
  // the run shell wires the real ones.
  const setView = setViewProp ?? (() => {});
  const setLogContainer = setLogContainerProp ?? (() => {});
  const appendEntry = appendEntryProp ?? (() => {});
  const clearEntries = clearEntriesProp ?? (() => {});
  const navigateTo = navigateProp ?? (() => {});
  const invalidate =
    invalidateProp ??
    ((queryKey: readonly unknown[]) =>
      void queryClient.invalidateQueries({ queryKey: queryKey as unknown[] }));

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
  const start = useMutation({
    mutationFn: () => startRunSession(name),
    // The dispatcher publishes status.sessionID within a few seconds; the run
    // query polls every 3 s, so one eager refetch is enough here.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['run', name] }),
  });
  const cancel = useMutation({
    mutationFn: () => deleteRun(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['runs'] });
      navigateTo('/runs');
    },
  });

  const trimmed = text.trim();
  // The menu only opens for a lone command token: a leading `/` followed by
  // non-whitespace (`/logs engine` and `/logs ` are closed).
  const slashToken = /^\/\S*$/.test(trimmed);
  const matches = useMemo(
    () => (slashToken ? matchCommands(trimmed.slice(1)) : []),
    [slashToken, trimmed],
  );
  const menuOpen = slashToken && !menuDismissed && matches.length > 0;
  const activeIndex = matches.length > 0 ? Math.min(selectedIndex, matches.length - 1) : 0;

  const canSend = trimmed.length > 0 && !send.isPending;

  function setAnnouncementText(next: string) {
    setAnnouncement(next);
  }

  function executeCommand(command: SlashCommand, parsed: ParsedCommand) {
    switch (command.name) {
      case 'help':
        appendEntry({ kind: 'output', text: helpText() });
        setAnnouncementText('Listed the slash commands');
        break;
      case 'status':
        setView('status');
        appendEntry({ kind: 'output', text: statusSummary(run) });
        setAnnouncementText('Showing the status view');
        break;
      case 'logs': {
        const container = parsed.args[0];
        if (container) setLogContainer(container);
        setView('logs');
        appendEntry({
          kind: 'output',
          text: container ? `Showing logs for ${container}` : 'Showing logs',
        });
        setAnnouncementText('Showing the logs view');
        break;
      }
      case 'conversation':
        setView('conversation');
        setAnnouncementText('Showing the conversation view');
        break;
      case 'shell':
        if (!active || !podRunning) {
          appendEntry({
            kind: 'error',
            text: `Interactive attach needs an active run with a Running pod (currently ${
              run.status?.podPhase ?? 'unknown'
            }).`,
          });
          setAnnouncementText('Interactive attach unavailable');
          break;
        }
        setView('shell');
        appendEntry({
          kind: 'output',
          text:
            run.spec.engine === 'claude'
              ? 'The claude engine has no TTY; the shell view explains why.'
              : 'Opened the interactive shell — keystrokes now go to the pod.',
        });
        setAnnouncementText('Opened the shell view');
        break;
      case 'clear':
        clearEntries();
        setAnnouncementText('Cleared local command output');
        break;
      case 'copy':
        void copyRunName();
        break;
      case 'refresh':
        invalidate(['run', name]);
        invalidate(['session', name]);
        invalidate(['logs', name]);
        appendEntry({ kind: 'output', text: 'Refreshed run, session and logs.' });
        setAnnouncementText('Refreshed');
        break;
      case 'stop':
        stop.mutate();
        appendEntry({ kind: 'output', text: 'Stopping the agent’s current turn…' });
        setAnnouncementText('Stopping the agent');
        break;
      case 'start':
        start.mutate();
        appendEntry({ kind: 'output', text: 'Starting the session…' });
        setAnnouncementText('Starting the session');
        break;
      case 'reply':
        if (parsed.argsText.length > 0) {
          send.mutate(parsed.argsText);
        } else {
          appendEntry({ kind: 'error', text: 'Usage: /reply <text>' });
        }
        break;
      case 'cancel':
        if (cancelArmed) {
          setCancelArmed(false);
          if (confirmCancelProp) confirmCancelProp();
          else cancel.mutate();
        } else {
          setCancelArmed(true);
          appendEntry({
            kind: 'error',
            text: `Cancel run ${name}? This deletes the run and its pods. Re-run /cancel to confirm.`,
          });
          setAnnouncementText('Cancellation armed — re-run /cancel to confirm');
        }
        break;
    }
  }

  async function copyRunName() {
    try {
      await navigator.clipboard.writeText(name);
      appendEntry({ kind: 'output', text: `Copied ${name} to the clipboard.` });
      setAnnouncementText('Copied the run name');
    } catch {
      appendEntry({ kind: 'error', text: 'Clipboard unavailable.' });
    }
  }

  function submit() {
    if (!canSend) return;
    const parsed = parseSlashInput(trimmed);
    const command = parsed ? resolveCommand(parsed.command) : undefined;

    // An unknown `/foo` is never forwarded to the agent.
    if (parsed && !command) {
      setCancelArmed(false);
      appendEntry({ kind: 'error', text: `unknown command: /${parsed.command} — try /help` });
      setAnnouncementText(`unknown command /${parsed.command}`);
      setText('');
      return;
    }

    if (parsed && command) {
      appendEntry({ kind: 'command', text: trimmed });
      // Any command other than /cancel disarms a pending cancellation.
      if (command.name !== 'cancel') setCancelArmed(false);
      executeCommand(command, parsed);
      setText('');
      return;
    }

    // Plain text is an implicit /reply.
    setCancelArmed(false);
    if (!hasSession) {
      appendEntry({ kind: 'error', text: 'No session yet — run /start first.' });
      setAnnouncementText('No session yet');
      return;
    }
    send.mutate(trimmed);
  }

  function completeMatch(command: SlashCommand) {
    setText(`/${command.name} `);
    setSelectedIndex(0);
    setMenuDismissed(true);
    const el = textareaRef.current;
    if (el) {
      el.focus();
      autoGrow(el);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (menuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % matches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing)) {
        e.preventDefault();
        const match = matches[activeIndex];
        if (match) completeMatch(match);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMenuDismissed(true);
        return;
      }
    }

    // Enter sends, Shift+Enter inserts a newline — the chat convention the
    // manager's agent chat already follows.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  function onChange(e: ChangeEvent<HTMLTextAreaElement>) {
    setText(e.target.value);
    setSelectedIndex(0);
    setMenuDismissed(false);
    autoGrow(e.target);
  }

  if (!active) return null;
  if (!hasSession) {
    // Prompt-mode runs have nothing to send into; interactive runs offer to
    // start a session. Both render nothing until the pod is up.
    if (!(run.spec.interactive && podRunning)) return null;
    const started = start.isSuccess;
    return (
      <div className="relative shrink-0 border-t border-border bg-surface pl-6 pr-20 py-3 space-y-2 font-mono">
        {menuOpen && !started && (
          <CommandMenu matches={matches} activeIndex={activeIndex} onSelect={completeMatch} />
        )}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <p className="text-sm text-text-muted">
            {started
              ? 'Session started — waiting for the dispatcher to pick it up…'
              : 'Interactive run — the agent is idle until a session is started. Type /start or press the button.'}
          </p>
          <div className="flex items-end gap-2">
            {!started && (
              <Textarea
                ref={textareaRef}
                aria-label="Command or message to the agent"
                aria-expanded={menuOpen}
                aria-controls={menuOpen ? LISTBOX_ID : undefined}
                aria-activedescendant={menuOpen ? optionId(activeIndex) : undefined}
                aria-autocomplete="list"
                value={text}
                onChange={onChange}
                onKeyDown={onKeyDown}
                placeholder="Type /start or a message…"
                rows={1}
                className="min-h-[40px] max-h-40 w-64 resize-none font-mono text-sm"
                disabled={start.isPending}
              />
            )}
            <Button size="sm" onClick={() => start.mutate()} disabled={start.isPending || started}>
              {start.isPending ? 'Starting…' : started ? 'Started' : 'Start session'}
            </Button>
          </div>
        </div>
        {start.error && (
          <p className="text-xs text-phase-failed" role="alert">
            {start.error.message}
          </p>
        )}
        <LiveRegion message={announcement} />
      </div>
    );
  }

  const error = send.error ?? stop.error ?? cancel.error;

  return (
    // Right padding keeps the buttons clear of the floating agent-chat button
    // pinned to the viewport's bottom-right corner.
    <div className="relative shrink-0 border-t border-border bg-surface pl-6 pr-20 py-3 space-y-2 font-mono">
      {menuOpen && (
        <CommandMenu matches={matches} activeIndex={activeIndex} onSelect={completeMatch} />
      )}
      <div className="flex items-end gap-2">
        <span aria-hidden="true" className="select-none pb-2 text-phase-running">
          ❯
        </span>
        <Textarea
          ref={textareaRef}
          aria-label="Command or message to the agent"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? LISTBOX_ID : undefined}
          aria-activedescendant={menuOpen ? optionId(activeIndex) : undefined}
          aria-autocomplete="list"
          value={text}
          onChange={onChange}
          onKeyDown={onKeyDown}
          placeholder={
            phase === 'WaitingForInput'
              ? 'The agent is waiting for your answer…'
              : 'Message the agent, or type / for commands (Enter to send)'
          }
          rows={1}
          className="min-h-[40px] max-h-40 flex-1 resize-none font-mono text-sm"
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
          {phase === 'WaitingForInput'
            ? 'The agent asked for input and is parked until you answer.'
            : 'Enter to send, Shift+Enter for a new line, / for commands.'}
        </span>
        {error && (
          <span className="text-phase-failed" role="alert">
            {error.message}
          </span>
        )}
      </div>
      <LiveRegion message={announcement} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Slash-command autocomplete

const LISTBOX_ID = 'run-command-listbox';

function optionId(index: number): string {
  return `${LISTBOX_ID}-option-${index}`;
}

function CommandMenu({
  matches,
  activeIndex,
  onSelect,
}: {
  matches: SlashCommand[];
  activeIndex: number;
  onSelect: (command: SlashCommand) => void;
}) {
  return (
    // Absolutely positioned above the prompt because the bar sits at the
    // bottom of the viewport. Mouse-down is prevented so a click does not move
    // focus out of the textarea (Enter still sends after selecting an option).
    <div
      id={LISTBOX_ID}
      role="listbox"
      aria-label="Slash commands"
      className="absolute bottom-full left-6 z-20 mb-1 max-h-64 w-[28rem] max-w-[calc(100%-3rem)] overflow-y-auto rounded-md border border-border bg-surface-raised py-1 shadow-lg"
    >
      {matches.map((command, index) => (
        <button
          key={command.name}
          type="button"
          id={optionId(index)}
          role="option"
          aria-selected={index === activeIndex}
          // Mouse-down would move focus out of the textarea and break the
          // Enter-to-send flow; keep focus and select on the click instead.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSelect(command)}
          className={`flex w-full cursor-pointer items-baseline gap-3 px-3 py-1.5 text-left text-xs ${
            index === activeIndex ? 'bg-surface-overlay text-text' : 'text-text-muted'
          }`}
        >
          <span className="w-40 shrink-0 truncate font-mono text-text">{command.usage}</span>
          <span className="truncate">{command.description}</span>
        </button>
      ))}
    </div>
  );
}

function LiveRegion({ message }: { message: string }) {
  return (
    <div className="sr-only" role="status" aria-live="polite">
      {message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers

/** Autogrow the single-line prompt up to its max height. */
function autoGrow(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
}

function helpText(): string {
  const lines = COMMANDS.map((command) => `  ${command.usage.padEnd(24)}${command.description}`);
  return [
    'Commands:',
    ...lines,
    '',
    'Slash commands apply here; once /shell attaches a PTY, keystrokes go to the pod.',
  ].join('\n');
}

function statusSummary(run: Run): string {
  const bits = [`phase=${run.status?.phase ?? 'unknown'}`];
  if (run.status?.podName) bits.push(`pod=${run.status.podName}`);
  if (run.status?.podPhase) bits.push(`podPhase=${run.status.podPhase}`);
  if (run.status?.sessionID) bits.push(`session=${run.status.sessionID}`);
  return bits.join(' ');
}
