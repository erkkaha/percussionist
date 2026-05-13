import { useState, useRef, useEffect } from "react";
import { useLogs } from "../hooks/useLogs";

interface LogViewerProps {
  name: string;
  /** Whether the run is still active (controls auto-refresh). */
  active: boolean;
  /** Container to select by default. Defaults to "opencode". */
  defaultContainer?: string;
}

const BASE_CONTAINERS = ["opencode", "dispatcher"] as const;
const GIT_CLONE_CONTAINER = "git-clone";
const TAIL_OPTIONS = [100, 500, 1000] as const;

export default function LogViewer({ name, active, defaultContainer = "opencode" }: LogViewerProps) {
  const [container, setContainer] = useState<string>(defaultContainer);
  const [tailLines, setTailLines] = useState<number>(500);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLPreElement>(null);

  // When defaultContainer changes (e.g. run loads and we know it failed on
  // git-clone), switch to it — but only if the user hasn't manually picked
  // a different container yet.
  useEffect(() => {
    setContainer(defaultContainer);
  }, [defaultContainer]);

  const { data, error, isLoading, isFetching } = useLogs(
    name,
    container,
    tailLines,
    true,
    active ? 5_000 : false,
  );

  // Show git-clone tab only when it's the defaultContainer (init failed) or
  // the user has manually selected it.
  const showGitClone = defaultContainer === GIT_CLONE_CONTAINER || container === GIT_CLONE_CONTAINER;
  const containers = showGitClone
    ? [GIT_CLONE_CONTAINER, ...BASE_CONTAINERS]
    : [...BASE_CONTAINERS];

  // Auto-scroll to bottom when new content arrives.
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [data?.lines, autoScroll]);

  return (
    <div className="flex flex-col gap-3">
      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Container tabs */}
        <div className="flex rounded-md border border-border overflow-hidden">
          {containers.map((c) => (
            <button
              key={c}
              onClick={() => setContainer(c)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                container === c
                  ? "bg-surface-overlay text-text"
                  : "text-text-muted hover:text-text hover:bg-surface-overlay/50"
              }`}
            >
              {c}
            </button>
          ))}
        </div>

        {/* Tail lines */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-text-dim">tail:</span>
          <select
            value={tailLines}
            onChange={(e) => setTailLines(Number(e.target.value))}
            className="bg-surface-raised border border-border rounded px-2 py-1 text-xs text-text"
          >
            {TAIL_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>

        {/* Auto-scroll toggle */}
        <label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
            className="rounded border-border"
          />
          auto-scroll
        </label>

        {isFetching && (
          <span className="text-xs text-text-dim animate-pulse">refreshing...</span>
        )}
      </div>

      {/* Log output */}
      {error ? (
        <div className="rounded-lg border border-phase-failed/30 bg-phase-failed/10 p-4 text-sm text-phase-failed">
          {error.message}
        </div>
      ) : isLoading ? (
        <div className="rounded-lg border border-border bg-surface p-4 text-sm text-text-dim animate-pulse">
          Loading logs...
        </div>
      ) : (
        <pre
          ref={scrollRef}
          className="log-viewer rounded-lg border border-border bg-surface p-4 text-xs font-mono overflow-auto max-h-[600px] whitespace-pre-wrap break-all"
        >
          {data?.lines || "No log output yet."}
        </pre>
      )}
    </div>
  );
}
