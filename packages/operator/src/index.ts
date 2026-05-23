// Operator entrypoint — watches Run CRs and ClusterSettings.

import { makeInformer } from "@kubernetes/client-node";
import {
  API_GROUP,
  API_VERSION,
  PLURAL_RUN,
  PLURAL_CLUSTER_SETTINGS,
  type Run,
  type ClusterSettings,
} from "@percussionist/api";
import {
  enqueue,
  dequeue,
  runWorker,
  startPeriodicResync,
  kc,
  co,
  NAMESPACE,
  reconcileClusterSettings,
} from "./reconciler.js";
import { INGRESS_BASE_URL, INGRESS_CLASS } from "./config.js";
import { startTTLCleanup } from "./ttl.js";

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
  runInformer.on("add", (obj) => enqueue(obj as unknown as Run));
  runInformer.on("update", (obj) => enqueue(obj as unknown as Run));
  runInformer.on("delete", (obj) => {
    const md = (obj as { metadata?: { namespace?: string; name?: string } })
      .metadata;
    dequeue(`${md?.namespace}/${md?.name}`);
  });
  runInformer.on("error", (e) => {
    err("run informer error:", (e as Error).message);
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
  csInformer.on("add", (obj) => {
    void reconcileClusterSettings(obj as unknown as ClusterSettings);
  });
  csInformer.on("update", (obj) => {
    void reconcileClusterSettings(obj as unknown as ClusterSettings);
  });
  csInformer.on("error", (e) => {
    err("cluster-settings informer error:", (e as Error).message);
    setTimeout(() => csInformer.start().catch(console.error), 2000);
  });
  await csInformer.start();

  startPeriodicResync();
  startTTLCleanup();
  await runWorker();
}

main().catch((e) => {
  err("fatal:", e);
  process.exit(1);
});
