import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';
import {
  Check,
  CheckCircle,
  ChevronDown,
  Clock,
  Copy,
  FolderOpen,
  Users,
  XCircle,
  Zap,
} from 'lucide-react';
import { useShiki } from '../../hooks/useShiki';
import type { SubtaskPart, ToolPart } from '../../lib/types';
import { CodeBlock } from '../CodeBlock';

// Re-exported so terminal-style transcripts can reach the same structured
// renderers without a second, divergent implementation.
export { FileDiff } from '../FileDiff';
export { TaskList } from '../TaskList';

// ---------------------------------------------------------------------------
// Markdown text renderer
//
// The session payload is proxied from the runner without validation, so this
// component map is the single definition of how assistant text is rendered.
// Both SessionView and the terminal transcript must use it verbatim.

export function MessageText({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        h1: ({ children }) => <h1 className="text-headline-lg font-bold mt-4 mb-2">{children}</h1>,
        h2: ({ children }) => <h2 className="text-headline-md font-bold mt-3 mb-2">{children}</h2>,
        h3: ({ children }) => <h3 className="text-body-lg font-semibold mt-3 mb-1">{children}</h3>,
        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="list-disc list-inside mb-2 space-y-1">{children}</ul>,
        ol: ({ children }) => (
          <ol className="list-decimal list-inside mb-2 space-y-1">{children}</ol>
        ),
        li: ({ children }) => <li className="ml-2">{children}</li>,
        code: ({ className, children, ...props }) => {
          const match = /language-(\w+)/.exec(className || '');
          const lang = match ? match[1] : undefined;
          const isInline = !className;

          if (isInline) {
            return (
              <code className="bg-surface-sunken rounded px-1 py-0.5 text-xs font-mono" {...props}>
                {children}
              </code>
            );
          }

          const code = String(children).replace(/\n$/, '');
          return <CodeBlock code={code} language={lang} />;
        },
        pre: ({ children }) => <div className="mb-2">{children}</div>,
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 border-border pl-3 italic text-text-dim mb-2">
            {children}
          </blockquote>
        ),
        a: ({ href, children }) => {
          // Check if it's a file path reference (e.g., src/file.ts:42)
          const filePathMatch = /^([a-zA-Z0-9_\-/.]+\.[a-zA-Z0-9]+):?(\d*)$/.exec(String(children));
          if (filePathMatch) {
            return (
              <span className="inline-flex items-center gap-1 bg-surface-sunken rounded px-1.5 py-0.5 text-xs font-mono">
                <span className="text-text">{filePathMatch[1]}</span>
                {filePathMatch[2] && <span className="text-text-dim">:{filePathMatch[2]}</span>}
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
        strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
        hr: () => <hr className="border-border-muted my-3" />,
        table: ({ children }) => (
          <div className="overflow-x-auto mb-2">
            <table className="border-collapse text-xs w-full">{children}</table>
          </div>
        ),
        thead: ({ children }) => <thead className="bg-surface-raised">{children}</thead>,
        tbody: ({ children }) => <tbody className="divide-y divide-border-muted">{children}</tbody>,
        tr: ({ children }) => (
          <tr className="hover:bg-surface-overlay/30 transition-colors">{children}</tr>
        ),
        th: ({ children }) => (
          <th className="border border-border px-2 py-1.5 font-semibold text-left">{children}</th>
        ),
        td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

// ---------------------------------------------------------------------------
// Subagent row — the claude engine's `subtask` part, which names a spawned
// subagent instead of carrying a todo checklist.

export function SubagentRow({ part }: { part: SubtaskPart }) {
  return (
    <div className="flex items-start gap-2 rounded border border-border-muted bg-surface px-3 py-2 text-xs">
      <Users className="h-3.5 w-3.5 mt-0.5 shrink-0 text-phase-running" />
      <span className="font-mono text-text shrink-0">{part.agentType ?? 'subagent'}</span>
      {part.description && <span className="text-text-muted break-words">{part.description}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool call display

export function ToolCall({ part }: { part: ToolPart }) {
  const { tool, state } = part;
  const { highlight, isLoading: shikiLoading } = useShiki();
  const [commandHtml, setCommandHtml] = useState('');
  const [outputHtml, setOutputHtml] = useState('');
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const statusIcon =
    {
      pending: Clock,
      running: Zap,
      completed: CheckCircle,
      error: XCircle,
    }[state.status] ?? Clock;

  const StatusIcon = statusIcon;

  const statusColor =
    {
      pending: 'text-gray-600 dark:text-gray-400',
      running: 'text-blue-600 dark:text-blue-400 animate-pulse',
      completed: 'text-green-600 dark:text-green-400',
      error: 'text-red-600 dark:text-red-400',
    }[state.status] ?? 'text-gray-600 dark:text-gray-400';

  // Get workdir if present
  const workdir = state.input?.workdir as string | undefined;
  const description = state.input?.description as string | undefined;

  // Calculate duration
  const duration =
    state.time?.start && state.time?.end
      ? ((state.time.end - state.time.start) / 1000).toFixed(1)
      : null;

  // Highlight command input for bash/sh tools
  useEffect(() => {
    if (shikiLoading || !['bash', 'sh'].includes(tool)) return;

    const command = state.input?.command as string | undefined;
    if (command) {
      highlight(command, 'bash', 'dark').then(setCommandHtml);
    }
  }, [tool, state.input, highlight, shikiLoading]);

  // Detect and highlight JSON output
  useEffect(() => {
    if (shikiLoading || !state.output) return;

    try {
      // Try to parse as JSON
      JSON.parse(state.output);
      highlight(state.output, 'json', 'dark').then(setOutputHtml);
    } catch {
      // Not JSON, leave as plain text
      setOutputHtml('');
    }
  }, [state.output, highlight, shikiLoading]);

  const handleCopyOutput = async () => {
    if (!state.output) return;
    try {
      await navigator.clipboard.writeText(state.output);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy output:', err);
    }
  };

  // Smart truncation: show first 50 lines
  const outputLines = state.output?.split('\n') || [];
  const isTruncated = outputLines.length > 50;
  const displayOutput = expanded
    ? state.output
    : outputLines.slice(0, 50).join('\n') + (isTruncated ? '\n...' : '');

  return (
    <details className="group rounded border border-border-muted bg-surface overflow-hidden">
      <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-surface-overlay/30 text-sm">
        <StatusIcon className={`h-4 w-4 ${statusColor}`} />
        <span className="font-mono text-xs text-text">{tool}</span>
        {description && (
          <span className="text-xs text-text-muted truncate flex-1">{description}</span>
        )}
        {duration && state.status === 'completed' && (
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
              // biome-ignore lint/security/noDangerouslySetInnerHtml: Command text is rendered through escaped ANSI-to-HTML conversion.
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
                // biome-ignore lint/security/noDangerouslySetInnerHtml: Tool output is rendered through escaped ANSI-to-HTML conversion.
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

export function formatToolInput(input: Record<string, unknown>): string {
  // Show common tool fields nicely.
  const entries = Object.entries(input);
  if (entries.length === 1) {
    const onlyEntry = entries[0];
    if (!onlyEntry) return '';
    const [key, val] = onlyEntry;
    if (typeof val === 'string') {
      // Single string input — show directly.
      if (val.length > 2000) return `${key}: ${val.slice(0, 2000)}... (truncated)`;
      return `${key}: ${val}`;
    }
  }
  const json = JSON.stringify(input, null, 2);
  if (json.length > 2000) return `${json.slice(0, 2000)}\n... (truncated)`;
  return json;
}
