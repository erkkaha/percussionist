// Audit — persist reconciler decisions as Kubernetes Events.

import type { AuditEvent } from "./decision.js";
import { KIND_TASK, API_GROUP, API_VERSION } from "@percussionist/api";

export async function persistEvent(
  event: AuditEvent,
  namespace: string,
  taskName: string,
  taskUid: string,
): Promise<void> {
  try {
    const { kc } = await import("../reconciler-bridge.js");
    const coreApi = kc.makeApiClient(await import("@kubernetes/client-node").then((m) => m.CoreV1Api));

    const k8sEvent = {
      metadata: {
        namespace,
        generateName: `${taskName}-`,
        labels: { "percussionist.dev/project": event.project },
      },
      involvedObject: {
        apiVersion: `${API_GROUP}/${API_VERSION}`,
        kind: KIND_TASK,
        name: taskName,
        namespace,
        uid: taskUid,
      },
      reason: event.reason,
      message: event.message ?? `${event.fromPhase} → ${event.toPhase ?? "(no change)"}`,
      type: event.toPhase === "failed" ? "Warning" : "Normal",
      firstTimestamp: event.at,
      lastTimestamp: event.at,
      count: 1,
      action: "Reconcile",
      reportingComponent: "percussionist-manager",
    };

    await coreApi.createNamespacedEvent({ namespace, body: k8sEvent as never });
  } catch (e) {
    // Best-effort — don't block reconciliation on event persistence failure.
    console.warn(`[audit] Failed to persist event ${event.reason} for ${taskName}:`, (e as Error).message);
  }
}
