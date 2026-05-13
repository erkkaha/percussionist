// reconciler.ts — reconciles a single OpenCodeProject's board.

import { randomBytes } from "node:crypto";
import {
  KubeConfig,
  CustomObjectsApi,
  makeInformer,
} from "@kubernetes/client-node";
import {
  API_GROUP,
  API_VERSION,
  PLURAL_PROJECT,
  type OpenCodeProject,
  type BoardStatus,
  type WorkerStatus,
  type FacilitationResult,
  type ManagerMetrics,
} from "@percussionist/api";
import {
  createRun,
  fetchSessionMessages,
  getRun,
  getProject,
  patchProjectStatus,
} from "@percussionist/kube";
import { buildWorkerRun, workerRunName, MAX_RETRIES } from "./worker-builder.js";
import { buildFacilitationRun, parseFacilitationResult } from "./facilitator.js";
import {
  getTasksToPull,
  getTasksToRework,
  moveTask,
  updateWorker,
  upsertWorker,
} from "./task-scheduler.js";

const NAMESPACE = process.env.PERCUSSIONIST_NAMESPACE ?? "percussionist";

const log = (...args: unknown[]) =>
  console.log(`[manager ${new Date().toISOString()}]`, ...args);
const err = (...args: unknown[]) =>
  console.error(`[manager ${new Date().toISOString()}]`, ...args);

// K8s client
const kc = new KubeConfig();
kc.loadFromDefault();
export const k8s = kc.makeApiClient(CustomObjectsApi);
export { kc };

// ---------------------------------------------------------------------------
// Main reconcile

export async function reconcile(project: OpenCodeProject): Promise<void> {
  const startTime = Date.now();

  try {
    await runReconcileCycle(project, startTime);
  } catch (e) {
    // On any unrecoverable error, still attempt to write failure metrics.
    const projectName = project.metadata.name;
    const ns = project.metadata.namespace ?? NAMESPACE;
    const reconcileDuration = Date.now() - startTime;
    try {
      await patchProjectStatus(
        projectName,
        {
          board: {
            managerMetrics: {
              lastReconcileAt: new Date().toISOString(),
              lastReconcileDurationMs: reconcileDuration,
              lastReconcileResult: "error",
              lastError: (e as Error).message,
            },
          } as Partial<BoardStatus>,
        },
        ns,
      ).catch(() => {});
    } catch {
      /* ignore second-fail */
    }
    throw e;
  }
}

async function runReconcileCycle(project: OpenCodeProject, startTime: number): Promise<void> {
  const projectName = project.metadata.name;
  const ns = project.metadata.namespace ?? NAMESPACE;

  let tasksPulled = 0;
  let workersMonitored = 0;
  let tasksReworked = 0;

  // Always fetch a fresh copy — the informer object may be stale relative to
  // status subresource updates (status patches don't bump metadata.resourceVersion
  // seen by the informer cache in all K8s versions).
  const fresh = await getProject(projectName, ns, k8s);
  const board = fresh.spec.board;

  // No board config — nothing to drive.
  if (!board) return;
  if (board.phase === "Archived") return;

  // Initialise board status if missing (first reconcile after project creation).
  const boardStatus: BoardStatus = fresh.status?.board ?? {
    columns: ["ready", "in-progress", "review", "rework", "done"],
    backlog: { ready: [] },
    workers: [],
    activeWorkers: 0,
  };

  let backlog = boardStatus.backlog ?? { ready: [] };
  let workers = boardStatus.workers ?? [];

  const specTaskIds = new Set((board.tasks ?? []).map((t) => t.id));

  // Prune: remove tasks from the backlog that no longer exist in spec.board.tasks.
  const prunedBacklog: Record<string, string[]> = {};
  for (const [col, ids] of Object.entries(backlog)) {
    const kept = (ids as string[]).filter((id) => specTaskIds.has(id));
    const pruned = (ids as string[]).filter((id) => !specTaskIds.has(id));
    if (pruned.length > 0) {
      log(`pruning ${pruned.join(", ")} from backlog column "${col}" — not in spec.board.tasks`);
    }
    prunedBacklog[col] = kept;
  }
  backlog = prunedBacklog;

  // Repair: any task in spec.board.tasks not present in any backlog column
  // gets placed into "ready".
  const placedIds = new Set(Object.values(backlog).flat());
  const unplaced = [...specTaskIds].filter((id) => !placedIds.has(id));
  if (unplaced.length > 0) {
    log(`repairing ${unplaced.length} unplaced task(s) → ready: ${unplaced.join(", ")}`);
    backlog = { ...backlog, ready: [...(backlog["ready"] ?? []), ...unplaced] };
  }

  // ------------------------------------------------------------------
  // PULL PHASE: move ready tasks → in-progress, create worker runs.
  // ------------------------------------------------------------------
  const tasksToPull = getTasksToPull(fresh, { ...boardStatus, backlog });

  for (const taskId of tasksToPull) {
    tasksPulled++;
    const taskDef = (board.tasks ?? []).find((t) => t.id === taskId);
    if (!taskDef) {
      err(`task ${taskId} in backlog but not in spec.board.tasks — skipping`);
      continue;
    }

    const teamNames = (board.agents ?? []).map((a) => a.name);
    if (!teamNames.includes(taskDef.agent)) {
      err(`task ${taskId} agent "${taskDef.agent}" not in board.agents roster — skipping`);
      continue;
    }

    const existingWorker = workers.find((w) => w.taskId === taskId);
    const retryCount = existingWorker?.retryCount ?? 0;
    const runName = workerRunName(projectName, taskId);

    backlog = moveTask(backlog, taskId, "in-progress");

    const newWorker: WorkerStatus = {
      taskId,
      runName,
      status: "Running",
      branch: `feat/${taskId}`,
      startedAt: new Date().toISOString(),
      retryCount,
      facilitated: false,
    };
    workers = upsertWorker(workers, newWorker);

    const workerRun = buildWorkerRun(fresh, taskDef, runName, retryCount);
    try {
      await createRun(workerRun, ns, k8s);
      log(`created worker run ${runName} for task ${taskId}`);
    } catch (e) {
      err(`failed to create worker run for ${taskId}:`, (e as Error).message);
      backlog = moveTask(backlog, taskId, "ready");
      workers = workers.filter((w) => w.taskId !== taskId);
    }
  }

  // ------------------------------------------------------------------
  // MONITOR PHASE: poll each Running worker's OpenCodeRun status.
  // ------------------------------------------------------------------
  const FACILITATOR_AGENT = process.env.FACILITATOR_AGENT_NAME ?? "facilitator";
  const facilitatorEnabled = (board.agents ?? []).some(
    (a) => a.name === FACILITATOR_AGENT,
  );

  for (const worker of workers.filter((w) => w.status === "Running")) {
    workersMonitored++;
    if (!worker.runName) continue;
    try {
      const run = await getRun(worker.runName, ns, k8s);
      const runPhase = run.status?.phase;

      if (runPhase === "Succeeded") {
        workers = updateWorker(workers, worker.taskId, {
          status: "Succeeded",
          completedAt: new Date().toISOString(),
        });
        backlog = moveTask(backlog, worker.taskId, "review");
        log(`worker ${worker.runName} succeeded → task ${worker.taskId} in review`);
      } else if (runPhase === "Failed") {
        const taskDef = (board.tasks ?? []).find((t) => t.id === worker.taskId);
        if (!taskDef) {
          err(`task ${worker.taskId} not found in spec.board.tasks during failure handling`);
          continue;
        }

        // Facilitator-based escalation: on first failure, spawn a
        // facilitator agent to analyze the failure and recommend an action.
        if (
          !worker.facilitated &&
          facilitatorEnabled &&
          (worker.retryCount ?? 0) === 0
        ) {
          // Read session summary for the facilitator's context.
          let sessionSummary = "";
          if (run.status?.sessionID && run.status?.serviceName) {
            let sessionData: unknown = null;
            try {
              sessionData = await fetchSessionMessages(
                run.status.serviceName,
                run.status.sessionID,
                ns,
              );
            } catch {
              sessionData = null;
            }
            if (sessionData && typeof sessionData === "object" && "messages" in sessionData) {
              const msgs = (sessionData.messages as Array<{ content?: string }>)
                .slice(-6)
                .map((m) => m.content)
                .filter(Boolean)
                .join("\n");
              sessionSummary = msgs.slice(0, 3200);
            }
          }

          const facilitationRunName = `${projectName}-facilitator-${worker.taskId.toLowerCase().replace(/[^a-z0-9]/g, "-")}-${randomBytes(3).toString("hex")}`;
          const facilitationRun = buildFacilitationRun(
            fresh,
            taskDef,
            worker.runName!,
            run.status ?? {},
            sessionSummary,
            facilitationRunName,
          );

          try {
            await createRun(facilitationRun, ns, k8s);
            workers = updateWorker(workers, worker.taskId, {
              facilitated: true,
              facilitationRunName,
            });
            log(`spawned facilitator ${facilitationRunName} for failed task ${worker.taskId}`);
          } catch (e) {
            err(`failed to create facilitator run for ${worker.taskId}:`, (e as Error).message);
            // Fall through to standard retry behavior.
            if ((worker.retryCount ?? 0) < MAX_RETRIES) {
              workers = updateWorker(workers, worker.taskId, {
                retryCount: (worker.retryCount ?? 0) + 1,
                status: "Running",
              });
              log(`facilitator creation failed — standard retry (${worker.retryCount! + 1}/${MAX_RETRIES})`);
              // Re-queue the task for retry
              backlog = moveTask(backlog, worker.taskId, "ready");
            } else {
              const msg = run.status?.message ?? "Unknown failure";
              workers = updateWorker(workers, worker.taskId, {
                status: "Escalated",
                completedAt: new Date().toISOString(),
                escalation: `Task: ${worker.taskId}\nWorker: ${worker.runName}\nError: ${msg}\nFacilitator creation failed.\nRetries exhausted (${MAX_RETRIES}). Human review needed.`,
              });
              log(`task ${worker.taskId} escalated after facilitator creation failure and retries exhausted`);
            }
          }
        } else if (
          facilitatorEnabled &&
          worker.facilitated &&
          worker.facilitationRunName
        ) {
          // Facilitator run exists — check its result.
          let result: FacilitationResult | null = null;
          try {
            result = await parseFacilitationResult(
              worker.facilitationRunName,
              ns,
            );
          } catch (e) {
            err(`failed to parse facilitation result for ${worker.taskId}:`, (e as Error).message);
          }

          if (result) {
            // Apply the facilitator's recommendation.
            if (result.recommendedAction === "retry_same") {
              workers = updateWorker(workers, worker.taskId, {
                retryCount: (worker.retryCount ?? 0) + 1,
                status: "Running",
                facilitated: true,
                facilitationResult: result,
              });
              backlog = moveTask(backlog, worker.taskId, "ready");
              log(`facilitator recommends retry_same for ${worker.taskId}`);
            } else if (result.recommendedAction === "retry_alternative" && result.alternativeAgent) {
              // Validate alternative agent is in the team roster.
              const teamNames = (board.agents ?? []).map((a) => a.name);
              if (teamNames.includes(result.alternativeAgent)) {
                const newRunName = workerRunName(projectName, worker.taskId);
                const reworkRun = buildWorkerRun(fresh, taskDef, newRunName, (worker.retryCount ?? 0) + 1);
                reworkRun.spec.agent = result.alternativeAgent;
                workers = upsertWorker(workers, {
                  taskId: worker.taskId,
                  runName: newRunName,
                  status: "Running",
                  branch: `feat/${worker.taskId}`,
                  startedAt: new Date().toISOString(),
                  retryCount: (worker.retryCount ?? 0) + 1,
                  facilitated: true,
                  facilitationResult: result,
                });
                backlog = moveTask(backlog, worker.taskId, "ready");
                try {
                  await createRun(reworkRun, ns, k8s);
                  log(`facilitator recommends retry_alternative with ${result.alternativeAgent} for ${worker.taskId}`);
                } catch (e) {
                  err(`failed to create alternative-agent run for ${worker.taskId}:`, (e as Error).message);
                  workers = updateWorker(workers, worker.taskId, {
                    status: "Escalated",
                    completedAt: new Date().toISOString(),
                    escalation: `Facilitator recommended retry_alternative with ${result.alternativeAgent} but failed to create run: ${(e as Error).message}`,
                  });
                }
              } else {
                // Alternative agent not available — escalate.
                const msg = result.suggestion ?? `Facilitator recommended alternative agent "${result.alternativeAgent}" not in team roster`;
                workers = updateWorker(workers, worker.taskId, {
                  status: "Escalated",
                  completedAt: new Date().toISOString(),
                  escalation: `Task: ${worker.taskId}\nWorker: ${worker.runName}\nFacilitator diagnosis: ${result.diagnosis}\nAction: ${msg}`,
                  facilitationResult: result,
                });
                log(`facilitator: alternative agent ${result.alternativeAgent} not available — escalated`);
              }
            } else {
              // "skip" or unrecognized action → escalate with diagnosis.
              workers = updateWorker(workers, worker.taskId, {
                status: "Escalated",
                completedAt: new Date().toISOString(),
                escalation: `Task: ${worker.taskId}\nWorker: ${worker.runName}\nFacilitator diagnosis: ${result.diagnosis}\nAction: skip recommended`,
                facilitationResult: result,
              });
              log(`facilitator recommends skip for ${worker.taskId}`);
            }
          } else {
            // No parseable result from facilitator — check facilitator run phase.
            let facilitatorPhase: string | undefined;
            try {
              const facRun = await getRun(worker.facilitationRunName, ns, k8s);
              facilitatorPhase = facRun.status?.phase;
            } catch {
              // facilitator run not found
            }

            if (facilitatorPhase === "Succeeded" || facilitatorPhase === "Failed") {
              // Facilitator done but we got nothing useful. Fall back.
              if ((worker.retryCount ?? 0) < MAX_RETRIES) {
                workers = updateWorker(workers, worker.taskId, {
                  retryCount: (worker.retryCount ?? 0) + 1,
                  status: "Running",
                  facilitated: true,
                });
                backlog = moveTask(backlog, worker.taskId, "ready");
                log(`facilitator returned no result (${facilitatorPhase}) — standard retry (${worker.retryCount! + 1}/${MAX_RETRIES})`);
              } else {
                const msg = run.status?.message ?? "Unknown failure after retries";
                workers = updateWorker(workers, worker.taskId, {
                  status: "Escalated",
                  completedAt: new Date().toISOString(),
                  escalation: `Task: ${worker.taskId}\nWorker: ${worker.runName}\nError: ${msg}\nFacilitator returned no actionable result (${facilitatorPhase}).\nHuman review needed.`,
                });
                log(`task ${worker.taskId} escalated after facilitator returned no result and retries exhausted`);
              }
            }
            // else: facilitator still Running — leave worker as Failed, retry next cycle
          }
        } else if ((worker.retryCount ?? 0) < MAX_RETRIES) {
          // Standard retry (no facilitator configured or already facilitated).
          workers = updateWorker(workers, worker.taskId, {
            retryCount: (worker.retryCount ?? 0) + 1,
            status: "Running",
          });
          backlog = moveTask(backlog, worker.taskId, "ready");
          log(
            `task ${worker.taskId} failed — retrying (${worker.retryCount! + 1}/${MAX_RETRIES})`,
          );
        } else {
          // Retries exhausted → escalate.
          const msg = run.status?.message ?? "Unknown failure after retries";
          const escalation = [
            `Task: ${worker.taskId}`,
            `Worker run: ${worker.runName}`,
            `Error: ${msg}`,
            `Retries exhausted (${MAX_RETRIES}). Human review needed.`,
          ].join("\n");
          workers = updateWorker(workers, worker.taskId, {
            status: "Escalated",
            completedAt: new Date().toISOString(),
            escalation,
          });
          log(`task ${worker.taskId} escalated after ${MAX_RETRIES} retries`);
        }
      } else if (runPhase === "Cancelled") {
        workers = updateWorker(workers, worker.taskId, {
          status: "Failed",
          completedAt: new Date().toISOString(),
        });
        backlog = moveTask(backlog, worker.taskId, "ready");
      } else if (runPhase === "WaitingForInput") {
        const sessionID = run.status?.sessionID ?? "";
        const messageText =
          run.status?.message ?? `Worker ${worker.taskId} is waiting for input`;
        // Surface pending question on board status.
        const existingQs = (boardStatus.pendingQuestions ?? []).filter(
          (q) => q.workerId !== worker.taskId,
        );
        const updatedQs = [
          ...existingQs,
          { workerId: worker.taskId, sessionID, messageText },
        ];
        await patchProjectStatus(projectName, { board: { ...boardStatus, pendingQuestions: updatedQs } }, ns);
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (/not found/i.test(msg)) {
        workers = updateWorker(workers, worker.taskId, {
          retryCount: (worker.retryCount ?? 0) + 1,
          status: "Failed",
          completedAt: new Date().toISOString(),
        });
        backlog = moveTask(backlog, worker.taskId, "ready");
        log(`worker run ${worker.runName} not found — task ${worker.taskId} returned to ready (retry ${(worker.retryCount ?? 0) + 1})`);
      } else {
        err(`monitor worker ${worker.runName}:`, msg);
      }
    }
  }

  // ------------------------------------------------------------------
  // REWORK PHASE: re-dispatch tasks in the "rework" column.
  // ------------------------------------------------------------------
  const tasksToRework = getTasksToRework({ ...boardStatus, backlog, workers });

  for (const taskId of tasksToRework) {
    const taskDef = (board.tasks ?? []).find((t) => t.id === taskId);
    if (!taskDef) continue;

    const existingWorker = workers.find((w) => w.taskId === taskId);
    if (existingWorker?.status === "Running") {
      log(`task ${taskId} already has a running worker (${existingWorker.runName}) — skipping rework dispatch`);
      continue;
    }

    tasksReworked++;

    const feedback =
      fresh.metadata.annotations?.[`percussionist.dev/rework-${taskId}`] ??
      "Please address the feedback from the previous review.";
    const runName = workerRunName(projectName, taskId);
    const reworkRun = buildWorkerRun(fresh, taskDef, runName, 0, feedback);

    backlog = moveTask(backlog, taskId, "in-progress");
    workers = upsertWorker(workers, {
      taskId,
      runName,
      status: "Running",
      branch: `feat/${taskId}`,
      startedAt: new Date().toISOString(),
      retryCount: 0,
      facilitated: false,
    });

    try {
      await createRun(reworkRun, ns, k8s);
      log(`re-dispatched rework for task ${taskId}`);
    } catch (e) {
      err(`failed to create rework run for ${taskId}:`, (e as Error).message);
      backlog = moveTask(backlog, taskId, "rework");
    }
  }

  // ------------------------------------------------------------------
  // UPDATE PHASE: patch project board status.
  // ------------------------------------------------------------------
  const activeWorkers = workers.filter((w) => w.status === "Running").length;
  const pendingQuestions = (boardStatus.pendingQuestions ?? []).filter((q) =>
    workers.some((w) => w.taskId === q.workerId && w.status === "Running"),
  );

  const reconcileDuration = Date.now() - startTime;

  try {
    await patchProjectStatus(
      projectName,
      {
        board: {
          columns: boardStatus.columns,
          backlog,
          workers,
          activeWorkers,
          escalations: workers
            .filter((w) => w.escalation)
            .map((w) => w.escalation!),
          facilitations: workers
            .filter((w) => w.facilitationResult)
            .map((w) => w.facilitationResult!),
          pendingQuestions,
          lastEventAt: new Date().toISOString(),
          managerMetrics: {
            lastReconcileAt: new Date().toISOString(),
            lastReconcileDurationMs: reconcileDuration,
            lastReconcileResult: "success",
            tasksPulled,
            workersMonitored,
            tasksReworked,
          },
        },
      },
      ns,
    );
  } catch (e) {
    const msg = `patchProjectStatus failed after ${reconcileDuration}ms: ${(e as Error).message}`;
    err(msg);
    await patchProjectStatus(
      projectName,
      {
        board: {
          columns: boardStatus.columns,
          backlog,
          workers,
          activeWorkers,
          escalations: workers
            .filter((w) => w.escalation)
            .map((w) => w.escalation!),
          facilitations: workers
            .filter((w) => w.facilitationResult)
            .map((w) => w.facilitationResult!),
          pendingQuestions,
          lastEventAt: new Date().toISOString(),
          managerMetrics: {
            lastReconcileAt: new Date().toISOString(),
            lastReconcileDurationMs: reconcileDuration,
            lastReconcileResult: "error",
            lastError: (e as Error).message,
            tasksPulled,
            workersMonitored,
            tasksReworked,
          },
        },
      },
      ns,
    ).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Work queue

const queue: string[] = [];
const pending = new Set<string>();
const seen = new Map<string, OpenCodeProject>();

export function enqueue(project: OpenCodeProject): void {
  const key = `${project.metadata.namespace}/${project.metadata.name}`;
  seen.set(key, project);
  if (!pending.has(key)) {
    pending.add(key);
    queue.push(key);
  }
}

export function dequeue(key: string): void {
  seen.delete(key);
}

export async function runWorker(): Promise<void> {
  while (true) {
    const key = queue.shift();
    if (!key) {
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }
    const project = seen.get(key);
    if (!project) {
      pending.delete(key);
      continue;
    }
    try {
      await reconcile(project);
    } catch (e) {
      err(`reconcile(${key}) failed:`, (e as Error).message);
      setTimeout(() => {
        const current = seen.get(key);
        if (current) enqueue(current);
      }, 5000);
    } finally {
      pending.delete(key);
    }
  }
}

export function startPeriodicResync(): void {
  setInterval(() => {
    for (const project of seen.values()) enqueue(project);
  }, 30_000).unref();
}

export { NAMESPACE };
