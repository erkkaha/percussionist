// `beatctl chat` — chat with the manager agent.
//
// Flow:
//   1. Start `kubectl port-forward svc/percussionist-manager <local>:4098`.
//   2. Wait for "Forwarding from" on stderr.
//   3. Provide a readline REPL that POSTs messages to localhost:<local>/chat,
//      or with --message send exactly one and exit.
//   4. Kill the port-forward on exit.
//
// This follows the same port-forward pattern as attach.ts.
//
// The reply goes to stdout and every diagnostic to stderr, so `--message` can be
// piped or captured from CI without the port-forward chatter contaminating it.

import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline/promises';
import { DEFAULT_NAMESPACE, loadKube } from './kube.js';

const MANAGER_SERVICE = 'percussionist-manager';
const MANAGER_PORT = 4098;

interface ChatOpts {
  namespace?: string;
  localPort?: string;
  /** Send this one message, print the reply, exit. No REPL, no stdin. */
  message?: string;
}

/**
 * POST one message and print the reply. Returns false if the manager answered
 * with an error, so one-shot mode can exit non-zero.
 */
async function sendMessage(base: string, message: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    const data = await res.json();
    if (data.response) {
      console.log(data.response);
      return true;
    }
    if (data.error) {
      console.error('Error:', data.error);
      return false;
    }
    console.error('Unexpected response:', JSON.stringify(data));
    return false;
  } catch (e) {
    console.error('Error:', (e as Error).message);
    return false;
  }
}

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
    const args = [
      'port-forward',
      '-n',
      namespace,
      `svc/${MANAGER_SERVICE}`,
      `${localPort}:${MANAGER_PORT}`,
    ];
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
      process.stderr.write(s);
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

    child.on('exit', (code) => {
      if (!ready) {
        reject(new Error(`kubectl port-forward exited with code ${code}`));
      }
    });
    child.on('error', reject);
  });
}

export async function runChat(opts: ChatOpts): Promise<void> {
  const ns = opts.namespace ?? DEFAULT_NAMESPACE;
  loadKube();

  const localPort = opts.localPort ? Number(opts.localPort) : await pickFreePort();

  console.error(`beatctl: port-forwarding svc/${MANAGER_SERVICE} -> localhost:${localPort}`);

  let pf: ChildProcess;
  try {
    pf = await startPortForward(ns, localPort);
  } catch (e) {
    console.error('beatctl: port-forward failed:', (e as Error).message);
    process.exit(1);
  }

  const kill = () => {
    if (!pf.killed) pf.kill('SIGTERM');
  };
  process.on('exit', kill);
  process.on('SIGINT', () => {
    kill();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    kill();
    process.exit(143);
  });

  const BASE = `http://localhost:${localPort}`;

  // Check availability
  try {
    const statusRes = await fetch(`${BASE}/chat/history`, { signal: AbortSignal.timeout(3_000) });
    if (!statusRes.ok) {
      console.error('beatctl: manager agent not reachable (status', `${statusRes.status})`);
      kill();
      process.exit(1);
    }
  } catch {
    console.error('beatctl: manager agent not reachable');
    kill();
    process.exit(1);
  }

  // One-shot: send, print, exit. The explicit exit is required because the
  // port-forward child would otherwise keep the event loop alive forever.
  if (opts.message !== undefined) {
    const message = opts.message.trim();
    if (!message) {
      console.error('beatctl: --message must not be empty');
      kill();
      process.exit(1);
    }
    const ok = await sendMessage(BASE, message);
    kill();
    process.exit(ok ? 0 : 1);
  }

  console.error('beatctl: connected to manager agent. Type your messages (Ctrl+C to exit).\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // Load history if available
  try {
    const histRes = await fetch(`${BASE}/chat/history`);
    if (histRes.ok) {
      const hist = await histRes.json();
      if (hist.history?.length) {
        console.error('--- previous conversation ---');
        for (const msg of hist.history) {
          console.error(`[${msg.role}] ${msg.text}`);
        }
        console.error('--- end ---\n');
      }
    }
  } catch {
    /* ignore */
  }

  while (true) {
    const line = await rl.question('> ');
    const trimmed = line.trim();
    if (!trimmed) continue;

    console.error(); // blank line before response
    await sendMessage(BASE, trimmed);
    console.log(); // trailing blank line
  }
}
