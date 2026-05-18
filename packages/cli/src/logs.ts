// `beatctl logs` — stream container logs from a run's pod.
//
// Shells out to `kubectl logs` so we inherit its -f, --since, --tail, etc.
// semantics for free. Principle: beatctl only implements the things that
// kubectl does awkwardly (Run-aware name resolution, attach, ...);
// for the rest we're a polite wrapper.

import { spawn } from "node:child_process";
import { DEFAULT_NAMESPACE, fatal, getRun, loadKube } from "./kube.js";
import { RUNNER_CONTAINER, DISPATCHER_CONTAINER } from "@percussionist/api";

export interface LogsOpts {
  namespace?: string;
  container?: string;
  follow?: boolean;
  tail?: string;
}

export async function runLogs(name: string, opts: LogsOpts): Promise<void> {
  const ns = opts.namespace ?? DEFAULT_NAMESPACE;
  const { custom } = loadKube();

  // Resolve run -> pod name via .status.podName. Falls back to the run name
  // because the operator uses `podName === runName` today, but we prefer the
  // indirection: if that ever changes the CLI keeps working.
  let podName: string;
  try {
    const run = await getRun(custom, ns, name);
    podName = run.status?.podName ?? run.metadata.name;
  } catch (e) {
    fatal(`resolve ${name}`, e);
  }

  const container = opts.container ?? RUNNER_CONTAINER;
  if (
    container !== RUNNER_CONTAINER &&
    container !== DISPATCHER_CONTAINER
  ) {
    console.error(
      `beatctl: warning: container '${container}' is not a known percussionist container ` +
        `(${RUNNER_CONTAINER}, ${DISPATCHER_CONTAINER})`,
    );
  }

  const args = ["logs", "-n", ns, podName, "-c", container];
  if (opts.follow) args.push("-f");
  if (opts.tail) args.push(`--tail=${opts.tail}`);

  const child = spawn("kubectl", args, { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", (e) => fatal("kubectl logs failed", e));
}
