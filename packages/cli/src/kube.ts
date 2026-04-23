// Shared Kubernetes client setup and small helpers reused across commands.
//
// beatctl intentionally reuses the user's kubeconfig (same rules as kubectl):
// KUBECONFIG env var, then ~/.kube/config. This keeps the CLI feeling like a
// thin ergonomic wrapper on top of the cluster, rather than something that
// owns its own credentials.

import {
  KubeConfig,
  CoreV1Api,
  CustomObjectsApi,
} from "@kubernetes/client-node";
import {
  API_GROUP,
  API_VERSION,
  PLURAL_RUN,
  PLURAL_PROJECT,
  type OpenCodeRun,
  type OpenCodeProject,
} from "@percussionist/api";

export const DEFAULT_NAMESPACE =
  process.env.PERCUSSIONIST_NAMESPACE ?? "percussionist";

export function loadKube(): {
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

// Thin wrappers around CustomObjectsApi so every command isn't repeating the
// same four-field object literal.

export async function listRuns(
  custom: CustomObjectsApi,
  namespace: string,
): Promise<OpenCodeRun[]> {
  const res = (await custom.listNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace,
    plural: PLURAL_RUN,
  })) as { items: OpenCodeRun[] };
  return res.items ?? [];
}

export async function getRun(
  custom: CustomObjectsApi,
  namespace: string,
  name: string,
): Promise<OpenCodeRun> {
  return (await custom.getNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace,
    plural: PLURAL_RUN,
    name,
  })) as OpenCodeRun;
}

export async function createRun(
  custom: CustomObjectsApi,
  namespace: string,
  body: OpenCodeRun,
): Promise<OpenCodeRun> {
  return (await custom.createNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace,
    plural: PLURAL_RUN,
    body,
  })) as OpenCodeRun;
}

export async function deleteRun(
  custom: CustomObjectsApi,
  namespace: string,
  name: string,
): Promise<void> {
  await custom.deleteNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace,
    plural: PLURAL_RUN,
    name,
  });
}

// Project wrappers ---------------------------------------------------------
//
// Projects are just another namespaced CR, no status subresource. Same four
// verbs, same error-propagation model as runs.

export async function listProjects(
  custom: CustomObjectsApi,
  namespace: string,
): Promise<OpenCodeProject[]> {
  const res = (await custom.listNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace,
    plural: PLURAL_PROJECT,
  })) as { items: OpenCodeProject[] };
  return res.items ?? [];
}

export async function getProject(
  custom: CustomObjectsApi,
  namespace: string,
  name: string,
): Promise<OpenCodeProject> {
  return (await custom.getNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace,
    plural: PLURAL_PROJECT,
    name,
  })) as OpenCodeProject;
}

export async function createProject(
  custom: CustomObjectsApi,
  namespace: string,
  body: OpenCodeProject,
): Promise<OpenCodeProject> {
  return (await custom.createNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace,
    plural: PLURAL_PROJECT,
    body,
  })) as OpenCodeProject;
}

export async function deleteProject(
  custom: CustomObjectsApi,
  namespace: string,
  name: string,
): Promise<void> {
  await custom.deleteNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace,
    plural: PLURAL_PROJECT,
    name,
  });
}

// Render helpers ------------------------------------------------------------

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
        .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd((widths[i] ?? 0) + 2)))
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
  const d = Math.floor(h / 24);
  return `${d}d`;
}

// Error-to-exit helper: Kubernetes client errors carry the useful bits on
// `.body`. Surface those instead of a generic stack trace.
export function fatal(prefix: string, e: unknown): never {
  const anyE = e as { body?: { message?: string }; message?: string };
  const msg = anyE?.body?.message ?? anyE?.message ?? String(e);
  console.error(`beatctl: ${prefix}: ${msg}`);
  process.exit(1);
}
