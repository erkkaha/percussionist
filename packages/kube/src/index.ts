// @percussionist/kube — shared Kubernetes client for all percussionist packages.
//
// Provides:
//   - Lazy singleton K8s client (in-cluster or kubeconfig)
//   - Typed CRUD helpers for all CRDs
//   - Status patch helper (uses raw fetch with merge-patch content-type)
//   - Session proxy helpers for OpenCode API
//   - Render utilities (padCols, age, fatal)
//
// Single env var for namespace: PERCUSSIONIST_NAMESPACE (default: "percussionist")

import {
  KubeConfig,
  CoreV1Api,
  CustomObjectsApi,
  PatchStrategy,
  setHeaderOptions,
} from "@kubernetes/client-node";
import fs from "node:fs";
import {
  API_GROUP,
  API_VERSION,
  API_GROUP_VERSION,
  KIND_RUN,
  KIND_PROJECT,
  KIND_CLUSTER_AGENT,
  PLURAL_RUN,
  PLURAL_PROJECT,
  PLURAL_CLUSTER_AGENT,
  type OpenCodeRun,
  type OpenCodeProject,
  type ClusterAgent,
  type BoardStatus,
} from "@percussionist/api";

// ---------------------------------------------------------------------------
// Namespace

export const NAMESPACE = process.env.PERCUSSIONIST_NAMESPACE ?? "percussionist";

// ---------------------------------------------------------------------------
// Client initialisation — two modes:
//   in-cluster: loadFromCluster() (service account token)
//   local dev:  loadFromDefault() (kubeconfig)

let _kc: KubeConfig | undefined;
let _core: CoreV1Api | undefined;
let _custom: CustomObjectsApi | undefined;

function init() {
  if (_kc) return;
  _kc = new KubeConfig();
  try {
    _kc.loadFromCluster();
  } catch {
    _kc.loadFromDefault();
  }
  _core = _kc.makeApiClient(CoreV1Api);
  _custom = _kc.makeApiClient(CustomObjectsApi);
}

export function kubeConfig(): KubeConfig {
  init();
  return _kc!;
}

export function core(): CoreV1Api {
  init();
  return _core!;
}

export function custom(): CustomObjectsApi {
  init();
  return _custom!;
}

// For CLI use — loads from kubeconfig only (no in-cluster fallback).
export function loadFromKubeconfig(): {
  kc: KubeConfig;
  core: CoreV1Api;
  custom: CustomObjectsApi;
} {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  return {
    kc,
    core: kc.makeApiClient(CoreV1Api),
    custom: kc.makeApiClient(CustomObjectsApi),
  };
}

// ---------------------------------------------------------------------------
// OpenCodeRun helpers

export async function listRuns(
  ns: string = NAMESPACE,
  client = custom(),
): Promise<OpenCodeRun[]> {
  const res = (await client.listNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: ns,
    plural: PLURAL_RUN,
  })) as { items: OpenCodeRun[] };
  return res.items ?? [];
}

export async function getRun(
  name: string,
  ns: string = NAMESPACE,
  client = custom(),
): Promise<OpenCodeRun> {
  return (await client.getNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: ns,
    plural: PLURAL_RUN,
    name,
  })) as OpenCodeRun;
}

export async function createRun(
  run: OpenCodeRun,
  ns: string = NAMESPACE,
  client = custom(),
): Promise<OpenCodeRun> {
  return (await client.createNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: ns,
    plural: PLURAL_RUN,
    body: run,
  })) as OpenCodeRun;
}

export async function deleteRun(
  name: string,
  ns: string = NAMESPACE,
  client = custom(),
): Promise<void> {
  await client.deleteNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: ns,
    plural: PLURAL_RUN,
    name,
  });
}

// ---------------------------------------------------------------------------
// ClusterAgent helpers (cluster-scoped — no namespace)

export async function listClusterAgents(
  client = custom(),
): Promise<ClusterAgent[]> {
  const res = (await client.listClusterCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    plural: PLURAL_CLUSTER_AGENT,
  })) as { items: ClusterAgent[] };
  return res.items ?? [];
}

export async function getClusterAgent(
  name: string,
  client = custom(),
): Promise<ClusterAgent> {
  return (await client.getClusterCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    plural: PLURAL_CLUSTER_AGENT,
    name,
  })) as ClusterAgent;
}

export async function createClusterAgent(
  agent: ClusterAgent,
  client = custom(),
): Promise<ClusterAgent> {
  return (await client.createClusterCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    plural: PLURAL_CLUSTER_AGENT,
    body: agent,
  })) as ClusterAgent;
}

export async function updateClusterAgent(
  name: string,
  spec: ClusterAgent["spec"],
  client = custom(),
): Promise<ClusterAgent> {
  const existing = await getClusterAgent(name, client);
  return (await client.replaceClusterCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    plural: PLURAL_CLUSTER_AGENT,
    name,
    body: {
      apiVersion: API_GROUP_VERSION,
      kind: KIND_CLUSTER_AGENT,
      metadata: { name, resourceVersion: existing.metadata.resourceVersion },
      spec,
    },
  })) as ClusterAgent;
}

export async function deleteClusterAgent(
  name: string,
  client = custom(),
): Promise<void> {
  await client.deleteClusterCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    plural: PLURAL_CLUSTER_AGENT,
    name,
  });
}

// ---------------------------------------------------------------------------
// OpenCodeProject helpers

export async function listProjects(
  ns: string = NAMESPACE,
  client = custom(),
): Promise<OpenCodeProject[]> {
  const res = (await client.listNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: ns,
    plural: PLURAL_PROJECT,
  })) as { items: OpenCodeProject[] };
  return res.items ?? [];
}

export async function getProject(
  name: string,
  ns: string = NAMESPACE,
  client = custom(),
): Promise<OpenCodeProject> {
  return (await client.getNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: ns,
    plural: PLURAL_PROJECT,
    name,
  })) as OpenCodeProject;
}

export async function createProject(
  project: OpenCodeProject,
  ns: string = NAMESPACE,
  client = custom(),
): Promise<OpenCodeProject> {
  return (await client.createNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: ns,
    plural: PLURAL_PROJECT,
    body: project,
  })) as OpenCodeProject;
}

export async function updateProject(
  name: string,
  spec: OpenCodeProject["spec"],
  ns: string = NAMESPACE,
  client = custom(),
): Promise<OpenCodeProject> {
  const existing = await getProject(name, ns, client);
  return (await client.replaceNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: ns,
    plural: PLURAL_PROJECT,
    name,
    body: {
      apiVersion: API_GROUP_VERSION,
      kind: KIND_PROJECT,
      metadata: { name, resourceVersion: existing.metadata.resourceVersion },
      spec,
    },
  })) as OpenCodeProject;
}

export async function patchProjectSpec(
  name: string,
  specPatch: Partial<OpenCodeProject["spec"]>,
  ns: string = NAMESPACE,
  client = custom(),
): Promise<OpenCodeProject> {
  return (await client.patchNamespacedCustomObject(
    {
      group: API_GROUP,
      version: API_VERSION,
      namespace: ns,
      plural: PLURAL_PROJECT,
      name,
      body: { spec: specPatch },
    },
    setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
  )) as OpenCodeProject;
}

export async function patchProject(
  name: string,
  patch: { metadata?: Partial<OpenCodeProject["metadata"]>; spec?: Partial<OpenCodeProject["spec"]> },
  ns: string = NAMESPACE,
  client = custom(),
): Promise<OpenCodeProject> {
  return (await client.patchNamespacedCustomObject(
    {
      group: API_GROUP,
      version: API_VERSION,
      namespace: ns,
      plural: PLURAL_PROJECT,
      name,
      body: patch,
    },
    setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
  )) as OpenCodeProject;
}

export async function patchProjectStatus(
  name: string,
  statusPatch: { board?: Partial<BoardStatus> },
  ns: string = NAMESPACE,
  maxRetries = 3,
): Promise<OpenCodeProject> {
  // Use raw fetch with merge-patch content-type — the K8s client sends the
  // wrong content-type for status subresources on some versions.
  //
  // Retry on HTTP 409 Conflict (optimistic concurrency violation). The status
  // subresource ignores resourceVersion in the patch body, so K8s itself
  // serialises writes at the apiserver — but two concurrent patch requests can
  // still race if one is a full replace of the status object. We retry up to
  // maxRetries times with exponential back-off.
  const token = readServiceAccountToken() ?? readKubeconfigToken();
  if (!token) throw new Error("No service account token available");

  const host = process.env.KUBERNETES_SERVICE_HOST ?? "kubernetes.default.svc";
  const port = process.env.KUBERNETES_SERVICE_PORT ?? "443";
  const url = `https://${host}:${port}/apis/${API_GROUP_VERSION}/namespaces/${ns}/${PLURAL_PROJECT}/${name}/status`;

  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      // Exponential back-off: 100ms, 200ms, 400ms
      await new Promise((r) => setTimeout(r, 100 * Math.pow(2, attempt - 1)));
    }
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/merge-patch+json",
        Accept: "application/json",
      },
      body: JSON.stringify({ status: statusPatch }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return res.json() as Promise<OpenCodeProject>;
    const body = await res.text();
    if (res.status === 409 && attempt < maxRetries) {
      // Conflict — another writer raced us. Retry with fresh data.
      lastErr = new Error(`Kubernetes API conflict ${res.status}: ${body}`);
      continue;
    }
    throw new Error(`Kubernetes API error ${res.status}: ${body}`);
  }
  throw lastErr!;
}

export async function deleteProject(
  name: string,
  ns: string = NAMESPACE,
  client = custom(),
): Promise<void> {
  await client.deleteNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: ns,
    plural: PLURAL_PROJECT,
    name,
  });
}

// ---------------------------------------------------------------------------
// Pod log helper

export async function readPodLog(
  podName: string,
  container: string,
  tailLines?: number,
  ns: string = NAMESPACE,
): Promise<string> {
  const res = await core().readNamespacedPodLog({
    name: podName,
    namespace: ns,
    container,
    tailLines,
  });
  return res ?? "";
}

// ---------------------------------------------------------------------------
// OpenCode API proxy helpers (talk to opencode server inside run pods)

export async function fetchSessionMessages(
  serviceName: string,
  sessionID: string,
  ns: string = NAMESPACE,
): Promise<unknown> {
  const url = `http://${serviceName}.${ns}.svc.cluster.local:4096/session/${sessionID}/message`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`OpenCode API ${res.status}: ${await res.text().catch(() => "")}`);
  }
  return res.json();
}

export async function postSessionMessage(
  serviceName: string,
  sessionID: string,
  text: string,
  ns: string = NAMESPACE,
): Promise<void> {
  const url = `http://${serviceName}.${ns}.svc.cluster.local:4096/session/${sessionID}/message`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text }] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`OpenCode API ${res.status}: ${await res.text().catch(() => "")}`);
}

export async function postPermissionReply(
  serviceName: string,
  sessionID: string,
  permissionID: string,
  response: "once" | "always" | "reject",
  ns: string = NAMESPACE,
): Promise<void> {
  const url = `http://${serviceName}.${ns}.svc.cluster.local:4096/session/${sessionID}/permissions/${permissionID}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`OpenCode permission API ${res.status}: ${await res.text().catch(() => "")}`);
}

// Session snapshot from ConfigMap (fallback when pod is gone).
export async function readSessionConfigMap(
  runName: string,
  sessionID: string,
  ns: string = NAMESPACE,
): Promise<{ messages: unknown[]; truncated: boolean } | null> {
  try {
    const cm = await core().readNamespacedConfigMap({
      name: `${runName}-session`,
      namespace: ns,
    });
    const sessionsRaw = cm.data?.["sessions.json"];
    if (!sessionsRaw) return null;
    const sessions: string[] = JSON.parse(sessionsRaw);
    if (!sessions.includes(sessionID)) return null;
    const raw = cm.data![`messages-${sessionID}.json`];
    if (!raw) return null;
    return {
      messages: JSON.parse(raw),
      truncated: cm.data?.[`truncated-${sessionID}`] === "true",
    };
  } catch (e: unknown) {
    if ((e as { statusCode?: number }).statusCode === 404) return null;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Render utilities

export function padCols(rows: string[][]): string {
  if (rows.length === 0) return "";
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) =>
          i === row.length - 1 ? cell : cell.padEnd((widths[i] ?? 0) + 2),
        )
        .join(""),
    )
    .join("\n");
}

export function age(iso: string | undefined): string {
  if (!iso) return "-";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return "-";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function fatal(prefix: string, e: unknown): never {
  const anyE = e as { body?: { message?: string }; message?: string };
  const msg = anyE?.body?.message ?? anyE?.message ?? String(e);
  console.error(`beatctl: ${prefix}: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Metrics helpers (metrics.k8s.io/v1beta1 — requires metrics-server addon).

export interface NodeMetric {
  name: string;
  timestamp: string;
  window: string;
  usage: { cpu: string; memory: string };
}

export interface PodMetric {
  name: string;
  namespace: string;
  timestamp: string;
  window: string;
  containers: { name: string; usage: { cpu: string; memory: string } }[];
}

export async function listNodeMetrics(): Promise<NodeMetric[]> {
  const token = readServiceAccountToken() ?? readKubeconfigToken();
  if (!token) throw new Error("No service account token available");

  const host = process.env.KUBERNETES_SERVICE_HOST ?? "kubernetes.default.svc";
  const port = process.env.KUBERNETES_SERVICE_PORT ?? "443";
  const url = `https://${host}:${port}/apis/metrics.k8s.io/v1beta1/nodes`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`metrics API ${res.status}: ${await res.text().catch(() => "")}`);
  const body = (await res.json()) as { items?: Array<{ metadata: { name: string }; timestamp: string; window: string; usage: { cpu: string; memory: string } }> };
  return (body.items ?? []).map((item) => ({
    name: item.metadata.name,
    timestamp: item.timestamp,
    window: item.window,
    usage: item.usage,
  }));
}

export async function listPodMetrics(ns: string = NAMESPACE): Promise<PodMetric[]> {
  const token = readServiceAccountToken() ?? readKubeconfigToken();
  if (!token) throw new Error("No service account token available");

  const host = process.env.KUBERNETES_SERVICE_HOST ?? "kubernetes.default.svc";
  const port = process.env.KUBERNETES_SERVICE_PORT ?? "443";
  const url = `https://${host}:${port}/apis/metrics.k8s.io/v1beta1/namespaces/${ns}/pods`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`metrics API ${res.status}: ${await res.text().catch(() => "")}`);
  const body = (await res.json()) as { items?: Array<{ metadata: { name: string; namespace: string }; timestamp: string; window: string; containers: Array<{ name: string; usage: { cpu: string; memory: string } }> }> };
  return (body.items ?? []).map((item) => ({
    name: item.metadata.name,
    namespace: item.metadata.namespace,
    timestamp: item.timestamp,
    window: item.window,
    containers: item.containers,
  }));
}

// ---------------------------------------------------------------------------
// Internal token helpers

function readServiceAccountToken(): string | undefined {
  try {
    return fs.readFileSync(
      "/var/run/secrets/kubernetes.io/serviceaccount/token",
      "utf8",
    ).trim();
  } catch {
    return undefined;
  }
}

function readKubeconfigToken(): string | undefined {
  try {
    const kc = kubeConfig();
    const currentContext = kc.getCurrentContext();
    if (!currentContext) return undefined;
    const user = kc.getUser(currentContext);
    return (user as unknown as Record<string, string>)?.token;
  } catch {
    return undefined;
  }
}
