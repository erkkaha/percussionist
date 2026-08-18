// reconciler.ts — core reconcile loop for Run CRs.

import {
  AppsV1Api,
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
  NetworkingV1Api,
  PatchStrategy,
  setHeaderOptions,
  type V1Deployment,
  type V1Pod,
  type V1Service,
} from '@kubernetes/client-node';
import {
  API_GROUP,
  API_VERSION,
  type ClusterSettings,
  deriveEngine,
  PLURAL_CLUSTER_SETTINGS,
  PLURAL_PROJECT,
  PLURAL_RUN,
  type Project,
  type ProjectStatus,
  type Run,
  RunPhase,
  type RunStatus,
  TERMINAL_PHASES,
} from '@percussionist/api';
import { errorMessage, isNotFoundError, makeNodeApiClient } from '@percussionist/kube';
import {
  assertCredentialsUnambiguous,
  resolveRunnerSpec,
  ValidationError,
} from './adapters/opencode-config.js';
import { resolveAgents } from './agent-resolver.js';
import {
  ideDeploymentName,
  ideIngressName,
  ideServiceName,
  ideURLFor,
  renderIdeDeployment,
  renderIdeIngress,
  renderIdeService,
  shouldReconcileCodeServer,
} from './code-server.js';
import {
  ALLOW_PRIVILEGED_SIDECARS,
  INGRESS_BASE_URL,
  NAMESPACE,
  SELF_NAMESPACE,
} from './config.js';
import {
  memoryServiceDeploymentName,
  memoryServiceServiceName,
  renderMemoryServiceDeployment,
  renderMemoryServiceService,
  shouldReconcileMemoryService,
} from './memory-service.js';
import {
  podName,
  renderAgentsConfigMap,
  renderPod,
  renderService,
  serviceName,
} from './pod-builder.js';
import { ensureDataPVC } from './pvc-helper.js';
import { mintRunKey, revokeRunKey } from './run-key-client.js';
import { validateProjectSpec, validateRunSpec } from './spec-validation.js';

const log = (...args: unknown[]) => console.log(`[operator ${new Date().toISOString()}]`, ...args);
const err = (...args: unknown[]) =>
  console.error(`[operator ${new Date().toISOString()}]`, ...args);

// ---------------------------------------------------------------------------
// K8s clients

const kc = new KubeConfig();
kc.loadFromDefault();
const core = makeNodeApiClient(kc, CoreV1Api);
const apps = makeNodeApiClient(kc, AppsV1Api);
const co = makeNodeApiClient(kc, CustomObjectsApi);
const networking = makeNodeApiClient(kc, NetworkingV1Api);

// ---------------------------------------------------------------------------
// Status writer

/**
 * Merge-patch a Run's status subresource.
 *
 * Rethrows on failure: the run worker's `runWorkerOnce` catch treats a thrown
 * reconcile as a transient failure and re-enqueues the key after
 * `ERROR_REQUEUE_DELAY_MS`, which is the retry path for a lost status patch
 * (pod-phase mirror, missing-agent warning, terminal-Failed claim). Swallowing
 * the error (the old behaviour) left the informer with nothing to re-fire and
 * the status patch permanently lost (A11).
 */
async function patchStatus(run: Run, patch: RunStatus): Promise<void> {
  try {
    await co.patchNamespacedCustomObjectStatus(
      {
        group: API_GROUP,
        version: API_VERSION,
        namespace: run.metadata.namespace ?? '',
        plural: PLURAL_RUN,
        name: run.metadata.name,
        body: { status: patch },
      },
      setHeaderOptions('Content-Type', PatchStrategy.MergePatch),
    );
  } catch (e) {
    err(`patchStatus(${run.metadata.name}):`, errorMessage(e));
    throw e;
  }
}

// Merge-patches Project.status.reconcile only — never touches status.board,
// which is owned by the manager. Modeled on patchStatus above; never throws.
async function patchProjectReconcileStatus(
  project: Project,
  reconcile: NonNullable<ProjectStatus['reconcile']>,
): Promise<void> {
  const ns = project.metadata.namespace ?? '';
  const name = project.metadata.name;
  try {
    await co.patchNamespacedCustomObjectStatus(
      {
        group: API_GROUP,
        version: API_VERSION,
        namespace: ns,
        plural: PLURAL_PROJECT,
        name,
        // A JSON merge patch (RFC 7386) leaves keys absent from the patch
        // untouched, so omitting `message` when it's undefined (the Ready
        // path) would leave a stale error message in place forever. Sending
        // `null` explicitly tells the apiserver to delete the key. `next`
        // (the typed value used for the unchanged-status comparison) stays
        // `string | undefined` — only the wire body needs the `null` cast.
        body: {
          status: {
            reconcile: {
              ...reconcile,
              message: (reconcile.message ?? null) as unknown as string | undefined,
            },
          },
        },
      },
      setHeaderOptions('Content-Type', PatchStrategy.MergePatch),
    );
  } catch (e) {
    err(`patchProjectReconcileStatus(${ns}/${name}):`, errorMessage(e));
  }
}

// ---------------------------------------------------------------------------
// Main reconcile function

// Inject the percussionist-dispatcher MCP stanza into an opencode.json string.
// Parses the raw JSON (defaults to {} on parse error), strips local/stdio MCP
// entries that are unsafe in headless containers, then adds the dispatcher entry.
// Exported so it can be called from ensureOpencodeConfig for the no-config case
// and unit-tested without a cluster.
export function injectDispatcherMcpStanza(raw: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const mcp = (parsed.mcp ?? {}) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(mcp)) {
    const e = entry as Record<string, unknown>;
    if (e.type === 'local' || e.type === 'stdio') {
      delete mcp[key];
    }
  }
  mcp['percussionist-dispatcher'] = {
    type: 'remote',
    url: 'http://127.0.0.1:4097/mcp',
    enabled: true,
  };
  parsed.mcp = mcp;
  return JSON.stringify(parsed);
}

// Ensure the opencode-config ConfigMap exists in the run namespace.
// If the operator namespace has an opencode-config, it is copied (once) so
// the run pod can read it via OPENCODE_CONFIG_CONTENT.
// If no source exists, a minimal config containing only the dispatcher MCP
// stanza is created so agents always have access to complete_run / fail_run.
async function ensureOpencodeConfig(ns: string): Promise<void> {
  const name = 'opencode-config';
  // Try to read the source from the operator namespace.
  let sourceData: Record<string, string> | null = null;
  try {
    const source = await core.readNamespacedConfigMap({ name, namespace: SELF_NAMESPACE });
    if (source?.data) sourceData = source.data;
  } catch {
    // Not present in operator ns — will fall back to minimal config below.
  }
  // Check if it already exists in the target namespace.
  try {
    await core.readNamespacedConfigMap({ name, namespace: ns });
    return; // Already exists; leave it alone (user may have customised it).
  } catch {
    // Does not exist — create it.
  }
  // Use operator-namespace config if available; otherwise build a minimal one
  // that contains only the dispatcher MCP stanza so agents always have tools.
  const data: Record<string, string> = sourceData ?? {
    'opencode.json': injectDispatcherMcpStanza('{}'),
  };
  try {
    await core.createNamespacedConfigMap({
      namespace: ns,
      body: {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name, namespace: ns },
        data,
      },
    });
    log(`synced opencode-config to ${ns}${sourceData ? '' : ' (minimal dispatcher-only config)'}`);
  } catch (e) {
    if (!/already exists/i.test((e as Error).message)) {
      err(`failed to sync opencode-config to ${ns}:`, (e as Error).message);
    }
  }
}

// Reconcile ClusterSettings spec into the two managed ConfigMaps:
//   1. opencode-config  — copied to every namespace that has a run
//   2. agent-config     — used by the manager's opencode-web sidecar
//
// Both ConfigMaps are written using server-side apply (SSA) with
// fieldManager="percussionist-operator" and force=true. This means the
// operator is the authoritative owner of these ConfigMap data keys regardless
// of what other tools (kubectl, tofu, node-fetch) may have written previously.
// Tofu excludes agent-config from its for_each to avoid conflicts.
//
// ConfigMap sources of truth (in priority order):
//   opencode.config  >  opencode.configMapRef  >  existing opencode-config CM
//   manager.*        >  static defaults
export async function reconcileClusterSettings(cs: ClusterSettings): Promise<void> {
  const { spec } = cs;
  if (!spec) return;

  // --- opencode-config ---
  // Always inject the dispatcher MCP stanza so every run pod can call
  // complete_run / complete_plan / fail_run / get_status regardless of what
  // the user provides in ClusterSettings. The stanza is merged last so it
  // cannot be accidentally overridden by user-supplied config.

  // If spec.runnerConfig?.config is set, it becomes the data source.
  // Otherwise use configMapRef if set. If neither, leave existing CM alone.
  if (spec.runnerConfig?.config) {
    await ssaConfigMap(SELF_NAMESPACE, 'opencode-config', {
      'opencode.json': injectDispatcherMcpStanza(spec.runnerConfig.config),
    });
    log(`reconciled opencode-config from ClusterSettings (config string)`);
  } else if (spec.runnerConfig?.configMapRef) {
    // Mirror the referenced ConfigMap into our namespace as opencode-config.
    try {
      const ref = spec.runnerConfig.configMapRef;
      const source = await core.readNamespacedConfigMap({
        name: ref.name,
        namespace: SELF_NAMESPACE,
      });
      const data = source.data ?? {};
      if (data['opencode.json']) {
        await ssaConfigMap(SELF_NAMESPACE, 'opencode-config', {
          'opencode.json': injectDispatcherMcpStanza(data['opencode.json']),
        });
        log(`reconciled opencode-config from ref ${ref.name}/${ref.key}`);
      }
    } catch (e) {
      err(`failed to mirror configMapRef for opencode-config:`, (e as Error).message);
    }
  }
  // If neither config nor configMapRef is set, do nothing — existing CM kept as-is.

  // --- agent-config ---
  // Always write agent-config so the operator owns it via SSA, even when
  // spec.manager is not set (use static defaults). This prevents field-manager
  // conflicts when other tools (kubectl, tofu) bootstrapped the ConfigMap.
  const agentName = spec.manager?.agentName ?? 'manager-agent';
  const decisionAgentName = 'manager-decision';
  const decisionContent =
    spec.manager?.decisionAgentContent ??
    `---
description: Manager decision agent — analyzes failures and assists operators.
mode: subagent
permission:
  edit: allow
  bash: allow
---

You are the decision-making agent for a Percussionist kanban board manager running in Kubernetes.
The manager provides full failure context inline in the prompt.

When analyzing a failure, keep the manager's live failure flow in mind:
failed runs are retried automatically up to the task's retry ceiling, and
tasks that exhaust retries or otherwise need human judgment move to
awaiting-human for a human decision.

When you are uncertain about a task's current phase or whether a
lifecycle-changing tool call is valid, call inspect_task_flow first.
It returns the current phase, allowed transitions, resolved project
flow, and expected next action, which helps avoid invalid
set_task_state or force_retry calls.

Workers can report issues unrelated to their own task (bugs, security
issues, tech debt) via the report_unrelated_issue tool, which files them
into this project's findings inbox. The findings system auto-triages high/critical
bugs and security issues into tasks. Use list_findings to see all reported
findings, update_finding to change their status or severity, and
create_task_from_finding to promote lower-severity issues to tasks manually.

When chatting with operators, explain your reasoning clearly and
offer to take corrective actions using your available tools.
Do not use icons, emoji, or unnecessary special characters
(asterisks, backticks, arrows, etc.) in your responses — they
will be read aloud by text-to-speech and sound garbled.

When offering the operator a choice of actions (e.g., retry with same agent,
retry with different agent, mark task done, escalate), present options using
structured [!options] blocks so they can click buttons instead of typing:

[!options]
[!option key="retry" label="Retry with same agent"]
[!option key="different-agent" label="Try a different agent"]
[!option key="done" label="Mark task done (skip)"]
[/!options]

Each option must have:
  - key: A short machine-readable identifier (no spaces, use underscores)
  - label: A clear human-readable button text
  - description (optional): Extra context shown below the label

Always include at least one actionable option when presenting choices.`;

  // Build opencode.json for the manager sidecar. It always needs the MCP
  // manager-agent entry; model/provider/skills are layered on top when set.
  const runnerConfig: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      'manager-agent': {
        type: 'remote',
        url: 'http://127.0.0.1:4097/mcp',
        enabled: true,
      },
    },
    skills: {
      directories: ['/root/.config/opencode/agents/'],
    },
  };
  if (spec.manager?.model) {
    runnerConfig.model = spec.manager.model;
  }
  if (spec.runnerConfig?.config) {
    try {
      const parsed = JSON.parse(spec.runnerConfig.config) as Record<string, unknown>;
      if (parsed.provider) runnerConfig.provider = parsed.provider;
      if (parsed.skills) runnerConfig.skills = parsed.skills;
    } catch {
      // ignore parse errors — just use the minimal config
    }
  } else {
    // Fall back to reading provider/skills from the existing opencode-config CM.
    try {
      const cm = await core.readNamespacedConfigMap({
        name: 'opencode-config',
        namespace: SELF_NAMESPACE,
      });
      const raw = cm.data?.['opencode.json'];
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed.provider) runnerConfig.provider = parsed.provider;
        if (parsed.skills) runnerConfig.skills = parsed.skills;
      }
    } catch {
      // CM doesn't exist — skip, leave runnerConfig as-is
    }
  }
  const runnerConfigJson = JSON.stringify(runnerConfig, null, 2);

  await ssaConfigMap(SELF_NAMESPACE, 'agent-config', {
    'opencode.json': runnerConfigJson,
    [`${decisionAgentName}.md`]: decisionContent,
  });
  log(`reconciled agent-config via SSA (agentName=${agentName})`);
}

// ssaConfigMap writes a ConfigMap using server-side apply with
// fieldManager="percussionist-operator" and force=true.
//
// force=true means the operator unconditionally takes ownership of these keys
// from any prior field manager (kubectl, tofu, node-fetch, etc.). This is safe
// because the operator is the authoritative source of truth for these ConfigMaps
// and rebuilds them from ClusterSettings on every reconcile cycle.
// Exported for unit testing (the SSA request shape is asserted without a cluster).
export async function ssaConfigMap(
  ns: string,
  name: string,
  data: Record<string, string>,
): Promise<void> {
  try {
    await core.patchNamespacedConfigMap(
      {
        name,
        namespace: ns,
        body: {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: { name, namespace: ns },
          data,
        },
        fieldManager: 'percussionist-operator',
        force: true,
      },
      setHeaderOptions('Content-Type', PatchStrategy.ServerSideApply),
    );
  } catch (e) {
    err(`ssaConfigMap(${ns}/${name}):`, (e as Error).message);
  }
}

export async function reconcile(run: Run): Promise<void> {
  const name = run.metadata.name;
  const ns = run.metadata.namespace;
  if (!ns) throw new Error(`Run ${name} missing namespace`);
  const currentPhase = run.status?.phase;

  if (currentPhase && TERMINAL_PHASES.has(currentPhase)) {
    // Revoke unconditionally, before the pod check: the run is over, so its
    // stats key must die even if the pod is already gone (the common case).
    // Keys carry an expiry too, so a missed revocation self-heals.
    await revokeRunKey(name);

    // Run is terminal but the Pod may still be alive (dispatcher patched the
    // Run CR status before its process exited). Clean up any remaining child
    // resources so they don't hold resource reservations indefinitely.
    try {
      await core.readNamespacedPod({ name, namespace: ns });
      await cleanupChildResources(run, ns);
    } catch {
      // Pod already gone — child resources confirmed cleaned up. Drop the run
      // from the resync set so it stops being re-enqueued every 10s for the
      // rest of its TTL retention window. The TTL loop (ttl.ts) lists runs
      // directly from the API, so this does not affect TTL-based deletion.
      log(`dequeuing terminal run ${ns}/${name}: pod confirmed gone`);
      dequeue(`${ns}/${name}`);
    }
    return;
  }

  // Re-validate the spec against the Zod schema. The generated CRDs have no CEL
  // equivalents of the .refine() rules (z.toJSONSchema drops them), so a spec
  // violating an invariant is admitted and would otherwise be reconciled into
  // an undefined state (e.g. a dispatcher auto-prompting with no task, or a
  // pod-builder getting a contradictory source). Failing here — before any pod
  // work — mirrors the assertCredentialsUnambiguous catch below. RunPhase.Failed
  // is terminal, so the guard above short-circuits every future reconcile: no
  // retry storm.
  const specCheck = validateRunSpec(run.spec);
  if (!specCheck.ok) {
    err(`reconcile(${ns}/${name}):`, specCheck.error);
    await patchStatus(run, { phase: RunPhase.Failed, message: specCheck.error });
    return;
  }

  // Resolve runner spec and dispatcher image from ClusterSettings.
  const cs = await co
    .getClusterCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      plural: PLURAL_CLUSTER_SETTINGS,
      name: 'default',
    })
    .then((r) => r as ClusterSettings)
    .catch(() => undefined);
  const engine = deriveEngine(run.spec);
  const runnerSpec = resolveRunnerSpec(cs, engine);
  try {
    assertCredentialsUnambiguous({
      engine,
      llmKeysSecret: run.spec.secrets?.llmKeysSecret,
      authSecretName: run.spec.secrets?.authSecret?.name,
      runName: `${run.metadata.namespace}/${run.metadata.name}`,
    });
  } catch (e) {
    if (!(e instanceof ValidationError)) throw e;
    err(`reconcile(${ns}/${name}):`, e.message);
    await patchStatus(run, { phase: RunPhase.Failed, message: e.message });
    return;
  }
  const dispatcherImage = run.spec.dispatcher?.image ?? cs?.spec?.dispatcher?.image;

  // Resolve agents from ClusterAgent CRs + inline escape hatch.
  const agentNames = (run.spec.agents ?? []).map((a) => a.name);
  if (run.spec.agent && !agentNames.includes(run.spec.agent)) {
    agentNames.unshift(run.spec.agent);
  }
  const { agents: resolvedAgents, missing: missingAgents } = await resolveAgents(
    agentNames,
    run.spec.inlineAgents ?? [],
  );

  // Surface a warning in run.status.message if any requested agents are missing.
  // The run still proceeds — partial agent sets are preferable to hard failures
  // that require operator intervention.
  if (missingAgents.length > 0 && !currentPhase) {
    await patchStatus(run, {
      phase: RunPhase.Initializing,
      message: `Warning: ClusterAgent(s) not found and will be skipped: ${missingAgents.join(', ')}. Run will proceed with available agents.`,
    });
  }

  // Ensure Service.
  try {
    await core.readNamespacedService({ name: serviceName(run), namespace: ns });
  } catch {
    try {
      await core.createNamespacedService({
        namespace: ns,
        body: renderService(run, runnerSpec),
      });
      log(`created service ${ns}/${serviceName(run)}`);
    } catch (e) {
      if (!/already exists/i.test((e as Error).message)) throw e;
    }
  }

  // Ensure agents ConfigMap.
  await ensureOpencodeConfig(ns);
  if (resolvedAgents.length > 0) {
    const cmName = `${podName(run)}-agents`;
    try {
      await core.readNamespacedConfigMap({ name: cmName, namespace: ns });
    } catch {
      try {
        await core.createNamespacedConfigMap({
          namespace: ns,
          body: renderAgentsConfigMap(run, resolvedAgents) as object,
        });
        log(`created configmap ${ns}/${cmName} (${resolvedAgents.length} agents)`);
      } catch (e) {
        if (!/already exists/i.test((e as Error).message)) throw e;
      }
    }
  }

  // Ensure data PVC exists for the project.
  const projectName = run.metadata.labels?.['percussionist.dev/project'];
  if (projectName) {
    try {
      // Fetch the Project CR to get its UID for owner reference.
      const project = (await co.getNamespacedCustomObject({
        group: API_GROUP,
        version: API_VERSION,
        namespace: ns,
        plural: PLURAL_PROJECT,
        name: projectName,
      })) as Project;

      const projectUid = project.metadata?.uid;
      if (!projectUid) {
        throw new Error(`Project ${ns}/${projectName} missing UID (newly created?)`);
      }

      const dataPvcName = run.spec.data?.pvcName ?? `${projectName}-data`;
      const storageClass = run.spec.data?.storageClass;

      // Ensure PVC exists (idempotent).
      await ensureDataPVC({
        projectName,
        namespace: ns,
        projectUid,
        storageClass,
        pvcName: dataPvcName,
      });

      // PVC exists — proceed to pod creation. WaitForFirstConsumer storage
      // classes (e.g. local-path) only bind the PVC after a pod references it,
      // so waiting here would deadlock. Let the pod wait for the PVC natively.
    } catch (e) {
      const msg = (e as Error).message;
      await patchStatus(run, {
        phase: RunPhase.Failed,
        message: `failed to ensure data PVC: ${msg}`,
      });
      err(`data PVC error for ${ns}/${name}:`, msg);
      throw e;
    }
  }

  // Ensure Pod.
  let pod: V1Pod | undefined;
  try {
    pod = await core.readNamespacedPod({ name: podName(run), namespace: ns });
  } catch {
    // Mint the run's stats key just before the pod is created, so its lifetime
    // tracks the pod's as closely as possible. Returns null if the web server is
    // unreachable or minting is not configured, in which case renderPod falls
    // back to the shared token rather than failing the run.
    const runApiKey = await mintRunKey({
      runName: name,
      runUid: run.metadata.uid,
      project: run.spec.project,
      timeoutSeconds: run.spec.timeoutSeconds,
    });

    try {
      pod = await core.createNamespacedPod({
        namespace: ns,
        body: renderPod(
          run,
          resolvedAgents,
          run.spec.sidecars ?? [],
          runnerSpec,
          dispatcherImage,
          ALLOW_PRIVILEGED_SIDECARS,
          runApiKey ?? undefined,
        ),
      });
      log(`created pod ${ns}/${podName(run)}`);
      await patchStatus(run, {
        phase: RunPhase.Initializing,
        podName: podName(run),
        serviceName: serviceName(run),
        message: 'pod created',
      });
    } catch (e) {
      const msg = (e as Error).message;
      if (!/already exists/i.test(msg)) {
        await patchStatus(run, {
          phase: RunPhase.Failed,
          message: `failed to create pod: ${msg}`,
        });
        throw e;
      }
      pod = await core.readNamespacedPod({ name: podName(run), namespace: ns });
    }
  }

  // Mirror pod phase into CR status (without owning terminal run phase).
  const podPhase = normalizePodPhase(pod?.status?.phase);
  if (!currentPhase || currentPhase === RunPhase.Pending) {
    await patchStatus(run, {
      phase: RunPhase.Initializing,
      podPhase,
      podName: podName(run),
      serviceName: serviceName(run),
      message: `pod phase: ${podPhase ?? 'Unknown'}`,
    });
  }

  if (podPhase && podPhase !== run.status?.podPhase) {
    await patchStatus(run, { podPhase });
  }

  if (podPhase === 'Succeeded') {
    // Terminal-phase fallback for the succeeded pod, mirroring the Failed
    // branch below. The dispatcher normally owns terminal run phases (it
    // patches Succeeded/Failed before exiting), but several exit-0 paths
    // leave the phase non-terminal: the message-abort paths patch Running
    // ("waiting for input (message aborted)"), and the shutdown / interactive-
    // end paths patch only `message`. If we deleted the pod without claiming
    // a terminal phase, the next resync would 404 on the pod, mint a new run
    // key, recreate it, and re-run the whole task forever, burning tokens. So
    // claim the terminal Succeeded phase here. The claim is guarded by a fresh
    // read: a Succeeded pod does NOT imply a non-terminal run — the dispatcher
    // can patch a terminal Failed and still exit 0 ("session ended without
    // completion signal") — and blindly claiming Succeeded would clobber that
    // Failed claim and mark a failed task done. Only claim when the fresh
    // phase is still non-terminal; the reconcile guard then short-circuits
    // future passes.
    const fresh = await readFreshRun(run, ns);
    const freshPhase = fresh?.status?.phase ?? currentPhase;
    if (!freshPhase || !TERMINAL_PHASES.has(freshPhase)) {
      await patchStatus(run, {
        phase: RunPhase.Succeeded,
        podPhase,
        message: 'pod succeeded (operator claimed terminal phase; dispatcher exited without one)',
        completedAt: new Date().toISOString(),
      });
    }
    await cleanupChildResources(run, ns);
  } else if (podPhase === 'Failed') {
    // Terminal-phase fallback. The dispatcher normally owns the terminal run
    // phase (it patches Succeeded/Failed before exiting). But if the dispatcher
    // crashed/OOMed before patching, the run phase is still non-terminal — and
    // because we clean up (delete) the failed pod below, the next resync would
    // 404 on the pod, recreate it, and re-run the whole task forever, burning
    // tokens. A Failed pod (restartPolicy: Never) will never make progress, so
    // claim the terminal Failed phase here. The reconcile guard then short-
    // circuits future passes, and the manager's retry/escalation logic (for
    // board runs) picks up from the Failed status as usual.
    await patchStatus(run, {
      phase: RunPhase.Failed,
      podPhase,
      message: summarizePodFailure(pod),
      containerExitCodes: collectContainerExitCodes(pod),
    });
    await cleanupChildResources(run, ns);
  }
}

// Freshly re-reads the Run CR from the apiserver. The `run` passed to
// reconcile()/cleanupChildResources is a snapshot taken by runWorkerOnce before
// the pass and is stale after any patchStatus (patchStatus never mutates it),
// so terminal-claim decisions must re-read. Returns undefined on read error —
// callers decide whether to fall back (Succeeded-branch claim) or fail safe
// (cleanup pod-delete guard). Same call shape as runWorkerOnce's fresh read.
async function readFreshRun(run: Run, ns: string): Promise<Run | undefined> {
  try {
    return (await co.getNamespacedCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      namespace: ns,
      plural: PLURAL_RUN,
      name: run.metadata.name,
    })) as Run;
  } catch (e) {
    err(`readFreshRun(${ns}/${run.metadata.name}):`, errorMessage(e));
    return undefined;
  }
}
async function cleanupChildResources(run: Run, ns: string): Promise<void> {
  const name = run.metadata.name;
  // Revoke the run's stats key alongside its other child resources, so the pod
  // failure paths don't wait for the next reconcile to invalidate it. Idempotent.
  await revokeRunKey(name);
  // Never delete a run pod while the run phase is non-terminal: deletion makes
  // the next resync 404 on the pod, mint a new run key, and recreate it,
  // re-running the task (burning tokens). Re-read the Run CR fresh (the passed
  // `run` is stale after patchStatus) and delete the pod only when the fresh
  // phase is terminal. On a read error, skip the pod deletion too (fail-safe):
  // the pod carries an ownerReference to the Run CR, so Kubernetes GC removes
  // it if the Run CR is gone, and a transient error is retried next resync.
  // Every cleanupChildResources caller (terminal guard, Failed branch,
  // Succeeded branch) has a terminal phase by the time it runs, so this guard
  // never blocks legitimate cleanup.
  const fresh = await readFreshRun(run, ns);
  const freshPhase = fresh?.status?.phase;
  const podDeleteAllowed = !!freshPhase && TERMINAL_PHASES.has(freshPhase);
  // Delete Pod (best-effort).
  if (podDeleteAllowed) {
    try {
      await core.deleteNamespacedPod({ name, namespace: ns });
      log(`deleted pod ${ns}/${name}`);
    } catch (e: unknown) {
      if (!isNotFoundError(e)) {
        err(`delete pod ${ns}/${name}:`, (e as Error).message);
      }
    }
  } else {
    log(`cleanup(${ns}/${name}): run phase non-terminal or read failed — skipping pod delete`);
  }
  // Delete Service (best-effort).
  try {
    await core.deleteNamespacedService({ name, namespace: ns });
    log(`deleted service ${ns}/${name}`);
  } catch (e: unknown) {
    if (!isNotFoundError(e)) {
      err(`delete service ${ns}/${name}:`, (e as Error).message);
    }
  }
}

function summarizePodFailure(pod?: V1Pod): string {
  for (const c of pod?.status?.initContainerStatuses ?? []) {
    const t = c.state?.terminated;
    if (t && (t.exitCode ?? 0) !== 0) {
      const detail = t.message?.trim();
      const base = `init container ${c.name} failed (exit ${t.exitCode ?? '?'})`;
      return detail ? `${base}: ${detail}` : base;
    }
  }
  const reasons = (pod?.status?.containerStatuses ?? [])
    .map((c) => {
      const t = c.state?.terminated;
      if (!t) return null;
      const detail = t.message?.trim();
      const base = `${c.name}: ${t.reason ?? 'Error'} (exit ${t.exitCode ?? '?'})`;
      return detail ? `${base}: ${detail}` : base;
    })
    .filter(Boolean);
  return reasons.length ? reasons.join('; ') : (pod?.status?.reason ?? 'pod failed');
}

function normalizePodPhase(phase: string | undefined): RunStatus['podPhase'] {
  if (
    phase === 'Pending' ||
    phase === 'Running' ||
    phase === 'Succeeded' ||
    phase === 'Failed' ||
    phase === 'Unknown'
  ) {
    return phase;
  }
  return undefined;
}

function collectContainerExitCodes(
  pod?: V1Pod,
): Array<{ container: string; exitCode: number; reason?: string; message?: string }> {
  const entries: Array<{ container: string; exitCode: number; reason?: string; message?: string }> =
    [];
  for (const c of pod?.status?.initContainerStatuses ?? []) {
    const t = c.state?.terminated;
    if (t && (t.exitCode ?? 0) !== 0) {
      entries.push({
        container: c.name,
        exitCode: t.exitCode ?? 0,
        reason: t.reason,
        message: t.message?.trim(),
      });
    }
  }
  for (const c of pod?.status?.containerStatuses ?? []) {
    const t = c.state?.terminated;
    if (t && (t.exitCode ?? 0) !== 0) {
      entries.push({
        container: c.name,
        exitCode: t.exitCode ?? 0,
        reason: t.reason,
        message: t.message?.trim(),
      });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Work queue

const queue: string[] = [];
const pending = new Set<string>();
const processing = new Set<string>();
const dirty = new Set<string>();
const seen = new Map<string, Run>();

/** Idle sleep between queue drains when the queue is empty (ms). */
export const IDLE_SLEEP_MS = 250;
/** Delay before a transiently-failed run is re-enqueued (ms). */
export const ERROR_REQUEUE_DELAY_MS = 5000;

/** Injectable idle sleep (defaults to `setTimeout`). */
export type IdleSleep = (ms: number) => Promise<void>;
/** Injectable requeue scheduler for transient reconcile failures (defaults to `setTimeout`). */
export type RequeueScheduler = (callback: () => void, delayMs: number) => unknown;

const defaultIdleSleep: IdleSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const defaultRequeue: RequeueScheduler = (callback, delayMs) => setTimeout(callback, delayMs);

export function enqueue(run: Run): void {
  const key = `${run.metadata.namespace}/${run.metadata.name}`;
  seen.set(key, run);
  if (processing.has(key)) {
    dirty.add(key);
    return;
  }
  if (!pending.has(key)) {
    pending.add(key);
    queue.push(key);
  }
}

export function dequeue(key: string): void {
  seen.delete(key);
  pending.delete(key);
  processing.delete(key);
  dirty.delete(key);
  const idx = queue.indexOf(key);
  if (idx !== -1) queue.splice(idx, 1);
}

/**
 * Processes a single work-queue entry: shifts one key, fetches the fresh Run
 * CR via `co.getNamespacedCustomObject` (falling back to the cached run when
 * the key carries no namespace/name split), and reconciles it. Returns true
 * when a key was processed (including the skip and error paths), false when
 * the queue was empty and the caller slept `delay(IDLE_SLEEP_MS)`.
 *
 * `delay` and `scheduleRequeue` are injectable seams whose defaults reproduce
 * the original `runWorker` `setTimeout` behavior (250ms idle sleep, 5s
 * error-requeue) — they exist so queue-semantics tests can drive the loop
 * without spawning the infinite `runWorker` loop or real timers.
 */
export async function runWorkerOnce(
  delay: IdleSleep = defaultIdleSleep,
  scheduleRequeue: RequeueScheduler = defaultRequeue,
): Promise<boolean> {
  const key = queue.shift();
  if (!key) {
    await delay(IDLE_SLEEP_MS);
    return false;
  }
  pending.delete(key);
  const run = seen.get(key);
  if (!run) {
    // Key queued without a `seen` entry (defensive: enqueue always sets
    // `seen`, so this only guards against direct queue manipulation).
    return true;
  }
  processing.add(key);
  try {
    const [namespace, name] = key.split('/');
    const fresh =
      namespace && name
        ? ((await co.getNamespacedCustomObject({
            group: API_GROUP,
            version: API_VERSION,
            namespace,
            plural: PLURAL_RUN,
            name,
          })) as Run)
        : run;
    seen.set(key, fresh);
    await reconcile(fresh);
    return true;
  } catch (e) {
    err(`reconcile(${key}) failed:`, (e as Error).message);
    if (isNotFoundError(e)) {
      // Run CR was deleted — remove from state to prevent indefinite re-enqueue.
      dequeue(key);
    } else {
      scheduleRequeue(() => {
        const current = seen.get(key);
        if (current) enqueue(current);
      }, ERROR_REQUEUE_DELAY_MS);
    }
    return true;
  } finally {
    processing.delete(key);
    if (dirty.delete(key)) {
      const current = seen.get(key);
      if (current) enqueue(current);
    }
  }
}

/** The operator's main reconcile loop: one `runWorkerOnce` iteration per pass. */
export async function runWorker(
  delay: IdleSleep = defaultIdleSleep,
  scheduleRequeue: RequeueScheduler = defaultRequeue,
): Promise<void> {
  while (true) {
    await runWorkerOnce(delay, scheduleRequeue);
  }
}

export function startPeriodicResync(): void {
  setInterval(() => {
    for (const run of seen.values()) enqueue(run);
  }, 10_000).unref();
}

// Test-only access to the in-memory work queue. Production code never calls
// this; queue.test.ts uses it to reset state between scenarios and to assert
// on the resulting queue/pending/processing/dirty/seen contents. The queue
// itself stays module-private otherwise.
export interface WorkQueueStateForTests {
  queue: string[];
  pending: Set<string>;
  processing: Set<string>;
  dirty: Set<string>;
  seen: Map<string, Run>;
}

export function __queueStateForTests(): WorkQueueStateForTests {
  return { queue, pending, processing, dirty, seen };
}

// ---------------------------------------------------------------------------
// Project reconciliation — code-server Deployment and Service
//
// Called by the project informer on add/update. Creates or updates code-server
// resources when spec.codeServer.enabled is true and a source is configured.

// Shared read → SSA-patch → on-NotFound-create upsert for the project's
// Deployment resources (code-server and memory-service). The method order
// (read → patch → create) and log strings are pinned by reconciler-flow.test.ts
// via the recording fake kube client, so they must not drift.
async function upsertDeployment(
  project: Project,
  ns: string,
  logPrefix: string,
  name: string,
  render: (p: Project) => V1Deployment,
): Promise<void> {
  try {
    await apps.readNamespacedDeployment({ name, namespace: ns });
    // Exists — patch it via SSA
    await apps.patchNamespacedDeployment(
      {
        name,
        namespace: ns,
        body: render(project),
        fieldManager: 'percussionist-operator',
        force: true,
      },
      setHeaderOptions('Content-Type', PatchStrategy.ServerSideApply),
    );
    log(`${logPrefix} patched deployment ${name}`);
  } catch (e) {
    if (isNotFoundError(e)) {
      await apps.createNamespacedDeployment({
        namespace: ns,
        body: render(project),
      });
      log(`${logPrefix} created deployment ${name}`);
    } else {
      err(`${logPrefix} deployment error:`, (e as Error).message);
      throw e;
    }
  }
}

// Shared read → SSA-patch → on-NotFound-create upsert for the project's
// Service resources (code-server and memory-service). Method order and log
// strings are pinned by reconciler-flow.test.ts, same as upsertDeployment.
async function upsertService(
  project: Project,
  ns: string,
  logPrefix: string,
  name: string,
  render: (p: Project) => V1Service,
): Promise<void> {
  try {
    await core.readNamespacedService({ name, namespace: ns });
    // Exists — patch it via SSA
    await core.patchNamespacedService(
      {
        name,
        namespace: ns,
        body: render(project),
        fieldManager: 'percussionist-operator',
        force: true,
      },
      setHeaderOptions('Content-Type', PatchStrategy.ServerSideApply),
    );
    log(`${logPrefix} patched service ${name}`);
  } catch (e) {
    if (isNotFoundError(e)) {
      await core.createNamespacedService({
        namespace: ns,
        body: render(project),
      });
      log(`${logPrefix} created service ${name}`);
    } else {
      err(`${logPrefix} service error:`, (e as Error).message);
      throw e;
    }
  }
}

// Ensures the project's data PVC exists before resource creation that mounts
// it (code-server and memory-service both need it). Returns false when the PVC
// could not be ensured — the caller must bail (nothing can mount without it).
async function ensureDataPvcOrBail(
  project: Project,
  ns: string,
  logPrefix: string,
): Promise<boolean> {
  const name = project.metadata.name ?? '';
  const projectUid = project.metadata.uid ?? '';
  const pvcName = project.spec.data?.pvcName ?? `${name}-data`;
  try {
    await ensureDataPVC({
      projectName: name,
      namespace: ns,
      projectUid,
      storageClass: project.spec.data?.storageClass,
      pvcName,
    });
    return true;
  } catch (e) {
    err(`${logPrefix} failed to ensure data PVC:`, (e as Error).message);
    return false; // Cannot proceed without PVC
  }
}

export async function reconcileProject(project: Project): Promise<void> {
  const name = project.metadata.name;
  if (!name) throw new Error('Project missing name');
  const ns = project.metadata.namespace;
  if (!ns) throw new Error('Project missing namespace');
  const logPrefix = `[project/${ns}/${name}]`;

  if (shouldReconcileCodeServer(project)) {
    log(`${logPrefix} reconciling code-server resources`);

    // Ensure data PVC exists first (code-server needs it).
    if (!(await ensureDataPvcOrBail(project, ns, logPrefix))) return;

    // Upsert Deployment + Service
    await upsertDeployment(project, ns, logPrefix, ideDeploymentName(project), renderIdeDeployment);
    await upsertService(project, ns, logPrefix, ideServiceName(project), renderIdeService);

    // Upsert Ingress (only when INGRESS_BASE_URL is set).
    const ingressName = ideIngressName(project);
    if (INGRESS_BASE_URL) {
      try {
        await networking.readNamespacedIngress({ name: ingressName, namespace: ns });
        // Exists — skip (SSA would reset infra-managed annotations).
        // TODO: reconcile spec.rules on drift (INGRESS_CLASS, host pattern, port).
      } catch (e) {
        if (isNotFoundError(e)) {
          await networking.createNamespacedIngress({
            namespace: ns,
            body: renderIdeIngress(project),
          });
          log(`${logPrefix} created ingress ${ingressName} → ${ideURLFor(project)}`);
        } else {
          err(`${logPrefix} ingress error:`, (e as Error).message);
        }
      }
    }

    log(`${logPrefix} code-server resources reconciled`);
  } else {
    // codeServer disabled or no source — clean up if exists
    await cleanupCodeServer(project);
  }

  // ── Memory / embedding service ─────────────────────────────────────────
  if (shouldReconcileMemoryService(project)) {
    log(`${logPrefix} reconciling memory-service resources`);

    // Ensure data PVC exists first (memory-service needs it).
    if (!(await ensureDataPvcOrBail(project, ns, logPrefix))) return;

    // Upsert Deployment + Service
    await upsertDeployment(
      project,
      ns,
      logPrefix,
      memoryServiceDeploymentName(project),
      renderMemoryServiceDeployment,
    );
    await upsertService(
      project,
      ns,
      logPrefix,
      memoryServiceServiceName(project),
      renderMemoryServiceService,
    );

    log(`${logPrefix} memory-service resources reconciled`);
  } else {
    // memory-service disabled or no source — clean up if exists
    await cleanupMemoryService(project);
  }
}

// ---------------------------------------------------------------------------
// safeReconcileProject — crash-safe wrapper around reconcileProject
//
// The informer calls this instead of reconcileProject directly. It never
// throws: every error is logged and surfaced into status.reconcile instead of
// propagating to an unhandled rejection (which would exit(1) the operator —
// see index.ts's `unhandledRejection` handler). A single bad Project CR (e.g.
// an invalid spec.codeServer.resources value rejected by the apiserver) must
// not stall reconciliation for every other Project/Run in the cluster.

const PROJECT_RECONCILE_MESSAGE_MAX_LENGTH = 2048; // must match k8s/crds/project.yaml maxLength
const PROJECT_RETRY_DELAY_MS = 30_000;

// Classifies an error from reconcileProject for retry purposes. HTTP 4xx
// (e.g. the apiserver rejecting a garbage resources.limits.memory value with
// 422) reflects a permanent spec problem — retrying won't help until the
// spec changes, so it is not requeued. Everything else (5xx, network errors,
// or no numeric code at all) is treated as transient and gets one retry.
export function classifyProjectReconcileError(e: unknown): 'permanent' | 'transient' {
  const code =
    (e as { statusCode?: number; code?: number } | null)?.statusCode ??
    (e as { code?: number } | null)?.code;
  if (typeof code === 'number' && code >= 400 && code < 500) return 'permanent';
  return 'transient';
}

// True when `next` differs from the Project's current status.reconcile.
// Patching Project status re-triggers the informer's `update` callback, so an
// unconditional patch would hot-loop; callers must skip the patch when this
// returns false. `next` must never include a timestamp or other always-
// changing field, or every reconcile would "differ" and the loop would never
// converge. A missing `message` and an explicit `null`/`undefined` one are
// treated as equivalent, since patchProjectReconcileStatus sends `null` (RFC
// 7386 delete) for an absent message and the apiserver may reflect that back
// as either a deleted key or a `null` value.
export function hasReconcileStatusChanged(
  current: ProjectStatus['reconcile'] | undefined,
  next: NonNullable<ProjectStatus['reconcile']>,
): boolean {
  const normalize = (message: string | null | undefined) => message ?? undefined;
  return (
    current?.state !== next.state ||
    normalize(current?.message) !== normalize(next.message) ||
    current?.observedGeneration !== next.observedGeneration
  );
}

// Canonical `namespace/name` key for a Project, shared between reconciler.ts
// (retry-timer map) and index.ts (delete-path timer cancellation) so the two
// can never disagree about a project's key when a metadata field is missing.
export function projectKey(project: Project): string {
  return `${project.metadata.namespace ?? ''}/${project.metadata.name ?? ''}`;
}

function truncateReconcileMessage(message: string): string {
  return message.length > PROJECT_RECONCILE_MESSAGE_MAX_LENGTH
    ? message.slice(0, PROJECT_RECONCILE_MESSAGE_MAX_LENGTH)
    : message;
}

// One pending retry timer per project key, so retries never stack.
const projectRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Cancels any pending delayed retry for a project key. Called on the Project
// delete path so a retry never fires for (and re-reconciles) a deleted Project.
export function cancelProjectRetry(key: string): void {
  const timer = projectRetryTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    projectRetryTimers.delete(key);
  }
}

function scheduleProjectRetry(key: string, project: Project): void {
  if (projectRetryTimers.has(key)) return; // already scheduled — don't stack
  const timer = setTimeout(() => {
    projectRetryTimers.delete(key);
    // The retry itself does not schedule a further retry on failure — it
    // waits for the next informer event/relist, so a persistently transient
    // error doesn't turn into an unbounded retry chain.
    void reconcileProjectOnce(project, false);
  }, PROJECT_RETRY_DELAY_MS);
  projectRetryTimers.set(key, timer);
}

async function reconcileProjectOnce(project: Project, allowRetry: boolean): Promise<void> {
  const ns = project.metadata.namespace ?? '';
  const name = project.metadata.name ?? '';
  const key = projectKey(project);
  const logPrefix = `[project/${ns}/${name}]`;
  // Any event that reaches a real reconcile (a fresh informer add/update, or
  // this project's own retry firing) supersedes a still-pending retry armed
  // against an older snapshot of this Project — otherwise a stale retry could
  // fire later and silently re-apply an outdated spec over a newer, already-
  // successful reconcile.
  cancelProjectRetry(key);
  // Re-validate the spec against the Zod schema before reconciling. The CRD
  // admits specs the generated schema cannot express (the .refine() rules have
  // no CEL equivalents), and a Project violating one (e.g. both source.git and
  // source.local set) cannot be meaningfully reconciled — pod-builder and
  // code-server would each pick an arbitrary side. Surface it as a permanent
  // Error, exactly like the 4xx classification in the catch below: no retry,
  // no hot-loop — the guard above the patch keeps this from re-firing.
  const specCheck = validateProjectSpec(project.spec);
  if (!specCheck.ok) {
    err(`${logPrefix} invalid spec:`, specCheck.error);
    const next: NonNullable<ProjectStatus['reconcile']> = {
      state: 'Error',
      message: truncateReconcileMessage(specCheck.error),
      observedGeneration: project.metadata.generation,
    };
    if (hasReconcileStatusChanged(project.status?.reconcile, next)) {
      await patchProjectReconcileStatus(project, next);
    }
    return;
  }
  try {
    await reconcileProject(project);
    const next: NonNullable<ProjectStatus['reconcile']> = {
      state: 'Ready',
      observedGeneration: project.metadata.generation,
    };
    if (hasReconcileStatusChanged(project.status?.reconcile, next)) {
      await patchProjectReconcileStatus(project, next);
    }
  } catch (e) {
    const message = truncateReconcileMessage(errorMessage(e));
    err(`${logPrefix} reconcile failed:`, message);
    const next: NonNullable<ProjectStatus['reconcile']> = {
      state: 'Error',
      message,
      observedGeneration: project.metadata.generation,
    };
    if (hasReconcileStatusChanged(project.status?.reconcile, next)) {
      await patchProjectReconcileStatus(project, next);
    }
    if (allowRetry && classifyProjectReconcileError(e) === 'transient') {
      scheduleProjectRetry(key, project);
    }
  }
}

export async function safeReconcileProject(project: Project): Promise<void> {
  await reconcileProjectOnce(project, true);
}

/**
 * Cleans up code-server resources when codeServer is disabled or project is deleted.
 */
export async function cleanupCodeServer(project: Project): Promise<void> {
  const name = project.metadata.name ?? '';
  const ns = project.metadata.namespace ?? '';
  const logPrefix = `[project/${ns}/${name}]`;

  // Delete Service (ignore 404)
  const svcName = ideServiceName(project);
  try {
    await core.deleteNamespacedService({ name: svcName, namespace: ns });
    log(`${logPrefix} deleted code-server service ${svcName}`);
  } catch (e) {
    if (!isNotFoundError(e)) {
      err(`${logPrefix} failed to delete service:`, (e as Error).message);
    }
  }

  // Delete Deployment (ignore 404)
  const deployName = ideDeploymentName(project);
  try {
    await apps.deleteNamespacedDeployment({ name: deployName, namespace: ns });
    log(`${logPrefix} deleted code-server deployment ${deployName}`);
  } catch (e) {
    if (!isNotFoundError(e)) {
      err(`${logPrefix} failed to delete deployment:`, (e as Error).message);
    }
  }

  // Delete Ingress (ignore 404)
  const ingName = ideIngressName(project);
  try {
    await networking.deleteNamespacedIngress({ name: ingName, namespace: ns });
    log(`${logPrefix} deleted code-server ingress ${ingName}`);
  } catch (e) {
    if (!isNotFoundError(e)) {
      err(`${logPrefix} failed to delete ingress:`, (e as Error).message);
    }
  }
}

/**
 * Cleans up memory-service resources when embedding is disabled or project is deleted.
 */
export async function cleanupMemoryService(project: Project): Promise<void> {
  const name = project.metadata.name ?? '';
  const ns = project.metadata.namespace ?? '';
  const logPrefix = `[project/${ns}/${name}]`;

  // Delete Service (ignore 404)
  const svcName = memoryServiceServiceName(project);
  try {
    await core.deleteNamespacedService({ name: svcName, namespace: ns });
    log(`${logPrefix} deleted memory-service service ${svcName}`);
  } catch (e) {
    if (!isNotFoundError(e)) {
      err(`${logPrefix} failed to delete service:`, (e as Error).message);
    }
  }

  // Delete Deployment (ignore 404)
  const deployName = memoryServiceDeploymentName(project);
  try {
    await apps.deleteNamespacedDeployment({ name: deployName, namespace: ns });
    log(`${logPrefix} deleted memory-service deployment ${deployName}`);
  } catch (e) {
    if (!isNotFoundError(e)) {
      err(`${logPrefix} failed to delete deployment:`, (e as Error).message);
    }
  }
}

// Export kc for informer setup in index.ts
export { co, kc, NAMESPACE };
