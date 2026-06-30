import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useCallback, useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import { getToken } from '../lib/auth';
import { Button } from './ui/button';

interface TerminalTabProps {
  runName: string;
  active: boolean;
}

function wsUrlFor(runName: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  const token = getToken();
  const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${proto}//${host}/api/runs/${encodeURIComponent(runName)}/attach${tokenQuery}`;
}

export default function TerminalTab({ runName, active }: TerminalTabProps) {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termDivRef = useRef<HTMLDivElement | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCountRef = useRef(0);
  const mountedRef = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const sendResize = useCallback(() => {
    const term = termRef.current;
    const ws = wsRef.current;
    if (!term || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  }, []);

  const scheduleRetry = useCallback(
    (retryConnect: () => void) => {
      if (!activeRef.current) return;
      clearRetryTimer();
      const delay = Math.min(500 * 2 ** retryCountRef.current, 10_000);
      retryCountRef.current++;
      const jitter = Math.random() * 500;
      retryTimerRef.current = setTimeout(() => {
        if (mountedRef.current && activeRef.current) {
          retryConnect();
        }
      }, delay + jitter);
    },
    [clearRetryTimer],
  );

  const connect = useCallback(() => {
    if (!activeRef.current) return;

    // Close any existing connection and detach handlers to prevent orphaned
    // WS callbacks from clobbering the new connection's state.
    const prev = wsRef.current;
    if (prev) {
      prev.onopen = null;
      prev.onmessage = null;
      prev.onerror = null;
      prev.onclose = null;
      if (prev.readyState === WebSocket.OPEN || prev.readyState === WebSocket.CONNECTING) {
        try {
          prev.close();
        } catch {
          // ignore
        }
      }
      wsRef.current = null;
    }

    clearRetryTimer();
    retryCountRef.current = 0;
    setError(null);
    setClosed(false);

    // Create terminal if it doesn't exist yet.
    if (!termRef.current && termDivRef.current) {
      const term = new Terminal({
        convertEol: false,
        scrollback: 10_000,
        fontSize: 12,
        fontFamily: '"JetBrains Mono", "Fira Mono", "Cascadia Code", monospace',
        theme: {
          background: '#111317',
          foreground: '#e2e2e8',
          cursor: '#e8a852',
          cursorAccent: '#111317',
          selectionBackground: '#514537',
          black: '#111317',
          brightBlack: '#9e8e7e',
          red: '#ffb4ab',
          brightRed: '#ffb4ab',
          green: '#58ea8a',
          brightGreen: '#58ea8a',
          yellow: '#fbbf24',
          brightYellow: '#fbbf24',
          blue: '#93c5fd',
          brightBlue: '#93c5fd',
          magenta: '#e879f9',
          brightMagenta: '#e879f9',
          cyan: '#67e8f9',
          brightCyan: '#67e8f9',
          white: '#e2e2e8',
          brightWhite: '#ffffff',
        },
        cursorBlink: true,
        allowTransparency: false,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(termDivRef.current);
      fit.fit();
      termRef.current = term;
      fitRef.current = fit;

      // stdin → WS (binary)
      term.onData((data) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(new TextEncoder().encode(data));
        }
      });

      // Resize observer
      const observer = new ResizeObserver(() => {
        fitRef.current?.fit();
        sendResize();
      });
      observer.observe(termDivRef.current);

      cleanupRef.current = () => {
        observer.disconnect();
        term.dispose();
        termRef.current = null;
        fitRef.current = null;
      };
    }

    // Clear terminal for a fresh connection.
    termRef.current?.reset();

    const ws = new WebSocket(wsUrlFor(runName));
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setError(null);
      // Send initial terminal size.
      const term = termRef.current;
      if (term) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };

    ws.onmessage = (e) => {
      const term = termRef.current;
      if (!term) return;
      if (typeof e.data === 'string') {
        // JSON control message
        try {
          const ctrl = JSON.parse(e.data) as { type?: string; message?: string; exitCode?: number };
          if (ctrl.type === 'error' && ctrl.message) {
            setError(ctrl.message);
          } else if (ctrl.type === 'status') {
            setClosed(true);
            setConnected(false);
          }
        } catch {
          // ignore
        }
      } else {
        // Binary — raw PTY output
        term.write(new Uint8Array(e.data as ArrayBuffer));
      }
    };

    ws.onerror = () => {
      setError('WebSocket error');
      setConnected(false);
    };

    ws.onclose = () => {
      setConnected(false);
      setClosed(true);
      scheduleRetry(connect);
    };
  }, [runName, sendResize, scheduleRetry, clearRetryTimer]);

  // Connect on mount, disconnect on unmount or when run becomes inactive.
  useEffect(() => {
    if (active) {
      connect();
    }
    return () => {
      clearRetryTimer();
      retryCountRef.current = 0;
      const ws = wsRef.current;
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
      wsRef.current = null;
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [active, connect, clearRetryTimer]);

  return (
    <div className="flex flex-col gap-3">
      {/* Status bar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              connected
                ? 'bg-phase-succeeded'
                : closed
                  ? 'bg-text-dim'
                  : 'bg-phase-failed animate-pulse'
            }`}
          />
          <span className="text-xs text-text-muted">
            {connected ? 'Connected' : closed ? 'Disconnected' : 'Connecting\u2026'}
          </span>
        </div>
        {error && <span className="text-xs text-phase-failed">{error}</span>}
        {closed && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              clearRetryTimer();
              retryCountRef.current = 0;
              connect();
            }}
          >
            Reconnect
          </Button>
        )}
        <span className="text-xs text-text-dim">
          Shell into the pod's <kbd className="font-mono">opencode</kbd> container
        </span>
      </div>

      {/* Terminal */}
      <div
        className="rounded-lg border border-border overflow-hidden"
        style={{ height: '600px', background: '#111317', padding: '12px', minWidth: 0 }}
      >
        <div ref={termDivRef} style={{ height: '100%', overflow: 'hidden' }} />
      </div>
    </div>
  );
}
