// attach-ws.ts — WebSocket handler that bridges the browser to a shell
// inside a run pod via the Kubernetes exec API.
//
// Uses Bun's native WebSocket directly (not the `ws` package) to avoid
// Bun's HTTP client intercepting the K8s API WebSocket upgrade and
// throwing "Expected 101 status code".
//
// Flow:
//   Browser (xterm.js) ←WS→ Bun server ←Bun WebSocket→ K8s exec API → pod: sh

import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import { Exec, type KubeConfig, type V1Status } from '@kubernetes/client-node';
import { RUNNER_CONTAINER, type Run, RunPhase } from '@percussionist/api';
import { isValidToken } from './auth.js';
import { getPod, getRun, kubeConfig, NAMESPACE } from './kube.js';

interface BunWebSocketTlsOptions {
  ca?: Buffer;
  cert?: Buffer;
  key?: Buffer;
  rejectUnauthorized?: boolean;
}

const K8S_CHANNEL_PROTOCOLS = [
  'v5.channel.k8s.io',
  'v4.channel.k8s.io',
  'v3.channel.k8s.io',
  'v2.channel.k8s.io',
  'channel.k8s.io',
];

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

export class BunWsWrapper {
  private ws: WebSocket;
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  readyState: number = WebSocket.CONNECTING;
  private opened = false;
  private closeFired = false;

  constructor(url: string, token: string, tlsOptions?: BunWebSocketTlsOptions) {
    const opts: Record<string, unknown> = {
      headers: {
        Authorization: `Bearer ${token}`,
        'Sec-WebSocket-Protocol': K8S_CHANNEL_PROTOCOLS.join(', '),
      },
    };
    if (tlsOptions) opts.tls = tlsOptions;
    this.ws = new WebSocket(url, opts as unknown as string[]);

    this.ws.onopen = () => {
      this.opened = true;
      this.readyState = WebSocket.OPEN;
      this.emit('open');
    };
    this.ws.onclose = (e) => {
      this.closeFired = true;
      this.readyState = WebSocket.CLOSED;
      if (!this.opened) {
        // Connection never opened — onerror carries no detail, but onclose
        // provides code + reason. Emit error with a rich message.
        const reason = e.reason || 'no reason';
        let message = `exec WebSocket connection failed (close ${e.code}: ${reason})`;
        if (e.code === 1006) {
          message += ' \u2014 TLS/handshake error; check cluster CA configuration';
        }
        this.emit('error', new Error(message));
      } else {
        this.emit('close', e.code, e.reason);
      }
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
      // Bun's onerror carries no useful detail. onclose always follows with
      // code + reason and emits the actual error. This is a fallback in the
      // unlikely case onclose never fires.
      if (!this.opened) {
        setTimeout(() => {
          if (!this.opened && !this.closeFired) {
            this.emit(
              'error',
              new Error('exec WebSocket connection failed (unknown transport error)'),
            );
          }
        }, 0);
      }
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
// Extract TLS options from the KubeConfig cluster for Bun's WebSocket.
// In-cluster config loads the CA from /var/run/secrets/.../ca.crt into
// `caData` (base64). Kubeconfig files may use `caData` or `caFile`.

export function buildTlsOptions(cluster: {
  caData?: string;
  caFile?: string;
  certData?: string;
  keyData?: string;
  certFile?: string;
  keyFile?: string;
  skipTLSVerify?: boolean;
}): BunWebSocketTlsOptions | undefined {
  let ca: Buffer | undefined;
  if (cluster.caData) {
    ca = Buffer.from(cluster.caData, 'base64');
  } else if (cluster.caFile) {
    try {
      ca = fs.readFileSync(cluster.caFile);
    } catch {
      // File not readable — fall through to system CA
    }
  }

  let cert: Buffer | undefined;
  let key: Buffer | undefined;
  if (cluster.certData && cluster.keyData) {
    cert = Buffer.from(cluster.certData, 'base64');
    key = Buffer.from(cluster.keyData, 'base64');
  } else if (cluster.certFile && cluster.keyFile) {
    try {
      cert = fs.readFileSync(cluster.certFile);
      key = fs.readFileSync(cluster.keyFile);
    } catch {
      // fall through
    }
  }

  if (!ca && !cert && !cluster.skipTLSVerify) return undefined;

  return {
    ...(ca ? { ca } : {}),
    ...(cert ? { cert } : {}),
    ...(key ? { key } : {}),
    ...(cluster.skipTLSVerify ? { rejectUnauthorized: false } : {}),
  };
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

    const tlsOptions = ssl ? buildTlsOptions(cluster) : undefined;
    const wsCompat = new BunWsWrapper(uri, token, tlsOptions);

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

  // Pre-flight pod check — verify the pod actually exists and the target
  // container is ready before attempting exec.
  try {
    const pod = await getPod(podName, namespace);
    const podPhase = pod.status?.phase;
    if (podPhase !== 'Running') {
      return { error: `pod phase is ${podPhase ?? 'unknown'}; must be Running`, status: 400 };
    }
    const containerReady = pod.status?.containerStatuses?.find(
      (c: { name: string; ready?: boolean }) => c.name === RUNNER_CONTAINER,
    )?.ready;
    if (!containerReady) {
      return {
        error: `container "${RUNNER_CONTAINER}" is not ready; try again shortly`,
        status: 400,
      };
    }
  } catch (e: unknown) {
    const code =
      (e as { statusCode?: number; code?: number }).statusCode ?? (e as { code?: number }).code;
    if (code === 404) {
      return {
        error: `pod "${podName}" not found (likely restarted or garbage-collected)`,
        status: 404,
      };
    }
    return {
      error: `failed to verify pod state: ${(e as Error).message ?? String(e)}`,
      status: 500,
    };
  }

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
