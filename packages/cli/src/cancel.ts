// `beatctl cancel <name>` — delete a run and its children.
//
// Since we set ownerReferences on Secret/Service/Pod, a single CR delete
// cascades. We don't mark the CR Cancelled first: by the time the delete is
// acked the children are gone and the status subresource is moot. (A future
// milestone with durable history will want a richer lifecycle.)

import { DEFAULT_NAMESPACE, deleteRun, fatal, loadKube } from "./kube.js";

export interface CancelOpts {
  namespace?: string;
}

export async function runCancel(name: string, opts: CancelOpts): Promise<void> {
  const ns = opts.namespace ?? DEFAULT_NAMESPACE;
  const { custom } = loadKube();
  try {
    await deleteRun(custom, ns, name);
    console.log(`${name} deleted`);
  } catch (e) {
    fatal(`cancel ${name}`, e);
  }
}
