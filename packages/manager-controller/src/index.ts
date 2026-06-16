// Manager controller entrypoint — watches Project CRs and drives
// the embedded kanban board for each project.

import { makeInformer } from '@kubernetes/client-node';
import {
  API_GROUP,
  API_VERSION,
  LABELS,
  PLURAL_PROJECT,
  PLURAL_RUN,
  PLURAL_TASK,
  type Project,
  type Run,
  type Task,
} from '@percussionist/api';
import { startAgent } from './agent/index.js';
import { startMcpServer } from './agent/tools.js';
import {
  dequeue,
  enqueue,
  k8s,
  kc,
  NAMESPACE,
  runWorker,
  startPeriodicResync,
} from './reconciler-bridge.js';

const log = (...args: unknown[]) => console.log(`[manager ${new Date().toISOString()}]`, ...args);
const err = (...args: unknown[]) => console.error(`[manager ${new Date().toISOString()}]`, ...args);

process.on('unhandledRejection', (reason) => {
  err('unhandledRejection:', reason);
  process.exit(1);
});

async function main(): Promise<void> {
  try {
    log(`NAMESPACE=${NAMESPACE}`);
    log(`API_GROUP=${API_GROUP}, API_VERSION=${API_VERSION}, PLURAL_PROJECT=${PLURAL_PROJECT}`);
    log(`watching ${API_GROUP}/${API_VERSION}/${PLURAL_PROJECT} in namespace=${NAMESPACE}`);
  } catch (e) {
    err('failed to log initial message:', (e as Error).message, (e as Error).stack);
    throw e;
  }
  log('about to define listFn...');

  const path = `/apis/${API_GROUP}/${API_VERSION}/namespaces/${NAMESPACE}/${PLURAL_PROJECT}`;
  log(`path: ${path}`);

  const listFn = async () => {
    log(`listFn called - fetching projects from ${NAMESPACE}`);
    const res = await k8s.listNamespacedCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      namespace: NAMESPACE,
      plural: PLURAL_PROJECT,
    });
    const items = (res as unknown as { items: Project[] }).items;
    log(`listFn returned ${items.length} project(s)`);
    return res as unknown as { items: Project[] };
  };
  log('listFn defined, starting bootstrap...');

  // Bootstrap: manually list and enqueue existing projects on startup.
  log('bootstrapping: listing existing projects');
  try {
    const initialList = await listFn();
    log(`bootstrap: found ${initialList.items.length} existing project(s)`);
    for (const project of initialList.items) {
      const md = project.metadata;
      log(`bootstrap: enqueueing ${md.namespace}/${md.name}`);
      enqueue(project);
    }
  } catch (e) {
    err('bootstrap failed:', (e as Error).message, (e as Error).stack);
  }

  const informer = makeInformer(kc, path, listFn as never);
  informer.on('add', (obj) => {
    const md = (obj as { metadata?: { namespace?: string; name?: string } }).metadata;
    log(`add event: ${md?.namespace}/${md?.name}`);
    enqueue(obj as unknown as Project);
  });
  informer.on('update', (obj) => {
    const md = (obj as { metadata?: { namespace?: string; name?: string } }).metadata;
    log(`update event: ${md?.namespace}/${md?.name}`);
    enqueue(obj as unknown as Project);
  });
  informer.on('delete', (obj) => {
    const md = (obj as { metadata?: { namespace?: string; name?: string } }).metadata;
    log(`delete event: ${md?.namespace}/${md?.name}`);
    dequeue(`${md?.namespace}/${md?.name}`);
  });
  informer.on('error', (e) => {
    err('informer error:', (e as Error).message);
    setTimeout(() => {
      void informer.start().catch((startErr) => {
        err('informer restart failed:', (startErr as Error).message);
      });
    }, 2000);
  });

  // Start MCP server before the informer / opencode-web health check so the
  // sidecar can discover K8s tools when it loads the mcp config at startup.
  log('starting MCP server...');
  startMcpServer().catch((e) => err('MCP server failed to start:', (e as Error).message));

  // Task informer: enqueue the parent project whenever a task CR changes.
  const taskPath = `/apis/${API_GROUP}/${API_VERSION}/namespaces/${NAMESPACE}/${PLURAL_TASK}`;
  const listTasksFn = async () => {
    const res = await k8s.listNamespacedCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      namespace: NAMESPACE,
      plural: PLURAL_TASK,
    });
    return res as unknown as { items: Task[] };
  };
  const taskInformer = makeInformer(kc, taskPath, listTasksFn as never);
  const enqueueTaskProject = (obj: unknown) => {
    const task = obj as Task;
    const projectName = task.metadata?.labels?.[LABELS.projectName];
    if (!projectName) return;
    // We don't have the full project object here — reconciler will fetch a fresh
    // copy anyway. Enqueue a minimal stub; the real data is re-fetched in
    // runReconcileCycle via getProject().
    enqueue({
      metadata: { name: projectName, namespace: NAMESPACE },
      spec: {} as Project['spec'],
    } as Project);
  };
  taskInformer.on('add', enqueueTaskProject);
  taskInformer.on('update', enqueueTaskProject);
  taskInformer.on('delete', enqueueTaskProject);
  taskInformer.on('error', (e) => {
    err('task informer error:', (e as Error).message);
    setTimeout(() => {
      void taskInformer
        .start()
        .catch((startErr) => err('task informer restart failed:', (startErr as Error).message));
    }, 2000);
  });
  log('starting task informer...');
  void taskInformer.start().then(
    () => log('task informer started'),
    (e) => err('task informer.start() failed:', (e as Error).message),
  );

  // Run informer: enqueue the owning project whenever a worker/facilitator run
  // changes phase. Without this, terminal runs wait for an unrelated task/project
  // event or a periodic resync before the board advances.
  const runPath = `/apis/${API_GROUP}/${API_VERSION}/namespaces/${NAMESPACE}/${PLURAL_RUN}`;
  const listRunsFn = async () => {
    const res = await k8s.listNamespacedCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      namespace: NAMESPACE,
      plural: PLURAL_RUN,
    });
    return res as unknown as { items: Run[] };
  };
  const runInformer = makeInformer(kc, runPath, listRunsFn as never);
  const enqueueRunProject = (obj: unknown) => {
    const run = obj as Run;
    const projectName = run.metadata?.labels?.[LABELS.projectName] ?? run.spec?.project;
    if (!projectName) return;
    enqueue({
      metadata: { name: projectName, namespace: run.metadata?.namespace ?? NAMESPACE },
      spec: {} as Project['spec'],
    } as Project);
  };
  runInformer.on('add', enqueueRunProject);
  runInformer.on('update', enqueueRunProject);
  runInformer.on('delete', enqueueRunProject);
  runInformer.on('error', (e) => {
    err('run informer error:', (e as Error).message);
    setTimeout(() => {
      void runInformer
        .start()
        .catch((startErr) => err('run informer restart failed:', (startErr as Error).message));
    }, 2000);
  });
  log('starting run informer...');
  void runInformer.start().then(
    () => log('run informer started'),
    (e) => err('runInformer.start() failed:', (e as Error).message),
  );

  log('starting informer...');
  void informer.start().then(
    () => log('informer started successfully'),
    (e) => err('informer.start() failed:', (e as Error).message, (e as Error).stack),
  );

  log('starting agent module...');
  startAgent().catch((e) => err('agent module failed to start:', (e as Error).message));

  log('starting periodic resync...');
  startPeriodicResync();
  log('starting worker loop...');
  await runWorker();
}

main().catch((e) => {
  err('fatal:', e);
  process.exit(1);
});
