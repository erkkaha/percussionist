// `beatctl web` — port-forward the percussionist web dashboard to localhost
// and open it in the default browser.
//
// localhost is treated as a secure context by all browsers, which enables the
// Web Notifications API and AudioContext used for run/task notifications.
//
// Flow:
//   1. Use default port 8080 (or honour --port), fall back to a free port if occupied.
//   2. Start `kubectl port-forward svc/percussionist-web <local>:8080`.
//   3. Wait for "Forwarding from" on stdout/stderr.
//   4. Open http://localhost:<local>/ in the default browser.
//   5. Block until the user presses Ctrl-C; kill the port-forward on exit.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { DEFAULT_NAMESPACE } from "./kube.js";

const WEB_SERVICE = "percussionist-web";
const WEB_PORT = 8080;
const DEFAULT_LOCAL_PORT = 8080;

export interface WebOpts {
  namespace?: string;
  port?: string;
  /** Skip opening the browser — just forward and print the URL. */
  noBrowser?: boolean;
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("could not determine free port"));
      }
    });
  });
}

async function resolveLocalPort(explicit?: string): Promise<number> {
  if (explicit) return Number(explicit);

  const available = await new Promise<boolean>((resolve) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", () => resolve(false));
    srv.listen(DEFAULT_LOCAL_PORT, "127.0.0.1", () => {
      srv.close(() => resolve(true));
    });
  });

  if (available) return DEFAULT_LOCAL_PORT;
  console.log(`beatctl: port ${DEFAULT_LOCAL_PORT} in use, picking a free port`);
  return pickFreePort();
}

async function startPortForward(
  namespace: string,
  localPort: number,
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const args = [
      "port-forward",
      "-n", namespace,
      `svc/${WEB_SERVICE}`,
      `${localPort}:${WEB_PORT}`,
    ];
    const child = spawn("kubectl", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let ready = false;
    const onReady = () => {
      if (ready) return;
      ready = true;
      resolve(child);
    };

    const onChunk = (buf: Buffer) => {
      const s = buf.toString();
      if (s.includes("Forwarding from")) onReady();
      // Surface kubectl errors (auth, RBAC, etc.) to the user.
      if (s.toLowerCase().includes("error") || s.toLowerCase().includes("unable")) {
        process.stderr.write(s);
      }
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);

    child.on("exit", (code) => {
      if (!ready) {
        reject(new Error(`kubectl port-forward exited with code ${String(code)}`));
      }
    });
    child.on("error", reject);
  });
}

function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];

  if (platform === "darwin") {
    cmd = "open"; args = [url];
  } else if (platform === "win32") {
    cmd = "cmd"; args = ["/c", "start", url];
  } else {
    // Linux: try xdg-open, fall back gracefully.
    cmd = "xdg-open"; args = [url];
  }

  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.unref();
}

export async function runWeb(opts: WebOpts): Promise<void> {
  const ns = opts.namespace ?? DEFAULT_NAMESPACE;
  const localPort = await resolveLocalPort(opts.port);
  const url = `http://localhost:${localPort}/`;

  console.log(`beatctl: port-forwarding svc/${WEB_SERVICE} -> localhost:${localPort}`);

  let pf: ChildProcess;
  try {
    pf = await startPortForward(ns, localPort);
  } catch (e) {
    console.error("beatctl: port-forward failed:", (e as Error).message);
    process.exit(1);
  }

  console.log(`beatctl: dashboard available at ${url}`);

  if (!opts.noBrowser) {
    openBrowser(url);
  }

  console.log("beatctl: press Ctrl-C to stop");

  const kill = () => {
    if (!pf.killed) pf.kill("SIGTERM");
  };

  pf.on("exit", () => {
    console.error("\nbeatctl: port-forward exited unexpectedly");
    process.exit(1);
  });

  process.on("exit", kill);
  process.on("SIGINT", () => { kill(); process.exit(130); });
  process.on("SIGTERM", () => { kill(); process.exit(143); });

  // Block forever — kubectl port-forward keeps running until killed.
  await new Promise<void>(() => undefined);
}
