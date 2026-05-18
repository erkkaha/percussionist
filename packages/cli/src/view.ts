// `beatctl ls` / `beatctl get` — read-only views of Run resources.

import {
  DEFAULT_NAMESPACE,
  age,
  fatal,
  getRun,
  listRuns,
  loadKube,
  padCols,
} from "./kube.js";

export interface LsOpts {
  namespace?: string;
  allNamespaces?: boolean;
}

export async function runLs(opts: LsOpts): Promise<void> {
  const { custom } = loadKube();
  const ns = opts.allNamespaces ? "" : opts.namespace ?? DEFAULT_NAMESPACE;
  let runs;
  try {
    // all-namespaces path — list via empty namespace argument (the informer
    // uses listForAllNamespaces under the hood but for a one-shot read we
    // just loop). For simplicity we require a ns here; --all-namespaces is
    // deferred to when it actually matters.
    runs = await listRuns(custom, ns || DEFAULT_NAMESPACE);
  } catch (e) {
    fatal("list failed", e);
  }

  if (runs.length === 0) {
    console.log(`No Runs in namespace ${ns || DEFAULT_NAMESPACE}.`);
    return;
  }

  const rows: string[][] = [
    ["NAME", "PHASE", "SESSION", "TOK-IN", "TOK-OUT", "AGE"],
  ];
  for (const r of runs) {
    rows.push([
      r.metadata.name,
      r.status?.phase ?? "-",
      r.status?.sessionID ?? "-",
      String(r.status?.tokensIn ?? 0),
      String(r.status?.tokensOut ?? 0),
      age(r.metadata.creationTimestamp),
    ]);
  }
  console.log(padCols(rows));
}

export interface GetOpts {
  namespace?: string;
  output?: "yaml" | "json" | "wide";
}

export async function runGet(name: string, opts: GetOpts): Promise<void> {
  const { custom } = loadKube();
  const ns = opts.namespace ?? DEFAULT_NAMESPACE;
  let run;
  try {
    run = await getRun(custom, ns, name);
  } catch (e) {
    fatal(`get ${name}`, e);
  }

  if (opts.output === "json") {
    console.log(JSON.stringify(run, null, 2));
    return;
  }
  if (opts.output === "yaml") {
    // Lazy-load yaml to avoid pulling it into hot paths unnecessarily.
    const YAML = (await import("yaml")).default;
    console.log(YAML.stringify(run));
    return;
  }

  // Default human-friendly view.
  const s = run.status ?? {};
  const lines = [
    `Name:        ${run.metadata.name}`,
    `Namespace:   ${run.metadata.namespace}`,
    `Phase:       ${s.phase ?? "-"}`,
    `Message:     ${s.message ?? "-"}`,
    `Pod:         ${s.podName ?? "-"}`,
    `Service:     ${s.serviceName ?? "-"}`,
    `Session:     ${s.sessionID ?? "-"}`,
    `Started:     ${s.startedAt ?? "-"}`,
    `Completed:   ${s.completedAt ?? "-"}`,
    `Tokens:      ${s.tokensIn ?? 0} in / ${s.tokensOut ?? 0} out`,
    ``,
    `Spec:`,
    `  Task:      ${run.spec.task}`,
    `  Image:     ${run.spec.image ?? "-"}`,
    `  Agent:     ${run.spec.agent ?? "-"}`,
    `  Model:     ${run.spec.model ?? "-"}`,
    `  Timeout:   ${run.spec.timeoutSeconds ?? "-"}s`,
  ];
  console.log(lines.join("\n"));
}
