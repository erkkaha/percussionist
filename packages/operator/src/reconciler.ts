// reconciler.ts — core reconcile loop for OpenCodeRun CRs.

import {
  KubeConfig,
  CoreV1Api,
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
  RunPhase,
  TERMINAL_PHASES,
  type OpenCodeRun,
  type OpenCodeRunStatus,
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

const log = (...args: unknown[]) =>
  console.log(`[operator ${new Date().toISOString()}]`, ...args);
const err = (...args: unknown[]) =>
  console.error(`[operator ${new Date().toISOString()}]`, ...args);

// ---------------------------------------------------------------------------
// K8s clients

const kc = new KubeConfig();
kc.loadFromDefault();
const core = kc.makeApiClient(CoreV1Api);
const co = kc.makeApiClient(CustomObjectsApi);
const networking = kc.makeApiClient(NetworkingV1Api);

// ---------------------------------------------------------------------------
// Status writer

async function patchStatus(
  run: OpenCodeRun,
  patch: OpenCodeRunStatus,
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

// Ensure the opencode-config ConfigMap exists in the run namespace by copying
// it from the operator namespace. This makes the MCP stanza (and provider
// config) available to every run regardless of which namespace it lands in.
async function ensureOpencodeConfig(ns: string): Promise<void> {
  const name = "opencode-config";
  // Try to read the source from the operator namespace.
  let source: { data?: Record<string, string> } | null = null;
  try {
    source = await core.readNamespacedConfigMap({ name, namespace: SELF_NAMESPACE });
  } catch {
    return; // Not present in operator ns — nothing to sync.
  }
  if (!source?.data) return;
  // Check if it already exists in the target namespace.
  try {
    await core.readNamespacedConfigMap({ name, namespace: ns });
    return; // Already exists; leave it alone (user may have customised it).
  } catch {
    // Does not exist — create it.
  }
  try {
    await core.createNamespacedConfigMap({
      namespace: ns,
      body: {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name, namespace: ns },
        data: source.data,
      },
    });
    log(`synced opencode-config to ${ns}`);
  } catch (e) {
    if (!/already exists/i.test((e as Error).message)) {
      err(`failed to sync opencode-config to ${ns}:`, (e as Error).message);
    }
  }
}

export async function reconcile(run: OpenCodeRun): Promise<void> {
  const name = run.metadata.name;
  const ns = run.metadata.namespace!;
  const currentPhase = run.status?.phase;

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
        body: renderService(run),
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
          body: renderIngress(run),
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

  // Ensure Pod.
  let pod: V1Pod | undefined;
  try {
    pod = await core.readNamespacedPod({ name: podName(run), namespace: ns });
  } catch {
    try {
      pod = await core.createNamespacedPod({
        namespace: ns,
        body: renderPod(run, resolvedAgents, run.spec.sidecars ?? []),
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
  } else if (podPhase === "Failed" && currentPhase !== RunPhase.Failed) {
    await patchStatus(run, {
      phase: RunPhase.Failed,
      completedAt: new Date().toISOString(),
      message: summarizePodFailure(pod),
    });
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
const seen = new Map<string, OpenCodeRun>();

export function enqueue(run: OpenCodeRun): void {
  const key = `${run.metadata.namespace}/${run.metadata.name}`;
  seen.set(key, run);
  if (!pending.has(key)) {
    pending.add(key);
    queue.push(key);
  }
}

export function dequeue(key: string): void {
  seen.delete(key);
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
    try {
      await reconcile(run);
    } catch (e) {
      err(`reconcile(${key}) failed:`, (e as Error).message);
      setTimeout(() => {
        const current = seen.get(key);
        if (current) enqueue(current);
      }, 5000);
    }
  }
}

export function startPeriodicResync(): void {
  setInterval(() => {
    for (const run of seen.values()) enqueue(run);
  }, 10_000).unref();
}

// Export kc for informer setup in index.ts
export { kc, co, NAMESPACE };
