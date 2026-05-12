// Manager controller — watches OpenCodeKanban CRs and dispatches worker runs.
//
// For each Kanban board:
//   1. Pull tasks from "ready" into "in-progress" up to maxParallel.
//   2. Create an OpenCodeRun for each pulled task (worker pod).
//   3. Monitor all active workers — when one completes, pull the next ready task.
//   4. On failure: retry up to 3 times, then escalate to human.
//
// The manager is persistent (single replica Deployment) and runs continuously.

import {
  KubeConfig,
  CustomObjectsApi,
  makeInformer,
  PatchStrategy,
  setHeaderOptions,
} from "@kubernetes/client-node";
import {
  API_GROUP,
  API_VERSION,
  API_GROUP_VERSION,
  KIND_KANBAN,
  PLURAL_KANBAN,
  KIND_RUN,
  OpenCodeKanbanSchema,
  OpenCodeKanbanSpecSchema,
  type OpenCodeKanban,
  type WorkerStatus,
} from "@percussionist/api";

const NAMESPACE = process.env.WATCH_NAMESPACE ?? "percussionist";
const RUNNER_IMAGE_DEFAULT =
  process.env.RUNNER_IMAGE_DEFAULT ?? "percussionist/runner:dev";

// Maximum retries before escalating to human.
const MAX_RETRIES = 3;

const log = (...args: unknown[]) =>
  console.log(`[manager ${new Date().toISOString()}]`, ...args);
const err = (...args: unknown[]) =>
  console.error(`[manager ${new Date().toISOString()}]`, ...args);

// ---------------------------------------------------------------------------
// K8s client

const kc = new KubeConfig();
kc.loadFromDefault();
const k8s = kc.makeApiClient(CustomObjectsApi);

// ---------------------------------------------------------------------------
// Helpers

function ownerRefsFor(kanban: OpenCodeKanban) {
  return [
    {
      apiVersion: API_GROUP_VERSION,
      kind: KIND_KANBAN,
      name: kanban.metadata.name,
      uid: kanban.metadata.uid!,
      controller: true,
      blockOwnerDeletion: true,
    },
  ];
}

async function patchKanbanStatus(
  kanbanName: string,
  patch: Partial<OpenCodeKanban["status"]>,
): Promise<void> {
  const body = { status: { ...patch, lastEventAt: new Date().toISOString() } };

  let token: string | undefined;
  try {
    const fs = await import("node:fs");
    token = fs.readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8").trim();
  } catch (e) {
    const kc = new KubeConfig();
    kc.loadFromCluster();
    const currentContext = kc.getCurrentContext();
    if (currentContext) {
      const user = kc.getUser(currentContext);
      token = (user as unknown as Record<string, string>)?.token;
    }
  }
  if (!token) { err("patchKanbanStatus: no service account token"); return; }

  const host = process.env.KUBERNETES_SERVICE_HOST || "kubernetes.default.svc";
  const port = process.env.KUBERNETES_SERVICE_PORT || "443";
  const url = `https://${host}:${port}/apis/${API_GROUP}/${API_VERSION}/namespaces/${NAMESPACE}/${PLURAL_KANBAN}/${kanbanName}/status`;

  try {
    // Minikube uses self-signed certs; disable verification for the status patch request.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/merge-patch+json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      err(`patchKanbanStatus(${kanbanName}): HTTP ${res.status}: ${text}`);
    }
  } catch (e) {
    err(`patchKanbanStatus(${kanbanName}):`, (e as Error).message);
  }
}

// Fetch a single run CR by name for reading its status.
async function getRun(runName: string): Promise<Record<string, unknown> | null> {
  let token: string | undefined;
  try {
    const fs = await import("node:fs");
    token = fs.readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8").trim();
  } catch (e) {}

  if (!token) return null;

  try {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    const host = process.env.KUBERNETES_SERVICE_HOST || "kubernetes.default.svc";
    const port = process.env.KUBERNETES_SERVICE_PORT || "443";
    const url = `https://${host}:${port}/apis/${API_GROUP}/${API_VERSION}/namespaces/${NAMESPACE}/opencoderuns/${runName}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    err(`getRun(${runName}):`, (e as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Worker run creation — builds an OpenCodeRun spec from a kanban task.

function buildWorkerSpec(
  kanban: OpenCodeKanban,
  taskId: string,
  retryCount: number,
): Record<string, unknown> {
  const spec = OpenCodeKanbanSpecSchema.parse(kanban.spec);
  const defaults = spec.defaults ?? {};
  const taskDef = spec.tasks?.find((t) => t.id === taskId);

  // Build the task prompt with structured context.
  const humanContext = ""; // empty on first attempt; populated from rework feedback later
  const dependencies: string[] = [];
  for (const worker of kanban.status?.workers ?? []) {
    if (worker.prNumber && worker.status === "Succeeded") {
      dependencies.push(`- PR #${worker.prNumber} (${worker.taskId}) is merged`);
    }
  }

  const promptLines = [
    `TASK: ${taskId}${taskDef ? ` — ${taskDef.title}` : ""}`,
    "",
    "DESCRIPTION:",
    taskDef?.description ?? "No description provided.",
    "",
    "ACCEPTANCE CRITERIA:",
    ...(taskDef?.description
      ? taskDef.description.split("\n").map((l) => `- [ ] ${l.trim()}`)
      : []),
    "",
  ];

  if (dependencies.length > 0) {
    promptLines.push("DEPENDENCIES:");
    promptLines.push(...dependencies);
    promptLines.push("");
  }

  if (retryCount > 0) {
    promptLines.push(`RETRY ${retryCount}/${MAX_RETRIES}:`);
    promptLines.push(
      humanContext || "Previous attempt failed. Review the error and try a different approach.",
    );
    promptLines.push("");
  }

  const taskPrompt = promptLines.join("\n");

  // Merge defaults with task-specific overrides.
  const mergedSpec: Record<string, unknown> = {
    ...(spec.source ? { source: spec.source } : {}),
    ...(defaults.model ? { model: defaults.model } : {}),
    timeoutSeconds: defaults.timeoutSeconds ?? 14400,
    ...(defaults.resources ? { resources: defaults.resources } : {}),
    ...(spec.agents && spec.agents.length > 0 ? { agents: spec.agents } : {}),
    task: taskPrompt,
    // Use the first agent as default worker persona.
    ...(spec.agents && spec.agents.length > 0 && spec.agents[0] ? { agent: spec.agents[0].name } : {}),
  };

  return mergedSpec;
}

// ---------------------------------------------------------------------------
// Reconcile a single Kanban board.

async function reconcile(kanban: OpenCodeKanban): Promise<void> {
  const name = kanban.metadata.name!;
  const ns = kanban.metadata.namespace ?? NAMESPACE;
  const spec = OpenCodeKanbanSpecSchema.parse(kanban.spec);

  // Skip archived boards.
  if (spec.phase === "Archived") return;

  // Ensure board phase is set in status.
  const currentPhase = kanban.status?.phase ?? spec.phase;
  if (currentPhase !== spec.phase) {
    await patchKanbanStatus(name, { phase: spec.phase });
  }

  // Skip Complete boards — no new work, but let existing workers finish.
  if (spec.phase === "Complete") return;

  const columns = kanban.status?.columns ?? ["ready", "in-progress", "review", "rework", "done"];
  const backlog = kanban.status?.backlog ?? { ready: [] };
  const workers = kanban.status?.workers ?? [];

  // Count active (Running) workers.
  const activeWorkers = workers.filter((w) => w.status === "Running").length;
  const availableSlots = spec.maxParallel - activeWorkers;

  // -----------------------------------------------------------------------
  // PULL PHASE: move tasks from "ready" to "in-progress", create worker runs.
  // -----------------------------------------------------------------------
  const readyTasks = backlog.ready ?? [];
  let newBacklog = { ...backlog };
  let updatedWorkers = [...workers];
  let pullCount = 0;

  for (const taskId of readyTasks) {
    if (pullCount >= availableSlots) break;

    // Check if this task already has a worker entry.
    const existingWorker = updatedWorkers.find((w) => w.taskId === taskId);
    if (existingWorker && existingWorker.status !== "Failed" && existingWorker.status !== "Escalated") {
      // Task is already being worked on — skip.
      continue;
    }

    // Remove from ready, add to in-progress.
    newBacklog.ready = newBacklog.ready!.filter((id) => id !== taskId);
    if (!newBacklog["in-progress"]) newBacklog["in-progress"] = [];
    if (!newBacklog["in-progress"].includes(taskId)) {
      newBacklog["in-progress"]!.push(taskId);
    }

    // Create worker entry.
    const retryCount = existingWorker?.retryCount ?? 0;
    const branchName = `feat/${taskId}`;
    const sanitizedTaskId = taskId.toLowerCase().replace(/[^a-z0-9]/g, "-");
    const runName = `${name}-${sanitizedTaskId}-${Date.now().toString(16)}`;

    updatedWorkers.push({
      taskId,
      runName,
      status: "Running",
      branch: branchName,
      startedAt: new Date().toISOString(),
      retryCount,
    });
    pullCount++;

    // Create the OpenCodeRun for this worker.
    const workerSpec = buildWorkerSpec(kanban, taskId, retryCount);
    try {
      await k8s.createNamespacedCustomObject({
        group: API_GROUP,
        version: API_VERSION,
        namespace: ns,
        plural: "opencoderuns",
        body: {
          apiVersion: API_GROUP_VERSION,
          kind: KIND_RUN,
          metadata: {
            name: runName,
            labels: {
              "app.kubernetes.io/managed-by": "percussionist-manager",
              "percussionist.dev/kanban": name,
              "percussionist.dev/task-id": taskId,
            },
            ownerReferences: ownerRefsFor(kanban),
          },
          spec: workerSpec as Record<string, unknown>,
        },
      });
      log(`created worker run ${runName} for task ${taskId}`);
    } catch (e) {
      err(`failed to create worker run for ${taskId}:`, (e as Error).message);
      // Remove from in-progress on failure.
      newBacklog["in-progress"] = newBacklog["in-progress"]!.filter((id) => id !== taskId);
      if (!newBacklog.ready) newBacklog.ready = [];
      newBacklog.ready.push(taskId);
      updatedWorkers = updatedWorkers.filter((w) => w.taskId !== taskId);
    }
  }

  // -----------------------------------------------------------------------
  // MONITOR PHASE: check each worker's OpenCodeRun status.
  // -----------------------------------------------------------------------
  for (const worker of updatedWorkers) {
    if (worker.status === "Running") {
      try {
        const run = await k8s.getNamespacedCustomObject({
          group: API_GROUP,
          version: API_VERSION,
          namespace: ns,
          plural: "opencoderuns",
          name: worker.runName!,
        });

        const runStatus = (run as { status?: { phase?: string; message?: string } }).status ?? {};
        const runPhase = runStatus.phase;

        if (runPhase === "Succeeded") {
          worker.status = "Succeeded";
          worker.completedAt = new Date().toISOString();
          // Move from in-progress to review.
          newBacklog["in-progress"] = newBacklog["in-progress"]!.filter((id) => id !== worker.taskId);
          if (!newBacklog.review) newBacklog.review = [];
          if (!newBacklog.review.includes(worker.taskId)) {
            newBacklog.review.push(worker.taskId);
          }
          log(`worker ${worker.runName} succeeded for task ${worker.taskId}`);
        } else if (runPhase === "Failed") {
          const currentRetry = worker.retryCount ?? 0;
          if (currentRetry < MAX_RETRIES) {
            // Retry: increment retry count, keep in in-progress.
            worker.retryCount = currentRetry + 1;
            worker.status = "Running";
            log(`retrying task ${worker.taskId} (${worker.retryCount}/${MAX_RETRIES})`);
          } else {
            // Max retries reached — escalate.
            worker.status = "Escalated";
            worker.completedAt = new Date().toISOString();
            const runMessage = runStatus.message ?? "Unknown failure after retries";
            worker.escalation = [
              `Task: ${worker.taskId}`,
              `Worker run: ${worker.runName}`,
              `Error: ${runMessage}`,
              `Retries exhausted (${MAX_RETRIES}).`,
              `Human review needed to resolve the blocker.`,
            ].join("\n");

            // Add to escalations list.
            const escalations = kanban.status?.escalations ?? [];
            escalations.push(worker.escalation!);
            await patchKanbanStatus(name, {
              workers: updatedWorkers,
              backlog: newBacklog,
              activeWorkers: updatedWorkers.filter((w) => w.status === "Running").length,
              escalations,
            });
            log(`task ${worker.taskId} escalated after ${MAX_RETRIES} retries`);
          }
        } else if (runPhase === "Cancelled") {
          worker.status = "Failed";
          worker.completedAt = new Date().toISOString();
          // Return to ready for re-pickup.
          newBacklog["in-progress"] = newBacklog["in-progress"]!.filter((id) => id !== worker.taskId);
          if (!newBacklog.ready) newBacklog.ready = [];
          newBacklog.ready.push(worker.taskId);
        } else if (runPhase === "WaitingForInput") {
          // Worker is waiting for human input — surface pending question on kanban board.
          log(`Worker ${worker.taskId} (${worker.runName!}) WaitingForInput`);

          const runData = await getRun(worker.runName!);
          if (runData) {
            const messageText = ((runData as any).status?.message ?? "") 
              .replace("waiting for permission: ", "").replace(/^waiting for answer$/, "");

            // Get existing pending questions or create new array.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime values via K8s API
            const qs: any[] = (kanban as any).status?.pendingQuestions ?? [];
            
            // Find existing entry by workerId (taskId) and update, or add new one.
            let foundIdx = -1;
            for (let qi = 0; qi < qs.length; qi++) {
              if ((qs[qi] as any).workerId === worker.taskId) { foundIdx = qi; break; }
            }

            const q: Record<string, unknown> = {
              workerId: worker.taskId,
              runName: worker.runName!,
              sessionID: (runData as any).status?.sessionID || "",
              messageText: messageText || `Worker ${worker.taskId} is waiting for human input`,
            };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime values via K8s API
            if (foundIdx >= 0) {
              (qs as any)[foundIdx] = q; // update in place
            } else {
              qs.push(q);
            }

            await patchKanbanStatus(name, { pendingQuestions: qs });
          }
        }
      } catch (e) {
        // Run not found yet — it may still be initializing. Log but don't fail.
        const msg = (e as Error).message;
        if (!/not found/i.test(msg)) {
          err(`monitor worker ${worker.runName}:`, msg);
        }
      }
    }


    // Clear stale pending questions for workers that returned to Running.
    const currentQs = kanban.status?.pendingQuestions ?? [];
    if (currentQs.length > 0 && updatedWorkers.length > 0) {
      const activeWorkerIds = new Set(updatedWorkers.filter((w) => w.status === "Running").map(w => w.taskId));
      // Also include Succeeded workers that are in review/done columns.
      
      for (const q of currentQs as Array<Record<string, unknown>>) {
        const wid = String(q.workerId);
        if (!activeWorkerIds.has(wid)) continue; // this worker is active — keep question? No, clear it.
      }
      
      // Remove questions whose workers are back in Running state.
      const filteredQs = currentQs.filter((q: any) => {
        const wid = String(q.workerId);
        return !updatedWorkers.some(w => w.taskId === wid && w.status === "Running");
      });

      const removedCount = currentQs.length - filteredQs.length;
      if (removedCount > 0) {
        log(`Cleared ${removedCount} pending question(s) — agents resumed`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime values via K8s API
        await patchKanbanStatus(name, { pendingQuestions: filteredQs as any[] } as Partial<Record<string, unknown>>);
      }
    }

    // Handle rework: human moved task from review → rework manually via status patch.
    if (worker.status === "Succeeded" && newBacklog.rework?.includes(worker.taskId)) {
      // Re-dispatch as a new worker run with human context.
      const existingIdx = updatedWorkers.findIndex((w) => w.taskId === worker.taskId);
      if (existingIdx >= 0) {
        updatedWorkers.splice(existingIdx, 1);
      }

      const branchName = `feat/${worker.taskId}`;
      const runName = `${name}-${worker.taskId.toLowerCase()}-${Date.now().toString(16)}`;

      // Find the human context from escalations or backlog annotations.
      const humanContext = kanban.metadata.annotations?.[`percussionist.dev/rework-${worker.taskId}`] ?? "";

      updatedWorkers.push({
        taskId: worker.taskId,
        runName,
        status: "Running",
        branch: branchName,
        startedAt: new Date().toISOString(),
        retryCount: 0,
      });

      // Create the rework worker run.
      const taskDef = spec.tasks?.find((t) => t.id === worker.taskId);
      const promptLines = [
        `TASK: ${worker.taskId}${taskDef ? ` — ${taskDef.title}` : ""}`,
        "",
        "DESCRIPTION:",
        taskDef?.description ?? "No description provided.",
        "",
        "ACCEPTANCE CRITERIA:",
        ...(taskDef?.description
          ? taskDef.description.split("\n").map((l) => `- [ ] ${l.trim()}`)
          : []),
        "",
        "HUMAN FEEDBACK (rework):",
        humanContext || "Please address the feedback from the previous review.",
        "",
      ];

      const reworkSpec = buildWorkerSpec(kanban, worker.taskId, 0);
      (reworkSpec as Record<string, unknown>).task = promptLines.join("\n");

      try {
        await k8s.createNamespacedCustomObject({
          group: API_GROUP,
          version: API_VERSION,
          namespace: ns,
          plural: "opencoderuns",
          body: {
            apiVersion: API_GROUP_VERSION,
            kind: KIND_RUN,
            metadata: {
              name: runName,
              labels: {
                "app.kubernetes.io/managed-by": "percussionist-manager",
                "percussionist.dev/kanban": name,
                "percussionist.dev/task-id": worker.taskId,
              },
              ownerReferences: ownerRefsFor(kanban),
            },
            spec: reworkSpec as Record<string, unknown>,
          },
        });
        log(`re-dispatched rework for task ${worker.taskId}`);
      } catch (e) {
        err(`failed to create rework run for ${worker.taskId}:`, (e as Error).message);
      }
    }

    // Handle done: human moved task from review → done manually.
    if (worker.status === "Succeeded" && newBacklog.done?.includes(worker.taskId)) {
      // Task is done — keep the worker entry for history but mark completed.
    }
  }

  // -----------------------------------------------------------------------
  // UPDATE PHASE: patch Kanban CR status.
  // -----------------------------------------------------------------------
  const activeCount = updatedWorkers.filter((w) => w.status === "Running").length;
  await patchKanbanStatus(name, {
    columns,
    backlog: newBacklog,
    workers: updatedWorkers,
    activeWorkers: activeCount,
  });

  // Clean up completed workers from status after a grace period.
  // Remove workers that are Succeeded and not in any active column.
  const staleWorkers = updatedWorkers.filter((w) => {
    if (w.status !== "Succeeded") return false;
    for (const col of columns) {
      if ((newBacklog[col] ?? []).includes(w.taskId)) return false;
    }
    // Worker succeeded but task is no longer in any tracked column — stale.
    return true;
  });

  if (staleWorkers.length > 0) {
    updatedWorkers = updatedWorkers.filter((w) => !staleWorkers.includes(w));
    await patchKanbanStatus(name, {
      columns,
      backlog: newBacklog,
      workers: updatedWorkers,
      activeWorkers: updatedWorkers.filter((w) => w.status === "Running").length,
    });
  }
}

// ---------------------------------------------------------------------------
// Work queue (same pattern as the operator).

const queue: string[] = [];
const pending = new Set<string>();
const seen = new Map<string, OpenCodeKanban>();

function enqueue(kanban: OpenCodeKanban): void {
  const key = `${kanban.metadata.namespace}/${kanban.metadata.name}`;
  seen.set(key, kanban);
  if (!pending.has(key)) {
    pending.add(key);
    queue.push(key);
  }
}

async function worker(): Promise<void> {
  while (true) {
    const key = queue.shift();
    if (!key) {
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }
    pending.delete(key);
    const kanban = seen.get(key);
    if (!kanban) continue;
    try {
      await reconcile(kanban);
    } catch (e) {
      err(`reconcile(${key}) failed:`, (e as Error).message);
      setTimeout(() => {
        const current = seen.get(key);
        if (current) enqueue(current);
      }, 5000);
    }
  }
}

function periodicResync(): void {
  setInterval(() => {
    for (const kanban of seen.values()) enqueue(kanban);
  }, 30_000).unref(); // resync every 30s
}

// ---------------------------------------------------------------------------
// Informer — watches OpenCodeKanban CRs.

async function run(): Promise<void> {
  log(`watching ${API_GROUP_VERSION}/${PLURAL_KANBAN} in namespace=${NAMESPACE}`);

  const path = `/apis/${API_GROUP}/${API_VERSION}/namespaces/${NAMESPACE}/${PLURAL_KANBAN}`;
  const listFn = async () => {
    const res = await k8s.listNamespacedCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      namespace: NAMESPACE,
      plural: PLURAL_KANBAN,
    });
    return res as unknown as { items: OpenCodeKanban[] };
  };

  const informer = makeInformer(kc, path, listFn as never);
  informer.on("add", (obj) => enqueue(obj as unknown as OpenCodeKanban));
  informer.on("update", (obj) => enqueue(obj as unknown as OpenCodeKanban));
  informer.on("delete", (obj) => {
    const md = (obj as { metadata?: { namespace?: string; name?: string } }).metadata;
    const key = `${md?.namespace}/${md?.name}`;
    seen.delete(key);
  });
  informer.on("error", (e) => {
    err("informer error:", (e as Error).message);
    setTimeout(() => informer.start().catch((err) => console.error(err)), 2000);
  });

  await informer.start();
  periodicResync();
  await worker();
}

run().catch((e) => {
  err("fatal:", e);
  process.exit(1);
});
