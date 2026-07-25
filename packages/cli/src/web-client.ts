// web-client.ts — reach the web API from the CLI.
//
// The rest of beatctl talks to the Kubernetes API directly, but auth commands
// need the web server itself: it owns the session/API-key database. Two ways in:
//
//   * PERCUSSIONIST_WEB_URL — an already-reachable URL (e.g. the Ingress).
//   * otherwise, `kubectl port-forward svc/percussionist-web` for the duration
//     of the command, mirroring the pattern in web.ts, chat.ts and attach.ts.
//
// The session token from `beatctl auth login` is stored in
// $XDG_CONFIG_HOME/percussionist/session.json with 0600 permissions, and sent as
// `Authorization: Bearer <token>` (the server accepts header-borne sessions via
// better-auth's bearer plugin).

import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { createServer } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_NAMESPACE } from './kube.js';

const WEB_SERVICE = 'percussionist-web';
const WEB_PORT = 8080;

// ---------------------------------------------------------------------------
// Stored session

interface StoredSession {
  token: string;
  /** ISO timestamp; informational — the server is the authority on expiry. */
  expiresAt?: string;
  /** Base URL the session was obtained from, to warn on mismatch. */
  baseUrl?: string;
}

function configDir(): string {
  const base =
    process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.length > 0
      ? process.env.XDG_CONFIG_HOME
      : path.join(os.homedir(), '.config');
  return path.join(base, 'percussionist');
}

function sessionPath(): string {
  return path.join(configDir(), 'session.json');
}

export function readSession(): StoredSession | null {
  try {
    const raw = fs.readFileSync(sessionPath(), 'utf8');
    const parsed = JSON.parse(raw) as StoredSession;
    return typeof parsed.token === 'string' && parsed.token.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export function writeSession(session: StoredSession): void {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(sessionPath(), `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
}

export function clearSession(): void {
  try {
    fs.unlinkSync(sessionPath());
  } catch {
    // already absent
  }
}

/** Auth headers for an API call, or {} when not logged in. */
export function sessionHeaders(): Record<string, string> {
  const session = readSession();
  return session ? { Authorization: `Bearer ${session.token}` } : {};
}

// ---------------------------------------------------------------------------
// Port-forward plumbing

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error('could not determine free port'));
      }
    });
  });
}

async function startPortForward(namespace: string, localPort: number): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'kubectl',
      ['port-forward', '-n', namespace, `svc/${WEB_SERVICE}`, `${localPort}:${WEB_PORT}`],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let ready = false;
    const onChunk = (buf: Buffer) => {
      const s = buf.toString();
      if (s.includes('Forwarding from') && !ready) {
        ready = true;
        resolve(child);
      }
      if (s.toLowerCase().includes('error') || s.toLowerCase().includes('unable')) {
        process.stderr.write(s);
      }
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.on('exit', (code) => {
      if (!ready) reject(new Error(`kubectl port-forward exited with code ${String(code)}`));
    });
    child.on('error', reject);
  });
}

/**
 * Run `fn` with a usable web API base URL, tearing down any port-forward after.
 */
export async function withWebApi<T>(
  namespace: string | undefined,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const configured = process.env.PERCUSSIONIST_WEB_URL;
  if (configured && configured.length > 0) {
    return fn(configured.replace(/\/+$/, ''));
  }

  const ns = namespace ?? DEFAULT_NAMESPACE;
  const localPort = await pickFreePort();
  const pf = await startPortForward(ns, localPort);
  try {
    return await fn(`http://127.0.0.1:${localPort}`);
  } finally {
    pf.kill();
  }
}

// ---------------------------------------------------------------------------
// Request helper

export async function webRequest<T>(
  baseUrl: string,
  path_: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${baseUrl}${path_}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...sessionHeaders(),
      ...(init.headers as Record<string, string> | undefined),
    },
  });

  if (res.status === 401) {
    throw new Error('Not authenticated. Run `beatctl auth login` first.');
  }
  if (res.status === 403) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? 'Forbidden');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}
