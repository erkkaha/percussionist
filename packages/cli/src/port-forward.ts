// port-forward.ts — shared port-forward plumbing for beatctl commands.
//
// `beatctl web`, `web-client.ts` (auth), `chat.ts` and `auth-login.ts` all
// reach in-cluster services via `kubectl port-forward`; the pick-free-port,
// port-forward and browser-opening helpers were copy-pasted across those files.
// This module is their single home:
//
//   * pickFreePort — bind an ephemeral port on 127.0.0.1, release it, return it.
//   * startPortForward — `kubectl port-forward svc/<service> <local>:<remote>`,
//     resolving once kubectl reports "Forwarding from".
//   * openBrowser — open a URL in the default browser, ignoring failures.
//
// startPortForward surfaces only error-ish stderr lines (matching `error` or
// `unable`) so stdout stays clean for piped/captured output; diagnostics still
// flow to stderr.

import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';

/** Bind an ephemeral port on 127.0.0.1, release it, and return the port number. */
export async function pickFreePort(): Promise<number> {
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

/**
 * Start `kubectl port-forward svc/<service> <localPort>:<remotePort>` in
 * namespace `namespace`, resolving with the child process once kubectl reports
 * "Forwarding from".
 *
 * When `timeoutMs` is set, the call instead rejects (and SIGKILLs the child)
 * if kubectl has not reported "Forwarding from" within the bound — used by
 * probes (doctor) that must not hang on a stuck port-forward. An error-ish
 * stderr line before "Forwarding from" (auth/RBAC failures, etc.) rejects
 * immediately with the specific message; after the forward is up, such lines
 * are surfaced to stderr so stdout stays clean for piped/captured output.
 */
export async function startPortForward(
  namespace: string,
  service: string,
  remotePort: number,
  localPort: number,
  timeoutMs?: number,
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const args = ['port-forward', '-n', namespace, `svc/${service}`, `${localPort}:${remotePort}`];
    const child = spawn('kubectl', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let ready = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(e);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(child);
    };

    const isErrorLine = (s: string) =>
      s.toLowerCase().includes('error') || s.toLowerCase().includes('unable');

    const onChunk = (buf: Buffer) => {
      const s = buf.toString();
      if (s.includes('Forwarding from')) {
        ready = true;
        succeed();
        return;
      }
      if (!ready && isErrorLine(s)) {
        fail(new Error(`kubectl port-forward: ${s.trim()}`));
        return;
      }
      // Diagnose a running forward without polluting stdout (auth, RBAC, …).
      if (isErrorLine(s)) process.stderr.write(s);
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

    child.on('exit', (code) => {
      if (!ready && !settled) {
        fail(new Error(`kubectl port-forward exited with code ${String(code)}`));
      }
    });
    child.on('error', (e) => fail(e));

    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        fail(new Error(`kubectl port-forward did not start within ${timeoutMs}ms`));
      }, timeoutMs);
    }
  });
}

/** Open `url` in the default browser, silently ignoring failures. */
export function openBrowser(url: string): void {
  const platform = process.platform;
  const [cmd, args] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? ['cmd', ['/c', 'start', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true });
    child.unref();
  } catch {
    // No browser opener available — the printed URL is the fallback.
  }
}
