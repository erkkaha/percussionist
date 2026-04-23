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
  type OpenCodeRun,
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
): Promise<{ messages: unknown; truncated: boolean } | null> {
  try {
    const cm = await core().readNamespacedConfigMap({
      name: `${runName}-session`,
      namespace: NAMESPACE,
    });
    const raw = cm.data?.["messages.json"];
    if (!raw) return null;
    return {
      messages: JSON.parse(raw),
      truncated: cm.data?.["truncated"] === "true",
    };
  } catch (e: unknown) {
    const anyE = e as { statusCode?: number };
    // 404 = no snapshot exists (run didn't succeed yet, or snapshot was GC'd).
    if (anyE.statusCode === 404) return null;
    throw e;
  }
}
