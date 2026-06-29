// attach-ws.ts — WebSocket handler that bridges the browser to a live tmux
// session inside a run pod via the Kubernetes exec API.
//
// Flow:
//   Browser (xterm.js) ←WS→ Bun server ←k8s exec WS→ pod: tmux attach -t opencode
//
// The runner pod runs the opencode TUI inside a detached tmux session named
// "opencode" (see images/runner/opencode-tmux.sh). This handler execs into
// that session with TTY=true, piping stdin/stdout bidirectionally.
//
// Multiple concurrent attachers (CLI + web) can join the same tmux session.
// WS disconnect does NOT kill the TUI — the tmux session persists in the pod.

import { PassThrough } from 'node:stream';
import { Exec, type KubeConfig, type V1Status } from '@kubernetes/client-node';
import { RUNNER_CONTAINER, type Run, RunPhase } from '@percussionist/api';
import { isValidToken } from './auth.js';
import { getRun, kubeConfig, NAMESPACE } from './kube.js';

// ---------------------------------------------------------------------------
// Resizable stream — the k8s Exec class checks for `columns`/`rows` props
// and a `resize()` method to drive the TerminalSizeQueue, which sends resize
// messages to the pod's PTY via the exec WebSocket's resize channel.

class ResizablePassThrough extends PassThrough {
  columns = 80;
  rows = 24;

  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.emit('resize');
  }
}

// ---------------------------------------------------------------------------
// Auth check for WS upgrade (browsers can't set headers on WS, so we use
// ?token= query param, which getAuthValue already supports).

export function isAttachAuthorized(url: URL): boolean {
  if (process.env.AUTH_DISABLED === '1') return true;
  const token = url.searchParams.get('token') ?? '';
  return token !== '' && isValidToken(token);
}

// ---------------------------------------------------------------------------
// Resolve a run name to podName + namespace, guarding against terminal phases.

export interface AttachTarget {
  podName: string;
  namespace: string;
  runName: string;
}

export async function resolveAttachTarget(
  runName: string,
): Promise<AttachTarget | { error: string; status: number }> {
  let run: Run;
  try {
    run = await getRun(runName);
  } catch (e: unknown) {
    const anyE = e as { statusCode?: number; body?: { message?: string }; message?: string };
    const status = anyE.statusCode === 404 ? 404 : 500;
    return { error: anyE.body?.message ?? anyE.message ?? String(e), status };
  }

  const phase = run.status?.phase;
  const terminal = [RunPhase.Succeeded, RunPhase.Failed, RunPhase.Cancelled];
  if (phase && (terminal as string[]).includes(phase)) {
    return { error: `run is ${phase}; pod is gone`, status: 410 };
  }

  const podName = run.status?.podName ?? run.metadata.name;
  const namespace = run.metadata.namespace ?? NAMESPACE;
  return { podName, namespace, runName };
}

// ---------------------------------------------------------------------------
// Bun WebSocket handlers — wired into Bun.serve() via the `websocket` option.

interface WsData {
  podName: string;
  namespace: string;
  runName: string;
  stdin?: PassThrough;
  stdout?: ResizablePassThrough;
  execWs?: import('ws').WebSocket;
  closed: boolean;
}

export const attachWsHandlers = {
  open(ws: import('bun').ServerWebSocket<WsData>): void {
    const data = ws.data;
    const kc: KubeConfig = kubeConfig();
    const exec = new Exec(kc);

    data.stdin = new PassThrough();
    data.stdout = new ResizablePassThrough();
    data.closed = false;

    // Pipe pod stdout → WS binary frames.
    data.stdout.on('data', (buf: Buffer) => {
      if (!data.closed) ws.send(buf);
    });

    const statusCallback = (status: V1Status) => {
      if (status?.status === 'Failure' || (status?.code !== undefined && status.code !== 0)) {
        const msg = status.message ?? `exec failed (code ${status.code})`;
        if (!data.closed) ws.send(JSON.stringify({ type: 'error', message: msg }));
      } else {
        if (!data.closed) ws.send(JSON.stringify({ type: 'status', exitCode: status.code ?? 0 }));
      }
    };

    exec
      .exec(
        data.namespace,
        data.podName,
        RUNNER_CONTAINER,
        ['tmux', 'attach', '-t', 'opencode'],
        data.stdout,
        null, // stderr — merge into stdout
        data.stdin,
        true, // tty
        statusCallback,
      )
      .then((execWs: import('ws').WebSocket) => {
        data.execWs = execWs;
        execWs.on('close', () => {
          if (!data.closed) {
            data.closed = true;
            ws.close(1011, 'exec stream closed');
          }
        });
      })
      .catch((e: unknown) => {
        const msg = (e as Error).message ?? String(e);
        if (!data.closed) {
          ws.send(JSON.stringify({ type: 'error', message: `exec failed: ${msg}` }));
          ws.close(1011, 'exec failed');
        }
      });
  },

  message(ws: import('bun').ServerWebSocket<WsData>, msg: string | Buffer): void {
    const data = ws.data;
    if (data.closed) return;

    if (typeof msg === 'string') {
      // JSON control message (resize).
      try {
        const ctrl = JSON.parse(msg) as { type?: string; cols?: number; rows?: number };
        if (
          ctrl.type === 'resize' &&
          typeof ctrl.cols === 'number' &&
          typeof ctrl.rows === 'number'
        ) {
          data.stdout.resize(ctrl.cols, ctrl.rows);
        }
      } catch {
        // Ignore malformed control messages.
      }
    } else {
      // Binary frame — raw stdin bytes.
      data.stdin.write(msg);
    }
  },

  close(ws: import('bun').ServerWebSocket<WsData>): void {
    const data = ws.data;
    data.closed = true;
    try {
      data.stdin?.end();
    } catch {
      // ignore
    }
    try {
      data.execWs?.close();
    } catch {
      // ignore
    }
  },
};
