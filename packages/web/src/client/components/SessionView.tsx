import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { Clock, Zap, CheckCircle, XCircle, FolderOpen, Copy, Check, ChevronDown } from "lucide-react";
import { useSession } from "../hooks/useSession";
import { useInViewport } from "../hooks/useInViewport";
import { useShiki } from "../hooks/useShiki";
import { CodeBlock } from "./CodeBlock";
import { TaskList } from "./TaskList";
import { FileDiff } from "./FileDiff";
import type { SessionMessage, SessionPart, ToolPart, TextPart, SubtaskPart, FilePart } from "../lib/types";

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
}

export default function SessionView({ name, hasSession, active, sseConnected, eventTick }: SessionViewProps) {
  void eventTick;
  const { data, error, isLoading, isFetching } = useSession(
    name,
    hasSession,
    active && !sseConnected ? 5_000 : false,
  );

  const messageRefsMap = useRef<Map<string, HTMLDivElement>>(new Map());

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
      {active && (
        <div className="text-xs text-text-dim">
          Updates: {sseConnected ? "live stream" : "polling fallback"}
        </div>
      )}
      {data?.source === "snapshot" && (
        <div className="rounded border border-border-muted bg-surface-overlay/30 px-3 py-2 text-xs text-text-dim">
          Loaded from snapshot (pod no longer available)
          {data.truncated && " — oldest messages truncated to fit size limit"}
        </div>
      )}
      {messages.map((msg) => (
        <MessageBubble
          key={msg.info.id}
          message={msg}
          messageRefsMap={messageRefsMap}
        />
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
  const { info, parts } = message;
  const isUser = info.role === "user";

  // Store ref for scroll target
  const setRef = (node: HTMLDivElement | null) => {
    if (node) {
      messageRefsMap.current.set(info.id, node);
    } else {
      messageRefsMap.current.delete(info.id);
    }
  };

  // Extract text parts for display.
  const textParts = parts.filter((p): p is TextPart => p.type === "text");
  
  // Separate todowrite tools from other tools
  const toolParts = parts.filter((p): p is ToolPart => p.type === "tool" && p.tool !== "todowrite");
  const todowriteParts = parts.filter((p): p is ToolPart => p.type === "tool" && p.tool === "todowrite");
  
  const subtaskParts = parts.filter((p): p is SubtaskPart => p.type === "subtask");
  const fileParts = parts.filter((p): p is FilePart => p.type === "file");
  const otherParts = parts.filter((p) => 
    p.type !== "text" && 
    p.type !== "tool" && 
    p.type !== "subtask" && 
    p.type !== "file" && 
    p.type !== "step-start" && 
    p.type !== "step-finish"
  );

  return (
    <div
      ref={setRef}
      className={`rounded-lg border ${
        isUser
          ? "border-border-muted bg-surface"
          : "border-border bg-surface-raised"
      }`}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border-muted flex-wrap">
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
          <span className="text-xs text-text-dim font-mono truncate max-w-[180px] sm:max-w-none">
            {info.providerID ? `${info.providerID}/` : ""}{info.modelID}
          </span>
        )}
        {info.time.created && (
          <span className="text-xs text-text-dim ml-auto shrink-0">
            {new Date(info.time.created).toLocaleTimeString()}
          </span>
        )}
        {info.error && (
          <span className="text-xs text-phase-failed w-full">
            error: {info.error.message}
          </span>
        )}
      </div>

      {/* Content */}
      <div className="px-4 py-3 space-y-3">
        {/* Text parts */}
        {textParts.map((part) => (
          isUser ? (
            <div
              key={part.id}
              className="text-sm text-text whitespace-pre-wrap leading-relaxed break-words"
            >
              {part.text}
            </div>
          ) : (
            <div key={part.id} className="text-sm text-text leading-relaxed break-words markdown-content">
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkMath]}
                rehypePlugins={[rehypeKatex]}
                components={{
                  h1: ({children}) => <h1 className="text-xl font-bold mt-4 mb-2">{children}</h1>,
                  h2: ({children}) => <h2 className="text-lg font-bold mt-3 mb-2">{children}</h2>,
                  h3: ({children}) => <h3 className="text-base font-semibold mt-3 mb-1">{children}</h3>,
                  p: ({children}) => <p className="mb-2 last:mb-0">{children}</p>,
                  ul: ({children}) => <ul className="list-disc list-inside mb-2 space-y-1">{children}</ul>,
                  ol: ({children}) => <ol className="list-decimal list-inside mb-2 space-y-1">{children}</ol>,
                  li: ({children}) => <li className="ml-2">{children}</li>,
                  code: ({className, children, ...props}) => {
                    const match = /language-(\w+)/.exec(className || "");
                    const lang = match ? match[1] : undefined;
                    const isInline = !className;
                    
                    if (isInline) {
                      return (
                        <code className="bg-surface-sunken rounded px-1 py-0.5 text-xs font-mono" {...props}>
                          {children}
                        </code>
                      );
                    }
                    
                    const code = String(children).replace(/\n$/, "");
                    return <CodeBlock code={code} language={lang} />;
                  },
                  pre: ({children}) => <div className="mb-2">{children}</div>,
                  blockquote: ({children}) => <blockquote className="border-l-2 border-border pl-3 italic text-text-dim mb-2">{children}</blockquote>,
                  a: ({href, children}) => {
                    // Check if it's a file path reference (e.g., src/file.ts:42)
                    const filePathMatch = /^([a-zA-Z0-9_\-/.]+\.[a-zA-Z0-9]+):?(\d*)$/.exec(String(children));
                    if (filePathMatch) {
                      return (
                        <span className="inline-flex items-center gap-1 bg-surface-sunken rounded px-1.5 py-0.5 text-xs font-mono">
                          <span className="text-text">{filePathMatch[1]}</span>
                          {filePathMatch[2] && (
                            <span className="text-text-dim">:{filePathMatch[2]}</span>
                          )}
                        </span>
                      );
                    }
                    return (
                      <a 
                        href={href} 
                        className="text-phase-running underline hover:text-phase-running/80 transition-colors" 
                        target="_blank" 
                        rel="noopener noreferrer"
                      >
                        {children}
                      </a>
                    );
                  },
                  strong: ({children}) => <strong className="font-semibold">{children}</strong>,
                  em: ({children}) => <em className="italic">{children}</em>,
                  hr: () => <hr className="border-border-muted my-3" />,
                  table: ({children}) => (
                    <div className="overflow-x-auto mb-2">
                      <table className="border-collapse text-xs w-full">{children}</table>
                    </div>
                  ),
                  thead: ({children}) => <thead className="bg-surface-raised">{children}</thead>,
                  tbody: ({children}) => <tbody className="divide-y divide-border-muted">{children}</tbody>,
                  tr: ({children}) => <tr className="hover:bg-surface-overlay/30 transition-colors">{children}</tr>,
                  th: ({children}) => <th className="border border-border px-2 py-1.5 font-semibold text-left">{children}</th>,
                  td: ({children}) => <td className="border border-border px-2 py-1">{children}</td>,
                }}
              >
                {part.text}
              </ReactMarkdown>
            </div>
          )
        ))}

        {/* Tool calls */}
        {toolParts.length > 0 && (
          <div className="space-y-2">
            {toolParts.map((part) => (
              <ToolCall key={part.id} part={part} />
            ))}
          </div>
        )}

        {/* Task lists */}
        {subtaskParts.map((part) => (
          <TaskList key={part.id} todos={part.todos} />
        ))}

        {/* Todowrite tools rendered as task lists */}
        {todowriteParts.map((part) => {
          const todos = part.state.input.todos;
          // Validate that todos is an array before rendering
          if (Array.isArray(todos) && todos.length > 0) {
            return <TaskList key={part.id} todos={todos as Array<{
              content: string;
              status: "pending" | "in_progress" | "completed" | "cancelled";
              priority: "high" | "medium" | "low";
            }>} />;
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
        {textParts.length === 0 && toolParts.length === 0 && todowriteParts.length === 0 && subtaskParts.length === 0 && fileParts.length === 0 && otherParts.length === 0 && (
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
  const { highlight, isLoading: shikiLoading } = useShiki();
  const [commandHtml, setCommandHtml] = useState("");
  const [outputHtml, setOutputHtml] = useState("");
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  
  const statusIcon = {
    pending: Clock,
    running: Zap,
    completed: CheckCircle,
    error: XCircle,
  }[state.status] ?? Clock;
  
  const StatusIcon = statusIcon;
  
  const statusColor = {
    pending: "text-gray-600 dark:text-gray-400",
    running: "text-blue-600 dark:text-blue-400 animate-pulse",
    completed: "text-green-600 dark:text-green-400",
    error: "text-red-600 dark:text-red-400",
  }[state.status] ?? "text-gray-600 dark:text-gray-400";

  // Get workdir if present
  const workdir = state.input?.workdir as string | undefined;
  const description = state.input?.description as string | undefined;

  // Calculate duration
  const duration = state.time?.start && state.time?.end
    ? ((state.time.end - state.time.start) / 1000).toFixed(1)
    : null;

  // Highlight command input for bash/sh tools
  useEffect(() => {
    if (shikiLoading || !["bash", "sh"].includes(tool)) return;
    
    const command = state.input?.command as string | undefined;
    if (command) {
      highlight(command, "bash", "dark").then(setCommandHtml);
    }
  }, [tool, state.input, highlight, shikiLoading]);

  // Detect and highlight JSON output
  useEffect(() => {
    if (shikiLoading || !state.output) return;
    
    try {
      // Try to parse as JSON
      JSON.parse(state.output);
      highlight(state.output, "json", "dark").then(setOutputHtml);
    } catch {
      // Not JSON, leave as plain text
      setOutputHtml("");
    }
  }, [state.output, highlight, shikiLoading]);

  const handleCopyOutput = async () => {
    if (!state.output) return;
    try {
      await navigator.clipboard.writeText(state.output);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy output:", err);
    }
  };

  // Smart truncation: show first 50 lines
  const outputLines = state.output?.split("\n") || [];
  const isTruncated = outputLines.length > 50;
  const displayOutput = expanded 
    ? state.output 
    : outputLines.slice(0, 50).join("\n") + (isTruncated ? "\n..." : "");

  // ────────────────────────────────────────────────────────────────────────
  // TRUST BOUNDARY — dangerouslySetInnerHTML usage in ToolCall component
  //
  // All HTML rendered via dangerouslySetInnerHTML originates exclusively from
  // Shiki's highlight() function (via useShiki hook). Shiki produces deterministic,
  // well-formed HTML with no user-controlled content embedded in the markup.
  // The only dynamic data flowing into these templates are:
  //   1. `commandHtml` — Shiki-highlighted bash/sh command strings from tool calls
  //   2. `outputHtml`  — Shiki-highlighted JSON output from tool calls
  //
  // Trust chain:
  //   SessionMessage.state.output → JSON.parse() validation → highlight() → HTML
  //   SessionMessage.state.input.command → highlight() → HTML
  //
  // No user input is ever interpolated directly into HTML. The only risk surface
  // would be a Shiki vulnerability in its output generation, which is outside our
  // control but mitigated by using the official @shikijs packages with no custom
  // HTML templates or user-controlled class names.
  //
  // If a different data source ever needs to be rendered as HTML here, it must pass
  // through DOMPurify or an equivalent sanitizer before dangerouslySetInnerHTML.
  // ────────────────────────────────────────────────────────────────────────

  return (
    <details className="group rounded border border-border-muted bg-surface overflow-hidden">
      <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-surface-overlay/30 text-sm">
        <StatusIcon className={`h-4 w-4 ${statusColor}`} />
        <span className="font-mono text-xs text-text">{tool}</span>
        {description && (
          <span className="text-xs text-text-muted truncate flex-1">{description}</span>
        )}
        {duration && state.status === "completed" && (
          <span className="text-xs text-text-dim ml-auto">{duration}s</span>
        )}
        <span className={`text-xs ${statusColor}`}>{state.status}</span>
      </summary>

      <div className="px-3 py-2 border-t border-border-muted space-y-2">
        {/* Working directory */}
        {workdir && (
          <div className="flex items-center gap-2 text-xs text-text-dim">
            <FolderOpen className="h-3 w-3" />
            <span className="font-mono">{workdir}</span>
          </div>
        )}

        {/* Command (for bash tools) */}
        {commandHtml && (
          <div>
            <div className="text-xs text-text-dim mb-1">Command</div>
            <div
              className="text-xs font-mono bg-surface-raised rounded p-2 overflow-x-auto"
              dangerouslySetInnerHTML={{ __html: commandHtml }}
            />
          </div>
        )}

        {/* Input (for non-bash tools or if no command highlighted) */}
        {!commandHtml && state.input && Object.keys(state.input).length > 0 && (
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
            <div className="flex items-center justify-between mb-1">
              <div className="text-xs text-text-dim">Output</div>
              <button
                onClick={handleCopyOutput}
                className="flex items-center gap-1 px-2 py-0.5 rounded text-xs text-text-dim hover:text-text hover:bg-surface-overlay/50 transition-colors"
                title="Copy output"
              >
                {copied ? (
                  <>
                    <Check className="h-3 w-3" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3" />
                    <span>Copy</span>
                  </>
                )}
              </button>
            </div>
            {outputHtml ? (
              <div
                className="text-xs font-mono bg-surface-raised rounded p-2 overflow-x-auto max-h-96"
                dangerouslySetInnerHTML={{ __html: outputHtml }}
              />
            ) : (
              <pre className="text-xs font-mono text-text-muted bg-surface-raised rounded p-2 overflow-x-auto max-h-96 whitespace-pre-wrap break-all">
                {displayOutput}
              </pre>
            )}
            {isTruncated && !expanded && (
              <button
                onClick={() => setExpanded(true)}
                className="flex items-center gap-1 mt-2 px-2 py-1 text-xs text-text-dim hover:text-text transition-colors"
              >
                <ChevronDown className="h-3 w-3" />
                <span>Show {outputLines.length - 50} more lines</span>
              </button>
            )}
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
