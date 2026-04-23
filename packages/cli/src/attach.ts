// `beatctl attach <name>` — drop into the live opencode TUI for a run.
//
// Flow:
//   1. Look up the run so we know which Service to forward to.
//   2. Pick a free local port (or honour --local-port).
//   3. Start `kubectl port-forward svc/<svc> <local>:4096` as a child.
//      Wait for the "Forwarding from" line on stderr (that's when it's
//      actually listening; connecting before that sometimes 500s).
//   4. Exec `opencode attach http://localhost:<local>`.
//   5. Whatever happens after, kill the port-forward on exit.
//
// We shell out to kubectl port-forward rather than using the client-node
// PortForward helper because (a) it's the reference implementation users
// already trust, and (b) it handles reconnection logic that we'd otherwise
// have to reproduce.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
  CONTAINER_PORT,
  RunPhase,
} from "@percussionist/api";
import { DEFAULT_NAMESPACE, fatal, getRun, loadKube } from "./kube.js";

export interface AttachOpts {
  namespace?: string;
  localPort?: string;
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

async function startPortForward(
  namespace: string,
  serviceName: string,
  localPort: number,
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const args = [
      "port-forward",
      "-n",
      namespace,
      `svc/${serviceName}`,
      `${localPort}:${CONTAINER_PORT}`,
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
      // kubectl prints this on stdout when the forward is live.
      if (s.includes("Forwarding from")) onReady();
      // Don't swallow errors — echo to stderr so the user sees auth/RBAC/etc.
      process.stderr.write(s);
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);

    child.on("exit", (code) => {
      if (!ready) {
        reject(new Error(`kubectl port-forward exited with code ${code}`));
      }
    });
    child.on("error", reject);
  });
}

export async function runAttach(name: string, opts: AttachOpts): Promise<void> {
  const ns = opts.namespace ?? DEFAULT_NAMESPACE;
  const { custom } = loadKube();

  let run;
  try {
    run = await getRun(custom, ns, name);
  } catch (e) {
    fatal(`resolve ${name}`, e);
  }

  // Guard against attaching to a run that's already finished. The Service
  // may still exist briefly but the runner pod is gone; surfacing a clear
  // message beats a cryptic connection-refused. Interactive runs reach
  // terminal phase only via cancel or timeout, so this still applies there.
  const terminal = [RunPhase.Succeeded, RunPhase.Failed, RunPhase.Cancelled];
  const phase = run.status?.phase;
  if (phase && (terminal as string[]).includes(phase)) {
    console.error(
      `beatctl: run ${name} is already ${phase}; nothing to attach to.`,
    );
    process.exit(1);
  }

  // For Pending/Initializing runs, the Service might not have endpoints yet.
  // kubectl port-forward will wait on the Service, so we don't block here —
  // but warn so the user knows why it might take a few extra seconds.
  if (!phase || phase === RunPhase.Pending || phase === RunPhase.Initializing) {
    console.log(
      `beatctl: run is ${phase ?? "Pending"}; port-forward may take a few seconds to settle.`,
    );
  }

  const serviceName = run.status?.serviceName ?? run.metadata.name;

  const localPort = opts.localPort
    ? Number(opts.localPort)
    : await pickFreePort();

  console.log(
    `beatctl: port-forwarding svc/${serviceName} -> localhost:${localPort}`,
  );

  let pf: ChildProcess;
  try {
    pf = await startPortForward(ns, serviceName, localPort);
  } catch (e) {
    fatal("port-forward failed", e);
  }

  // Clean teardown no matter how the attach exits (ctrl-c, opencode exit, ...)
  const kill = () => {
    if (!pf.killed) pf.kill("SIGTERM");
  };
  process.on("exit", kill);
  process.on("SIGINT", () => {
    kill();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    kill();
    process.exit(143);
  });

  console.log(`beatctl: launching opencode attach...`);
  const attach = spawn(
    "opencode",
    ["attach", `http://localhost:${localPort}`],
    {
      stdio: "inherit",
      env: { ...process.env },
    },
  );
  attach.on("exit", (code) => {
    kill();
    process.exit(code ?? 0);
  });
  attach.on("error", (e) => {
    kill();
    fatal("failed to spawn opencode", e);
  });
}
