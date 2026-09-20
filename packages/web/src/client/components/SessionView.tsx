import { useRef } from 'react';
import { useSession } from '../hooks/useSession';
import type { FilePart, SessionMessage, SubtaskPart, TextPart, ToolPart } from '../lib/types';
import { skeletonKeys } from '../lib/utils';
import ErrorBoundary from './ErrorBoundary';
import { FileDiff, MessageText, SubagentRow, TaskList, ToolCall } from './session/session-parts';

interface SessionViewProps {
  name: string;
  /** Whether the run has a sessionID. */
  hasSession: boolean;
  /** Whether the run is still active (controls polling). */
  active: boolean;
  /** Whether SSE stream is currently connected. */
  sseConnected: boolean;
  /** Increments whenever relevant SSE events arrive. */
  eventTick: number;
  /** Replaces the default "still initializing" copy when there is no session. */
  noSessionMessage?: string;
}

export default function SessionView(props: SessionViewProps) {
  // The session payload is proxied from the runner without validation, so a
  // single malformed part must not unmount the run/session page. The boundary
  // catches the whole view and falls back to a message while the surrounding
  // header/cards keep rendering.
  return (
    <ErrorBoundary fallback={<SessionViewFallback />}>
      <SessionViewContent {...props} />
    </ErrorBoundary>
  );
}

function SessionViewFallback() {
  return (
    <div className="rounded-lg border border-phase-failed/30 bg-phase-failed/10 p-4 text-sm text-phase-failed">
      Could not render this session — a malformed message part was received.
    </div>
  );
}

function SessionViewContent({
  name,
  hasSession,
  active,
  sseConnected,
  eventTick,
  noSessionMessage,
}: SessionViewProps) {
  void eventTick;
  // Event-driven refetch while the stream is up, with a slow safety poll in
  // case a frame is missed; 5 s polling when the stream is down.
  const { data, error, isLoading, isFetching } = useSession(
    name,
    hasSession,
    active ? (sseConnected ? 15_000 : 5_000) : false,
  );

  const messageRefsMap = useRef<Map<string, HTMLDivElement>>(new Map());

  if (!hasSession) {
    return (
      <div className="text-sm text-text-dim">
        {noSessionMessage ?? 'No session yet — run is still initializing.'}
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

  if (messages.length === 0) {
    return (
      <div className="rounded-lg border border-border-muted bg-surface-overlay/30 p-4 text-sm">
        <p className="text-text-dim mb-2">No session messages available.</p>
        {data?.source && (
          <p className="text-xs text-text-muted">Loaded from snapshot (pod no longer available)</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
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
      {messages.map((msg) => (
        <MessageBubble key={msg.info.id} message={msg} messageRefsMap={messageRefsMap} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message bubble

function MessageBubble({
  message,
  messageRefsMap,
}: {
  message: SessionMessage;
  messageRefsMap: React.MutableRefObject<Map<string, HTMLDivElement>>;
}) {
  const { info } = message;
  // The session payload is proxied straight from the runner without validation,
  // so treat a missing `parts` as an empty message rather than a blank page.
  const parts = message.parts ?? [];
  const isUser = info.role === 'user';

  // Store ref for scroll target
  const setRef = (node: HTMLDivElement | null) => {
    if (node) {
      messageRefsMap.current.set(info.id, node);
    } else {
      messageRefsMap.current.delete(info.id);
    }
  };

  // Extract text parts for display.
  const textParts = parts.filter((p): p is TextPart => p.type === 'text');

  // Separate todowrite tools from other tools
  const toolParts = parts.filter((p): p is ToolPart => p.type === 'tool' && p.tool !== 'todowrite');
  const todowriteParts = parts.filter(
    (p): p is ToolPart => p.type === 'tool' && p.tool === 'todowrite',
  );

  const subtaskParts = parts.filter((p): p is SubtaskPart => p.type === 'subtask');
  const fileParts = parts.filter((p): p is FilePart => p.type === 'file');
  const otherParts = parts.filter(
    (p) =>
      p.type !== 'text' &&
      p.type !== 'tool' &&
      p.type !== 'subtask' &&
      p.type !== 'file' &&
      p.type !== 'step-start' &&
      p.type !== 'step-finish',
  );

  return (
    <div
      ref={setRef}
      className={`rounded-lg border ${
        isUser ? 'border-border-muted bg-surface' : 'border-border bg-surface-raised'
      }`}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border-muted flex-wrap">
        <span
          className={`text-xs font-semibold uppercase tracking-wider ${
            isUser ? 'text-phase-pending' : 'text-phase-running'
          }`}
        >
          {info.role}
        </span>
        {info.agent && <span className="text-xs text-text-dim">({info.agent})</span>}
        {!isUser && info.modelID && (
          <span className="text-xs text-text-dim font-mono truncate max-w-[180px] sm:max-w-none">
            {info.providerID ? `${info.providerID}/` : ''}
            {info.modelID}
          </span>
        )}
        {info.time.created && (
          <span className="text-xs text-text-dim ml-auto shrink-0">
            {new Date(info.time.created).toLocaleTimeString()}
          </span>
        )}
        {info.error && (
          <span className="text-xs text-phase-failed w-full">error: {info.error.message}</span>
        )}
      </div>

      {/* Content */}
      <div className="px-4 py-3 space-y-3">
        {/* Text parts */}
        {textParts.map((part) =>
          isUser ? (
            <div
              key={part.id}
              className="text-sm text-text whitespace-pre-wrap leading-relaxed break-words"
            >
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

        {/* Tool calls */}
        {toolParts.length > 0 && (
          <div className="space-y-2">
            {toolParts.map((part) => (
              <ToolCall key={part.id} part={part} />
            ))}
          </div>
        )}

        {/* Subtasks — a todo checklist (opencode) or a spawned subagent (claude) */}
        {subtaskParts.map((part, i) => {
          // The claude runner leaves `id` unset when the SDK gives the tool call
          // no id, so fall back to position for the key.
          const key = part.id ?? `subtask-${i}`;
          return part.todos && part.todos.length > 0 ? (
            <TaskList key={key} todos={part.todos} />
          ) : (
            <SubagentRow key={key} part={part} />
          );
        })}

        {/* Todowrite tools rendered as task lists */}
        {todowriteParts.map((part) => {
          // The payload is unvalidated proxied JSON — `state` or `state.input`
          // may be missing, so optional-chain down to `todos` and rely on the
          // Array.isArray check to skip anything that is not a real list.
          const todos = part.state?.input?.todos;
          // Validate that todos is an array before rendering
          if (Array.isArray(todos) && todos.length > 0) {
            return (
              <TaskList
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
          }
          return null;
        })}

        {/* File diffs */}
        {fileParts.map((part) => (
          <FileDiff
            key={part.id}
            filename={part.filename}
            path={part.path}
            diff={part.diff}
            beforeContent={part.beforeContent}
            afterContent={part.afterContent}
          />
        ))}

        {/* Other parts (unknown types) — show type as placeholder */}
        {otherParts.map((part) => (
          <div key={part.id} className="text-xs text-text-dim italic">
            [{part.type}]
          </div>
        ))}

        {/* Empty message (no visible parts) */}
        {textParts.length === 0 &&
          toolParts.length === 0 &&
          todowriteParts.length === 0 &&
          subtaskParts.length === 0 &&
          fileParts.length === 0 &&
          otherParts.length === 0 && (
            <div className="text-xs text-text-dim italic">(no content)</div>
          )}
      </div>

      {/* Token footer for assistant messages */}
      {!isUser && (info.tokens || info.cost) && (
        <div className="px-4 py-1.5 border-t border-border-muted text-xs text-text-dim tabular-nums flex items-center gap-3">
          <span>
            tokens: {info.tokens?.input ?? 0} in / {info.tokens?.output ?? 0} out
            {(info.tokens?.reasoning ?? 0) > 0 && ` / ${info.tokens?.reasoning} reasoning`}
          </span>
          {(info.tokens?.cache?.read ?? 0) > 0 && (
            <span className="text-text-dim/60">
              cache: {info.tokens?.cache?.read} read / {info.tokens?.cache?.write ?? 0} write
            </span>
          )}
          {typeof info.cost === 'number' && info.cost > 0 && (
            <span className="ml-auto font-medium text-phase-running">${info.cost.toFixed(4)}</span>
          )}
        </div>
      )}
    </div>
  );
}
