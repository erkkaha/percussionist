// `beatctl submit` — create a new OpenCodeRun from the command line.
//
// Two input modes:
//   1. Inline task:    beatctl submit --task "fix the thing" [--name my-run]
//   2. From file:      beatctl submit -f run.yaml
//
// Without --name we generate one from a short timestamp so users can spam
// `submit` without thinking about uniqueness.
//
// --attach turns submit into a one-shot launcher: create the CR, poll until
// the dispatcher reports Running, then hand off to `beatctl attach`. This
// is the common flow for interactive runs ("give me a shell in a pod") and
// also useful for peeking into a scripted run while it's still thinking.

import { readFileSync } from "node:fs";
import YAML from "yaml";
import {
  API_GROUP_VERSION,
  KIND_RUN,
  OpenCodeRunSchema,
  RunPhase,
  TERMINAL_PHASES,
  type OpenCodeRun,
} from "@percussionist/api";
import {
  DEFAULT_NAMESPACE,
  createRun,
  fatal,
  getRun,
  loadKube,
} from "./kube.js";
import { runAttach } from "./attach.js";

export interface SubmitOpts {
  task?: string;
  interactive?: boolean;
  attach?: boolean;
  name?: string;
  namespace?: string;
  file?: string;
  image?: string;
  agent?: string;
  model?: string;
  timeout?: string;
  llmKeysSecret?: string;
  serverPasswordSecret?: string;
  wait?: boolean;
}

function generateName(): string {
  // 6 hex chars from the current ms is enough entropy for casual use.
  const stamp = Date.now().toString(16).slice(-6);
  return `run-${stamp}`;
}

function buildRunFromFlags(opts: SubmitOpts): OpenCodeRun {
  if (!opts.task && !opts.interactive) {
    throw new Error(
      "either --task or --interactive is required when --file is not supplied",
    );
  }
  const ns = opts.namespace ?? DEFAULT_NAMESPACE;
  const name = opts.name ?? generateName();

  // Only include optional fields when set; the CRD defaults fill the rest.
  // Zod schema validates and fills default()s for us.
  const raw: unknown = {
    apiVersion: API_GROUP_VERSION,
    kind: KIND_RUN,
    metadata: { name, namespace: ns },
    spec: {
      ...(opts.task ? { task: opts.task } : {}),
      ...(opts.interactive ? { interactive: true } : {}),
      ...(opts.agent ? { agent: opts.agent } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.image ? { image: opts.image } : {}),
      ...(opts.timeout ? { timeoutSeconds: Number(opts.timeout) } : {}),
      ...(opts.llmKeysSecret || opts.serverPasswordSecret
        ? {
            secrets: {
              ...(opts.llmKeysSecret
                ? { llmKeysSecret: opts.llmKeysSecret }
                : {}),
              ...(opts.serverPasswordSecret
                ? { serverPasswordSecret: opts.serverPasswordSecret }
                : {}),
            },
          }
        : {}),
    },
  };
  return OpenCodeRunSchema.parse(raw);
}

function buildRunFromFile(path: string, opts: SubmitOpts): OpenCodeRun {
  const doc = YAML.parse(readFileSync(path, "utf8"));
  // Let a user override the name/namespace at the CLI without editing the file.
  if (opts.name) doc.metadata = { ...(doc.metadata ?? {}), name: opts.name };
  if (opts.namespace) {
    doc.metadata = { ...(doc.metadata ?? {}), namespace: opts.namespace };
  }
  return OpenCodeRunSchema.parse(doc);
}

// Poll the CR status until phase is Running (or terminal, which is fatal for
// --attach). We prefer polling over a Watch here because submits are short
// and one-shot; setting up an informer is overkill and adds RBAC surface.
async function waitForRunning(
  namespace: string,
  name: string,
  timeoutMs = 120_000,
): Promise<OpenCodeRun> {
  const { custom } = loadKube();
  const deadline = Date.now() + timeoutMs;
  let lastPhase: string | undefined;
  // Small stderr spinner so the user knows we're alive. Keep it cheap —
  // a single line updated in place; no fancy spinner libs.
  const stamp = () =>
    new Date().toISOString().slice(11, 19); // HH:MM:SS
  while (Date.now() < deadline) {
    const run = await getRun(custom, namespace, name);
    const phase = run.status?.phase;
    if (phase !== lastPhase) {
      process.stderr.write(`\rbeatctl: [${stamp()}] phase=${phase ?? "-"}   `);
      lastPhase = phase;
    }
    if (phase === RunPhase.Running) {
      process.stderr.write("\n");
      return run;
    }
    if (phase && TERMINAL_PHASES.has(phase)) {
      process.stderr.write("\n");
      throw new Error(
        `run reached terminal phase ${phase} before Running: ${
          run.status?.message ?? "(no message)"
        }`,
      );
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  process.stderr.write("\n");
  throw new Error(
    `run did not reach Running within ${timeoutMs / 1000}s (last phase=${lastPhase ?? "-"})`,
  );
}

export async function runSubmit(opts: SubmitOpts): Promise<void> {
  let run: OpenCodeRun;
  try {
    run = opts.file ? buildRunFromFile(opts.file, opts) : buildRunFromFlags(opts);
  } catch (e) {
    fatal("invalid run spec", e);
  }
  const ns = run.metadata.namespace ?? DEFAULT_NAMESPACE;
  run.metadata.namespace = ns;

  const { custom } = loadKube();
  let createdName: string;
  try {
    const created = await createRun(custom, ns, run);
    createdName = created.metadata.name;
    console.log(`${createdName} created in namespace ${ns}`);
  } catch (e) {
    fatal("create failed", e);
  }

  if (opts.attach) {
    // For non-interactive runs we still honour --attach — it's useful to
    // watch the agent work in real time — but flag that the dispatcher may
    // terminate the pod as soon as the first assistant turn completes.
    if (!run.spec.interactive) {
      console.log(
        "beatctl: non-interactive run; dispatcher will declare Succeeded " +
          "after the first assistant turn completes.",
      );
    }
    console.log("beatctl: waiting for run to reach Running...");
    try {
      await waitForRunning(ns, createdName);
    } catch (e) {
      fatal(`wait for Running`, e);
    }
    // Hand off. runAttach calls process.exit itself on opencode termination
    // so control won't return here.
    await runAttach(createdName, { namespace: ns });
    return;
  }

  if (run.spec.interactive) {
    console.log(
      `\nInteractive run — once the pod is Ready, attach with:\n` +
        `  beatctl attach ${createdName} -n ${ns}`,
    );
  }
}
