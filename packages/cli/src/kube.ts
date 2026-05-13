// kube.ts — backward-compat shim over @percussionist/kube.
//
// All CLI commands import helpers from here. The underlying implementation
// lives in @percussionist/kube (shared with operator, manager-controller, web).
//
// Old call signature: fn(client, namespace, name)
// New call signature: fn(name, namespace?, client?)
//
// The wrappers below bridge the gap so no other file needs to change.

import type { CustomObjectsApi } from "@kubernetes/client-node";
import * as kube from "@percussionist/kube";
import type { OpenCodeRun, OpenCodeProject } from "@percussionist/api";

// Re-export everything, then override specific functions below.
export {
  NAMESPACE,
  NAMESPACE as DEFAULT_NAMESPACE,
  loadFromKubeconfig,
  loadFromKubeconfig as loadKube,
  padCols,
  age,
  fatal,
  // project — new-signature (name, ns?, client?); also see old-sig wrappers below
  patchProjectSpec,
  patchProjectStatus,
  // cluster agents
  listClusterAgents,
  getClusterAgent,
  createClusterAgent,
  deleteClusterAgent,
  // run
  createRun as _createRun,
  deleteRun as _deleteRun,
  listRuns as _listRuns,
} from "@percussionist/kube";

// --- Old-signature wrappers ------------------------------------------------

export async function getRun(
  client: CustomObjectsApi,
  namespace: string,
  name: string,
): Promise<OpenCodeRun> {
  return kube.getRun(name, namespace, client);
}

export async function listRuns(
  client: CustomObjectsApi,
  namespace: string,
): Promise<OpenCodeRun[]> {
  return kube.listRuns(namespace, client);
}

export async function createRun(
  client: CustomObjectsApi,
  namespace: string,
  body: OpenCodeRun,
): Promise<OpenCodeRun> {
  return kube.createRun(body, namespace, client);
}

export async function deleteRun(
  client: CustomObjectsApi,
  namespace: string,
  name: string,
): Promise<void> {
  return kube.deleteRun(name, namespace, client);
}

export async function getProject(
  client: CustomObjectsApi,
  namespace: string,
  name: string,
): Promise<OpenCodeProject> {
  return kube.getProject(name, namespace, client);
}

export async function listProjects(
  client: CustomObjectsApi,
  namespace: string,
): Promise<OpenCodeProject[]> {
  return kube.listProjects(namespace, client);
}

export async function createProject(
  client: CustomObjectsApi,
  namespace: string,
  project: OpenCodeProject,
): Promise<OpenCodeProject> {
  return kube.createProject(project, namespace, client);
}

export async function deleteProject(
  client: CustomObjectsApi,
  namespace: string,
  name: string,
): Promise<void> {
  return kube.deleteProject(name, namespace, client);
}

export async function updateProject(
  client: CustomObjectsApi,
  namespace: string,
  name: string,
  spec: OpenCodeProject["spec"],
): Promise<OpenCodeProject> {
  return kube.updateProject(name, spec, namespace, client);
}
