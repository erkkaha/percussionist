// server/kube.ts — re-exports from @percussionist/kube.
//
// The web server previously duplicated K8s client logic here. Now the shared
// package owns all of it. This file exists as a stable import target for the
// route files.

export {
  NAMESPACE,
  core,
  custom,
  // Run helpers
  listRuns,
  getRun,
  createRun,
  deleteRun,
  // ClusterAgent helpers
  listClusterAgents,
  getClusterAgent,
  createClusterAgent,
  updateClusterAgent,
  deleteClusterAgent,
  // ClusterSettings helpers
  getClusterSettings,
  updateClusterSettings,
  // Project helpers
  listProjects,
  getProject,
  createProject,
  updateProject,
  patchProject,
  patchProjectSpec,
  patchProjectStatus,
  deleteProject,
  // Task helpers
  listTasks,
  getTask,
  createTask,
  deleteTask,
  patchTask,
  patchTaskStatus,
  buildTask,
  // Pod helpers
  readPodLog,
  // Session proxy
  fetchSessionMessages,
  postSessionMessage,
  postPermissionReply,
  readSessionConfigMap,
  execInWorkspace,
  // Metrics helpers
  listNodeMetrics,
  listPodMetrics,
  type NodeMetric,
  type PodMetric,
} from "@percussionist/kube";

// Convenience helper used by session.ts.
import { getRun } from "@percussionist/kube";
export async function getServiceNameForRun(runName: string): Promise<string | null> {
  const run = await getRun(runName);
  return (run as Record<string, unknown> & { status?: { serviceName?: string } }).status?.serviceName ?? null;
}
