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

import { readFileSync } from 'node:fs';
import {
  API_GROUP_VERSION,
  KIND_RUN,
  LABELS,
  MANAGED_BY,
  type Run,
  RunPhase,
  RunSchema,
  TERMINAL_PHASES,
} from '@percussionist/api';
import { validateModelAuth } from '@percussionist/kube';
import YAML from 'yaml';
import { runAttach } from './attach.js';
import { createRun, DEFAULT_NAMESPACE, fatal, getProject, getRun, loadKube } from './kube.js';

export interface AgentFileEntry {
  path: string;
  name?: string;
}

/**
 * Shared accumulator backing the `submit` command's repeatable inline-agent
 * flags. Commander processes options in argv order, so `--agent-file` pushes
 * a `{ path }` entry and `--agent-name` binds to the last entry that has no
 * name yet — the "preceding --agent-file" the help text promises. A name with
 * no preceding unnamed file is a hard usage error rather than a silent
 * misassignment.
 *
 * Both processors return the shared `entries` array so `opts.agentFile` always
 * reflects the full collected list regardless of flag order.
 */
export function createAgentFileAccumulator() {
  const entries: AgentFileEntry[] = [];
  return {
    entries,
    pushFile: (path: string) => {
      entries.push({ path });
      return entries;
    },
    bindName: (name: string) => {
      const target = [...entries].reverse().find((entry) => entry.name === undefined);
      if (!target) {
        throw new Error(
          '--agent-name requires a preceding --agent-file that does not already have a name',
        );
      }
      target.name = name;
      return entries;
    },
  };
}

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
  agentFile?: AgentFileEntry[];
  // project defaults
  project?: string;
}

function generateName(): string {
  return `run-${Date.now().toString(16)}`;
}

export function buildRunFromFlags(
  opts: SubmitOpts,
  projectDefaults?: import('@percussionist/api').ProjectSpec,
): Run {
  if (!opts.task && !opts.interactive) {
    throw new Error('either --task or --interactive is required when --file is not supplied');
  }
  if (!opts.project) {
    throw new Error('--project is required');
  }
  const ns = opts.namespace ?? DEFAULT_NAMESPACE;
  const name = opts.name ?? generateName();

  // Merge project defaults first, then explicit flags win over them.
  const pd = projectDefaults;
  const resolvedAgent = opts.agent ?? pd?.agent;
  const resolvedImage = opts.image ?? pd?.image;
  const resolvedTimeoutSeconds = opts.timeout ? Number(opts.timeout) : pd?.timeoutSeconds;
  const resolvedModel = opts.model ?? pd?.model;
  const resolvedLlmSecret = opts.llmKeysSecret ?? pd?.secrets?.llmKeysSecret;
  const resolvedAuthSecret = opts.authSecret ?? pd?.secrets?.authSecret?.name;
  const resolvedAuthKey = opts.authKey ?? pd?.secrets?.authSecret?.key;
  const resolvedGitUrl = opts.gitUrl ?? pd?.source?.git?.url;
  const resolvedGitRef = opts.gitRef ?? pd?.source?.git?.ref;
  const resolvedGitSshSecret = opts.gitSshSecret ?? pd?.source?.git?.sshSecret?.name;
  const resolvedGitGithubTokenSecret =
    opts.gitGithubTokenSecret ?? pd?.source?.git?.githubTokenSecret?.name;
  const resolvedGitAuthorName = opts.gitAuthorName ?? pd?.source?.git?.author?.name;
  const resolvedGitAuthorEmail = opts.gitAuthorEmail ?? pd?.source?.git?.author?.email;

  if (
    (resolvedGitAuthorName && !resolvedGitAuthorEmail) ||
    (!resolvedGitAuthorName && resolvedGitAuthorEmail)
  ) {
    throw new Error(
      'git author requires both name and email (--git-author-name and --git-author-email)',
    );
  }

  // Build inline agents from --agent-file / --agent-name flags.
  const rawAgents: Array<{ name: string; content: string }> = [];
  if (opts.agentFile) {
    for (const entry of opts.agentFile) {
      // An explicit --agent-name (bound at parse time to this entry) wins;
      // otherwise derive the name from the filename: strip directory, remove
      // the .md extension.
      const agentName = entry.name ?? (entry.path.split('/').pop() ?? '').replace(/\.md$/, '');
      if (!agentName) continue;
      const content = readFileSync(entry.path, 'utf8');
      rawAgents.push({ name: agentName, content });
    }
  }

  // Only include optional fields when set; the CRD defaults fill the rest.
  // Zod schema validates and fills default()s for us.
  const raw: unknown = {
    apiVersion: API_GROUP_VERSION,
    kind: KIND_RUN,
    metadata: withProjectLabels({ name, namespace: ns }, opts.project ?? ''),
    spec: {
      project: opts.project,
      ...(opts.task ? { task: opts.task } : {}),
      ...(opts.interactive ? { interactive: true } : {}),
      ...(resolvedAgent ? { agent: resolvedAgent } : {}),
      ...(resolvedModel ? { model: resolvedModel } : {}),
      ...(resolvedImage ? { image: resolvedImage } : {}),
      ...(resolvedTimeoutSeconds ? { timeoutSeconds: resolvedTimeoutSeconds } : {}),
      ...(resolvedLlmSecret || resolvedAuthSecret
        ? {
            secrets: {
              ...(resolvedLlmSecret ? { llmKeysSecret: resolvedLlmSecret } : {}),
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
                ...(resolvedGitSshSecret ? { sshSecret: { name: resolvedGitSshSecret } } : {}),
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
      // Inherit resources from the project spec. Not overridable via CLI flags.
      ...(pd?.resources ? { resources: pd.resources } : {}),
      // Inherit data PVC config from the project spec. Not overridable via CLI flags.
      ...(pd?.data ? { data: pd.data } : {}),
      // Inherit git cache options from the project spec. Not overridable via CLI flags.
      ...(pd?.gitCache ? { gitCache: pd.gitCache } : {}),
      // Inherit runner packages from the project spec. Not overridable via CLI flags.
      ...(pd?.runner?.packages ? { runner: { packages: pd.runner.packages } } : {}),
    },
  };
  return RunSchema.parse(raw);
}

/**
 * Ensure the Run carries the project label the operator requires.
 *
 * renderPod() throws "missing required label: percussionist.dev/project" without
 * it, because the label is how the data PVC is resolved. The operator started
 * requiring it when PVC-based caching landed, but submit was never updated, so
 * every `beatctl submit` produced a Run that failed at pod creation. The manager
 * sets the same pair on the worker runs it creates.
 *
 * Existing labels win: a user who set the label in their YAML keeps their value.
 */
export function withProjectLabels(meta: Record<string, unknown> | undefined, project: string) {
  const existing = (meta?.labels ?? {}) as Record<string, string>;
  return {
    ...(meta ?? {}),
    labels: {
      [LABELS.managedBy]: MANAGED_BY,
      ...(project ? { [LABELS.projectName]: project } : {}),
      ...existing,
    },
  };
}

export function buildRunFromFile(path: string, opts: SubmitOpts): Run {
  const doc = YAML.parse(readFileSync(path, 'utf8'));
  // Let a user override the name/namespace at the CLI without editing the file.
  // opts.namespace is only set when -n was explicitly passed (the option has no
  // commander default), so the file's metadata.namespace survives unless the
  // user overrides it.
  if (opts.name) doc.metadata = { ...(doc.metadata ?? {}), name: opts.name };
  if (opts.namespace) {
    doc.metadata = { ...(doc.metadata ?? {}), namespace: opts.namespace };
  }
  // The project may only be present in the file (spec.project), so read it back
  // rather than relying on --project being passed alongside -f.
  const project = String(opts.project ?? doc?.spec?.project ?? '');
  doc.metadata = withProjectLabels(doc.metadata, project);
  return RunSchema.parse(doc);
}

/**
 * Read a run YAML file's metadata.namespace, if any. runSubmit uses this to
 * resolve Project defaults in the namespace a -f submission will actually land
 * in, instead of the global default.
 */
function namespaceFromFile(path: string): string | undefined {
  const doc = YAML.parse(readFileSync(path, 'utf8'));
  return doc?.metadata?.namespace;
}

// Poll the CR status until phase is Running (or terminal, which is fatal for
// --attach). We prefer polling over a Watch here because submits are short
// and one-shot; setting up an informer is overkill and adds RBAC surface.
async function waitForRunning(namespace: string, name: string, timeoutMs = 120_000): Promise<Run> {
  const { custom } = loadKube();
  const deadline = Date.now() + timeoutMs;
  let lastPhase: string | undefined;
  // Small stderr spinner so the user knows we're alive. Keep it cheap —
  // a single line updated in place; no fancy spinner libs.
  const stamp = () => new Date().toISOString().slice(11, 19); // HH:MM:SS
  while (Date.now() < deadline) {
    const run = await getRun(custom, namespace, name);
    const phase = run.status?.phase;
    if (phase !== lastPhase) {
      process.stderr.write(`\rbeatctl: [${stamp()}] phase=${phase ?? '-'}   `);
      lastPhase = phase;
    }
    if (phase === RunPhase.Running) {
      process.stderr.write('\n');
      return run;
    }
    if (phase && TERMINAL_PHASES.has(phase)) {
      process.stderr.write('\n');
      throw new Error(
        `run reached terminal phase ${phase} before Running: ${
          run.status?.message ?? '(no message)'
        }`,
      );
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  process.stderr.write('\n');
  throw new Error(
    `run did not reach Running within ${timeoutMs / 1000}s (last phase=${lastPhase ?? '-'})`,
  );
}

export async function runSubmit(opts: SubmitOpts): Promise<void> {
  if (!opts.project && !opts.file) {
    fatal('--project is required (use --file to supply a fully-specified run YAML)', undefined);
  }

  // A -f submission may carry its own metadata.namespace. Resolve the namespace
  // the run will land in before the Project lookup so defaults come from the
  // file's namespace rather than the global default. Explicit -n wins, then the
  // file, then the default (which honors $PERCUSSIONIST_NAMESPACE).
  let fileNs: string | undefined;
  if (opts.file) {
    try {
      fileNs = namespaceFromFile(opts.file);
    } catch (e) {
      fatal('invalid run spec', e);
    }
  }
  const ns = opts.namespace ?? fileNs ?? DEFAULT_NAMESPACE;

  // Resolve project defaults before building the run spec. Hard-fail if the
  // project is referenced but cannot be found — a missing project is almost
  // certainly a typo and silently ignoring it would produce a confusing run.
  let projectDefaults: import('@percussionist/api').ProjectSpec | undefined;
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
    run = opts.file ? buildRunFromFile(opts.file, opts) : buildRunFromFlags(opts, projectDefaults);
  } catch (e) {
    fatal('invalid run spec', e);
  }
  run.metadata.namespace = run.metadata.namespace ?? ns;
  const runNs = run.metadata.namespace;

  // Validate auth before creating the run.
  const authValidation = validateModelAuth(run.spec.model, run.spec.secrets);
  if (!authValidation.ok) {
    fatal('auth validation failed', new Error(authValidation.error));
  }

  const { custom } = loadKube();
  let createdName: string;
  try {
    const created = await createRun(custom, runNs, run);
    createdName = created.metadata.name;
    console.log(`${createdName} created in namespace ${runNs}`);
  } catch (e) {
    fatal('create failed', e);
  }

  if (opts.attach) {
    // For non-interactive runs we still honour --attach — it's useful to
    // watch the agent work in real time — but flag that the dispatcher may
    // terminate the pod as soon as the first assistant turn completes.
    if (!run.spec.interactive) {
      console.log(
        'beatctl: non-interactive run; dispatcher will declare Succeeded ' +
          'after the first assistant turn completes.',
      );
    }
    console.log('beatctl: waiting for run to reach Running...');
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
