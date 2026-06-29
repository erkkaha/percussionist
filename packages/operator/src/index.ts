// Operator entrypoint — watches Run CRs, Project CRs, and ClusterSettings.

import { makeInformer } from '@kubernetes/client-node';
import {
  API_GROUP,
  API_VERSION,
  type ClusterSettings,
  PLURAL_CLUSTER_SETTINGS,
  PLURAL_PROJECT,
  PLURAL_RUN,
  type Project,
  type Run,
} from '@percussionist/api';
import {
  cleanupCodeServer,
  cleanupMemoryService,
  co,
  dequeue,
  enqueue,
  kc,
  NAMESPACE,
  reconcileClusterSettings,
  reconcileProject,
  runWorker,
  startPeriodicResync,
} from './reconciler.js';
import { startTTLCleanup } from './ttl.js';

const log = (...args: unknown[]) => console.log(`[operator ${new Date().toISOString()}]`, ...args);
const err = (...args: unknown[]) =>
  console.error(`[operator ${new Date().toISOString()}]`, ...args);

process.on('unhandledRejection', (reason) => {
  err('unhandledRejection:', reason);
  process.exit(1);
});

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
  runInformer.on('delete', (obj) => {
    const md = (obj as { metadata?: { namespace?: string; name?: string } }).metadata;
    dequeue(`${md?.namespace}/${md?.name}`);
  });
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
    void reconcileClusterSettings(obj as unknown as ClusterSettings);
  });
  csInformer.on('update', (obj) => {
    void reconcileClusterSettings(obj as unknown as ClusterSettings);
  });
  csInformer.on('error', (e) => {
    err('cluster-settings informer error:', (e as Error).message);
    setTimeout(() => csInformer.start().catch(console.error), 2000);
  });
  await csInformer.start();

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
    void reconcileProject(obj as unknown as Project);
  });
  projectInformer.on('update', (obj) => {
    void reconcileProject(obj as unknown as Project);
  });
  projectInformer.on('delete', (obj) => {
    void cleanupCodeServer(obj as unknown as Project);
    void cleanupMemoryService(obj as unknown as Project);
  });
  projectInformer.on('error', (e) => {
    err('project informer error:', (e as Error).message);
    setTimeout(() => projectInformer.start().catch(console.error), 2000);
  });
  await projectInformer.start();
  log('project informer started');

  startPeriodicResync();
  startTTLCleanup();
  await runWorker();
}

main().catch((e) => {
  err('fatal:', e);
  process.exit(1);
});
