// reconciler.ts — core reconcile loop for Run CRs.

import {
  KubeConfig,
  CoreV1Api,
  AppsV1Api,
  CustomObjectsApi,
  NetworkingV1Api,
  PatchStrategy,
  setHeaderOptions,
  type V1Pod,
} from "@kubernetes/client-node";
import {
  API_GROUP,
  API_VERSION,
  PLURAL_RUN,
  PLURAL_PROJECT,
  PLURAL_CLUSTER_SETTINGS,
  RunPhase,
  TERMINAL_PHASES,
  type Run,
  type RunStatus,
  type Project,
  type ClusterSettings,
} from "@percussionist/api";
import { resolveAgents } from "./agent-resolver.js";
import {
  renderService,
  renderIngress,
  renderAgentsConfigMap,
  renderPod,
  serviceName,
  podName,
  ingressName,
  shouldCreateIngress,
  webURLFor,
} from "./pod-builder.js";
import { NAMESPACE, SELF_NAMESPACE } from "./config.js";
import { ensureDataPVC } from "./pvc-helper.js";
import { resolveRunnerSpec } from "./adapters/opencode-config.js";
import {
  shouldReconcileCodeServer,
  renderCodeServerDeployment,
  renderCodeServerService,
  codeServerDeploymentName,
  codeServerServiceName,
} from "./code-server.js";
import {
  shouldReconcileMemoryService,
  renderMemoryServiceDeployment,
  renderMemoryServiceService,
  memoryServiceDeploymentName,
  memoryServiceServiceName,
} from "./memory-service.js";

const log = (...args: unknown[]) =>
  console.log(`[operator ${new Date().toISOString()}]`, ...args);
const err = (...args: unknown[]) =>
  console.error(`[operator ${new Date().toISOString()}]`, ...args);

// ---------------------------------------------------------------------------
// K8s clients

const kc = new KubeConfig();
kc.loadFromDefault();
const core = kc.makeApiClient(CoreV1Api);
const apps = kc.makeApiClient(AppsV1Api);
const co = kc.makeApiClient(CustomObjectsApi);
const networking = kc.makeApiClient(NetworkingV1Api);

// ---------------------------------------------------------------------------
// Status writer

async function patchStatus(
  run: Run,
  patch: RunStatus,
): Promise<void> {
  try {
    await co.patchNamespacedCustomObjectStatus(
      {
        group: API_GROUP,
        version: API_VERSION,
        namespace: run.metadata.namespace!,
        plural: PLURAL_RUN,
        name: run.metadata.name,
        body: { status: patch },
      },
      setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
    );
  } catch (e) {
    err(`patchStatus(${run.metadata.name}):`, (e as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Main reconcile function

// Inject the percussionist-dispatcher MCP stanza into an opencode.json string.
// Parses the raw JSON (defaults to {} on parse error), strips local/stdio MCP
// entries that are unsafe in headless containers, then adds the dispatcher entry.
// Exported so it can be called from ensureOpencodeConfig for the no-config case.
function injectDispatcherMcpStanza(raw: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const mcp = (parsed.mcp ?? {}) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(mcp)) {
    const e = entry as Record<string, unknown>;
    if (e.type === "local" || e.type === "stdio") {
      delete mcp[key];
    }
  }
  mcp["percussionist-dispatcher"] = {
    type: "remote",
    url: "http://127.0.0.1:4097/mcp",
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
  const name = "opencode-config";
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
    "opencode.json": injectDispatcherMcpStanza("{}"),
  };
  try {
    await core.createNamespacedConfigMap({
      namespace: ns,
      body: {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name, namespace: ns },
        data,
      },
    });
    log(`synced opencode-config to ${ns}${sourceData ? "" : " (minimal dispatcher-only config)"}`);
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
export async function reconcileClusterSettings(
  cs: ClusterSettings,
): Promise<void> {
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
     await ssaConfigMap(SELF_NAMESPACE, "opencode-config", {
       "opencode.json": injectDispatcherMcpStanza(spec.runnerConfig.config),
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
      if (data["opencode.json"]) {
        await ssaConfigMap(SELF_NAMESPACE, "opencode-config", {
           "opencode.json": injectDispatcherMcpStanza(data["opencode.json"]),
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
  const agentName = spec.manager?.agentName ?? "manager-agent";
  const decisionAgentName = "manager-decision";
  const decisionContent =
    spec.manager?.decisionAgentContent ??
    `---
description: Manager decision agent — analyzes failures, parses facilitation output, and assists operators.
mode: subagent
permission:
  edit: allow
  bash: allow
---

You are the decision-making agent for a Percussionist kanban board manager running in Kubernetes.
The manager provides full failure context inline in the prompt.

When analyzing a failure, produce structured JSON output:
{
  "action": "retry_same | retry_alternative | skip | escalate",
  "agent": "(name if retry_alternative)",
  "reason": "(1-2 sentence explanation)"
}

- retry_same: The same agent should try again (intermittent issue)
- retry_alternative: A different agent would be better suited
- skip: The task is impossible or harmful; mark it done
- escalate: Human expertise is needed

When parsing facilitator output, extract the structured diagnosis
from the raw session text. Output valid JSON matching the expected
FacilitationResult schema.

When chatting with operators, explain your reasoning clearly and
offer to take corrective actions using your available tools.
Do not use icons, emoji, or unnecessary special characters
(asterisks, backticks, arrows, etc.) in your responses — they
will be read aloud by text-to-speech and sound garbled.`;

  // Build opencode.json for the manager sidecar. It always needs the MCP
  // manager-agent entry; model/provider/skills are layered on top when set.
  const runnerConfig: Record<string, unknown> = {
    "$schema": "https://opencode.ai/config.json",
    mcp: {
      "manager-agent": {
        type: "remote",
        url: "http://127.0.0.1:4097/mcp",
        enabled: true,
      },
    },
    skills: {
      directories: ["/root/.config/opencode/agents/"],
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
        name: "opencode-config",
        namespace: SELF_NAMESPACE,
      });
      const raw = cm.data?.["opencode.json"];
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

  await ssaConfigMap(SELF_NAMESPACE, "agent-config", {
    "opencode.json": runnerConfigJson,
    [`${decisionAgentName}.md`]: decisionContent,
  });
  log(
    `reconciled agent-config via SSA (agentName=${agentName})`,
  );
}

// ssaConfigMap writes a ConfigMap using server-side apply with
// fieldManager="percussionist-operator" and force=true.
//
// force=true means the operator unconditionally takes ownership of these keys
// from any prior field manager (kubectl, tofu, node-fetch, etc.). This is safe
// because the operator is the authoritative source of truth for these ConfigMaps
// and rebuilds them from ClusterSettings on every reconcile cycle.
async function ssaConfigMap(
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
          apiVersion: "v1",
          kind: "ConfigMap",
          metadata: { name, namespace: ns },
          data,
        },
        fieldManager: "percussionist-operator",
        force: true,
      },
      setHeaderOptions("Content-Type", PatchStrategy.ServerSideApply),
    );
  } catch (e) {
    err(`ssaConfigMap(${ns}/${name}):`, (e as Error).message);
  }
}

export async function reconcile(run: Run): Promise<void> {
  const name = run.metadata.name;
  const ns = run.metadata.namespace!;
  const currentPhase = run.status?.phase;

  if (currentPhase && TERMINAL_PHASES.has(currentPhase)) return;

  // Resolve runner spec from ClusterSettings (falls back to opencode defaults).
  const cs = await co.getClusterCustomObject({
    group: API_GROUP, version: API_VERSION,
    plural: PLURAL_CLUSTER_SETTINGS, name: "default",
  }).then((r) => r as ClusterSettings).catch(() => undefined);
  const runnerSpec = resolveRunnerSpec(cs);

  if (currentPhase && TERMINAL_PHASES.has(currentPhase)) return;

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
      message: `Warning: ClusterAgent(s) not found and will be skipped: ${missingAgents.join(", ")}. Run will proceed with available agents.`,
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

  // Ensure Ingress.
  if (shouldCreateIngress(run)) {
    try {
      await networking.readNamespacedIngress({
        name: ingressName(run),
        namespace: ns,
      });
    } catch {
      try {
        await networking.createNamespacedIngress({
          namespace: ns,
          body: renderIngress(run, runnerSpec),
        });
        log(
          `created ingress ${ns}/${ingressName(run)} → ${webURLFor(run)}`,
        );
      } catch (e) {
        if (!/already exists/i.test((e as Error).message)) throw e;
      }
    }
    if (!run.status?.webURL) {
      await patchStatus(run, {
        ingressName: ingressName(run),
        webURL: webURLFor(run),
      });
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
        log(
          `created configmap ${ns}/${cmName} (${resolvedAgents.length} agents)`,
        );
      } catch (e) {
        if (!/already exists/i.test((e as Error).message)) throw e;
      }
    }
  }

  // Ensure data PVC exists for the project.
  const projectName = run.metadata.labels?.["percussionist.dev/project"];
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
        throw new Error(
          `Project ${ns}/${projectName} missing UID (newly created?)`,
        );
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
    try {
      pod = await core.createNamespacedPod({
        namespace: ns,
        body: renderPod(run, resolvedAgents, run.spec.sidecars ?? [], runnerSpec),
      });
      log(`created pod ${ns}/${podName(run)}`);
      await patchStatus(run, {
        phase: RunPhase.Initializing,
        podName: podName(run),
        serviceName: serviceName(run),
        ...(shouldCreateIngress(run)
          ? { ingressName: ingressName(run), webURL: webURLFor(run) }
          : {}),
        message: "pod created",
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

  // Mirror pod phase into CR status.
  const podPhase = pod?.status?.phase;
  if (!currentPhase || currentPhase === RunPhase.Pending) {
    await patchStatus(run, {
      phase: RunPhase.Initializing,
      podName: podName(run),
      serviceName: serviceName(run),
      ...(shouldCreateIngress(run)
        ? { ingressName: ingressName(run), webURL: webURLFor(run) }
        : {}),
      message: `pod phase: ${podPhase ?? "Unknown"}`,
    });
  }

  if (podPhase === "Succeeded" && currentPhase !== RunPhase.Succeeded) {
    await patchStatus(run, {
      phase: RunPhase.Succeeded,
      completedAt: new Date().toISOString(),
      message: "pod succeeded",
    });
    await cleanupChildResources(run, ns);
  } else if (podPhase === "Failed" && currentPhase !== RunPhase.Failed) {
    await patchStatus(run, {
      phase: RunPhase.Failed,
      completedAt: new Date().toISOString(),
      message: summarizePodFailure(pod),
    });
    await cleanupChildResources(run, ns);
  }
}

function isNotFound(e: unknown): boolean {
  return ((e as { statusCode?: number; code?: number }).statusCode ?? (e as { code?: number }).code) === 404;
}

async function cleanupChildResources(run: Run, ns: string): Promise<void> {
  const name = run.metadata.name;
  // Delete Pod (best-effort).
  try {
    await core.deleteNamespacedPod({ name, namespace: ns });
    log(`deleted pod ${ns}/${name}`);
  } catch (e: unknown) {
    if (!isNotFound(e)) {
      err(`delete pod ${ns}/${name}:`, (e as Error).message);
    }
  }
  // Delete Service (best-effort).
  try {
    await core.deleteNamespacedService({ name, namespace: ns });
    log(`deleted service ${ns}/${name}`);
  } catch (e: unknown) {
    if (!isNotFound(e)) {
      err(`delete service ${ns}/${name}:`, (e as Error).message);
    }
  }
  // Delete Ingress (best-effort).
  try {
    await networking.deleteNamespacedIngress({ name, namespace: ns });
    log(`deleted ingress ${ns}/${name}`);
  } catch (e: unknown) {
    if (!isNotFound(e)) {
      err(`delete ingress ${ns}/${name}:`, (e as Error).message);
    }
  }
}

function summarizePodFailure(pod?: V1Pod): string {
  for (const c of pod?.status?.initContainerStatuses ?? []) {
    const t = c.state?.terminated;
    if (t && (t.exitCode ?? 0) !== 0) {
      const detail = t.message?.trim();
      const base = `init container ${c.name} failed (exit ${t.exitCode ?? "?"})`;
      return detail ? `${base}: ${detail}` : base;
    }
  }
  const reasons = (pod?.status?.containerStatuses ?? [])
    .map((c) => {
      const t = c.state?.terminated;
      if (!t) return null;
      const detail = t.message?.trim();
      const base = `${c.name}: ${t.reason ?? "Error"} (exit ${t.exitCode ?? "?"})`;
      return detail ? `${base}: ${detail}` : base;
    })
    .filter(Boolean);
  return reasons.length
    ? reasons.join("; ")
    : (pod?.status?.reason ?? "pod failed");
}

// ---------------------------------------------------------------------------
// Work queue

const queue: string[] = [];
const pending = new Set<string>();
const processing = new Set<string>();
const dirty = new Set<string>();
const seen = new Map<string, Run>();

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

export async function runWorker(): Promise<void> {
  while (true) {
    const key = queue.shift();
    if (!key) {
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }
    pending.delete(key);
    const run = seen.get(key);
    if (!run) continue;
    processing.add(key);
    try {
      const [namespace, name] = key.split("/");
      const fresh = namespace && name
        ? await co.getNamespacedCustomObject({
            group: API_GROUP,
            version: API_VERSION,
            namespace,
            plural: PLURAL_RUN,
            name,
          }) as Run
        : run;
      seen.set(key, fresh);
      await reconcile(fresh);
    } catch (e) {
      err(`reconcile(${key}) failed:`, (e as Error).message);
      if (isNotFound(e)) {
        // Run CR was deleted — remove from state to prevent indefinite re-enqueue.
        dequeue(key);
      } else {
        setTimeout(() => {
          const current = seen.get(key);
          if (current) enqueue(current);
        }, 5000);
      }
    } finally {
      processing.delete(key);
      if (dirty.delete(key)) {
        const current = seen.get(key);
        if (current) enqueue(current);
      }
    }
  }
}

export function startPeriodicResync(): void {
  setInterval(() => {
    for (const run of seen.values()) enqueue(run);
  }, 10_000).unref();
}

// ---------------------------------------------------------------------------
// Project reconciliation — code-server Deployment and Service
//
// Called by the project informer on add/update. Creates or updates code-server
// resources when spec.codeServer.enabled is true and a source is configured.

export async function reconcileProject(project: Project): Promise<void> {
  const name = project.metadata.name!;
  const ns = project.metadata.namespace!;
  const logPrefix = `[project/${ns}/${name}]`;

  if (shouldReconcileCodeServer(project)) {
    log(`${logPrefix} reconciling code-server resources`);

    // Ensure data PVC exists first (code-server needs it).
    const projectUid = project.metadata.uid!;
    const pvcName = project.spec.data?.pvcName ?? `${name}-data`;
    try {
      await ensureDataPVC({
        projectName: name,
        namespace: ns,
        projectUid,
        storageClass: project.spec.data?.storageClass,
        pvcName,
      });
    } catch (e) {
      err(`${logPrefix} failed to ensure data PVC:`, (e as Error).message);
      return; // Cannot proceed without PVC
    }

    // Upsert Deployment
    const deployName = codeServerDeploymentName(project);
    try {
      await apps.readNamespacedDeployment({ name: deployName, namespace: ns });
      // Exists — patch it via SSA
      await apps.patchNamespacedDeployment(
        {
          name: deployName,
          namespace: ns,
          body: renderCodeServerDeployment(project),
          fieldManager: "percussionist-operator",
          force: true,
        },
        setHeaderOptions("Content-Type", PatchStrategy.ServerSideApply),
      );
      log(`${logPrefix} patched deployment ${deployName}`);
    } catch (e) {
      if (isNotFound(e)) {
        await apps.createNamespacedDeployment({
          namespace: ns,
          body: renderCodeServerDeployment(project),
        });
        log(`${logPrefix} created deployment ${deployName}`);
      } else {
        err(`${logPrefix} deployment error:`, (e as Error).message);
        throw e;
      }
    }

    // Upsert Service
    const svcName = codeServerServiceName(project);
    try {
      await core.readNamespacedService({ name: svcName, namespace: ns });
      // Exists — patch it via SSA
      await core.patchNamespacedService(
        {
          name: svcName,
          namespace: ns,
          body: renderCodeServerService(project),
          fieldManager: "percussionist-operator",
          force: true,
        },
        setHeaderOptions("Content-Type", PatchStrategy.ServerSideApply),
      );
      log(`${logPrefix} patched service ${svcName}`);
    } catch (e) {
      if (isNotFound(e)) {
        await core.createNamespacedService({
          namespace: ns,
          body: renderCodeServerService(project),
        });
        log(`${logPrefix} created service ${svcName}`);
      } else {
        err(`${logPrefix} service error:`, (e as Error).message);
        throw e;
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
    const projectUid = project.metadata.uid!;
    const pvcName = project.spec.data?.pvcName ?? `${name}-data`;
    try {
      await ensureDataPVC({
        projectName: name,
        namespace: ns,
        projectUid,
        storageClass: project.spec.data?.storageClass,
        pvcName,
      });
    } catch (e) {
      err(`${logPrefix} failed to ensure data PVC:`, (e as Error).message);
      return; // Cannot proceed without PVC
    }

    // Upsert Deployment
    const memDeployName = memoryServiceDeploymentName(project);
    try {
      await apps.readNamespacedDeployment({ name: memDeployName, namespace: ns });
      // Exists — patch it via SSA
      await apps.patchNamespacedDeployment(
        {
          name: memDeployName,
          namespace: ns,
          body: renderMemoryServiceDeployment(project),
          fieldManager: "percussionist-operator",
          force: true,
        },
        setHeaderOptions("Content-Type", PatchStrategy.ServerSideApply),
      );
      log(`${logPrefix} patched deployment ${memDeployName}`);
    } catch (e) {
      if (isNotFound(e)) {
        await apps.createNamespacedDeployment({
          namespace: ns,
          body: renderMemoryServiceDeployment(project),
        });
        log(`${logPrefix} created deployment ${memDeployName}`);
      } else {
        err(`${logPrefix} deployment error:`, (e as Error).message);
        throw e;
      }
    }

    // Upsert Service
    const memSvcName = memoryServiceServiceName(project);
    try {
      await core.readNamespacedService({ name: memSvcName, namespace: ns });
      // Exists — patch it via SSA
      await core.patchNamespacedService(
        {
          name: memSvcName,
          namespace: ns,
          body: renderMemoryServiceService(project),
          fieldManager: "percussionist-operator",
          force: true,
        },
        setHeaderOptions("Content-Type", PatchStrategy.ServerSideApply),
      );
      log(`${logPrefix} patched service ${memSvcName}`);
    } catch (e) {
      if (isNotFound(e)) {
        await core.createNamespacedService({
          namespace: ns,
          body: renderMemoryServiceService(project),
        });
        log(`${logPrefix} created service ${memSvcName}`);
      } else {
        err(`${logPrefix} service error:`, (e as Error).message);
        throw e;
      }
    }

    log(`${logPrefix} memory-service resources reconciled`);
  } else {
    // memory-service disabled or no source — clean up if exists
    await cleanupMemoryService(project);
  }
}

/**
 * Cleans up code-server resources when codeServer is disabled or project is deleted.
 */
export async function cleanupCodeServer(project: Project): Promise<void> {
  const name = project.metadata.name!;
  const ns = project.metadata.namespace!;
  const logPrefix = `[project/${ns}/${name}]`;

  // Delete Service (ignore 404)
  const svcName = codeServerServiceName(project);
  try {
    await core.deleteNamespacedService({ name: svcName, namespace: ns });
    log(`${logPrefix} deleted code-server service ${svcName}`);
  } catch (e) {
    if (!isNotFound(e)) {
      err(`${logPrefix} failed to delete service:`, (e as Error).message);
    }
  }

  // Delete Deployment (ignore 404)
  const deployName = codeServerDeploymentName(project);
  try {
    await apps.deleteNamespacedDeployment({ name: deployName, namespace: ns });
    log(`${logPrefix} deleted code-server deployment ${deployName}`);
  } catch (e) {
    if (!isNotFound(e)) {
      err(`${logPrefix} failed to delete deployment:`, (e as Error).message);
    }
  }
}

/**
 * Cleans up memory-service resources when embedding is disabled or project is deleted.
 */
export async function cleanupMemoryService(project: Project): Promise<void> {
  const name = project.metadata.name!;
  const ns = project.metadata.namespace!;
  const logPrefix = `[project/${ns}/${name}]`;

  // Delete Service (ignore 404)
  const svcName = memoryServiceServiceName(project);
  try {
    await core.deleteNamespacedService({ name: svcName, namespace: ns });
    log(`${logPrefix} deleted memory-service service ${svcName}`);
  } catch (e) {
    if (!isNotFound(e)) {
      err(`${logPrefix} failed to delete service:`, (e as Error).message);
    }
  }

  // Delete Deployment (ignore 404)
  const deployName = memoryServiceDeploymentName(project);
  try {
    await apps.deleteNamespacedDeployment({ name: deployName, namespace: ns });
    log(`${logPrefix} deleted memory-service deployment ${deployName}`);
  } catch (e) {
    if (!isNotFound(e)) {
      err(`${logPrefix} failed to delete deployment:`, (e as Error).message);
    }
  }
}

// Export kc for informer setup in index.ts
export { kc, co, NAMESPACE };
