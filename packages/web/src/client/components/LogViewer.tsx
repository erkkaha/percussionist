import { useState, useRef, useEffect, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Checkbox } from "./ui/checkbox";
import { useLogs } from "../hooks/useLogs";

interface LogViewerProps {
  name: string;
  /** Whether the run is still active (controls auto-refresh). */
  active: boolean;
  /** Container to select by default. Defaults to "opencode". */
  defaultContainer?: string;
  /** Whether SSE stream is currently connected. */
  sseConnected: boolean;
  /** Increments whenever relevant SSE events arrive. */
  eventTick: number;
}

const BASE_CONTAINERS = ["bootstrap", "opencode", "dispatcher"] as const;
const TAIL_OPTIONS = [100, 500, 1000] as const;

/** Convert a plain-text log string to xterm-safe output (CRLF line endings). */
function toTerminalLines(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}

export default function LogViewer({
  name,
  active,
  defaultContainer = "bootstrap",
  sseConnected,
  eventTick,
}: LogViewerProps) {
  void eventTick;
  const [container, setContainer] = useState<string>(defaultContainer);
  const [tailLines, setTailLines] = useState<number>(500);
  const [autoScroll, setAutoScroll] = useState(true);

  const termDivRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  /** Tracks how many characters of `data.lines` have already been written. */
  const writtenLenRef = useRef(0);
  /** Tracks which container+tail combo was last written (to detect resets). */
  const lastKeyRef = useRef("");
  /** Mirror of latest data.lines for use inside the mount effect. */
  const dataRef = useRef<string>("");
  /** Mirror of current container:tailLines key. */
  const keyRef = useRef(`${defaultContainer}:500`);
  /** Mirror of autoScroll state for use inside the mount effect. */
  const autoScrollRef = useRef(true);
  /** Cleanup fn stored so the callback ref can tear down on unmount. */
  const termCleanupRef = useRef<(() => void) | null>(null);

  // Callback ref: fires when the inner div enters/leaves the DOM.
  // This works correctly even when the div is conditionally rendered
  // (a plain useEffect([]) runs before the loading state resolves).
  const termCallbackRef = useCallback((node: HTMLDivElement | null) => {
    // Teardown previous instance if any.
    if (termCleanupRef.current) {
      termCleanupRef.current();
      termCleanupRef.current = null;
    }
    if (!node) return;

    // Keep termDivRef in sync for ResizeObserver.
    (termDivRef as React.MutableRefObject<HTMLDivElement | null>).current = node;

    const term = new Terminal({
      convertEol: false,
      scrollback: 10_000,
      fontSize: 12,
      fontFamily: '"JetBrains Mono", "Fira Mono", "Cascadia Code", monospace',
      theme: {
        background: "#111317",
        foreground: "#e2e2e8",
        cursor: "#e8a852",
        cursorAccent: "#111317",
        selectionBackground: "#514537",
        black: "#111317",
        brightBlack: "#9e8e7e",
        red: "#ffb4ab",
        brightRed: "#ffb4ab",
        green: "#58ea8a",
        brightGreen: "#58ea8a",
        yellow: "#fbbf24",
        brightYellow: "#fbbf24",
        blue: "#93c5fd",
        brightBlue: "#93c5fd",
        magenta: "#e879f9",
        brightMagenta: "#e879f9",
        cyan: "#67e8f9",
        brightCyan: "#67e8f9",
        white: "#e2e2e8",
        brightWhite: "#ffffff",
      },
      disableStdin: true,
      cursorBlink: false,
      allowTransparency: false,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(node);

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // Resize observer — debounced via rAF.
    let rafId = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => fitAddon.fit());
    });
    observer.observe(node);

    // Fit at final size, then write any already-loaded data.
    rafId = requestAnimationFrame(() => {
      fitAddon.fit();
      const existingLines = dataRef.current;
      if (existingLines) {
        term.write(toTerminalLines(existingLines));
        writtenLenRef.current = existingLines.length;
        lastKeyRef.current = keyRef.current;
        if (autoScrollRef.current) term.scrollToBottom();
      }
    });

    termCleanupRef.current = () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
      writtenLenRef.current = 0;
      lastKeyRef.current = "";
    };
  }, []);

  // When defaultContainer changes, switch to it.
  useEffect(() => {
    setContainer(defaultContainer);
  }, [defaultContainer]);

  const { data, error, isLoading, isFetching } = useLogs(
    name,
    container,
    tailLines,
    true,
    active && !sseConnected ? 5_000 : false,
  );

  // Write new log content whenever data/error/loading changes.
  const writeData = useCallback(() => {
    const term = termRef.current;

    const currentKey = `${container}:${tailLines}`;
    const newLines = data?.lines ?? "";

    // Always keep mirrors current so the mount effect can use them.
    dataRef.current = newLines;
    keyRef.current = currentKey;
    autoScrollRef.current = autoScroll;

    if (!term) return;

    if (lastKeyRef.current !== currentKey) {
      // Container or tail changed — full reset.
      term.reset();
      writtenLenRef.current = 0;
      lastKeyRef.current = currentKey;
    }

    if (error) {
      if (writtenLenRef.current === 0) {
        term.write(`\x1b[33m${error.message}\x1b[0m`);
        writtenLenRef.current = 1; // sentinel so we don't repeat
      }
      return;
    }

    if (isLoading && writtenLenRef.current === 0) {
      term.write("\x1b[2mLoading logs...\x1b[0m");
      return;
    }

    // Clear "Loading logs..." once data arrives.
    if (newLines.length > writtenLenRef.current) {
      const delta = newLines.slice(writtenLenRef.current);
      term.write(toTerminalLines(delta));
      writtenLenRef.current = newLines.length;
    }

    if (autoScroll) {
      term.scrollToBottom();
    }
  }, [data?.lines, error, isLoading, container, tailLines, autoScroll]);

  useEffect(() => {
    writeData();
  }, [writeData]);

  return (
    <div className="flex flex-col gap-3">
      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Container tabs */}
        <div className="flex rounded-md border border-border overflow-hidden">
          {[...BASE_CONTAINERS].map((c) => (
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
          <Checkbox
            checked={autoScroll}
            onCheckedChange={(v) => setAutoScroll(v === true)}
          />
          auto-scroll
        </label>

        {isFetching && (
          <span className="text-xs text-text-dim animate-pulse">refreshing...</span>
        )}
        {active && (
          <span className="text-xs text-text-dim">
            updates: {sseConnected ? "live stream" : "polling fallback"}
          </span>
        )}
      </div>

      {/* Log output — always render the terminal; error/loading written into it */}
      <div
        className="rounded-lg border border-border overflow-hidden"
        style={{ height: "600px", background: "#111317", padding: "12px", minWidth: 0 }}
      >
        <div ref={termCallbackRef} style={{ height: "100%", overflow: "hidden" }} />
      </div>
    </div>
  );
}
