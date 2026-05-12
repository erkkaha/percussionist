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
  type OpenCodeRun,
  type OpenCodeProject,
  type ClusterAgent,
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
