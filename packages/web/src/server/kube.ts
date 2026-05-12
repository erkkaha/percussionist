// Shared Kubernetes client setup for the web server.
//
// In-cluster: uses the service account token mounted at
// /var/run/secrets/kubernetes.io/serviceaccount.
// Local dev: falls back to kubeconfig (same as beatctl).

import {
  KubeConfig,
  CoreV1Api,
  CustomObjectsApi,
} from "@kubernetes/client-node";
import {
  API_GROUP,
  API_VERSION,
  API_GROUP_VERSION,
  KIND_RUN,
  PLURAL_RUN,
  KIND_PROJECT,
  PLURAL_PROJECT,
  KIND_CLUSTER_AGENT,
  PLURAL_CLUSTER_AGENT,
  KIND_KANBAN,
  PLURAL_KANBAN,
  type OpenCodeRun,
  type OpenCodeProject,
  type ClusterAgent,
  type OpenCodeKanban,
} from "@percussionist/api";

export const NAMESPACE =
  process.env.WATCH_NAMESPACE ??
  process.env.PERCUSSIONIST_NAMESPACE ??
  "percussionist";

let _kc: KubeConfig | undefined;
let _core: CoreV1Api | undefined;
let _custom: CustomObjectsApi | undefined;

function init() {
  if (_kc) return;
  _kc = new KubeConfig();
  try {
    _kc.loadFromCluster();
  } catch {
    // Fallback for local development.
    _kc.loadFromDefault();
  }
  _core = _kc.makeApiClient(CoreV1Api);
  _custom = _kc.makeApiClient(CustomObjectsApi);
}

export function core(): CoreV1Api {
  init();
  return _core!;
}

export function custom(): CustomObjectsApi {
  init();
  return _custom!;
}

// ---------------------------------------------------------------------------
// Typed helpers (same pattern as CLI's kube.ts)

export async function listRuns(): Promise<OpenCodeRun[]> {
  const res = (await custom().listNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: NAMESPACE,
    plural: PLURAL_RUN,
  })) as { items: OpenCodeRun[] };
  return res.items ?? [];
}

export async function getRun(name: string): Promise<OpenCodeRun> {
  return (await custom().getNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: NAMESPACE,
    plural: PLURAL_RUN,
    name,
  })) as OpenCodeRun;
}

export async function createRun(run: OpenCodeRun): Promise<OpenCodeRun> {
  return (await custom().createNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: NAMESPACE,
    plural: PLURAL_RUN,
    body: run,
  })) as OpenCodeRun;
}

export async function deleteRun(name: string): Promise<void> {
  await custom().deleteNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: NAMESPACE,
    plural: PLURAL_RUN,
    name,
  });
}

// ---------------------------------------------------------------------------
// ClusterAgent helpers (cluster-scoped)

export async function listClusterAgents(): Promise<ClusterAgent[]> {
  const res = (await custom().listClusterCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    plural: PLURAL_CLUSTER_AGENT,
  })) as { items: ClusterAgent[] };
  return res.items ?? [];
}

export async function getClusterAgent(name: string): Promise<ClusterAgent> {
  return (await custom().getClusterCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    plural: PLURAL_CLUSTER_AGENT,
    name,
  })) as ClusterAgent;
}

export async function createClusterAgent(agent: ClusterAgent): Promise<ClusterAgent> {
  return (await custom().createClusterCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    plural: PLURAL_CLUSTER_AGENT,
    body: agent,
  })) as ClusterAgent;
}

export async function updateClusterAgent(
  name: string,
  spec: ClusterAgent["spec"],
): Promise<ClusterAgent> {
  const existing = await getClusterAgent(name);
  return (await custom().replaceClusterCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    plural: PLURAL_CLUSTER_AGENT,
    name,
    body: {
      apiVersion: API_GROUP_VERSION,
      kind: KIND_CLUSTER_AGENT,
      metadata: {
        name,
        resourceVersion: existing.metadata.resourceVersion,
      },
      spec,
    },
  })) as ClusterAgent;
}

export async function deleteClusterAgent(name: string): Promise<void> {
  await custom().deleteClusterCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    plural: PLURAL_CLUSTER_AGENT,
    name,
  });
}

// ---------------------------------------------------------------------------
// Project helpers

export async function listProjects(): Promise<OpenCodeProject[]> {
  const res = (await custom().listNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: NAMESPACE,
    plural: PLURAL_PROJECT,
  })) as { items: OpenCodeProject[] };
  return res.items ?? [];
}

export async function getProject(name: string): Promise<OpenCodeProject> {
  return (await custom().getNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: NAMESPACE,
    plural: PLURAL_PROJECT,
    name,
  })) as OpenCodeProject;
}

export async function createProject(project: OpenCodeProject): Promise<OpenCodeProject> {
  return (await custom().createNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: NAMESPACE,
    plural: PLURAL_PROJECT,
    body: project,
  })) as OpenCodeProject;
}

export async function updateProject(
  name: string,
  spec: OpenCodeProject["spec"],
): Promise<OpenCodeProject> {
  const existing = await getProject(name);
  return (await custom().replaceNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: NAMESPACE,
    plural: PLURAL_PROJECT,
    name,
    body: {
      apiVersion: API_GROUP_VERSION,
      kind: KIND_PROJECT,
      metadata: {
        name,
        resourceVersion: existing.metadata.resourceVersion,
      },
      spec,
    },
  })) as OpenCodeProject;
}

export async function deleteProject(name: string): Promise<void> {
  await custom().deleteNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: NAMESPACE,
    plural: PLURAL_PROJECT,
    name,
  });
}

// ---------------------------------------------------------------------------
// Kanban helpers

export async function listKanbans(): Promise<OpenCodeKanban[]> {
  const res = (await custom().listNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: NAMESPACE,
    plural: PLURAL_KANBAN,
  })) as { items: OpenCodeKanban[] };
  return res.items ?? [];
}

export async function getKanban(name: string): Promise<OpenCodeKanban> {
  return (await custom().getNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: NAMESPACE,
    plural: PLURAL_KANBAN,
    name,
  })) as OpenCodeKanban;
}

export async function createKanban(kanban: OpenCodeKanban): Promise<OpenCodeKanban> {
  return (await custom().createNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: NAMESPACE,
    plural: PLURAL_KANBAN,
    body: kanban,
  })) as OpenCodeKanban;
}

export async function updateKanban(
  name: string,
  spec: OpenCodeKanban["spec"],
): Promise<OpenCodeKanban> {
  const existing = await getKanban(name);
  return (await custom().replaceNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: NAMESPACE,
    plural: PLURAL_KANBAN,
    name,
    body: {
      apiVersion: API_GROUP_VERSION,
      kind: KIND_KANBAN,
      metadata: {
        name,
        resourceVersion: existing.metadata.resourceVersion,
      },
      spec,
    },
  })) as OpenCodeKanban;
}

export async function patchKanbanStatus(
  name: string,
  statusPatch: Record<string, unknown>,
): Promise<OpenCodeKanban> {
  // Use fetch directly with the correct content-type for merge-patch on status subresource.
  // The kubernetes client's patchNamespacedCustomObjectStatus sends application/json-patch+json
  // which Kubernetes rejects for this CRD; we need application/merge-patch+json instead.
  const kc = _kc || new KubeConfig();
  kc.loadFromCluster();

  let token: string | undefined;
  try {
    token = require("fs").readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8").trim();
  } catch {
    // Fallback for local development — read from kubeconfig.
    const currentContext = kc.getCurrentContext();
    if (currentContext) {
      const user = kc.getUser(currentContext);
      token = (user as unknown as Record<string, string>)?.token;
    }
  }
  if (!token) throw new Error("No service account token available");

  const apiVersion = `${API_GROUP}/${API_VERSION}`;
  const host = process.env.KUBERNETES_SERVICE_HOST || "kubernetes.default.svc";
  const port = process.env.KUBERNETES_SERVICE_PORT || "443";
  const url = `https://${host}:${port}/apis/${apiVersion}/namespaces/${NAMESPACE}/${PLURAL_KANBAN}/${name}/status`;

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/merge-patch+json",
      Accept: "application/json",
    },
    body: JSON.stringify({ status: statusPatch }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kubernetes API error ${res.status}: ${text}`);
  }

  return (await res.json()) as OpenCodeKanban;
}

export async function deleteKanban(name: string): Promise<void> {
  await custom().deleteNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: NAMESPACE,
    plural: PLURAL_KANBAN,
    name,
  });
}

export async function readPodLog(
  podName: string,
  container: string,
  tailLines?: number,
): Promise<string> {
  const res = await core().readNamespacedPodLog({
    name: podName,
    namespace: NAMESPACE,
    container,
    tailLines,
  });
  return res ?? "";
}

// ---------------------------------------------------------------------------
// OpenCode API proxy helpers
//
// Session messages live inside each run pod's OpenCode server (port 4096).

export async function fetchSessionMessages(
  serviceName: string,
  sessionID: string,
): Promise<unknown> {
  const url = `http://${serviceName}.${NAMESPACE}.svc.cluster.local:4096/session/${sessionID}/message`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`OpenCode API returned HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Session snapshot fallback
//
// When the live proxy to the OpenCode server fails (pod deleted, etc) we
// try reading the session from the ConfigMap that the dispatcher wrote
// before exiting.

export async function readSessionConfigMap(
  runName: string,
  sessionID: string,
): Promise<{ messages: unknown[]; truncated: boolean } | null> {
  try {
    const cm = await core().readNamespacedConfigMap({
      name: `${runName}-session`,
      namespace: NAMESPACE,
    });
    // Verify the session exists in the snapshot index.
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
    const anyE = e as { statusCode?: number };
    // 404 = no snapshot exists (run didn't succeed yet, or snapshot was GC'd).
    if (anyE.statusCode === 404) return null;

    throw e;
  }
}

// POST a follow-up message to an opencode session (human reply).
export async function postSessionMessage(
  serviceName: string, sessionID: string, text: string,
): Promise<void> {
  const url = `http://${serviceName}.${NAMESPACE}.svc.cluster.local:4096/session/${sessionID}/message`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text }] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`OpenCode API returned HTTP ${res.status}: ${await res.text().catch(() => "")}`);
}

// Reply to a permission request (approve/reject).
export async function postPermissionReply(
  serviceName: string, sessionID: string, permissionID: string, response: "once" | "always" | "reject",
): Promise<void> {
  const url = `http://${serviceName}.${NAMESPACE}.svc.cluster.local:4096/session/${sessionID}/permissions/${permissionID}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`OpenCode permission API returned HTTP ${res.status}: ${await res.text().catch(() => "")}`);
}

// Resolve the opencode service name for a given run.
export async function getServiceNameForRun(runName: string): Promise<string | null> {
  const run = await getRun(runName);
  return (run as any).status?.serviceName ?? null;
}
