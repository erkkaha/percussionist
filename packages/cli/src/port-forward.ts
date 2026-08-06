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
 */
export async function startPortForward(
  namespace: string,
  service: string,
  remotePort: number,
  localPort: number,
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const args = ['port-forward', '-n', namespace, `svc/${service}`, `${localPort}:${remotePort}`];
    const child = spawn('kubectl', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let ready = false;
    const onReady = () => {
      if (ready) return;
      ready = true;
      resolve(child);
    };

    const onChunk = (buf: Buffer) => {
      const s = buf.toString();
      if (s.includes('Forwarding from')) onReady();
      // Surface kubectl errors (auth, RBAC, etc.) to the user.
      if (s.toLowerCase().includes('error') || s.toLowerCase().includes('unable')) {
        process.stderr.write(s);
      }
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

    child.on('exit', (code) => {
      if (!ready) {
        reject(new Error(`kubectl port-forward exited with code ${String(code)}`));
      }
    });
    child.on('error', reject);
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
