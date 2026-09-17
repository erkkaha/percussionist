// Operator entrypoint — watches Run CRs, Project CRs, and ClusterSettings.

import { makeInformer } from '@kubernetes/client-node';
import {
  API_GROUP,
  API_VERSION,
  type ClusterSettings,
  LABELS,
  PLURAL_CLUSTER_SETTINGS,
  PLURAL_PROJECT,
  PLURAL_RUN,
  type Project,
  type Run,
} from '@percussionist/api';
import {
  cancelProjectRetry,
  cleanupCodeServer,
  cleanupMemoryService,
  co,
  core,
  dequeue,
  enqueue,
  isManagedConfigMapName,
  kc,
  NAMESPACE,
  projectKey,
  reconcileClusterSettings,
  resyncClusterSettings,
  runWorker,
  SELF_NAMESPACE,
  safeReconcileProject,
  startClusterSettingsResync,
  startPeriodicResync,
} from './reconciler.js';
import { spawnWorktreeCleanupJob, startTTLCleanup } from './ttl.js';

const log = (...args: unknown[]) => console.log(`[operator ${new Date().toISOString()}]`, ...args);
const err = (...args: unknown[]) =>
  console.error(`[operator ${new Date().toISOString()}]`, ...args);

process.on('unhandledRejection', (reason) => {
  err('unhandledRejection:', reason);
  process.exit(1);
});

/**
 * Run informer `delete` handler: dequeues the run from the resync set and,
 * for git-source runs only, fire-and-forget spawns the worktree cleanup Job.
 * This is the single trigger path for worktree cleanup — it covers TTL
 * expiry (the TTL loop deletes the Run CR, which raises this same event),
 * `kubectl delete run`, dashboard delete, and the manager's `delete_run`
 * tool alike. Local-source runs use the shared `workspace/` subPath
 * (pod-builder.ts) and must not be touched.
 */
export function handleRunDelete(obj: unknown): void {
  const run = obj as Run;
  const md = run.metadata;
  const key = `${md?.namespace}/${md?.name}`;
  dequeue(key);

  if (run.spec?.source?.git && md?.labels?.[LABELS.projectName]) {
    spawnWorktreeCleanupJob(run).catch((e) => {
      err(`worktree cleanup for ${key}:`, (e as Error).message);
    });
  }
}

async function main(): Promise<void> {
  log(`watching ${API_GROUP}/${API_VERSION}/${PLURAL_RUN} in namespace=${NAMESPACE}`);

  // Watch Run CRs.
  const runPath = `/apis/${API_GROUP}/${API_VERSION}/namespaces/${NAMESPACE}/${PLURAL_RUN}`;
  const listRunsFn = async () => {
    const res = await co.listNamespacedCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      namespace: NAMESPACE,
      plural: PLURAL_RUN,
    });
    return res as unknown as { items: Run[] };
  };

  const runInformer = makeInformer(kc, runPath, listRunsFn as never);
  runInformer.on('add', (obj) => enqueue(obj as unknown as Run));
  runInformer.on('update', (obj) => enqueue(obj as unknown as Run));
  runInformer.on('delete', handleRunDelete);
  runInformer.on('error', (e) => {
    err('run informer error:', (e as Error).message);
    setTimeout(() => runInformer.start().catch(console.error), 2000);
  });
  await runInformer.start();

  // Watch ClusterSettings CR (cluster-scoped, singleton "default").
  const csPath = `/apis/${API_GROUP}/${API_VERSION}/clustersettings`;
  const listCsFn = async () => {
    const res = await co.listClusterCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      plural: PLURAL_CLUSTER_SETTINGS,
    });
    return res as unknown as { items: ClusterSettings[] };
  };

  const csInformer = makeInformer(kc, csPath, listCsFn as never);
  csInformer.on('add', (obj) => {
    reconcileClusterSettings(obj as unknown as ClusterSettings).catch((e) => {
      err('reconcileClusterSettings(add) failed:', (e as Error).message);
    });
  });
  csInformer.on('update', (obj) => {
    reconcileClusterSettings(obj as unknown as ClusterSettings).catch((e) => {
      err('reconcileClusterSettings(update) failed:', (e as Error).message);
    });
  });
  csInformer.on('error', (e) => {
    err('cluster-settings informer error:', (e as Error).message);
    setTimeout(() => csInformer.start().catch(console.error), 2000);
  });
  await csInformer.start();

  // Watch the two ConfigMaps the operator owns. A foreign writer (Flux,
  // kubectl apply, beatctl deploy) can overwrite their data keys without
  // touching ClusterSettings, so no ClusterSettings event fires. Reacting to
  // their add/update events reverts that drift immediately; the read-before-
  // write check makes the operator's own correction a no-op the second time,
  // so this converges instead of looping.
  const cmPath = `/api/v1/namespaces/${SELF_NAMESPACE}/configmaps`;
  const listConfigMapsFn = async () => {
    const res = await core.listNamespacedConfigMap({ namespace: SELF_NAMESPACE });
    return res as unknown as { items: unknown[] };
  };
  const cmInformer = makeInformer(kc, cmPath, listConfigMapsFn as never);
  const onManagedConfigMapEvent = (obj: unknown) => {
    const name = (obj as { metadata?: { name?: string } })?.metadata?.name;
    if (!isManagedConfigMapName(name)) return;
    resyncClusterSettings().catch((e) => {
      err('reconcileClusterSettings(configmap) failed:', (e as Error).message);
    });
  };
  cmInformer.on('add', onManagedConfigMapEvent);
  cmInformer.on('update', onManagedConfigMapEvent);
  cmInformer.on('error', (e) => {
    err('configmap informer error:', (e as Error).message);
    setTimeout(() => cmInformer.start().catch(console.error), 2000);
  });
  await cmInformer.start();
  log('configmap informer started');

  // Watch Project CRs for code-server reconciliation.
  const projectPath = `/apis/${API_GROUP}/${API_VERSION}/namespaces/${NAMESPACE}/projects`;
  const listProjectsFn = async () => {
    const res = await co.listNamespacedCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      namespace: NAMESPACE,
      plural: PLURAL_PROJECT,
    });
    return res as unknown as { items: Project[] };
  };

  const projectInformer = makeInformer(kc, projectPath, listProjectsFn as never);
  projectInformer.on('add', (obj) => {
    // safeReconcileProject already catches and surfaces every error into
    // status.reconcile; this .catch is a belt-and-suspenders backstop so a
    // genuine bug in that wrapper still can't reach unhandledRejection/exit(1).
    safeReconcileProject(obj as unknown as Project).catch((e) => {
      err('safeReconcileProject(add) failed:', (e as Error).message);
    });
  });
  projectInformer.on('update', (obj) => {
    safeReconcileProject(obj as unknown as Project).catch((e) => {
      err('safeReconcileProject(update) failed:', (e as Error).message);
    });
  });
  projectInformer.on('delete', (obj) => {
    const project = obj as unknown as Project;
    cancelProjectRetry(projectKey(project));
    cleanupCodeServer(project).catch((e) => {
      err('cleanupCodeServer failed:', (e as Error).message);
    });
    cleanupMemoryService(project).catch((e) => {
      err('cleanupMemoryService failed:', (e as Error).message);
    });
  });
  projectInformer.on('error', (e) => {
    err('project informer error:', (e as Error).message);
    setTimeout(() => projectInformer.start().catch(console.error), 2000);
  });
  await projectInformer.start();
  log('project informer started');

  startPeriodicResync();
  // Backstop against foreign writers of the owned ConfigMaps: re-render from
  // ClusterSettings on an interval even when no informer event arrives.
  startClusterSettingsResync();
  startTTLCleanup();
  await runWorker();
}

if (import.meta.main) {
  main().catch((e) => {
    err('fatal:', e);
    process.exit(1);
  });
}
