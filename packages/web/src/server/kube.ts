// server/kube.ts — re-exports from @percussionist/kube.
//
// The web server previously duplicated K8s client logic here. Now the shared
// package owns all of it. This file exists as a stable import target for the
// route files.

export {
  buildTask,
  core,
  createClusterAgent,
  createProject,
  createRun,
  createTask,
  custom,
  deleteClusterAgent,
  deleteProject,
  deleteRun,
  deleteTask,
  execInWorkspace,
  // Session proxy
  fetchSessionMessages,
  getClusterAgent,
  // ClusterSettings helpers
  getClusterSettings,
  getProject,
  getRun,
  getTask,
  gitUrlHash,
  // ClusterAgent helpers
  listClusterAgents,
  listNodeAllocated,
  listNodeCapacities,
  listNodeHostStats,
  // Metrics helpers
  listNodeMetrics,
  listPodMetrics,
  listPodResources,
  // Project helpers
  listProjects,
  // Run helpers
  listRuns,
  // Task helpers
  listTasks,
  NAMESPACE,
  type NodeCapacity,
  type NodeCapacityTotal,
  type NodeHostStats,
  type NodeMetric,
  type PodMetric,
  type PodResourceSpec,
  patchProject,
  patchProjectSpec,
  patchProjectStatus,
  patchTask,
  patchTaskStatus,
  postPermissionReply,
  postSessionMessage,
  // Pod helpers
  readPodLog,
  readSessionConfigMap,
  updateClusterAgent,
  updateClusterSettings,
  updateProject,
} from '@percussionist/kube';
