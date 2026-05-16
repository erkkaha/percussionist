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
  deleteRun,
  fetchSessionMessages,
  getRun,
  getProject,
  patchProject,
  patchProjectStatus,
  patchProjectSpec,
  readSessionConfigMap,
} from "@percussionist/kube";
import { buildWorkerRun, buildMergeRun, workerRunName, MAX_RETRIES } from "./worker-builder.js";
import { buildFacilitationRun, buildSuccessReviewRun, parseFacilitationResult, buildBuildTaskGeneratorRun, parseBuildTaskDefinitions } from "./facilitator.js";
import { isAgentReady } from "./agent/index.js";
import { analyzeFailure, parseRawFacilitation, parseRawReview, parseRawBuildTaskGen } from "./agent/decision-engine.js";
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
try {
  kc.loadFromDefault();
  console.log("[manager] KubeConfig loaded successfully");
} catch (e) {
  console.error("[manager] Failed to load KubeConfig:", (e as Error).message);
  throw e;
}
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

  // Clean up: move escalated tasks out of in-progress to unblock WIP slots.
  const inProgress = backlog["in-progress"] ?? [];
  const escalatedInProgress = inProgress.filter((taskId) => {
    const worker = workers.find((w) => w.taskId === taskId);
    return worker?.status === "Escalated";
  });
  if (escalatedInProgress.length > 0) {
    log(`moving ${escalatedInProgress.length} escalated task(s) from in-progress → review: ${escalatedInProgress.join(", ")}`);
    for (const taskId of escalatedInProgress) {
      backlog = moveTask(backlog, taskId, "review");
    }
  }

  // Self-heal: a worker marked Running must have a runName and be present in
  // backlog.in-progress. If not, it blocks scheduling forever.
  // Skip workers that already have a runName - those are handled by the monitor phase.
  log("=== STARTING REPAIR CHECK ===");
  const inProgressSet = new Set(backlog["in-progress"] ?? []);
  const runningWorkers = workers.filter((w) => w.status === "Running");
  log(`=== REPAIR: ${runningWorkers.length} running workers, inProgressSet=${JSON.stringify([...inProgressSet])} ===`);
  const staleRunningWorkers = runningWorkers.filter((w) => !w.runName && !inProgressSet.has(w.taskId));
  log(`=== REPAIR: ${staleRunningWorkers.length} stale workers: ${staleRunningWorkers.map(w => w.taskId).join(", ")} ===`);
  if (staleRunningWorkers.length > 0) {
    log(
      `repairing ${staleRunningWorkers.length} stale running worker(s): ${staleRunningWorkers.map((w) => w.taskId).join(", ")}`,
    );
    for (const stale of staleRunningWorkers) {
      if (stale.runName) {
        try {
          const staleRun = await getRun(stale.runName, ns, k8s);
          const stalePhase = staleRun.status?.phase;
          if (stalePhase === "Succeeded") {
            workers = updateWorker(workers, stale.taskId, {
              status: "Succeeded",
              completedAt: new Date().toISOString(),
            });
            backlog = moveTask(backlog, stale.taskId, "review");
            continue;
          }
          if (stalePhase === "Failed" || stalePhase === "Cancelled") {
            workers = updateWorker(workers, stale.taskId, {
              status: "Failed",
              completedAt: new Date().toISOString(),
            });
            backlog = moveTask(backlog, stale.taskId, "rework");
            continue;
          }

          // Run is still active; reattach the task into in-progress.
          backlog = moveTask(backlog, stale.taskId, "in-progress");
          continue;
        } catch {
          // Fall through to mark failed below.
        }
      }

      workers = updateWorker(workers, stale.taskId, {
        status: "Failed",
        completedAt: new Date().toISOString(),
      });
      backlog = moveTask(backlog, stale.taskId, "rework");
    }
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
    const runName = workerRunName(projectName, taskId, retryCount);

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
  const FAILURE_FACILITATOR_AGENT =
    process.env.FAILURE_FACILITATOR_AGENT_NAME ??
    process.env.FACILITATOR_AGENT_NAME ??
    "facilitator-failure";
  const REVIEW_FACILITATOR_AGENT =
    process.env.REVIEW_FACILITATOR_AGENT_NAME ??
    process.env.FACILITATOR_AGENT_NAME ??
    "facilitator-review";
  const BUILDGEN_FACILITATOR_AGENT =
    process.env.BUILDGEN_FACILITATOR_AGENT_NAME ??
    process.env.FACILITATOR_AGENT_NAME ??
    "facilitator-buildgen";

  const failureFacilitatorEnabled = (board.agents ?? []).some(
    (a) => a.name === FAILURE_FACILITATOR_AGENT,
  );
  const reviewFacilitatorEnabled = (board.agents ?? []).some(
    (a) => a.name === REVIEW_FACILITATOR_AGENT,
  );
  const buildgenFacilitatorEnabled = (board.agents ?? []).some(
    (a) => a.name === BUILDGEN_FACILITATOR_AGENT,
  );

  for (const worker of workers.filter(
    (w) => w.status === "Running" || (w.status === "Succeeded" && !backlog["done"]?.includes(w.taskId)),
  )) {
    workersMonitored++;
    if (!worker.runName) continue;
    try {
      const run = await getRun(worker.runName, ns, k8s);
      const runPhase = run.status?.phase;

      if (runPhase === "Succeeded") {
        const taskDef = (board.tasks ?? []).find((t) => t.id === worker.taskId);

        // Success-review gate: if a reviewer agent is in the team roster,
        // spawn a success-review facilitator run before moving to done.
        if (reviewFacilitatorEnabled && taskDef && !worker.reviewRunName) {
          // First time we see this worker Succeeded — spawn a review run.
          let sessionSummary = "";
          if (run.status?.sessionID && run.status?.serviceName) {
            try {
              const sessionData = await fetchSessionMessages(
                run.status.serviceName,
                run.status.sessionID,
                ns,
              );
              if (sessionData && typeof sessionData === "object" && "messages" in sessionData) {
                const msgs = (sessionData.messages as Array<{ content?: string }>)
                  .slice(-20)
                  .map((m) => m.content)
                  .filter(Boolean)
                  .join("\n");
                sessionSummary = msgs.slice(0, 8000);
              }
            } catch { /* best effort */ }
          }

          const reviewRunName = `${projectName}-review-${worker.taskId.toLowerCase().replace(/[^a-z0-9]/g, "-")}-${randomBytes(3).toString("hex")}`;
          const reviewRun = buildSuccessReviewRun(
            fresh,
            taskDef,
            worker.runName!,
            run.status ?? {},
            sessionSummary,
            reviewRunName,
            worker.branch,
            REVIEW_FACILITATOR_AGENT,
          );

          try {
            await createRun(reviewRun, ns, k8s);
            workers = updateWorker(workers, worker.taskId, {
              status: "Succeeded",
              completedAt: new Date().toISOString(),
              reviewRunName,
            });
            log(`spawned success reviewer ${reviewRunName} for succeeded task ${worker.taskId}`);
          } catch (e) {
            // If we can't spawn the reviewer, fall back to moving straight to review.
            err(`failed to create success review run for ${worker.taskId}:`, (e as Error).message);
            workers = updateWorker(workers, worker.taskId, {
              status: "Succeeded",
              completedAt: new Date().toISOString(),
            });
            backlog = moveTask(backlog, worker.taskId, "review");
            log(`worker ${worker.runName} succeeded (no reviewer) → task ${worker.taskId} in review`);
          }
        } else if (reviewFacilitatorEnabled && taskDef && worker.reviewRunName) {
          // Review run already spawned — check its result.
          let reviewRun: Awaited<ReturnType<typeof getRun>> | null = null;
          try {
            reviewRun = await getRun(worker.reviewRunName, ns, k8s);
          } catch { /* not found yet — wait */ }

          let result = null;
          try {
            result = await parseFacilitationResult(
              worker.reviewRunName,
              ns,
              reviewRun?.status?.serviceName,
              reviewRun?.status?.sessionID,
            );
          } catch (e) {
            err(`failed to parse review result for ${worker.taskId}:`, (e as Error).message);
          }

          if (result) {
            if (result.recommendedAction === "approve") {
              workers = updateWorker(workers, worker.taskId, {
                facilitationResult: result,
                reviewApproved: true,
                reviewFeedback: undefined,
                reworkAgent: undefined,
              });
              backlog = moveTask(backlog, worker.taskId, "review");
              log(`reviewer approved task ${worker.taskId} → review (awaiting human approval)`);
            } else if (result.recommendedAction === "request_changes") {
              const teamNames = (board.agents ?? []).map((a) => a.name);
              const suggestedAgent =
                result.alternativeAgent && teamNames.includes(result.alternativeAgent)
                  ? result.alternativeAgent
                  : undefined;
              const feedback = (result.suggestion ?? result.diagnosis ?? "").trim() || "Please address review feedback.";
              workers = updateWorker(workers, worker.taskId, {
                facilitationResult: result,
                reviewApproved: false,
                reviewFeedback: feedback,
                reworkAgent: suggestedAgent,
                reviewRunName: undefined,
              });
              backlog = moveTask(backlog, worker.taskId, "rework");
              log(`reviewer requested changes for task ${worker.taskId} → rework`);
            } else if (result.recommendedAction === "retry_alternative" && result.alternativeAgent) {
              const teamNames = (board.agents ?? []).map((a) => a.name);
              if (teamNames.includes(result.alternativeAgent)) {
                const newRunName = workerRunName(projectName, worker.taskId, (worker.retryCount ?? 0) + 1);
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
                  log(`reviewer redirected task ${worker.taskId} to ${result.alternativeAgent}`);
                } catch (e) {
                  err(`failed to create reviewer-redirected run for ${worker.taskId}:`, (e as Error).message);
                  workers = updateWorker(workers, worker.taskId, {
                    status: "Escalated",
                    completedAt: new Date().toISOString(),
                    escalation: `Reviewer recommended retry_alternative with ${result.alternativeAgent} but failed to create run: ${(e as Error).message}`,
                    facilitationResult: result,
                  });
                  backlog = moveTask(backlog, worker.taskId, "review");
                }
              } else {
                workers = updateWorker(workers, worker.taskId, {
                  status: "Escalated",
                  completedAt: new Date().toISOString(),
                  escalation: `Reviewer recommended alternative agent "${result.alternativeAgent}" not in team roster`,
                  facilitationResult: result,
                });
                backlog = moveTask(backlog, worker.taskId, "review");
                log(`reviewer: alternative agent ${result.alternativeAgent} not available — escalated`);
              }
            } else {
              // escalate or unrecognized
              workers = updateWorker(workers, worker.taskId, {
                status: "Escalated",
                completedAt: new Date().toISOString(),
                escalation: `Reviewer escalated task ${worker.taskId}: ${result.diagnosis}. ${result.suggestion ?? ""}`,
                facilitationResult: result,
              });
              backlog = moveTask(backlog, worker.taskId, "review");
              log(`reviewer escalated task ${worker.taskId}`);
            }
          } else {
            // No result yet — check if the review run is done.
            const reviewPhase = reviewRun?.status?.phase;
            if (reviewPhase === "Succeeded" || reviewPhase === "Failed") {
              // Review run finished but produced no parseable result.
              // Try the agent before defaulting to approve.
              if (isAgentReady()) {
                let rawContext = "";
                try {
                  const snapshot = await readSessionConfigMap(
                    worker.reviewRunName,
                    "",
                    ns,
                  );
                  if (snapshot) {
                    rawContext = JSON.stringify(snapshot.messages).slice(0, 12000);
                  }
                } catch { /* best effort */ }
                if (!rawContext) {
                  try {
                    const { readPodLog } = await import("@percussionist/kube");
                    rawContext = await readPodLog(worker.reviewRunName, "opencode", 50, ns);
                  } catch { /* best effort */ }
                }
                const taskDef = (board.tasks ?? []).find((t) => t.id === worker.taskId);
                const parsed = await parseRawReview({
                  projectName,
                  taskId: worker.taskId,
                  taskTitle: taskDef?.title ?? "",
                  rawContext: rawContext || "no session data available",
                });
                if (parsed) {
                  log(`agent parsed review output for ${worker.taskId}: ${parsed.recommendedAction}`);
                  // Treat as a successful parse — re-run the outer logic next cycle.
                  workers = updateWorker(workers, worker.taskId, {
                    reviewRunName: undefined, // force re-check
                    facilitationResult: {
                      diagnosis: parsed.diagnosis,
                      recommendedAction: parsed.recommendedAction as never,
                      alternativeAgent: parsed.alternativeAgent,
                      suggestion: parsed.suggestion,
                    },
                  });
                  continue;
                }
                log(`agent could not parse review output for ${worker.taskId} — falling back to approve`);
              }
              // Fallback: treat as approved.
              workers = updateWorker(workers, worker.taskId, {
                reviewApproved: true,
                reviewFeedback: undefined,
                reworkAgent: undefined,
              });
              backlog = moveTask(backlog, worker.taskId, "review");
              log(`reviewer produced no result (${reviewPhase}) — defaulting to review-approved for task ${worker.taskId}`);
            }
            // else: review still running — leave worker as Succeeded, retry next cycle
          }
        } else {
          // No reviewer configured — original behavior: move to review column.
          if (!worker.reviewApproved) {
            workers = updateWorker(workers, worker.taskId, {
              status: "Succeeded",
              completedAt: new Date().toISOString(),
              reviewApproved: true,
              reviewFeedback: undefined,
              reworkAgent: undefined,
            });
            backlog = moveTask(backlog, worker.taskId, "review");
            log(`worker ${worker.runName} succeeded → task ${worker.taskId} in review (no reviewer agent configured, auto-approved)`);
          }
        }
      } else if (runPhase === "Failed") {
        const taskDef = (board.tasks ?? []).find((t) => t.id === worker.taskId);
        if (!taskDef) {
          err(`task ${worker.taskId} not found in spec.board.tasks during failure handling`);
          continue;
        }

        // Facilitator-based escalation: on first un-facilitated failure, spawn
        // a facilitator agent to analyze the failure and recommend an action.
        // We rely solely on the `facilitated` flag to gate this — retryCount
        // may have already been incremented by the "not found" catch path
        // before the run phase was ever observed as Failed.
        if (
          !worker.facilitated &&
          failureFacilitatorEnabled
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
                .slice(-20)
                .map((m) => m.content)
                .filter(Boolean)
                .join("\n");
              sessionSummary = msgs.slice(0, 8000);
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
            FAILURE_FACILITATOR_AGENT,
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
              backlog = moveTask(backlog, worker.taskId, "review");
              log(`task ${worker.taskId} escalated after facilitator creation failure and retries exhausted`);
            }
          }
        } else if (
          failureFacilitatorEnabled &&
          worker.facilitated &&
          worker.facilitationRunName
        ) {
          // Facilitator run exists — fetch it once, then parse its result.
          let facRun: Awaited<ReturnType<typeof getRun>> | null = null;
          try {
            facRun = await getRun(worker.facilitationRunName, ns, k8s);
          } catch {
            // facilitator run not yet found — will retry next cycle
          }
          let result: FacilitationResult | null = null;
          try {
            result = await parseFacilitationResult(
              worker.facilitationRunName,
              ns,
              facRun?.status?.serviceName,
              facRun?.status?.sessionID,
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
                const newRunName = workerRunName(projectName, worker.taskId, (worker.retryCount ?? 0) + 1);
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
                  backlog = moveTask(backlog, worker.taskId, "review");
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
                backlog = moveTask(backlog, worker.taskId, "review");
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
              backlog = moveTask(backlog, worker.taskId, "review");
              log(`facilitator recommends skip for ${worker.taskId}`);
            }
          } else {
            // No parseable result from facilitator — check facilitator run phase.
            const facilitatorPhase = facRun?.status?.phase;

            if (facilitatorPhase === "Succeeded" || facilitatorPhase === "Failed") {
              // Facilitator done but we got nothing useful.
              if (isAgentReady()) {
                // Ask the agent to parse the raw facilitator output from
                // the facilitator run's session ConfigMap snapshot.
                let rawContext = "";
                try {
                  const snapshot = await readSessionConfigMap(
                    worker.facilitationRunName,
                    "",
                    ns,
                  );
                  if (snapshot) {
                    rawContext = JSON.stringify(snapshot.messages).slice(0, 12000);
                  }
                } catch { /* best effort */ }
                if (!rawContext) {
                  // Fallback: try pod logs.
                  try {
                    const { readPodLog } = await import("@percussionist/kube");
                    rawContext = await readPodLog(worker.facilitationRunName, "opencode", 50, ns);
                  } catch { /* best effort */ }
                }
                const parsed = await parseRawFacilitation({
                  projectName,
                  taskId: worker.taskId,
                  rawContext: rawContext || "no session data available",
                });
                if (parsed) {
                  log(`agent parsed facilitator output for ${worker.taskId}: ${parsed.recommendedAction}`);
                  // Treat as a successful parse — re-run the outer logic by
                  // enriching the worker state so next cycle picks up the result.
                  workers = updateWorker(workers, worker.taskId, {
                    facilitated: true,
                    facilitationResult: {
                      diagnosis: parsed.diagnosis,
                      recommendedAction: parsed.recommendedAction as never,
                      alternativeAgent: parsed.alternativeAgent,
                      suggestion: parsed.suggestion,
                    },
                  });
                  // Don't move the task yet — next reconcile cycle will pick up the result.
                  continue;
                }
                log(`agent could not parse facilitator output for ${worker.taskId} — falling back`);
              }

              // Fall back to standard retry or escalate.
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
                backlog = moveTask(backlog, worker.taskId, "review");
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
        } else if (isAgentReady()) {
          // Retries exhausted — ask the agent for a decision.
          const taskDef = (board.tasks ?? []).find((t) => t.id === worker.taskId);
          let sessionSummary = "";
          if (run.status?.sessionID && run.status?.serviceName) {
            try {
              const sessionData = await fetchSessionMessages(
                run.status.serviceName,
                run.status.sessionID,
                ns,
              );
              if (sessionData && typeof sessionData === "object" && "messages" in sessionData) {
                const msgs = (sessionData.messages as Array<{ content?: string }>)
                  .slice(-20)
                  .map((m) => m.content)
                  .filter(Boolean)
                  .join("\n");
                sessionSummary = msgs.slice(0, 8000);
              }
            } catch { /* best effort */ }
          }
          const decision = await analyzeFailure({
            projectName,
            taskId: worker.taskId,
            taskTitle: taskDef?.title ?? "",
            taskDescription: taskDef?.description,
            agent: taskDef?.agent ?? "",
            retryCount: worker.retryCount ?? 0,
            maxRetries: MAX_RETRIES,
            failureMessage: run.status?.message ?? "Unknown failure after retries",
            sessionSummary,
            alternativeAgents: (board.agents ?? []).map((a) => a.name),
          });
          if (decision.action === "retry_same" || (decision.action === "retry_alternative" && decision.agent && (board.agents ?? []).some((a) => a.name === decision.agent))) {
            workers = updateWorker(workers, worker.taskId, {
              retryCount: (worker.retryCount ?? 0) + 1,
              status: "Running",
              ...(decision.action === "retry_alternative" ? { reworkAgent: decision.agent } : {}),
            });
            backlog = moveTask(backlog, worker.taskId, "ready");
            log(`agent decision: ${decision.action}${decision.agent ? ` with ${decision.agent}` : ""} for ${worker.taskId} — ${decision.reason}`);
          } else if (decision.action === "skip") {
            workers = updateWorker(workers, worker.taskId, {
              status: "Succeeded",
              completedAt: new Date().toISOString(),
            });
            backlog = moveTask(backlog, worker.taskId, "done");
            log(`agent decision: skip for ${worker.taskId} — marking done`);
          } else {
            // escalate
            const escalation = [
              `Task: ${worker.taskId}`,
              `Worker run: ${worker.runName}`,
              `Agent analysis: ${decision.reason}`,
              `Retries exhausted (${MAX_RETRIES}). Agent recommended escalation.`,
            ].join("\n");
            workers = updateWorker(workers, worker.taskId, {
              status: "Escalated",
              completedAt: new Date().toISOString(),
              escalation,
            });
            backlog = moveTask(backlog, worker.taskId, "review");
            log(`agent decision: escalate for ${worker.taskId} — ${decision.reason}`);
          }
        } else {
          // Retries exhausted, no agent available → escalate to human.
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
          backlog = moveTask(backlog, worker.taskId, "review");
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
  // REVIEW APPROVAL PHASE: handle approved PLAN tasks and request-changes.
  // ------------------------------------------------------------------
  const reviewTasks = backlog["review"] ?? [];
  
  for (const taskId of reviewTasks) {
    const taskDef = (board.tasks ?? []).find((t) => t.id === taskId);
    if (!taskDef) continue;
    const worker = workers.find((w) => w.taskId === taskId);

    const approvedAnnotation = fresh.metadata.annotations?.[`percussionist.dev/approved-${taskId}`];
    const requestChangesAnnotation = fresh.metadata.annotations?.[`percussionist.dev/request-changes-${taskId}`];

    // Handle request-changes first
    if (requestChangesAnnotation === "true") {
      const comment = fresh.metadata.annotations?.[`percussionist.dev/rework-${taskId}`] ?? "Please address the review feedback.";
      
      // If this is a PLAN task with BUILD tasks already created, delete them
      if (taskDef.type === "PLAN") {
        const worker = workers.find((w) => w.taskId === taskId);
        const createdBuildTasks = worker?.createdBuildTasks ?? [];
        
        if (createdBuildTasks.length > 0) {
          log(`deleting ${createdBuildTasks.length} BUILD tasks created from PLAN ${taskId}: ${createdBuildTasks.join(", ")}`);
          
          // Remove BUILD tasks from spec
          const updatedTasks = (board.tasks ?? []).filter((t) => !createdBuildTasks.includes(t.id));
          
          // Remove BUILD tasks from backlog
          for (const col of Object.keys(backlog)) {
            backlog[col] = (backlog[col] ?? []).filter((id) => !createdBuildTasks.includes(id));
          }
          
          // Clear worker BUILD task tracking
          if (worker) {
            workers = updateWorker(workers, taskId, {
              buildTasksFacilitatorRun: undefined,
              buildTasksCreated: false,
              createdBuildTasks: [],
            });
          }
          
          // Patch project to remove BUILD tasks
          try {
            await patchProjectSpec(projectName, { board: { ...board, tasks: updatedTasks } }, ns, k8s);
            log(`removed BUILD tasks from project spec for PLAN ${taskId}`);
          } catch (e) {
            err(`failed to remove BUILD tasks for PLAN ${taskId}:`, (e as Error).message);
          }
        }
      }
      
      // Move task to rework
      workers = updateWorker(workers, taskId, {
        reviewApproved: false,
        reviewFeedback: comment,
        reviewRunName: undefined,
        reworkAgent: undefined,
        mergeRunName: undefined,
        mergeError: undefined,
      });
      backlog = moveTask(backlog, taskId, "rework");
      try {
        await patchProject(projectName, {
          metadata: {
            annotations: {
              [`percussionist.dev/request-changes-${taskId}`]: "false",
              [`percussionist.dev/approved-${taskId}`]: "false",
            },
          },
        }, ns, k8s);
      } catch (e) {
        err(`failed to clear review annotations for ${taskId}:`, (e as Error).message);
      }
      log(`task ${taskId} moved to rework with feedback`);
      continue;
    }

    // BUILD tasks require reviewer approval + explicit human approval + successful merge.
    if (taskDef.type === "BUILD") {
      if (worker?.mergeRunName) {
        let mergeRun: Awaited<ReturnType<typeof getRun>> | null = null;
        try {
          mergeRun = await getRun(worker.mergeRunName, ns, k8s);
        } catch {
          mergeRun = null;
        }

        const mergePhase = mergeRun?.status?.phase;
        if (mergePhase === "Succeeded") {
          workers = updateWorker(workers, taskId, {
            mergedAt: new Date().toISOString(),
            mergeError: undefined,
            mergeRunName: undefined,
            status: "Succeeded",
            completedAt: new Date().toISOString(),
          });
          backlog = moveTask(backlog, taskId, "done");
          try {
            await patchProject(projectName, {
              metadata: {
                annotations: {
                  [`percussionist.dev/approved-${taskId}`]: "false",
                },
              },
            }, ns, k8s);
          } catch (e) {
            err(`failed to reset approved annotation for ${taskId}:`, (e as Error).message);
          }
          log(`merge run ${worker.mergeRunName} succeeded for ${taskId} → done`);
          continue;
        }

        if (mergePhase === "Failed" || mergePhase === "Cancelled") {
          const mergeMessage = mergeRun?.status?.message ?? `merge run ended with phase ${mergePhase}`;
          workers = updateWorker(workers, taskId, {
            status: "Escalated",
            mergeError: mergeMessage,
            escalation: `Merge failed for ${taskId}: ${mergeMessage}`,
            mergeRunName: undefined,
          });
          backlog = moveTask(backlog, taskId, "review");
          log(`merge run ${worker.mergeRunName} failed for ${taskId} → review`);
          continue;
        }

        // Merge run still pending/running.
        continue;
      }

      if (approvedAnnotation === "true") {
        if (!worker?.reviewApproved) {
          log(`human approved ${taskId} but reviewer has not approved yet — waiting`);
          continue;
        }

        const mergeRunName = `${projectName}-merge-${taskId.toLowerCase().replace(/[^a-z0-9]/g, "-")}-${randomBytes(3).toString("hex")}`;
        const mergeRun = buildMergeRun(fresh, taskDef, mergeRunName);
        try {
          await createRun(mergeRun, ns, k8s);
          workers = updateWorker(workers, taskId, {
            mergeRunName,
            mergeError: undefined,
          });
          log(`spawned merge run ${mergeRunName} for approved BUILD ${taskId}`);
        } catch (e) {
          workers = updateWorker(workers, taskId, {
            status: "Escalated",
            mergeError: (e as Error).message,
            escalation: `Failed to create merge run for ${taskId}: ${(e as Error).message}`,
          });
          err(`failed to create merge run for ${taskId}:`, (e as Error).message);
        }
      }
      continue;
    }

    // Handle approval for PLAN tasks
    if (approvedAnnotation === "true" && taskDef.type === "PLAN") {
      if (!buildgenFacilitatorEnabled) {
        workers = updateWorker(workers, taskId, {
          status: "Escalated",
          escalation: `BUILD generation agent "${BUILDGEN_FACILITATOR_AGENT}" is not configured in board.agents for PLAN ${taskId}.`,
          buildTasksCreated: true,
        });
        log(`BUILD generation agent ${BUILDGEN_FACILITATOR_AGENT} missing for PLAN ${taskId} — escalated`);
        continue;
      }
      
      // Check if BUILD task generation is needed
      if (!worker?.buildTasksFacilitatorRun) {
        // Spawn facilitator to generate BUILD tasks
        const buildGenRunName = `${projectName}-build-gen-${taskId.toLowerCase().replace(/[^a-z0-9]/g, "-")}-${randomBytes(3).toString("hex")}`;
        
        const buildGenRun = buildBuildTaskGeneratorRun(
          fresh,
          taskDef,
          worker?.runName ?? "",
          buildGenRunName,
          BUILDGEN_FACILITATOR_AGENT,
        );
        
        try {
          await createRun(buildGenRun, ns, k8s);
          workers = updateWorker(workers, taskId, {
            buildTasksFacilitatorRun: buildGenRunName,
          });
          log(`spawned BUILD task generator ${buildGenRunName} for approved PLAN ${taskId}`);
        } catch (e) {
          err(`failed to create BUILD task generator for ${taskId}:`, (e as Error).message);
          workers = updateWorker(workers, taskId, {
            status: "Escalated",
            escalation: `Failed to spawn BUILD task generator: ${(e as Error).message}`,
          });
        }
      } else if (!worker.buildTasksCreated) {
        // BUILD task generator exists, try to parse result
        let buildGenRun: Awaited<ReturnType<typeof getRun>> | null = null;
        try {
          buildGenRun = await getRun(worker.buildTasksFacilitatorRun, ns, k8s);
        } catch {
          // Not found yet — wait
        }
        
        let buildTaskDefs: Awaited<ReturnType<typeof parseBuildTaskDefinitions>> | null = null;
        try {
          buildTaskDefs = await parseBuildTaskDefinitions(
            worker.buildTasksFacilitatorRun,
            ns,
            buildGenRun?.status?.serviceName,
            buildGenRun?.status?.sessionID,
          );
        } catch (e) {
          err(`failed to parse BUILD task definitions for ${taskId}:`, (e as Error).message);
        }
        
        if (buildTaskDefs !== null) {
          // Valid result (array, possibly empty)
          if (buildTaskDefs.length === 0) {
            // Empty array — escalate for human review
            workers = updateWorker(workers, taskId, {
              status: "Escalated",
              escalation: `BUILD task generator returned empty array. PLAN ${taskId} may need manual BUILD task creation or should be marked complete as-is.`,
              buildTasksCreated: true,
            });
            log(`BUILD task generator returned empty array for PLAN ${taskId} — escalated`);
          } else {
            // Create BUILD tasks
            const currentSequence = boardStatus.sequences?.BUILD ?? 0;
            const newBuildTasks: typeof board.tasks = [];
            const createdIds: string[] = [];
            
            for (let i = 0; i < buildTaskDefs.length; i++) {
              const def = buildTaskDefs[i];
              if (!def) continue;
              const buildId = `BUILD-${currentSequence + i + 1}`;
              createdIds.push(buildId);
              
              newBuildTasks.push({
                id: buildId,
                type: "BUILD",
                title: def.title,
                description: def.description,
                agent: def.agent ?? "builder",
                priority: def.priority ?? "medium",
              });
            }
            
            const updatedTasks = [...(board.tasks ?? []), ...newBuildTasks];
            const updatedSequences = {
              ...(boardStatus.sequences ?? {}),
              BUILD: currentSequence + buildTaskDefs.length,
            };
            
            // Patch project to add BUILD tasks
            try {
              await patchProjectSpec(projectName, { board: { ...board, tasks: updatedTasks } }, ns, k8s);
              
              // Update worker tracking
              workers = updateWorker(workers, taskId, {
                buildTasksCreated: true,
                createdBuildTasks: createdIds,
              });
              
              // Update sequences in status
              boardStatus.sequences = updatedSequences;
              
              // Move PLAN to done
              backlog = moveTask(backlog, taskId, "done");
              
              log(`created ${newBuildTasks.length} BUILD tasks from PLAN ${taskId}: ${createdIds.join(", ")}`);
            } catch (e) {
              err(`failed to create BUILD tasks for PLAN ${taskId}:`, (e as Error).message);
              workers = updateWorker(workers, taskId, {
                status: "Escalated",
                escalation: `Failed to create BUILD tasks: ${(e as Error).message}`,
              });
            }
          }
        } else {
          // No result yet — check if facilitator run is done
          const buildGenPhase = buildGenRun?.status?.phase;
          if (buildGenPhase === "Succeeded" || buildGenPhase === "Failed") {
            // Facilitator done but no parseable result.
            // Try the agent to reconstruct BUILD tasks before escalating.
            if (isAgentReady()) {
              let rawContext = "";
              try {
                const snapshot = await readSessionConfigMap(
                  worker.buildTasksFacilitatorRun,
                  "",
                  ns,
                );
                if (snapshot) {
                  rawContext = JSON.stringify(snapshot.messages).slice(0, 12000);
                }
              } catch { /* best effort */ }
              if (!rawContext) {
                try {
                  const { readPodLog } = await import("@percussionist/kube");
                  rawContext = await readPodLog(worker.buildTasksFacilitatorRun, "opencode", 50, ns);
                } catch { /* best effort */ }
              }
              const buildTaskDefs = await parseRawBuildTaskGen({
                projectName,
                taskId,
                taskTitle: taskDef?.title ?? "",
                rawContext: rawContext || "no session data available",
              });
              if (buildTaskDefs && buildTaskDefs.length > 0) {
                log(`agent parsed BUILD task definitions for PLAN ${taskId}: ${buildTaskDefs.length} tasks`);
                // Apply the agent-parsed definitions immediately.
                const currentSequence = boardStatus.sequences?.BUILD ?? 0;
                const newBuildTasks: typeof board.tasks = [];
                const createdIds: string[] = [];
                for (let i = 0; i < buildTaskDefs.length; i++) {
                  const def = buildTaskDefs[i];
                  if (!def) continue;
                  const buildId = `BUILD-${currentSequence + i + 1}`;
                  createdIds.push(buildId);
                  newBuildTasks.push({
                    id: buildId,
                    type: "BUILD",
                    title: def.title,
                    description: def.description,
                    agent: def.agent ?? "builder",
                    priority: (def.priority === "high" || def.priority === "low" ? def.priority : "medium") as "high" | "medium" | "low",
                  });
                }
                const updatedTasks = [...(board.tasks ?? []), ...newBuildTasks];
                const updatedSequences = {
                  ...(boardStatus.sequences ?? {}),
                  BUILD: currentSequence + buildTaskDefs.length,
                };
                try {
                  await patchProjectSpec(projectName, { board: { ...board, tasks: updatedTasks } }, ns, k8s);
                  workers = updateWorker(workers, taskId, {
                    buildTasksCreated: true,
                    createdBuildTasks: createdIds,
                  });
                  boardStatus.sequences = updatedSequences;
                  backlog = moveTask(backlog, taskId, "done");
                  log(`created ${newBuildTasks.length} BUILD tasks (via agent) from PLAN ${taskId}: ${createdIds.join(", ")}`);
                } catch (e) {
                  err(`failed to create BUILD tasks (via agent) for PLAN ${taskId}:`, (e as Error).message);
                  workers = updateWorker(workers, taskId, {
                    status: "Escalated",
                    escalation: `Failed to create BUILD tasks (via agent): ${(e as Error).message}`,
                    buildTasksCreated: true,
                  });
                }
                continue;
              }
              log(`agent could not parse BUILD task gen output for ${taskId} — falling back to escalate`);
            }
            // Fallback: escalate.
            workers = updateWorker(workers, taskId, {
              status: "Escalated",
              escalation: `BUILD task generator finished (${buildGenPhase}) but produced no valid JSON array. Human review needed.`,
              buildTasksCreated: true,
            });
            log(`BUILD task generator for PLAN ${taskId} produced no valid result (${buildGenPhase}) — escalated`);
          }
          // else: facilitator still running, retry next cycle
        }
      }
      // If buildTasksCreated is already true, PLAN should have been moved to done in a previous cycle
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

    const existingFeedback = existingWorker?.reviewFeedback;
    const feedback =
      fresh.metadata.annotations?.[`percussionist.dev/rework-${taskId}`] ??
      existingFeedback ??
      "Please address the feedback from the previous review.";
    const currentRetryCount = existingWorker?.retryCount ?? 0;
    const newRetryCount = currentRetryCount + 1;
    const runName = workerRunName(projectName, taskId, newRetryCount);
    const reworkRun = buildWorkerRun(fresh, taskDef, runName, newRetryCount, feedback);
    if (existingWorker?.reworkAgent) {
      reworkRun.spec.agent = existingWorker.reworkAgent;
    }

    backlog = moveTask(backlog, taskId, "in-progress");
    workers = upsertWorker(workers, {
      taskId,
      runName,
      status: "Running",
      branch: `feat/${taskId}`,
      startedAt: new Date().toISOString(),
      retryCount: newRetryCount,
      facilitated: false,
      reviewApproved: false,
      reviewFeedback: undefined,
      reworkAgent: undefined,
      mergeRunName: undefined,
      mergeError: undefined,
    });

    try {
      log(`DEBUG: about to createRun for ${taskId} with runName=${runName}, newRetryCount=${newRetryCount}`);
      await createRun(reworkRun, ns, k8s);
      log(`re-dispatched rework for task ${taskId}`);
    } catch (e) {
      const msg = (e as Error).message;
      log(`DEBUG: createRun failed for ${taskId}: ${msg}`);
      if (/AlreadyExists/i.test(msg)) {
        // Run already exists - check if it's in a failed state.
        // If failed, delete it so we can recreate with a fresh pod.
        try {
          const existingRun = await getRun(runName, ns, k8s);
          log(`DEBUG: getRun succeeded for ${taskId} runName=${runName}, phase=${existingRun?.status?.phase}`);
          const existingPhase = existingRun?.status?.phase;
          if (existingPhase === "Failed" || existingPhase === "Cancelled") {
            log(`rework run ${runName} is ${existingPhase}; deleting and recreating`);
            await deleteRun(runName, ns, k8s);
            await createRun(reworkRun, ns, k8s);
            log(`re-dispatched rework for task ${taskId} after cleaning up failed run`);
          } else {
            log(`rework run already exists for ${taskId} (phase: ${existingPhase}); keeping task in in-progress`);
          }
        } catch (checkErr) {
          log(`DEBUG: catch block hit for ${taskId} runName=${runName} error=${(checkErr as Error).message}`);
          err(`failed to check existing run for ${taskId} (runName=${runName}):`, (checkErr as Error).message);
          log(`rework run already exists for ${taskId}; keeping task in in-progress`);
        }
      } else {
        err(`failed to create rework run for ${taskId}:`, msg);
        backlog = moveTask(backlog, taskId, "rework");
      }
    }
  }

  // ------------------------------------------------------------------
  // UPDATE PHASE: patch project board status.
  // ------------------------------------------------------------------
  const inProgressFinal = new Set(backlog["in-progress"] ?? []);
  const activeWorkers = workers.filter(
    (w) => w.status === "Running" && !!w.runName && inProgressFinal.has(w.taskId),
  ).length;
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
