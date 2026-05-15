// Manager controller entrypoint — watches OpenCodeProject CRs and drives
// the embedded kanban board for each project.

import { makeInformer } from "@kubernetes/client-node";
import {
  API_GROUP,
  API_VERSION,
  PLURAL_PROJECT,
  type OpenCodeProject,
} from "@percussionist/api";
import {
  enqueue,
  dequeue,
  runWorker,
  startPeriodicResync,
  kc,
  k8s,
  NAMESPACE,
} from "./reconciler.js";
import { startAgent } from "./agent/index.js";

const log = (...args: unknown[]) =>
  console.log(`[manager ${new Date().toISOString()}]`, ...args);
const err = (...args: unknown[]) =>
  console.error(`[manager ${new Date().toISOString()}]`, ...args);

async function main(): Promise<void> {
  try {
    log(`NAMESPACE=${NAMESPACE}`);
    log(`API_GROUP=${API_GROUP}, API_VERSION=${API_VERSION}, PLURAL_PROJECT=${PLURAL_PROJECT}`);
    log(
      `watching ${API_GROUP}/${API_VERSION}/${PLURAL_PROJECT} in namespace=${NAMESPACE}`,
    );
  } catch (e) {
    err("failed to log initial message:", (e as Error).message, (e as Error).stack);
    throw e;
  }
  log("about to define listFn...");

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
    const items = (res as unknown as { items: OpenCodeProject[] }).items;
    log(`listFn returned ${items.length} project(s)`);
    return res as unknown as { items: OpenCodeProject[] };
  };
  log("listFn defined, starting bootstrap...");

  // Bootstrap: manually list and enqueue existing projects on startup.
  log("bootstrapping: listing existing projects");
  try {
    const initialList = await listFn();
    log(`bootstrap: found ${initialList.items.length} existing project(s)`);
    for (const project of initialList.items) {
      const md = project.metadata;
      log(`bootstrap: enqueueing ${md.namespace}/${md.name}`);
      enqueue(project);
    }
  } catch (e) {
    err("bootstrap failed:", (e as Error).message, (e as Error).stack);
  }

  const informer = makeInformer(kc, path, listFn as never);
  informer.on("add", (obj) => {
    const md = (obj as { metadata?: { namespace?: string; name?: string } }).metadata;
    log(`add event: ${md?.namespace}/${md?.name}`);
    enqueue(obj as unknown as OpenCodeProject);
  });
  informer.on("update", (obj) => {
    const md = (obj as { metadata?: { namespace?: string; name?: string } }).metadata;
    log(`update event: ${md?.namespace}/${md?.name}`);
    enqueue(obj as unknown as OpenCodeProject);
  });
  informer.on("delete", (obj) => {
    const md = (obj as { metadata?: { namespace?: string; name?: string } })
      .metadata;
    log(`delete event: ${md?.namespace}/${md?.name}`);
    dequeue(`${md?.namespace}/${md?.name}`);
  });
  informer.on("error", (e) => {
    err("informer error:", (e as Error).message);
    setTimeout(() => {
      void informer.start().catch((startErr) => {
        err("informer restart failed:", (startErr as Error).message);
      });
    }, 2000);
  });

  log("starting informer...");
  void informer.start().then(
    () => log("informer started successfully"),
    (e) => err("informer.start() failed:", (e as Error).message, (e as Error).stack),
  );

  log("starting agent module...");
  startAgent().catch((e) =>
    err("agent module failed to start:", (e as Error).message),
  );

  log("starting periodic resync...");
  startPeriodicResync();
  log("starting worker loop...");
  await runWorker();
}

main().catch((e) => {
  err("fatal:", e);
  process.exit(1);
});
