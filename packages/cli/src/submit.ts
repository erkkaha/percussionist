// `beatctl submit` — create a new Run from the command line.
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
  RunSchema,
  RunPhase,
  TERMINAL_PHASES,
  type Run,
} from "@percussionist/api";
import {
  DEFAULT_NAMESPACE,
  createRun,
  fatal,
  getProject,
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
  serverPasswordSecret?: string; // kept for backward compat but ignored
  authSecret?: string;
  authKey?: string;
  wait?: boolean;
  // git source
  gitUrl?: string;
  gitRef?: string;
  gitSshSecret?: string;
  gitGithubTokenSecret?: string;
  gitAuthorName?: string;
  gitAuthorEmail?: string;
  // inline agents
  agentFile?: string[];
  agentName?: string[];
  // project defaults
  project?: string;
}

function generateName(): string {
  return `run-${Date.now().toString(16)}`;
}

function buildRunFromFlags(opts: SubmitOpts, projectDefaults?: import("@percussionist/api").ProjectSpec): Run {
  if (!opts.task && !opts.interactive) {
    throw new Error(
      "either --task or --interactive is required when --file is not supplied",
    );
  }
  if (!opts.project) {
    throw new Error("--project is required");
  }
  const ns = opts.namespace ?? DEFAULT_NAMESPACE;
  const name = opts.name ?? generateName();

  // Merge project defaults first, then explicit flags win over them.
  const pd = projectDefaults;
  const resolvedAgent = opts.agent;
  const resolvedModel = opts.model ?? pd?.model;
  const resolvedLlmSecret = opts.llmKeysSecret ?? pd?.secrets?.llmKeysSecret;
  const resolvedAuthSecret = opts.authSecret ?? pd?.secrets?.authSecret?.name;
  const resolvedAuthKey = opts.authKey ?? pd?.secrets?.authSecret?.key;
  const resolvedGitUrl = opts.gitUrl ?? pd?.source?.git?.url;
  const resolvedGitRef = opts.gitRef ?? pd?.source?.git?.ref;
  const resolvedGitSshSecret = opts.gitSshSecret ?? pd?.source?.git?.sshSecret?.name;
  const resolvedGitGithubTokenSecret = opts.gitGithubTokenSecret ?? pd?.source?.git?.githubTokenSecret?.name;
  const resolvedGitAuthorName = opts.gitAuthorName ?? pd?.source?.git?.author?.name;
  const resolvedGitAuthorEmail = opts.gitAuthorEmail ?? pd?.source?.git?.author?.email;

  if ((resolvedGitAuthorName && !resolvedGitAuthorEmail) || (!resolvedGitAuthorName && resolvedGitAuthorEmail)) {
    throw new Error("git author requires both name and email (--git-author-name and --git-author-email)");
  }

  // Build inline agents from --agent-file / --agent-name flags.
  const rawAgents: Array<{name: string; content: string}> = [];
  if (opts.agentFile) {
    for (let i = 0; i < opts.agentFile.length; i++) {
      const filePath = opts.agentFile[i];
      if (!filePath) continue;
      let agentName: string | undefined;
      // Check if there's a corresponding --agent-name override at the same index.
      if (opts.agentName && opts.agentName[i]) {
        agentName = opts.agentName[i];
      } else {
        // Derive name from filename: strip directory, remove .md extension.
        const basename = filePath.split("/").pop() ?? "";
        agentName = basename.replace(/\.md$/, "");
      }
      if (!agentName) continue;
      const content = readFileSync(filePath, "utf8");
      rawAgents.push({ name: agentName, content });
    }
  }

  // Only include optional fields when set; the CRD defaults fill the rest.
  // Zod schema validates and fills default()s for us.
  const raw: unknown = {
    apiVersion: API_GROUP_VERSION,
    kind: KIND_RUN,
    metadata: { name, namespace: ns },
    spec: {
      project: opts.project,
      ...(opts.task ? { task: opts.task } : {}),
      ...(opts.interactive ? { interactive: true } : {}),
      ...(resolvedAgent ? { agent: resolvedAgent } : {}),
      ...(resolvedModel ? { model: resolvedModel } : {}),
      ...(opts.image ? { image: opts.image } : {}),
      ...(opts.timeout ? { timeoutSeconds: Number(opts.timeout) } : {}),
      ...(resolvedLlmSecret || resolvedAuthSecret
        ? {
            secrets: {
              ...(resolvedLlmSecret
                ? { llmKeysSecret: resolvedLlmSecret }
                : {}),
              ...(resolvedAuthSecret
                ? {
                    authSecret: {
                      name: resolvedAuthSecret,
                      ...(resolvedAuthKey ? { key: resolvedAuthKey } : {}),
                    },
                  }
                : {}),
            },
          }
        : {}),
      ...(resolvedGitUrl
        ? {
            source: {
              git: {
                url: resolvedGitUrl,
                ...(resolvedGitRef ? { ref: resolvedGitRef } : {}),
                ...(resolvedGitSshSecret
                  ? { sshSecret: { name: resolvedGitSshSecret } }
                  : {}),
                ...(resolvedGitGithubTokenSecret
                  ? { githubTokenSecret: { name: resolvedGitGithubTokenSecret } }
                  : {}),
                ...(resolvedGitAuthorName && resolvedGitAuthorEmail
                  ? {
                      author: {
                        name: resolvedGitAuthorName,
                        email: resolvedGitAuthorEmail,
                      },
                    }
                  : {}),
              },
            },
          }
        : {}),
      ...(rawAgents.length > 0 ? { inlineAgents: rawAgents } : {}),
      // Inherit sidecars from the project spec. Not overridable via CLI flags.
      ...(pd?.sidecars?.length ? { sidecars: pd.sidecars } : {}),
      // Inherit initScript from the project spec. Not overridable via CLI flags.
      ...(pd?.initScript ? { initScript: pd.initScript } : {}),
    },
  };
  return RunSchema.parse(raw);
}

function buildRunFromFile(path: string, opts: SubmitOpts): Run {
  const doc = YAML.parse(readFileSync(path, "utf8"));
  // Let a user override the name/namespace at the CLI without editing the file.
  if (opts.name) doc.metadata = { ...(doc.metadata ?? {}), name: opts.name };
  if (opts.namespace) {
    doc.metadata = { ...(doc.metadata ?? {}), namespace: opts.namespace };
  }
  return RunSchema.parse(doc);
}

// Poll the CR status until phase is Running (or terminal, which is fatal for
// --attach). We prefer polling over a Watch here because submits are short
// and one-shot; setting up an informer is overkill and adds RBAC surface.
async function waitForRunning(
  namespace: string,
  name: string,
  timeoutMs = 120_000,
): Promise<Run> {
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
  const ns = opts.namespace ?? DEFAULT_NAMESPACE;

  if (!opts.project && !opts.file) {
    fatal("--project is required (use --file to supply a fully-specified run YAML)", undefined);
  }

  // Resolve project defaults before building the run spec. Hard-fail if the
  // project is referenced but cannot be found — a missing project is almost
  // certainly a typo and silently ignoring it would produce a confusing run.
  let projectDefaults: import("@percussionist/api").ProjectSpec | undefined;
  if (opts.project) {
    const { custom } = loadKube();
    try {
      const proj = await getProject(custom, ns, opts.project);
      projectDefaults = proj.spec;
      console.log(`beatctl: using project ${opts.project}`);
    } catch (e) {
      fatal(`project "${opts.project}" not found in namespace ${ns}`, e);
    }
  }

  let run: Run;
  try {
    run = opts.file
      ? buildRunFromFile(opts.file, opts)
      : buildRunFromFlags(opts, projectDefaults);
  } catch (e) {
    fatal("invalid run spec", e);
  }
  run.metadata.namespace = run.metadata.namespace ?? ns;
  const runNs = run.metadata.namespace;

  const { custom } = loadKube();
  let createdName: string;
  try {
    const created = await createRun(custom, runNs, run);
    createdName = created.metadata.name;
    console.log(`${createdName} created in namespace ${runNs}`);
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
      await waitForRunning(runNs, createdName);
    } catch (e) {
      fatal(`wait for Running`, e);
    }
    // Hand off. runAttach calls process.exit itself on opencode termination
    // so control won't return here.
    await runAttach(createdName, { namespace: runNs });
    return;
  }

  if (run.spec.interactive) {
    console.log(
      `\nInteractive run — once the pod is Ready, attach with:\n` +
        `  beatctl attach ${createdName} -n ${runNs}`,
    );
  }
}
