// manager-mcp.ts — call the manager's MCP server (port 4097) from the CLI.
//
// The manager exposes a Streamable-HTTP JSON-RPC MCP endpoint at
// `svc/percussionist-manager:4097/mcp` (see
// packages/manager-controller/src/agent/tools.ts). Non-loopback callers must
// present the shared bearer token from the `manager-mcp-token` Secret; but
// `kubectl port-forward` traffic arrives on the pod's loopback interface, which
// the server exempts from the token check (that is how `beatctl chat` reaches
// the chat port). We attach the token anyway when the Secret exists so the call
// is robust if that loopback assumption ever changes.
//
// This mirrors the port-forward pattern in web-client.ts / chat.ts but is
// generic over the MCP method, so every doctor check that probes the manager
// (list_models, tools/list, …) shares one implementation. Every network step is
// bounded by `AbortSignal.timeout` (`--timeout` on the doctor command).
//
// Two call shapes are exposed:
//   - `managerMcpRequest(namespace, tool, args)` — `tools/call`, unwraps the
//     text content of the tool result (used by list_models and friends).
//   - `managerMcpListTools(namespace)` — `tools/list`, returns the raw tool
//     descriptor array (used as a liveness probe by the health check).
// Both share the generic `managerMcpJsonRpc` port-forward + fetch plumbing.

import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { loadKube } from './kube.js';

const MANAGER_SERVICE = 'percussionist-manager';
const MCP_PORT = 4097;
const MCP_PATH = '/mcp';
const MCP_TOKEN_SECRET = 'manager-mcp-token';

export const DEFAULT_MCP_TIMEOUT_MS = 30_000;

/**
 * Classifies a manager MCP failure so a check can report the *specific* cause:
 *
 *   - `unreachable` — the MCP server itself could not be reached (port-forward
 *     failed, HTTP error, timeout, empty body). The manager pod is down or the
 *     network path is broken.
 *   - `tool-error` — the MCP server answered but the tool call failed
 *     (JSON-RPC error or `isError` result). For `list_models` this means the
 *     manager is up but the opencode sidecar it proxies is not serving
 *     `/provider`.
 */
export class ManagerMcpError extends Error {
  readonly kind: 'unreachable' | 'tool-error';
  constructor(kind: 'unreachable' | 'tool-error', message: string) {
    super(message);
    this.name = 'ManagerMcpError';
    this.kind = kind;
  }
}

function pickFreePort(): Promise<number> {
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

function startPortForward(
  namespace: string,
  localPort: number,
  timeoutMs: number,
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'kubectl',
      ['port-forward', '-n', namespace, `svc/${MANAGER_SERVICE}`, `${localPort}:${MCP_PORT}`],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let ready = false;
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(child);
    };

    const onChunk = (buf: Buffer) => {
      const s = buf.toString();
      if (s.includes('Forwarding from')) {
        ready = true;
        succeed();
      } else if (
        !ready &&
        (s.toLowerCase().includes('error') || s.toLowerCase().includes('unable'))
      ) {
        fail(new Error(`kubectl port-forward: ${s.trim()}`));
      }
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.on('error', (e) => fail(e));
    child.on('exit', (code) => {
      if (!ready) fail(new Error(`kubectl port-forward exited with code ${String(code)}`));
    });

    // The port-forward must not hang the doctor run — kill it if it never
    // reports "Forwarding from" within the probe bound.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`kubectl port-forward did not start within ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

/**
 * Read the MCP bearer token from the `manager-mcp-token` Secret, or null when
 * the Secret is absent (fresh installs / dev clusters — the manager then runs
 * in no-auth mode and the loopback exemption covers us anyway).
 */
export async function readMcpToken(namespace: string): Promise<string | null> {
  try {
    const { core } = loadKube();
    const secret = await core.readNamespacedSecret({ name: MCP_TOKEN_SECRET, namespace });
    const raw = secret.data?.token ?? secret.stringData?.token;
    if (!raw) return null;
    try {
      return atob(raw);
    } catch {
      return raw; // plaintext (stringData) — pass through
    }
  } catch {
    return null;
  }
}

export interface ManagerMcpRequestOpts {
  /** Per-probe timeout in ms (default: DEFAULT_MCP_TIMEOUT_MS). */
  timeoutMs?: number;
  /** MCP bearer token. When omitted, read from the manager-mcp-token Secret. */
  token?: string;
}

/**
 * Call a JSON-RPC method on the manager's MCP server over a short-lived
 * port-forward and return the parsed `result` object (the shape depends on the
 * method — `tools/call` returns `{ content, isError? }`, `tools/list` returns
 * `{ tools }`). Throws `ManagerMcpError` on any failure so callers can
 * distinguish "sidecar not ready" from "MCP unreachable".
 */
export async function managerMcpJsonRpc<T = unknown>(
  namespace: string,
  method: string,
  params: Record<string, unknown> = {},
  opts: ManagerMcpRequestOpts = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  const localPort = await pickFreePort();

  let pf: ChildProcess;
  try {
    pf = await startPortForward(namespace, localPort, timeoutMs);
  } catch (e) {
    throw new ManagerMcpError(
      'unreachable',
      `cannot port-forward svc/${MANAGER_SERVICE}:${MCP_PORT}: ${errorMessage(e)}`,
    );
  }

  try {
    const token = opts.token ?? (await readMcpToken(namespace));
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${localPort}${MCP_PATH}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (isTimeoutError(e)) {
        throw new ManagerMcpError(
          'unreachable',
          `manager MCP request timed out after ${timeoutMs}ms`,
        );
      }
      throw new ManagerMcpError('unreachable', `manager MCP request failed: ${errorMessage(e)}`);
    }

    if (!res.ok) {
      throw new ManagerMcpError('unreachable', `manager MCP returned HTTP ${res.status}`);
    }

    const rpc = (await res.json()) as {
      result?: T;
      error?: { code?: number; message?: string };
    };

    if (rpc.error) {
      throw new ManagerMcpError(
        'tool-error',
        `JSON-RPC error ${rpc.error.code ?? ''}: ${rpc.error.message ?? 'unknown'}`.trim(),
      );
    }
    return rpc.result as T;
  } finally {
    if (!pf.killed) pf.kill('SIGTERM');
  }
}

/**
 * Call a manager MCP tool over a short-lived port-forward and return the
 * parsed tool result.
 *
 * `managerMcpRequest(namespace, 'list_models', {})` returns the payload the
 * tool echoes back (providers + models). Throws `ManagerMcpError` on any
 * failure so callers can distinguish "sidecar not ready" from "MCP
 * unreachable".
 */
export async function managerMcpRequest<T = unknown>(
  namespace: string,
  tool: string,
  args: Record<string, unknown> = {},
  opts: ManagerMcpRequestOpts = {},
): Promise<T> {
  const result = await managerMcpJsonRpc<{
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  }>(namespace, 'tools/call', { name: tool, arguments: args }, opts);

  if (result?.isError) {
    const text = result.content?.find((p) => p.type === 'text')?.text ?? 'tool failed';
    // Strip the server's "Error calling <tool>: " prefix — the remainder is
    // the specific cause (e.g. "opencode /provider returned 502").
    throw new ManagerMcpError('tool-error', text.replace(/^Error calling [^:]+:\s*/, ''));
  }

  const text = result?.content?.find((p) => p.type === 'text')?.text;
  if (text === undefined) {
    throw new ManagerMcpError('unreachable', 'manager MCP returned no content');
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

/** A tool descriptor from the manager's MCP `tools/list` response. */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Probe the manager's MCP server with a JSON-RPC `tools/list` and return the
 * exposed tool descriptors. The check-health path uses this as a liveness
 * probe: a successful response proves the manager pod + MCP server are serving
 * without depending on the opencode sidecar.
 */
export async function managerMcpListTools(
  namespace: string,
  opts: ManagerMcpRequestOpts = {},
): Promise<McpToolDescriptor[]> {
  const result = await managerMcpJsonRpc<{ tools?: McpToolDescriptor[] }>(
    namespace,
    'tools/list',
    {},
    opts,
  );
  return result?.tools ?? [];
}

function isTimeoutError(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'name' in e &&
    (e as { name?: string }).name === 'TimeoutError'
  );
}

function errorMessage(e: unknown): string {
  return ((e as { message?: string }).message ?? String(e)).trim();
}
