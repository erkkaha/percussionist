// lib/kube-upsert.ts — shared read→replace, catch-any→create upsert helpers
// for Kubernetes Secrets and ConfigMaps owned by the web server.
//
// This pattern was previously copy-pasted in routes/settings.ts,
// lib/agent-keys.ts and routes/projects.ts; a fix applied to one copy was
// routinely missed by the others. It now lives here exactly once.

import { core, NAMESPACE } from '../kube.js';

/**
 * Upsert a Kubernetes Secret: replace it if it exists, create it otherwise.
 *
 * Read → replace; any error from the read (not just NotFound) falls through to
 * create, preserving the original call sites' catch-all semantics exactly.
 */
export async function upsertSecret(
  name: string,
  data: Record<string, string>,
  labels?: Record<string, string>,
): Promise<void> {
  const body = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name, namespace: NAMESPACE, ...(labels ? { labels } : {}) },
    stringData: data,
  };
  try {
    await core().readNamespacedSecret({ name, namespace: NAMESPACE });
    await core().replaceNamespacedSecret({ name, namespace: NAMESPACE, body });
  } catch {
    await core().createNamespacedSecret({ namespace: NAMESPACE, body });
  }
}

/**
 * Upsert a Kubernetes ConfigMap: replace it if it exists, create it otherwise.
 * Same read → replace, catch-any → create semantics as `upsertSecret`.
 */
export async function upsertConfigMap(
  name: string,
  data: Record<string, string>,
  labels?: Record<string, string>,
): Promise<void> {
  const body = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name, namespace: NAMESPACE, ...(labels ? { labels } : {}) },
    data,
  };
  try {
    await core().readNamespacedConfigMap({ name, namespace: NAMESPACE });
    await core().replaceNamespacedConfigMap({ name, namespace: NAMESPACE, body });
  } catch {
    await core().createNamespacedConfigMap({ namespace: NAMESPACE, body });
  }
}
