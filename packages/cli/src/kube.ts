// kube.ts — backward-compat shim over @percussionist/kube.
//
// All CLI commands import helpers from here. The underlying implementation
// lives in @percussionist/kube (shared with operator, manager-controller, web).
//
// Old call signature: fn(client, namespace, name)
// New call signature: fn(name, namespace?, client?)
//
// The wrappers below bridge the gap so no other file needs to change.

import type { CustomObjectsApi } from '@kubernetes/client-node';
import type { Project, Run } from '@percussionist/api';
import * as kube from '@percussionist/kube';

// Re-export everything, then override specific functions below.
export {
  age,
  createClusterAgent,
  // run
  createRun as _createRun,
  deleteClusterAgent,
  deleteRun as _deleteRun,
  fatal,
  getClusterAgent,
  // cluster agents
  listClusterAgents,
  listAllProjects as _listAllProjects,
  listRuns as _listRuns,
  loadFromKubeconfig,
  loadFromKubeconfig as loadKube,
  NAMESPACE,
  NAMESPACE as DEFAULT_NAMESPACE,
  padCols,
  // project — new-signature (name, ns?, client?); also see old-sig wrappers below
  patchProjectSpec,
  patchProjectStatus,
} from '@percussionist/kube';

// --- Old-signature wrappers ------------------------------------------------

export async function getRun(
  client: CustomObjectsApi,
  namespace: string,
  name: string,
): Promise<Run> {
  return kube.getRun(name, namespace, client);
}

export async function listRuns(client: CustomObjectsApi, namespace: string): Promise<Run[]> {
  return kube.listRuns(namespace, client);
}

export async function createRun(
  client: CustomObjectsApi,
  namespace: string,
  body: Run,
): Promise<Run> {
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
): Promise<Project> {
  return kube.getProject(name, namespace, client);
}

export async function listProjects(
  client: CustomObjectsApi,
  namespace: string,
): Promise<Project[]> {
  return kube.listProjects(namespace, client);
}

export async function listAllProjects(client: CustomObjectsApi): Promise<Project[]> {
  return kube.listAllProjects(client);
}

export async function createProject(
  client: CustomObjectsApi,
  namespace: string,
  project: Project,
): Promise<Project> {
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
  spec: Project['spec'],
): Promise<Project> {
  return kube.updateProject(name, spec, namespace, client);
}
