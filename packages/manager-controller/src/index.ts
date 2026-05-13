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

const log = (...args: unknown[]) =>
  console.log(`[manager ${new Date().toISOString()}]`, ...args);
const err = (...args: unknown[]) =>
  console.error(`[manager ${new Date().toISOString()}]`, ...args);

async function main(): Promise<void> {
  log(
    `watching ${API_GROUP}/${API_VERSION}/${PLURAL_PROJECT} in namespace=${NAMESPACE}`,
  );

  const path = `/apis/${API_GROUP}/${API_VERSION}/namespaces/${NAMESPACE}/${PLURAL_PROJECT}`;
  const listFn = async () => {
    const res = await k8s.listNamespacedCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      namespace: NAMESPACE,
      plural: PLURAL_PROJECT,
    });
    return res as unknown as { items: OpenCodeProject[] };
  };

  const informer = makeInformer(kc, path, listFn as never);
  informer.on("add", (obj) => enqueue(obj as unknown as OpenCodeProject));
  informer.on("update", (obj) => enqueue(obj as unknown as OpenCodeProject));
  informer.on("delete", (obj) => {
    const md = (obj as { metadata?: { namespace?: string; name?: string } })
      .metadata;
    dequeue(`${md?.namespace}/${md?.name}`);
  });
  informer.on("error", (e) => {
    err("informer error:", (e as Error).message);
    setTimeout(() => informer.start().catch(console.error), 2000);
  });

  await informer.start();
  startPeriodicResync();
  await runWorker();
}

main().catch((e) => {
  err("fatal:", e);
  process.exit(1);
});
