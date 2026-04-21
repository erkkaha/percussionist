import { useSession } from "../hooks/useSession";
import type { SessionMessage, SessionPart, ToolPart, TextPart } from "../lib/types";

interface SessionViewProps {
  name: string;
  /** Whether the run has a sessionID. */
  hasSession: boolean;
  /** Whether the run is still active (controls polling). */
  active: boolean;
}

export default function SessionView({ name, hasSession, active }: SessionViewProps) {
  const { data, error, isLoading, isFetching } = useSession(
    name,
    hasSession,
    active ? 5_000 : false,
  );

  if (!hasSession) {
    return (
      <div className="text-sm text-text-dim">
        No session yet — run is still initializing.
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
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-border bg-surface p-4 animate-pulse">
            <div className="h-4 w-24 rounded bg-surface-overlay mb-2" />
            <div className="h-4 w-full rounded bg-surface-overlay" />
          </div>
        ))}
      </div>
    );
  }

  const messages = data?.messages ?? [];

  if (messages.length === 0) {
    return (
      <div className="text-sm text-text-dim">
        No messages in session yet.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {isFetching && (
        <span className="text-xs text-text-dim animate-pulse">refreshing...</span>
      )}
      {messages.map((msg) => (
        <MessageBubble key={msg.info.id} message={msg} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message bubble

function MessageBubble({ message }: { message: SessionMessage }) {
  const { info, parts } = message;
  const isUser = info.role === "user";

  // Extract text parts for display.
  const textParts = parts.filter((p): p is TextPart => p.type === "text");
  const toolParts = parts.filter((p): p is ToolPart => p.type === "tool");
  const otherParts = parts.filter((p) => p.type !== "text" && p.type !== "tool" && p.type !== "step-start" && p.type !== "step-finish");

  return (
    <div
      className={`rounded-lg border ${
        isUser
          ? "border-border-muted bg-surface"
          : "border-border bg-surface-raised"
      }`}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border-muted">
        <span
          className={`text-xs font-semibold uppercase tracking-wider ${
            isUser ? "text-phase-pending" : "text-phase-running"
          }`}
        >
          {info.role}
        </span>
        {info.agent && (
          <span className="text-xs text-text-dim">({info.agent})</span>
        )}
        {!isUser && info.modelID && (
          <span className="text-xs text-text-dim font-mono">
            {info.providerID ? `${info.providerID}/` : ""}{info.modelID}
          </span>
        )}
        {info.time.created && (
          <span className="text-xs text-text-dim ml-auto">
            {new Date(info.time.created).toLocaleTimeString()}
          </span>
        )}
        {info.error && (
          <span className="text-xs text-phase-failed ml-2">
            error: {info.error.message}
          </span>
        )}
      </div>

      {/* Content */}
      <div className="px-4 py-3 space-y-3">
        {/* Text parts */}
        {textParts.map((part) => (
          <div
            key={part.id}
            className="text-sm text-text whitespace-pre-wrap leading-relaxed break-words"
          >
            {part.text}
          </div>
        ))}

        {/* Tool calls */}
        {toolParts.length > 0 && (
          <div className="space-y-2">
            {toolParts.map((part) => (
              <ToolCall key={part.id} part={part} />
            ))}
          </div>
        )}

        {/* Other parts (subtask, file, etc.) — show type as placeholder */}
        {otherParts.map((part) => (
          <div key={part.id} className="text-xs text-text-dim italic">
            [{part.type}]
          </div>
        ))}

        {/* Empty message (no visible parts) */}
        {textParts.length === 0 && toolParts.length === 0 && otherParts.length === 0 && (
          <div className="text-xs text-text-dim italic">
            (no content)
          </div>
        )}
      </div>

      {/* Token footer for assistant messages */}
      {!isUser && info.tokens && (
        <div className="px-4 py-1.5 border-t border-border-muted text-xs text-text-dim tabular-nums">
          tokens: {info.tokens.input} in / {info.tokens.output} out
          {info.tokens.reasoning > 0 && ` / ${info.tokens.reasoning} reasoning`}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool call display

function ToolCall({ part }: { part: ToolPart }) {
  const { tool, state } = part;
  const statusColor = {
    pending: "text-phase-pending",
    running: "text-phase-initializing animate-pulse",
    completed: "text-phase-succeeded",
    error: "text-phase-failed",
  }[state.status] ?? "text-text-dim";

  return (
    <details className="group rounded border border-border-muted bg-surface overflow-hidden">
      <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-surface-overlay/30 text-sm">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${statusColor.replace("text-", "bg-")}`} />
        <span className="font-mono text-xs text-text">{tool}</span>
        {state.title && (
          <span className="text-xs text-text-muted truncate">{state.title}</span>
        )}
        <span className={`text-xs ml-auto ${statusColor}`}>{state.status}</span>
      </summary>

      <div className="px-3 py-2 border-t border-border-muted space-y-2">
        {/* Input */}
        {state.input && Object.keys(state.input).length > 0 && (
          <div>
            <div className="text-xs text-text-dim mb-1">Input</div>
            <pre className="text-xs font-mono text-text-muted bg-surface-raised rounded p-2 overflow-x-auto max-h-48 whitespace-pre-wrap break-all">
              {formatToolInput(state.input)}
            </pre>
          </div>
        )}

        {/* Output */}
        {state.output && (
          <div>
            <div className="text-xs text-text-dim mb-1">Output</div>
            <pre className="text-xs font-mono text-text-muted bg-surface-raised rounded p-2 overflow-x-auto max-h-48 whitespace-pre-wrap break-all">
              {state.output.length > 2000
                ? state.output.slice(0, 2000) + "\n... (truncated)"
                : state.output}
            </pre>
          </div>
        )}

        {/* Error */}
        {state.error && (
          <div>
            <div className="text-xs text-phase-failed mb-1">Error</div>
            <pre className="text-xs font-mono text-phase-failed/80 bg-phase-failed/5 rounded p-2 whitespace-pre-wrap">
              {state.error}
            </pre>
          </div>
        )}
      </div>
    </details>
  );
}

function formatToolInput(input: Record<string, unknown>): string {
  // Show common tool fields nicely.
  const entries = Object.entries(input);
  if (entries.length === 1) {
    const [key, val] = entries[0]!;
    if (typeof val === "string") {
      // Single string input — show directly.
      if (val.length > 2000) return `${key}: ${val.slice(0, 2000)}... (truncated)`;
      return `${key}: ${val}`;
    }
  }
  const json = JSON.stringify(input, null, 2);
  if (json.length > 2000) return json.slice(0, 2000) + "\n... (truncated)";
  return json;
}
