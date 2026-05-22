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
  V1Pod,
} from "@kubernetes/client-node";
import fs from "node:fs";
import {
  API_GROUP,
  API_VERSION,
  API_GROUP_VERSION,
  KIND_RUN,
  KIND_PROJECT,
  KIND_TASK,
  KIND_CLUSTER_AGENT,
  KIND_CLUSTER_SETTINGS,
  PLURAL_RUN,
  PLURAL_PROJECT,
  PLURAL_TASK,
  PLURAL_CLUSTER_AGENT,
  PLURAL_CLUSTER_SETTINGS,
  LABELS,
  OPENCODE_RUNNER_DEFAULTS,
  type Run,
  type RunStatus,
  type Project,
  type Task,
  type TaskStatus,
  type ClusterAgent,
  type ClusterSettings,
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
// Run helpers

export async function listRuns(
  ns: string = NAMESPACE,
  client = custom(),
): Promise<Run[]> {
  const res = (await client.listNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: ns,
    plural: PLURAL_RUN,
  })) as { items: Run[] };
  return res.items ?? [];
}

export async function getRun(
  name: string,
  ns: string = NAMESPACE,
  client = custom(),
): Promise<Run> {
  return (await client.getNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: ns,
    plural: PLURAL_RUN,
    name,
  })) as Run;
}

export async function createRun(
  run: Run,
  ns: string = NAMESPACE,
  client = custom(),
): Promise<Run> {
  return (await client.createNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: ns,
    plural: PLURAL_RUN,
    body: run,
  })) as Run;
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

export async function patchRunStatus(
  name: string,
  statusPatch: Partial<RunStatus>,
  ns: string = NAMESPACE,
  maxRetries = 3,
): Promise<Run> {
  const token = readServiceAccountToken() ?? readKubeconfigToken();
  if (!token) throw new Error("No service account token available");

  const host = process.env.KUBERNETES_SERVICE_HOST ?? "kubernetes.default.svc";
  const port = process.env.KUBERNETES_SERVICE_PORT ?? "443";
  const url = `https://${host}:${port}/apis/${API_GROUP_VERSION}/namespaces/${ns}/${PLURAL_RUN}/${name}/status`;

  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
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
    if (res.ok) return res.json() as Promise<Run>;
    const body = await res.text();
    if (res.status === 409 && attempt < maxRetries) {
      lastErr = new Error(`Kubernetes API conflict ${res.status}: ${body}`);
      continue;
    }
    throw new Error(`Kubernetes API error ${res.status}: ${body}`);
  }
  throw lastErr!;
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
// ClusterSettings helpers (cluster-scoped singleton — name is always "default")

export async function getClusterSettings(
  name = "default",
  client = custom(),
): Promise<ClusterSettings> {
  return (await client.getClusterCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    plural: PLURAL_CLUSTER_SETTINGS,
    name,
  })) as ClusterSettings;
}

export async function updateClusterSettings(
  name: string,
  spec: ClusterSettings["spec"],
  client = custom(),
): Promise<ClusterSettings> {
  const existing = await getClusterSettings(name, client).catch(() => null);
  const body = {
    apiVersion: API_GROUP_VERSION,
    kind: KIND_CLUSTER_SETTINGS,
    metadata: { name, resourceVersion: existing?.metadata.resourceVersion },
    spec,
  };
  if (existing) {
    return (await client.replaceClusterCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      plural: PLURAL_CLUSTER_SETTINGS,
      name,
      body,
    })) as ClusterSettings;
  }
  return (await client.createClusterCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    plural: PLURAL_CLUSTER_SETTINGS,
    body,
  })) as ClusterSettings;
}

// ---------------------------------------------------------------------------
// Project helpers

export async function listProjects(
  ns: string = NAMESPACE,
  client = custom(),
): Promise<Project[]> {
  const res = (await client.listNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: ns,
    plural: PLURAL_PROJECT,
  })) as { items: Project[] };
  return res.items ?? [];
}

export async function getProject(
  name: string,
  ns: string = NAMESPACE,
  client = custom(),
): Promise<Project> {
  return (await client.getNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: ns,
    plural: PLURAL_PROJECT,
    name,
  })) as Project;
}

export async function createProject(
  project: Project,
  ns: string = NAMESPACE,
  client = custom(),
): Promise<Project> {
  return (await client.createNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: ns,
    plural: PLURAL_PROJECT,
    body: project,
  })) as Project;
}

export async function updateProject(
  name: string,
  spec: Project["spec"],
  ns: string = NAMESPACE,
  client = custom(),
): Promise<Project> {
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
  })) as Project;
}

export async function patchProjectSpec(
  name: string,
  specPatch: Partial<Project["spec"]>,
  ns: string = NAMESPACE,
  client = custom(),
): Promise<Project> {
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
  )) as Project;
}

export async function patchProject(
  name: string,
  patch: { metadata?: Partial<Project["metadata"]>; spec?: Partial<Project["spec"]> },
  ns: string = NAMESPACE,
  client = custom(),
): Promise<Project> {
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
  )) as Project;
}

export async function patchProjectStatus(
  name: string,
  statusPatch: { board?: Partial<BoardStatus> },
  ns: string = NAMESPACE,
  maxRetries = 3,
): Promise<Project> {
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
    if (res.ok) return res.json() as Promise<Project>;
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
// Task helpers

export async function listTasks(
  project: string,
  ns: string = NAMESPACE,
  client = custom(),
): Promise<Task[]> {
  const res = (await client.listNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: ns,
    plural: PLURAL_TASK,
    labelSelector: `${LABELS.projectName}=${project}`,
  })) as { items: Task[] };
  return res.items ?? [];
}

export async function getTask(
  name: string,
  ns: string = NAMESPACE,
  client = custom(),
): Promise<Task> {
  return (await client.getNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: ns,
    plural: PLURAL_TASK,
    name,
  })) as Task;
}

export async function createTask(
  task: Task,
  ns: string = NAMESPACE,
  client = custom(),
): Promise<Task> {
  return (await client.createNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: ns,
    plural: PLURAL_TASK,
    body: task,
  })) as Task;
}

export async function deleteTask(
  name: string,
  ns: string = NAMESPACE,
  client = custom(),
): Promise<void> {
  await client.deleteNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: ns,
    plural: PLURAL_TASK,
    name,
  });
}

export async function patchTaskStatus(
  name: string,
  statusPatch: Partial<TaskStatus>,
  ns: string = NAMESPACE,
  maxRetries = 3,
): Promise<Task> {
  const token = readServiceAccountToken() ?? readKubeconfigToken();
  if (!token) throw new Error("No service account token available");

  const host = process.env.KUBERNETES_SERVICE_HOST ?? "kubernetes.default.svc";
  const port = process.env.KUBERNETES_SERVICE_PORT ?? "443";
  const url = `https://${host}:${port}/apis/${API_GROUP_VERSION}/namespaces/${ns}/${PLURAL_TASK}/${name}/status`;

  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
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
    if (res.ok) return res.json() as Promise<Task>;
    const body = await res.text();
    if (res.status === 409 && attempt < maxRetries) {
      lastErr = new Error(`Kubernetes API conflict ${res.status}: ${body}`);
      continue;
    }
    throw new Error(`Kubernetes API error ${res.status}: ${body}`);
  }
  throw lastErr!;
}

// Patch a Task (metadata + spec, not status).
export async function patchTask(
  name: string,
  patch: Partial<Pick<Task, "metadata" | "spec">>,
  ns: string = NAMESPACE,
  client = custom(),
): Promise<Task> {
  // Use fetch directly for merge-patch since the client doesn't support custom headers well.
  const token = readServiceAccountToken() ?? readKubeconfigToken();
  if (!token) throw new Error("No service account token available");

  const host = process.env.KUBERNETES_SERVICE_HOST ?? "kubernetes.default.svc";
  const port = process.env.KUBERNETES_SERVICE_PORT ?? "443";
  const url = `https://${host}:${port}/apis/${API_GROUP_VERSION}/namespaces/${ns}/${PLURAL_TASK}/${name}`;

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/merge-patch+json",
      Accept: "application/json",
    },
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(15_000),
  });

  if (res.ok) return res.json() as Promise<Task>;
  const body = await res.text();
  throw new Error(`Kubernetes API error ${res.status}: ${body}`);
}

// Build a new Task object ready for createTask().
// projectUid is needed for the ownerReference.
export function buildTask({
  name,
  projectName,
  projectUid,
  ns,
  spec,
}: {
  name: string;
  projectName: string;
  projectUid: string;
  ns: string;
  spec: Task["spec"];
}): Task {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: KIND_TASK,
    metadata: {
      name,
      namespace: ns,
      labels: {
        [LABELS.projectName]: projectName,
        [LABELS.component]: "task",
      },
      ownerReferences: [
        {
          apiVersion: API_GROUP_VERSION,
          kind: KIND_PROJECT,
          name: projectName,
          uid: projectUid,
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
    spec,
  };
}

// ---------------------------------------------------------------------------
// Pod helpers

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

export async function getPod(
  name: string,
  ns: string = NAMESPACE,
): Promise<V1Pod> {
  return await core().readNamespacedPod({ name, namespace: ns });
}

export async function listPodsByLabels(
  labels: Record<string, string>,
  ns: string = NAMESPACE,
): Promise<V1Pod[]> {
  const labelSelector = Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(",");
  const res = await core().listNamespacedPod({ namespace: ns, labelSelector });
  return res.items ?? [];
}

export async function listPodEvents(
  podName: string,
  ns: string = NAMESPACE,
): Promise<Array<{
  type: string;
  reason: string;
  message: string;
  count: number;
  firstTimestamp: string;
  lastTimestamp: string;
  source: string;
}>> {
  const res = await core().listNamespacedEvent({
    namespace: ns,
    fieldSelector: `involvedObject.name=${podName}`,
  });
  return (res.items ?? []).map((e) => ({
    type: e.type ?? "",
    reason: e.reason ?? "",
    message: e.message ?? "",
    count: e.count ?? 1,
    firstTimestamp: e.firstTimestamp?.toISOString() ?? "",
    lastTimestamp: e.lastTimestamp?.toISOString() ?? "",
    source: e.source ? `${e.source.component ?? ""}/${e.source.host ?? ""}` : "",
  }));
}

// ---------------------------------------------------------------------------
// OpenCode API proxy helpers (talk to opencode server inside run pods)

export async function fetchSessionMessages(
  serviceName: string,
  sessionID: string,
  ns: string = NAMESPACE,
): Promise<unknown> {
  const url = `http://${serviceName}.${ns}.svc.cluster.local:${OPENCODE_RUNNER_DEFAULTS.port}/session/${sessionID}/message`;
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
  const url = `http://${serviceName}.${ns}.svc.cluster.local:${OPENCODE_RUNNER_DEFAULTS.port}/session/${sessionID}/message`;
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
  const url = `http://${serviceName}.${ns}.svc.cluster.local:${OPENCODE_RUNNER_DEFAULTS.port}/session/${sessionID}/permissions/${permissionID}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`OpenCode permission API ${res.status}: ${await res.text().catch(() => "")}`);
}

// Fetch all sessions and their messages from a live run pod.
// Returns combined messages from all sessions, ordered by session discovery.
export async function fetchAllSessionMessages(
  serviceName: string,
  ns: string = NAMESPACE,
): Promise<{ sessions: Array<{ id: string; messages: unknown[] }>; allMessages: unknown[] }> {
  const listUrl = `http://${serviceName}.${ns}.svc.cluster.local:${OPENCODE_RUNNER_DEFAULTS.port}/session`;
  const listRes = await fetch(listUrl, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!listRes.ok) {
    throw new Error(`OpenCode session list API ${listRes.status}: ${await listRes.text().catch(() => "")}`);
  }
  const listData = (await listRes.json()) as unknown;
  const sessionList: Array<{ id: string }> = Array.isArray(listData)
    ? listData
    : ((listData as Record<string, unknown>).items ?? (listData as Record<string, unknown>).sessions ?? []) as Array<{ id: string }>;

  const sessions: Array<{ id: string; messages: unknown[] }> = [];
  const allMessages: unknown[] = [];

  for (const session of sessionList) {
    try {
      const msgUrl = `http://${serviceName}.${ns}.svc.cluster.local:${OPENCODE_RUNNER_DEFAULTS.port}/session/${session.id}/message`;
      const msgRes = await fetch(msgUrl, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!msgRes.ok) continue;
      const msgData = (await msgRes.json()) as unknown;
      const messages: unknown[] = Array.isArray(msgData)
        ? msgData
        : ((msgData as Record<string, unknown>).items ?? []) as unknown[];
      sessions.push({ id: session.id, messages });
      allMessages.push(...messages);
    } catch {
      // Skip sessions that fail to fetch
    }
  }

  return { sessions, allMessages };
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
    if (((e as { statusCode?: number; code?: number }).statusCode ?? (e as { code?: number }).code) === 404) return null;
    throw e;
  }
}

// Read all sessions from ConfigMap snapshot (fallback when pod is gone).
// Returns all sessions with their messages combined.
export async function readAllSessionsFromConfigMap(
  runName: string,
  ns: string = NAMESPACE,
): Promise<{ sessions: Array<{ id: string; messages: unknown[]; truncated: boolean }>; allMessages: unknown[] } | null> {
  try {
    const cm = await core().readNamespacedConfigMap({
      name: `${runName}-session`,
      namespace: ns,
    });
    const sessionsRaw = cm.data?.["sessions.json"];
    if (!sessionsRaw) return null;
    const sessionIDs: string[] = JSON.parse(sessionsRaw);

    const sessions: Array<{ id: string; messages: unknown[]; truncated: boolean }> = [];
    const allMessages: unknown[] = [];

    for (const sessionID of sessionIDs) {
      const raw = cm.data?.[`messages-${sessionID}.json`];
      if (!raw) continue;
      const messages: unknown[] = JSON.parse(raw);
      const truncated = cm.data?.[`truncated-${sessionID}`] === "true";
      sessions.push({ id: sessionID, messages, truncated });
      allMessages.push(...messages);
    }

    return { sessions, allMessages };
  } catch (e: unknown) {
    if (((e as { statusCode?: number; code?: number }).statusCode ?? (e as { code?: number }).code) === 404) return null;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Plan ConfigMap helpers — store/retrieve plan artifacts per project.
// ConfigMap name: {project}-plans, data key: {task}.md

const CONFIGMAP_SIZE_WARN = 900 * 1024; // 900 KB soft limit warning

export async function getPlansConfigMap(
  projectName: string,
  ns: string = NAMESPACE,
): Promise<{ apiVersion: string; kind: string; metadata: Record<string, unknown>; data?: Record<string, string> } | null> {
  try {
    const cm = await core().readNamespacedConfigMap({
      name: `${projectName}-plans`,
      namespace: ns,
    });
    return {
      apiVersion: cm.apiVersion ?? "v1",
      kind: cm.kind ?? "ConfigMap",
      metadata: cm.metadata as unknown as Record<string, unknown>,
      data: cm.data,
    };
  } catch (e: unknown) {
    if (((e as { statusCode?: number; code?: number }).statusCode ?? (e as { code?: number }).code) === 404) return null;
    throw e;
  }
}

export async function writePlanToConfigMap(
  projectName: string,
  taskName: string,
  content: string,
  ns: string = NAMESPACE,
): Promise<{ written: boolean; sizeBytes: number; warning?: string }> {
  const key = `${taskName}.md`;
  const cmName = `${projectName}-plans`;
  let existing = await getPlansConfigMap(projectName, ns);

  if (!existing) {
    existing = {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: cmName,
        namespace: ns,
        labels: {
          [LABELS.projectName]: projectName,
          "percussionist.dev/component": "plans",
        },
      },
      data: {},
    };
  }

  const newData = { ...existing.data, [key]: content };
  const totalSize = Object.values(newData).reduce((sum, v) => sum + Buffer.byteLength(v, "utf8"), 0);
  let warning: string | undefined;
  if (totalSize > CONFIGMAP_SIZE_WARN) {
    warning = `ConfigMap data size (${Math.round(totalSize / 1024)}KB) approaching 1MB limit. Consider removing old plans.`;
  }

  if (!existing.metadata.resourceVersion) {
    // Create new ConfigMap
    await core().createNamespacedConfigMap({
      namespace: ns,
      body: {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: existing.metadata as any,
        data: newData,
      },
    });
  } else {
    // Update existing ConfigMap
    await core().replaceNamespacedConfigMap({
      name: cmName,
      namespace: ns,
      body: {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: {
          ...existing.metadata,
        } as any,
        data: newData,
      },
    });
  }

  return { written: true, sizeBytes: Buffer.byteLength(content, "utf8"), warning };
}

export async function readPlanFromConfigMap(
  projectName: string,
  taskName: string,
  ns: string = NAMESPACE,
): Promise<string | null> {
  const cm = await getPlansConfigMap(projectName, ns);
  if (!cm || !cm.data) return null;
  return cm.data[`${taskName}.md`] ?? null;
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
// Workspace exec — spawn a one-off maintenance pod to run a command against
// the project data PVC, collect its output, then delete the pod.

export interface WorkspaceExecResult {
  stdout: string;
  exitCode: number | null;
  podName: string;
}

export async function execInWorkspace(
  projectName: string,
  command: string,
  mountPath = "/data",
  timeoutMs = 120_000,
  ns: string = NAMESPACE,
): Promise<WorkspaceExecResult> {
  const podName = `ws-exec-${projectName}-${Date.now()}`.slice(0, 63).replace(/[^a-z0-9-]/g, "-");
  const pvcName = `${projectName}-data`;

  const pod: V1Pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: podName,
      namespace: ns,
      labels: {
        "app.kubernetes.io/managed-by": "percussionist",
        "percussionist.dev/component": "ws-exec",
        "percussionist.dev/project": projectName,
      },
    },
    spec: {
      restartPolicy: "Never",
      containers: [
        {
          name: "exec",
          image: "alpine:3.20",
          command: ["/bin/sh", "-c", command],
          volumeMounts: [{ name: "data", mountPath }],
        },
      ],
      volumes: [
        {
          name: "data",
          persistentVolumeClaim: { claimName: pvcName },
        },
      ],
    },
  };

  await core().createNamespacedPod({ namespace: ns, body: pod });

  // Poll until the pod reaches a terminal phase or timeout
  const deadline = Date.now() + timeoutMs;
  let exitCode: number | null = null;
  let finalPhase = "Unknown";

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2_000));
    let podStatus: V1Pod;
    try {
      podStatus = await core().readNamespacedPod({ name: podName, namespace: ns });
    } catch {
      break;
    }
    finalPhase = podStatus.status?.phase ?? "Unknown";
    if (finalPhase === "Succeeded" || finalPhase === "Failed") {
      exitCode =
        podStatus.status?.containerStatuses?.[0]?.state?.terminated?.exitCode ?? null;
      break;
    }
  }

  // Collect logs before deletion (best-effort)
  let stdout = "";
  try {
    const logRes = await core().readNamespacedPodLog({ name: podName, namespace: ns, container: "exec" });
    stdout = typeof logRes === "string" ? logRes : JSON.stringify(logRes);
  } catch {
    stdout = `(logs unavailable — pod phase: ${finalPhase})`;
  }

  // Delete the pod (best-effort)
  core().deleteNamespacedPod({ name: podName, namespace: ns }).catch(() => { /* ignore */ });

  return { stdout, exitCode, podName };
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
