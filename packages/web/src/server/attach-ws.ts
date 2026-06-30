// attach-ws.ts — WebSocket handler that bridges the browser to a shell
// inside a run pod via the Kubernetes exec API.
//
// Uses Bun's native WebSocket directly (not the `ws` package) to avoid
// Bun's HTTP client intercepting the K8s API WebSocket upgrade and
// throwing "Expected 101 status code".
//
// Flow:
//   Browser (xterm.js) ←WS→ Bun server ←Bun WebSocket→ K8s exec API → pod: sh

import { PassThrough } from 'node:stream';
import { Exec, type KubeConfig, type V1Status } from '@kubernetes/client-node';
import { RUNNER_CONTAINER, type Run, RunPhase } from '@percussionist/api';
import { isValidToken } from './auth.js';
import { getRun, kubeConfig, NAMESPACE } from './kube.js';

// Minimal shape for the object the Exec class uses after connect returns.
interface ExecWebSocket {
  on(event: string, handler: (...args: unknown[]) => void): void;
  send(data: Buffer | string): void;
  close(): void;
}

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
// Wraps Bun's native WebSocket to match the ws-package event interface
// (`.on(event, handler)`) that the Exec class's WebSocketHandler uses.

class BunWsWrapper {
  private ws: WebSocket;
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  readyState: number = WebSocket.CONNECTING;

  constructor(url: string, token: string) {
    this.ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${token}` },
    } as unknown as string[]);

    this.ws.onopen = () => {
      this.readyState = WebSocket.OPEN;
      this.emit('open');
    };
    this.ws.onclose = (e) => {
      this.readyState = WebSocket.CLOSED;
      this.emit('close', e.code, e.reason);
    };
    this.ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        this.emit('message', e.data, false);
      } else if (e.data instanceof ArrayBuffer) {
        this.emit('message', Buffer.from(e.data as ArrayBuffer), true);
      } else if (e.data instanceof Blob) {
        e.data.arrayBuffer().then((ab) => {
          this.emit('message', Buffer.from(new Uint8Array(ab)), true);
        });
      }
    };
    this.ws.onerror = () => {
      this.emit('error', new Error('WebSocket error'));
    };
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
  }

  off(event: string, handler: (...args: unknown[]) => void): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) this.listeners.delete(event);
    }
  }

  removeAllListeners(event?: string): void {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }

  send(data: Buffer | string): void {
    this.ws.send(data as any);
  }

  close(): void {
    this.ws.close();
  }

  private emit(event: string, ...args: unknown[]): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      for (const h of handlers) h(...args);
    }
  }
}

// ---------------------------------------------------------------------------
// Custom handler passed as the wsInterface argument to the Exec constructor.
// Uses Bun's native WebSocket instead of the ws package, avoiding the
// "Expected 101 status code" error from Bun's HTTP client.

class BunExecHandler {
  constructor(private kc: KubeConfig) {}

  async connect(
    path: string,
    _textHandler: ((text: string) => boolean) | null,
    binaryHandler: ((stream: number, buff: Buffer) => boolean) | null,
  ): Promise<ExecWebSocket> {
    const cluster = this.kc.getCurrentCluster();
    if (!cluster) throw new Error('No cluster is defined');

    const server = cluster.server;
    const ssl = server.startsWith('https://');
    const target = ssl ? server.slice(8) : server.slice(7);
    const proto = ssl ? 'wss' : 'ws';
    const uri = `${proto}://${target}${path}`;

    const user = this.kc.getCurrentUser();
    const token = user?.token ?? '';

    const wsCompat = new BunWsWrapper(uri, token);

    return await new Promise<ExecWebSocket>((resolve, reject) => {
      wsCompat.on('open', () => resolve(wsCompat));
      wsCompat.on('error', (err: unknown) => reject(err as Error));

      if (binaryHandler) {
        wsCompat.on('message', (_data: unknown) => {
          if (!(_data instanceof Buffer)) return;
          if (_data.length < 1) return;
          const streamNum = _data.readUint8(0);
          const payload = _data.slice(1);
          if (!binaryHandler(streamNum, payload)) {
            wsCompat.close();
          }
        });
      }
    });
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

  const podPhase = run.status?.podPhase;
  if (podPhase && podPhase !== 'Running') {
    return { error: `pod is ${podPhase}; must be Running to attach`, status: 400 };
  }
  if (!podPhase) {
    return { error: 'pod not yet created; try again shortly', status: 400 };
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
  execWs?: ExecWebSocket;
  closed: boolean;
}

export const attachWsHandlers = {
  open(ws: import('bun').ServerWebSocket<WsData>): void {
    const data = ws.data;
    const kc: KubeConfig = kubeConfig();
    const exec = new Exec(kc, new BunExecHandler(kc) as any);

    data.stdin = new PassThrough();
    data.stdout = new ResizablePassThrough();
    data.closed = false;

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
        ['sh'],
        data.stdout,
        null,
        data.stdin,
        true,
        statusCallback,
      )
      .then((execWs: ExecWebSocket) => {
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
      try {
        const ctrl = JSON.parse(msg) as { type?: string; cols?: number; rows?: number };
        if (
          ctrl.type === 'resize' &&
          typeof ctrl.cols === 'number' &&
          typeof ctrl.rows === 'number'
        ) {
          data.stdout!.resize(ctrl.cols, ctrl.rows);
        }
      } catch {
        // Ignore malformed control messages.
      }
    } else {
      data.stdin!.write(msg);
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
