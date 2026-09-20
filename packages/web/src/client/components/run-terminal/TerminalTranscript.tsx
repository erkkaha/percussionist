import { memo, useEffect, useRef } from 'react';
import { useSession } from '../../hooks/useSession';
import type {
  FilePart,
  ReasoningPart,
  SessionMessage,
  SessionPart,
  SubtaskPart,
  TextPart,
  ToolPart,
} from '../../lib/types';
import { skeletonKeys } from '../../lib/utils';
import ErrorBoundary from '../ErrorBoundary';
import { SessionViewFallback } from '../SessionView';
import { FileDiff, MessageText, SubagentRow, TaskList, ToolCall } from '../session/session-parts';

/**
 * One line of local command output produced by the command bar (`/help`,
 * `/status`, errors, confirmations). This is view state, not session data:
 * `/clear` empties only this tail, never the conversation.
 */
export interface LocalEntry {
  id: string;
  kind: 'command' | 'output' | 'error';
  text: string;
  at: number;
}

interface TerminalTranscriptProps {
  name: string;
  /** Whether the run has a sessionID. */
  hasSession: boolean;
  /** Whether the run is still active (controls polling). */
  active: boolean;
  /** Whether SSE stream is currently connected. */
  sseConnected: boolean;
  /** Increments whenever relevant SSE events arrive. */
  eventTick: number;
  /** Local command output appended after the session messages. */
  localEntries: LocalEntry[];
  /**
   * Notified when the run has no session yet, so the shell can offer `/start`
   * or focus the prompt. Fires on mount and whenever the run loses its session.
   */
  onNoSession?: () => void;
}

/**
 * Terminal-style rendering of a run's session. Text stays inline (so the
 * conversation reads as a thread); every structured part is reachable behind a
 * one-line `<details>` accordion and no part is ever silently dropped.
 *
 * The session payload is proxied from the runner without validation, so a
 * single malformed part must not unmount the run page: the whole transcript is
 * wrapped in the same `ErrorBoundary` fallback SessionView uses.
 */
export default function TerminalTranscript(props: TerminalTranscriptProps) {
  return (
    <ErrorBoundary fallback={<SessionViewFallback />}>
      <TerminalTranscriptContent {...props} />
    </ErrorBoundary>
  );
}

function TerminalTranscriptContent({
  name,
  hasSession,
  active,
  sseConnected,
  eventTick,
  localEntries,
  onNoSession,
}: TerminalTranscriptProps) {
  // Events invalidate the ['session', name] query key; the tick itself carries
  // no value to read, it only signals that the cache was refreshed.
  void eventTick;

  // Keep the callback in a ref so an inline arrow from the shell does not
  // retrigger the "no session" notification on every render.
  const onNoSessionRef = useRef(onNoSession);
  useEffect(() => {
    onNoSessionRef.current = onNoSession;
  });
  useEffect(() => {
    if (!hasSession) onNoSessionRef.current?.();
  }, [hasSession]);

  // Event-driven refetch while the stream is up, with a slow safety poll in
  // case a frame is missed; 5 s polling when the stream is down.
  const { data, error, isLoading, isFetching } = useSession(
    name,
    hasSession,
    active ? (sseConnected ? 15_000 : 5_000) : false,
  );

  if (!hasSession) {
    return (
      <div className="space-y-2 font-mono text-sm">
        <div className="text-text-dim">No session yet — run is still initializing.</div>
        <LocalOutput entries={localEntries} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-phase-failed/30 bg-phase-failed/10 p-4 text-sm text-phase-failed">
        {error.message}
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-3">
        {skeletonKeys(3).map((key) => (
          <div key={key} className="rounded-lg border border-border bg-surface p-4 animate-pulse">
            <div className="h-4 w-24 rounded bg-surface-overlay mb-2" />
            <div className="h-4 w-full rounded bg-surface-overlay" />
          </div>
        ))}
        <p className="text-xs text-text-dim">Loading session messages...</p>
      </div>
    );
  }

  const messages = data?.messages ?? [];

  return (
    <div className="space-y-4 font-mono text-sm">
      {isFetching && <span className="text-xs text-text-dim animate-pulse">refreshing...</span>}
      {active && (
        <div className="text-xs text-text-dim">
          Updates: {sseConnected ? 'live stream' : 'polling fallback'}
        </div>
      )}
      {data?.source === 'snapshot' && (
        <div className="rounded border border-border-muted bg-surface-overlay/30 px-3 py-2 text-xs text-text-dim">
          {active
            ? 'Loaded from the dispatcher’s last snapshot (live transcript unavailable)'
            : 'Loaded from snapshot (pod no longer available)'}
          {data.truncated && ' — oldest messages truncated to fit size limit'}
        </div>
      )}

      {messages.length === 0 ? (
        <div className="text-xs text-text-dim">No session messages available.</div>
      ) : (
        messages.map((message) => <MessageEntry key={message.info.id} message={message} />)
      )}

      <LocalOutput entries={localEntries} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message entry
//
// Memoized so typing in the command bar (which re-renders the shell) does not
// re-render a long transcript. `message` objects come from the react-query
// cache, so their identity is stable between polls unless the session changed.

const MessageEntry = memo(function MessageEntry({ message }: { message: SessionMessage }) {
  const { info } = message;
  const parts = message.parts ?? [];
  const isUser = info.role === 'user';

  const textParts = parts.filter((p): p is TextPart => p.type === 'text');
  const toolParts = parts.filter((p): p is ToolPart => p.type === 'tool' && p.tool !== 'todowrite');
  const todowriteParts = parts.filter(
    (p): p is ToolPart => p.type === 'tool' && p.tool === 'todowrite',
  );
  const subtaskParts = parts.filter((p): p is SubtaskPart => p.type === 'subtask');
  const fileParts = parts.filter((p): p is FilePart => p.type === 'file');
  const reasoningParts = parts.filter((p): p is ReasoningPart => p.type === 'reasoning');
  const otherParts = parts.filter(
    (p) =>
      p.type !== 'text' &&
      p.type !== 'tool' &&
      p.type !== 'subtask' &&
      p.type !== 'file' &&
      p.type !== 'reasoning' &&
      p.type !== 'step-start' &&
      p.type !== 'step-finish',
  );

  const hasVisibleContent =
    textParts.length > 0 ||
    toolParts.length > 0 ||
    todowriteParts.length > 0 ||
    subtaskParts.length > 0 ||
    fileParts.length > 0 ||
    reasoningParts.length > 0 ||
    otherParts.length > 0;

  return (
    <div data-role={info.role} className="border-l-2 border-border-muted pl-3">
      <div className="mb-1 text-xs text-text-dim truncate">
        {isUser ? `user ▸ ${formatClock(info.time?.created)}` : assistantHeader(info)}
      </div>

      <div className="space-y-2">
        {textParts.map((part) =>
          isUser ? (
            // User text is the prompt: prefix it and keep the author's line
            // breaks verbatim instead of running it through markdown.
            <div
              key={part.id}
              className="text-sm text-text whitespace-pre-wrap leading-relaxed break-words"
            >
              <span className="text-phase-running select-none">❯ </span>
              {part.text}
            </div>
          ) : (
            <div
              key={part.id}
              className="text-sm text-text leading-relaxed break-words markdown-content"
            >
              <MessageText text={part.text} />
            </div>
          ),
        )}

        {/* Tool calls stay collapsed; the expanded body is the full ToolCall
            view (command, input, output with its 50-line truncation). */}
        {toolParts.map((part) => (
          <ToolPartEntry key={part.id} part={part} />
        ))}

        {/* Subtasks: opencode carries a todo list, claude a spawned subagent. */}
        {subtaskParts.map((part, i) => {
          // The claude runner may omit the id, so fall back to position.
          const key = part.id ?? `subtask-${i}`;
          return part.todos && part.todos.length > 0 ? (
            <TaskListEntry key={key} todos={part.todos} />
          ) : (
            <SubagentEntry key={key} part={part} />
          );
        })}

        {/* Todowrite tools are todo lists too; guard the unvalidated payload. */}
        {todowriteParts.map((part) => {
          const todos = part.state?.input?.todos;
          if (!Array.isArray(todos) || todos.length === 0) return null;
          return (
            <TaskListEntry
              key={part.id}
              todos={
                todos as Array<{
                  content: string;
                  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
                  priority: 'high' | 'medium' | 'low';
                }>
              }
            />
          );
        })}

        {fileParts.map((part) => (
          <FilePartEntry key={part.id} part={part} />
        ))}

        {reasoningParts.map((part) => (
          <ReasoningEntry key={part.id} part={part} />
        ))}

        {/* Unknown part types are never dropped — show the type, expandable to
            its raw payload. */}
        {otherParts.map((part) => (
          <UnknownPartEntry key={part.id} part={part} />
        ))}

        {!hasVisibleContent && <div className="text-xs text-text-dim italic">(no content)</div>}
      </div>

      {!isUser && info.error && (
        <div className="mt-1 text-xs text-phase-failed">error: {info.error.message}</div>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Structured-part accordions

function ToolPartEntry({ part }: { part: ToolPart }) {
  const { tool, state } = part;
  const status = state?.status ?? 'pending';
  const duration =
    state?.time?.start && state?.time?.end
      ? ((state.time.end - state.time.start) / 1000).toFixed(1)
      : null;
  const summary = `${tool} — ${status}${duration ? ` · ${duration}s` : ''}`;
  return (
    <TerminalDetails summary={summary}>
      <ToolCall part={part} />
    </TerminalDetails>
  );
}

function FilePartEntry({ part }: { part: FilePart }) {
  const path = part.path || part.filename;
  const counts = countDiffLines(part.diff);
  const summary = `diff ${path}${counts ? ` (+${counts.added} −${counts.removed})` : ''}`;
  return (
    <TerminalDetails summary={summary}>
      <FileDiff
        filename={part.filename}
        path={part.path}
        diff={part.diff}
        beforeContent={part.beforeContent}
        afterContent={part.afterContent}
      />
    </TerminalDetails>
  );
}

function TaskListEntry({ todos }: { todos: NonNullable<SubtaskPart['todos']> }) {
  const completed = todos.filter((todo) => todo.status === 'completed').length;
  return (
    <TerminalDetails summary={`todos ${completed}/${todos.length}`}>
      <TaskList todos={todos} />
    </TerminalDetails>
  );
}

function SubagentEntry({ part }: { part: SubtaskPart }) {
  return (
    <TerminalDetails summary={`subagent ${part.agentType ?? 'subagent'}`}>
      <SubagentRow part={part} />
    </TerminalDetails>
  );
}

function ReasoningEntry({ part }: { part: ReasoningPart }) {
  const text = typeof part.text === 'string' ? part.text : '';
  return (
    <TerminalDetails summary={`reasoning (${text.length} chars)`}>
      <pre className="text-xs font-mono text-text-muted whitespace-pre-wrap break-words max-h-96 overflow-y-auto">
        {text}
      </pre>
    </TerminalDetails>
  );
}

function UnknownPartEntry({ part }: { part: SessionPart }) {
  return (
    <TerminalDetails summary={`[${part.type}]`}>
      <pre className="text-xs font-mono text-text-dim whitespace-pre-wrap break-all max-h-96 overflow-y-auto">
        {safeStringify(part)}
      </pre>
    </TerminalDetails>
  );
}

function TerminalDetails({ summary, children }: { summary: string; children: React.ReactNode }) {
  return (
    <details className="group rounded border border-border-muted bg-surface/40">
      <summary className="flex items-center gap-2 px-2 py-1 cursor-pointer text-xs text-text-muted hover:bg-surface-overlay/30">
        <span className="text-text-dim select-none">▸</span>
        <span className="truncate">{summary}</span>
      </summary>
      <div className="border-t border-border-muted p-2">{children}</div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Local command output tail

function LocalOutput({ entries }: { entries: LocalEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div className="space-y-0.5" data-testid="local-output">
      {entries.map((entry) => (
        <div
          key={entry.id}
          className={`text-xs whitespace-pre-wrap ${
            entry.kind === 'error'
              ? 'text-phase-failed'
              : entry.kind === 'command'
                ? 'text-text-muted'
                : 'text-text-dim'
          }`}
        >
          {entry.kind === 'command' && <span className="text-phase-running select-none">❯ </span>}
          {entry.text}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers

function formatClock(ts: number | undefined): string {
  if (!ts) return '-';
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleTimeString();
}

function assistantHeader(info: SessionMessage['info']): string {
  const bits: string[] = [];
  if (info.providerID || info.modelID) {
    bits.push(`${info.providerID ? `${info.providerID}/` : ''}${info.modelID ?? ''}`);
  }
  if (info.tokens) {
    bits.push(`${info.tokens.input ?? 0} in / ${info.tokens.output ?? 0} out`);
  }
  if (typeof info.cost === 'number' && info.cost > 0) {
    bits.push(`$${info.cost.toFixed(4)}`);
  }
  // A malformed info object may have none of the above; fall back to the clock
  // so the header still carries a timestamp like the user line.
  if (bits.length === 0) bits.push(formatClock(info.time?.created));
  return `assistant ▸ ${bits.join(' · ')}`;
}

/** Count added/removed lines in a unified diff, or null when there is none. */
function countDiffLines(diff: string | undefined): { added: number; removed: number } | null {
  if (!diff) return null;
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
