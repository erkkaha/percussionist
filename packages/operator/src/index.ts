// Operator entrypoint — watches OpenCodeRun CRs and reconciles them.

import { makeInformer } from "@kubernetes/client-node";
import { API_GROUP, API_VERSION, PLURAL_RUN, type OpenCodeRun } from "@percussionist/api";
import {
  enqueue,
  dequeue,
  runWorker,
  startPeriodicResync,
  kc,
  co,
  NAMESPACE,
} from "./reconciler.js";
import { INGRESS_BASE_URL, INGRESS_CLASS } from "./config.js";

const log = (...args: unknown[]) =>
  console.log(`[operator ${new Date().toISOString()}]`, ...args);
const err = (...args: unknown[]) =>
  console.error(`[operator ${new Date().toISOString()}]`, ...args);

async function main(): Promise<void> {
  log(`watching ${API_GROUP}/${API_VERSION}/${PLURAL_RUN} in namespace=${NAMESPACE}`);
  if (INGRESS_BASE_URL) {
    log(`ingress base URL: ${INGRESS_BASE_URL}${INGRESS_CLASS ? ` (class: ${INGRESS_CLASS})` : ""}`);
  } else {
    log("no PERCUSSIONIST_INGRESS_BASE_URL set — per-run ingress disabled");
  }

  const path = `/apis/${API_GROUP}/${API_VERSION}/namespaces/${NAMESPACE}/${PLURAL_RUN}`;
  const listFn = async () => {
    const res = await co.listNamespacedCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      namespace: NAMESPACE,
      plural: PLURAL_RUN,
    });
    return res as unknown as { items: OpenCodeRun[] };
  };

  const informer = makeInformer(kc, path, listFn as never);
  informer.on("add", (obj) => enqueue(obj as unknown as OpenCodeRun));
  informer.on("update", (obj) => enqueue(obj as unknown as OpenCodeRun));
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
