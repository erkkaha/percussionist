// reconciler.ts — reconciles a single Project's board.
//
// Task state is authoritative in Task CRs (status subresource).
// The project CR status carries only lightweight summary metrics.

import { randomBytes } from "node:crypto";
import {
  KubeConfig,
  CustomObjectsApi,
} from "@kubernetes/client-node";
import {
  API_GROUP_VERSION,
  PLURAL_TASK,
  type Project,
  type Task,
  type WorkerStatus,
  type BoardStatus,
  type FacilitationResult,
} from "@percussionist/api";
import {
  createRun,
  deleteRun,
  fetchSessionMessages,
  getRun,
  getProject,
  patchProject,
  patchProjectStatus,
  listTasks,
  createTask,
  deleteTask,
  patchTaskStatus,
  buildTask,
  readSessionConfigMap,
} from "@percussionist/kube";
import { buildWorkerRun, buildMergeRun, workerRunName, auxiliaryRunName, MAX_RETRIES } from "./worker-builder.js";
import { spawnWorktreeCleanupPod, spawnTaskWorktreeCleanupPod } from "./worktree-cleanup.js";
import {
  resolveTaskBranch,
  resolveParentBranch,
  resolveMergeBranch,
} from "./branch-resolver.js";
import {
  buildFacilitationRun,
  buildSuccessReviewRun,
  parseFacilitationResult,
  buildBuildTaskGeneratorRun,
  parseBuildTaskDefinitions,
} from "./facilitator.js";
import { isAgentReady } from "./agent/index.js";
import { analyzeFailure, parseRawFacilitation, parseRawReview, parseRawBuildTaskGen } from "./agent/decision-engine.js";
import { getTasksToPull, getTasksToRework } from "./task-scheduler.js";
import { backfillStats } from "./stats-backfill.js";
import { emitEvent } from "./events.js";

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
// Helpers

/** Patch just the worker field on a task status. Best-effort — logs errors. */
async function patchWorker(
  taskName: string,
  patch: Partial<WorkerStatus>,
  existingWorker: WorkerStatus | undefined,
  ns: string,
): Promise<void> {
  try {
    await patchTaskStatus(taskName, { worker: { ...(existingWorker ?? { status: "Running", retryCount: 0, facilitated: false }), ...patch } }, ns);
  } catch (e) {
    err(`patchWorker(${taskName}) failed:`, (e as Error).message);
  }
}

/** Move a task to a new column. */
async function moveTaskColumn(
  taskName: string,
  column: string,
  ns: string,
): Promise<void> {
  try {
    await patchTaskStatus(taskName, { column: column as "backlog" | "ready" | "in-progress" | "review" | "rework" | "done" | "blocked" }, ns);
  } catch (e) {
    err(`moveTaskColumn(${taskName} → ${column}) failed:`, (e as Error).message);
  }
}

/**
 * Spawns a worktree cleanup pod for a completed task (fire-and-forget).
 * Only triggers when the task has a remote git source (worktrees live under
 * /data/worktrees/{runName}/).  Local workspaces (/data/workspace/) are
 * persistent and must not be cleaned up.
 */
async function cleanupWorktree(
  task: Task,
  runName: string,
  project: { name: string; image: string; gitUrl?: string; dataPvcName?: string; dataMountPath?: string },
  ns: string,
): Promise<void> {
  // Only clean up if there is a remote git source — local workspaces persist.
  if (!project.gitUrl) return;
  await spawnWorktreeCleanupPod({
    task,
    runName,
    projectName: project.name,
    namespace: ns,
    image: project.image,
    dataMountPath: project.dataMountPath,
    dataPvcName: project.dataPvcName,
    gitUrl: project.gitUrl,
  });
}

/**
 * Spawns a cleanup pod that removes ALL worktrees for a task.
 * Used when task moves to "done" to clean up all runs (retries/rework).
 * Only cleans up remote git workspaces — local workspaces are persistent.
 */
async function cleanupTaskWorktrees(
  task: Task,
  project: { name: string; image: string; gitUrl?: string; dataPvcName?: string; dataMountPath?: string },
  ns: string,
): Promise<void> {
  // Only clean up if there is a remote git source — local workspaces persist.
  if (!project.gitUrl) return;
  await spawnTaskWorktreeCleanupPod({
    task,
    projectName: project.name,
    namespace: ns,
    image: project.image,
    dataMountPath: project.dataMountPath,
    dataPvcName: project.dataPvcName,
    gitUrl: project.gitUrl,
  });
}

// ---------------------------------------------------------------------------
// Main reconcile

export async function reconcile(project: Project): Promise<void> {
  const startTime = Date.now();

  try {
    await runReconcileCycle(project, startTime);
  } catch (e) {
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
              tasksPulled: 0,
              workersMonitored: 0,
              tasksReworked: 0,
            },
          },
        },
        ns,
      ).catch(() => {});
    } catch {
      /* ignore second-fail */
    }
    throw e;
  }
}

async function runReconcileCycle(project: Project, startTime: number): Promise<void> {
  const projectName = project.metadata.name;
  const ns = project.metadata.namespace ?? NAMESPACE;

  let tasksPulled = 0;
  let workersMonitored = 0;
  let tasksReworked = 0;

  // Always fetch a fresh copy of the project.
  const fresh = await getProject(projectName, ns, k8s);

  // Build the project context used by worktree cleanup helpers.
  const cleanupProject = {
    name: projectName,
    image: fresh.spec.image ?? "percussionist/runner:dev",
    gitUrl: fresh.spec.source?.git?.url,
    dataPvcName: fresh.spec.data?.pvcName ?? `${projectName}-data`,
    dataMountPath: fresh.spec.data?.mountPath ?? "/data",
  };

  // No phase or Archived → nothing to drive.
  if (fresh.spec.phase === "Archived") return;

  // Load all task CRs for this project.
  const tasks = await listTasks(projectName, ns);

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

  const failureFacilitatorEnabled = (fresh.spec.agents ?? []).some(
    (a) => a.name === FAILURE_FACILITATOR_AGENT,
  );
  const reviewFacilitatorEnabled = (fresh.spec.agents ?? []).some(
    (a) => a.name === REVIEW_FACILITATOR_AGENT,
  );
  const buildgenFacilitatorEnabled = (fresh.spec.agents ?? []).some(
    (a) => a.name === BUILDGEN_FACILITATOR_AGENT,
  );

  // Clean up: move escalated tasks out of in-progress to unblock WIP slots.
  const escalatedInProgress = tasks.filter(
    (t) => t.status?.column === "in-progress" && t.status?.worker?.status === "Escalated",
  );
  for (const task of escalatedInProgress) {
    log(`moving escalated task ${task.metadata.name} from in-progress → review`);
    await moveTaskColumn(task.metadata.name, "review", ns);
    emitEvent(projectName, task.metadata.name, task.spec.type, "column.changed", { from: "in-progress", to: "review", reason: "escalated" });
  }

  // Reload tasks after potential column moves above.
  const freshTasks = await listTasks(projectName, ns);

  // ------------------------------------------------------------------
  // PULL PHASE: move ready tasks → in-progress, create worker runs.
  // ------------------------------------------------------------------
  const tasksToPull = getTasksToPull(fresh, freshTasks);

  for (const task of tasksToPull) {
    tasksPulled++;
    const taskName = task.metadata.name;
    const teamNames = (fresh.spec.agents ?? []).map((a) => a.name);
    if (task.spec.agent && !teamNames.includes(task.spec.agent)) {
      err(`task ${taskName} agent "${task.spec.agent}" not in agents roster — skipping`);
      continue;
    }

    const existingWorker = task.status?.worker;
    const retryCount = existingWorker?.retryCount ?? 0;
    const runName = workerRunName(projectName, taskName, retryCount);

    // Resolve feature branch metadata (if enabled).
    const gitBranch = resolveTaskBranch(task, fresh, freshTasks);
    const parentBranch = resolveParentBranch(task, fresh, freshTasks);
    const mergeIntoBranch = resolveMergeBranch(task, fresh, freshTasks);

    // Move to in-progress and update worker state.
    await patchTaskStatus(taskName, {
      column: "in-progress",
      worker: {
        ...(existingWorker ?? {}),
        runName,
        status: "Running",
        branch: gitBranch ?? `feat/${taskName}`, // Legacy fallback
        gitBranch,
        parentBranch,
        mergeIntoBranch,
        startedAt: new Date().toISOString(),
        retryCount,
        facilitated: false,
      },
    }, ns);

    const workerRun = buildWorkerRun(fresh, task, runName, retryCount, undefined, freshTasks);
    try {
      let skipCreate = false;
      try {
        const existing = await getRun(runName, ns, k8s);
        const existingPhase = existing.status?.phase;
        if (existingPhase === "Failed" || existingPhase === "Cancelled") {
          log(`deleting stale ${existingPhase} run ${runName} before recreating for task ${taskName}`);
          await deleteRun(runName, ns, k8s);
        } else {
          log(`run ${runName} already exists (phase: ${existingPhase ?? "pending"}), reattaching for task ${taskName}`);
          skipCreate = true;
        }
      } catch {
        // 404 — run does not exist, proceed.
      }

      if (!skipCreate) {
        await createRun(workerRun, ns, k8s);
        log(`created worker run ${runName} for task ${taskName}`);
        emitEvent(projectName, taskName, task.spec.type, "run.created", { runName, agent: task.spec.agent ?? "", retryCount });
      }
    } catch (e) {
      err(`failed to create worker run for ${taskName}:`, (e as Error).message);
      // Roll back: move task back to ready.
      await patchTaskStatus(taskName, { column: "ready" }, ns);
      emitEvent(projectName, taskName, task.spec.type, "column.changed", { from: "in-progress", to: "ready", reason: "run-create-failed" });
    }
  }

  // Reload tasks again after pull phase mutations.
  const postPullTasks = await listTasks(projectName, ns);

  // ------------------------------------------------------------------
  // MONITOR PHASE: poll each Running worker's Run status.
  // ------------------------------------------------------------------
  const runningTasks = postPullTasks.filter(
    (t) =>
      (t.status?.worker?.status === "Running" ||
        (t.status?.worker?.status === "Succeeded" && t.status?.column !== "done")) &&
      !!t.status?.worker?.runName,
  );

  for (const task of runningTasks) {
    workersMonitored++;
    const taskName = task.metadata.name;
    const worker = task.status!.worker!;
    const runName = worker.runName!;

    if (worker.status === "Succeeded" && task.status?.column !== "in-progress") {
      continue;
    }

    try {
      const run = await getRun(runName, ns, k8s);
      const runPhase = run.status?.phase;

      if (runPhase === "Succeeded") {
        // Best-effort stats backfill.
        if (run.status?.sessionID) {
          backfillStats(
            runName,
            run.status.sessionID,
            ns,
            "Succeeded",
            taskName,
            run.spec.model,
            run.spec.agent,
            run.status.startedAt,
            run.status.completedAt,
          ).catch(() => {});
        }

        // Success-review gate.
        if (reviewFacilitatorEnabled && !worker.reviewRunName) {
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
                  .slice(-20).map((m) => m.content).filter(Boolean).join("\n");
                sessionSummary = msgs.slice(0, 8000);
              }
            } catch { /* best effort */ }
          }

          const reviewRunName = auxiliaryRunName(projectName, "review", taskName, randomBytes(3).toString("hex"));
          const reviewRun = buildSuccessReviewRun(
            fresh, task, runName, run.status ?? {}, sessionSummary,
            reviewRunName, worker.branch, REVIEW_FACILITATOR_AGENT, freshTasks,
          );

          try {
            await createRun(reviewRun, ns, k8s);
            await patchWorker(taskName, {
              status: "Succeeded",
              completedAt: new Date().toISOString(),
              reviewRunName,
            }, worker, ns);
            log(`spawned success reviewer ${reviewRunName} for task ${taskName}`);
            emitEvent(projectName, taskName, task.spec.type, "reviewer.spawned", { runName: reviewRunName, agent: REVIEW_FACILITATOR_AGENT });
          } catch (e) {
            err(`failed to create success review run for ${taskName}:`, (e as Error).message);
            await patchWorker(taskName, { status: "Succeeded", completedAt: new Date().toISOString() }, worker, ns);
            await moveTaskColumn(taskName, "review", ns);
            log(`worker ${runName} succeeded (no reviewer) → task ${taskName} in review`);
            emitEvent(projectName, taskName, task.spec.type, "column.changed", { from: "in-progress", to: "review", reason: "succeeded" });
          }
        } else if (reviewFacilitatorEnabled && worker.reviewRunName) {
          let reviewRun: Awaited<ReturnType<typeof getRun>> | null = null;
          try {
            reviewRun = await getRun(worker.reviewRunName, ns, k8s);
          } catch {
            if (worker.reviewApproved) {
              await patchWorker(taskName, { reviewRunName: undefined }, worker, ns);
              await moveTaskColumn(taskName, "review", ns);
              await patchProject(projectName, {
                metadata: {
                  annotations: {
                    [`percussionist.dev/approved-${taskName}`]: "false",
                    [`percussionist.dev/request-changes-${taskName}`]: "false",
                  },
                },
              }, ns, k8s).catch((e) => {
                err(`failed to clear stale review annotations for ${taskName}:`, (e as Error).message);
              });
              log(`review run ${worker.reviewRunName} missing but already approved — ${taskName} moved to review`);
              emitEvent(projectName, taskName, task.spec.type, "column.changed", { from: "in-progress", to: "review", reason: "missing-review-run-approved" });
            }
            continue;
          }

          let result: FacilitationResult | null = null;
          try {
            result = await parseFacilitationResult(
              worker.reviewRunName, ns,
              reviewRun?.status?.serviceName, reviewRun?.status?.sessionID,
            );
          } catch (e) {
            err(`failed to parse review result for ${taskName}:`, (e as Error).message);
          }

          if (result) {
            if (result.recommendedAction === "approve") {
              await patchWorker(taskName, { facilitationResult: result, reviewApproved: true, reviewFeedback: undefined, reworkAgent: undefined }, worker, ns);
              await moveTaskColumn(taskName, "review", ns);
              log(`reviewer approved task ${taskName} → review`);
              emitEvent(projectName, taskName, task.spec.type, "column.changed", { from: "in-progress", to: "review", reason: "reviewer-approved" });
            } else if (result.recommendedAction === "request_changes") {
              const teamNames = (fresh.spec.agents ?? []).map((a) => a.name);
              const suggestedAgent = result.alternativeAgent && teamNames.includes(result.alternativeAgent) ? result.alternativeAgent : undefined;
              const feedback = (result.suggestion ?? result.diagnosis ?? "").trim() || "Please address review feedback.";
              await patchWorker(taskName, {
                facilitationResult: result,
                reviewApproved: false,
                reviewFeedback: feedback,
                reworkAgent: suggestedAgent,
                reviewRunName: undefined,
              }, worker, ns);
              await moveTaskColumn(taskName, "rework", ns);
              log(`reviewer requested changes for ${taskName} → rework`);
              emitEvent(projectName, taskName, task.spec.type, "column.changed", { from: "in-progress", to: "rework", reason: "reviewer-request-changes", feedback: feedback.slice(0, 200) });
            } else if (result.recommendedAction === "retry_alternative" && result.alternativeAgent) {
              const teamNames = (fresh.spec.agents ?? []).map((a) => a.name);
              if (teamNames.includes(result.alternativeAgent)) {
                const newRunName = workerRunName(projectName, taskName, (worker.retryCount ?? 0) + 1);
                const reworkRun = buildWorkerRun(fresh, task, newRunName, (worker.retryCount ?? 0) + 1, undefined, freshTasks);
                reworkRun.spec.agent = result.alternativeAgent;
                const gitBranch = worker.gitBranch ?? resolveTaskBranch(task, fresh, freshTasks);
                const parentBranch = worker.parentBranch ?? resolveParentBranch(task, fresh, freshTasks);
                const mergeIntoBranch = worker.mergeIntoBranch ?? resolveMergeBranch(task, fresh, freshTasks);
                await patchTaskStatus(taskName, {
                  column: "in-progress",
                  worker: {
                    ...worker,
                    runName: newRunName,
                    status: "Running",
                    branch: gitBranch ?? `feat/${taskName}`,
                    gitBranch,
                    parentBranch,
                    mergeIntoBranch,
                    startedAt: new Date().toISOString(),
                    retryCount: (worker.retryCount ?? 0) + 1,
                    facilitated: true,
                    facilitationResult: result,
                  },
                }, ns);
                try {
                  await createRun(reworkRun, ns, k8s);
                  log(`reviewer redirected task ${taskName} to ${result.alternativeAgent}`);
                  emitEvent(projectName, taskName, task.spec.type, "run.created", { runName: newRunName, agent: result.alternativeAgent, retryCount: (worker.retryCount ?? 0) + 1, reason: "reviewer-retry-alternative" });
                } catch (e) {
                  err(`failed to create reviewer-redirected run for ${taskName}:`, (e as Error).message);
                  await patchWorker(taskName, {
                    status: "Escalated",
                    completedAt: new Date().toISOString(),
                    escalation: `Reviewer recommended retry_alternative with ${result.alternativeAgent} but failed: ${(e as Error).message}`,
                    facilitationResult: result,
                  }, worker, ns);
                  await moveTaskColumn(taskName, "review", ns);
                  emitEvent(projectName, taskName, task.spec.type, "escalated", { reason: `Reviewer recommended retry_alternative but run creation failed` });
                }
              } else {
                await patchWorker(taskName, {
                  status: "Escalated",
                  completedAt: new Date().toISOString(),
                  escalation: `Reviewer recommended alternative agent "${result.alternativeAgent}" not in roster`,
                  facilitationResult: result,
                }, worker, ns);
                await moveTaskColumn(taskName, "review", ns);
                emitEvent(projectName, taskName, task.spec.type, "escalated", { reason: `Reviewer recommended unknown agent "${result.alternativeAgent}"` });
              }
            } else {
              await patchWorker(taskName, {
                status: "Escalated",
                completedAt: new Date().toISOString(),
                escalation: `Reviewer escalated ${taskName}: ${result.diagnosis}. ${result.suggestion ?? ""}`,
                facilitationResult: result,
              }, worker, ns);
              await moveTaskColumn(taskName, "review", ns);
              log(`reviewer escalated task ${taskName}`);
              emitEvent(projectName, taskName, task.spec.type, "escalated", { reason: result.diagnosis ?? "reviewer escalated" });
            }
          } else {
            const reviewPhase = reviewRun?.status?.phase;
            if (reviewPhase === "Succeeded" || reviewPhase === "Failed") {
              if (isAgentReady()) {
                let rawContext = "";
                try {
                  const snapshot = await readSessionConfigMap(worker.reviewRunName, "", ns);
                  if (snapshot) rawContext = JSON.stringify(snapshot.messages).slice(0, 12000);
                } catch { /* best effort */ }
                if (!rawContext) {
                  try {
                    const { readPodLog } = await import("@percussionist/kube");
                    rawContext = await readPodLog(worker.reviewRunName, "opencode", 50, ns);
                  } catch { /* best effort */ }
                }
                const parsed = await parseRawReview({
                  projectName,
                  taskId: taskName,
                  taskTitle: task.spec.title,
                  rawContext: rawContext || "no session data available",
                });
                if (parsed) {
                  log(`agent parsed review output for ${taskName}: ${parsed.recommendedAction}`);
                  await patchWorker(taskName, {
                    reviewRunName: undefined,
                    facilitationResult: {
                      diagnosis: parsed.diagnosis,
                      recommendedAction: parsed.recommendedAction as never,
                      alternativeAgent: parsed.alternativeAgent,
                      suggestion: parsed.suggestion,
                    },
                  }, worker, ns);
                  continue;
                }
              }
              await patchWorker(taskName, { reviewApproved: true, reviewFeedback: undefined, reworkAgent: undefined }, worker, ns);
              await moveTaskColumn(taskName, "review", ns);
              log(`reviewer produced no result (${reviewPhase}) — defaulting approved for ${taskName}`);
              emitEvent(projectName, taskName, task.spec.type, "column.changed", { from: "in-progress", to: "review", reason: "reviewer-no-result-default-approved" });
            }
          }
        } else {
          if (!worker.reviewApproved) {
            await patchWorker(taskName, {
              status: "Succeeded",
              completedAt: new Date().toISOString(),
              reviewApproved: true,
              reviewFeedback: undefined,
              reworkAgent: undefined,
            }, worker, ns);
            await moveTaskColumn(taskName, "review", ns);
            log(`worker ${runName} succeeded → ${taskName} in review (no reviewer, auto-approved)`);
            emitEvent(projectName, taskName, task.spec.type, "column.changed", { from: "in-progress", to: "review", reason: "succeeded-auto-approved" });
          }
        }
      } else if (runPhase === "Failed") {
        // Best-effort stats backfill.
        if (run.status?.sessionID) {
          backfillStats(
            runName, run.status.sessionID, ns, "Failed",
            taskName, run.spec.model, run.spec.agent,
            run.status.startedAt, run.status.completedAt,
          ).catch(() => {});
        }

        if (!worker.facilitated && failureFacilitatorEnabled) {
          let sessionSummary = "";
          if (run.status?.sessionID && run.status?.serviceName) {
            try {
              const sessionData = await fetchSessionMessages(run.status.serviceName, run.status.sessionID, ns);
              if (sessionData && typeof sessionData === "object" && "messages" in sessionData) {
                const msgs = (sessionData.messages as Array<{ content?: string }>)
                  .slice(-20).map((m) => m.content).filter(Boolean).join("\n");
                sessionSummary = msgs.slice(0, 8000);
              }
            } catch { /* best effort */ }
          }

          const facilitationRunName = auxiliaryRunName(projectName, "facilitator", taskName, randomBytes(3).toString("hex"));
          const facilitationRun = buildFacilitationRun(
            fresh, task, runName, run.status ?? {}, sessionSummary,
            facilitationRunName, FAILURE_FACILITATOR_AGENT, freshTasks,
          );

          try {
            await createRun(facilitationRun, ns, k8s);
            await patchWorker(taskName, { facilitated: true, facilitationRunName }, worker, ns);
            log(`spawned facilitator ${facilitationRunName} for failed task ${taskName}`);
            emitEvent(projectName, taskName, task.spec.type, "facilitator.spawned", { runName: facilitationRunName, agent: FAILURE_FACILITATOR_AGENT });
          } catch (e) {
            err(`failed to create facilitator run for ${taskName}:`, (e as Error).message);
            if ((worker.retryCount ?? 0) < MAX_RETRIES) {
              await cleanupWorktree(task, runName, cleanupProject, ns);
              await patchWorker(taskName, { retryCount: (worker.retryCount ?? 0) + 1, status: "Running" }, worker, ns);
              await moveTaskColumn(taskName, "ready", ns);
              emitEvent(projectName, taskName, task.spec.type, "run.failed", { runName, retryCount: (worker.retryCount ?? 0) + 1, error: (e as Error).message });
            } else {
              await patchWorker(taskName, {
                status: "Escalated",
                completedAt: new Date().toISOString(),
                escalation: `Task: ${taskName}\nWorker: ${runName}\nError: ${run.status?.message ?? "Unknown"}\nFacilitator creation failed, retries exhausted (${MAX_RETRIES}).`,
              }, worker, ns);
              await moveTaskColumn(taskName, "review", ns);
              emitEvent(projectName, taskName, task.spec.type, "escalated", { retryCount: worker.retryCount ?? 0, reason: "facilitator-creation-failed-retries-exhausted" });
            }
          }
        } else if (failureFacilitatorEnabled && worker.facilitated && worker.facilitationRunName) {
          let facRun: Awaited<ReturnType<typeof getRun>> | null = null;
          try {
            facRun = await getRun(worker.facilitationRunName, ns, k8s);
          } catch { /* not found yet */ }

          let result: FacilitationResult | null = null;
          try {
            result = await parseFacilitationResult(
              worker.facilitationRunName, ns,
              facRun?.status?.serviceName, facRun?.status?.sessionID,
            );
          } catch (e) {
            err(`failed to parse facilitation result for ${taskName}:`, (e as Error).message);
          }

          if (result) {
            if (result.recommendedAction === "retry_same") {
              if ((worker.retryCount ?? 0) < MAX_RETRIES) {
                await cleanupWorktree(task, runName, cleanupProject, ns);
                await patchWorker(taskName, { retryCount: (worker.retryCount ?? 0) + 1, status: "Running", facilitated: true, facilitationResult: result }, worker, ns);
                await moveTaskColumn(taskName, "ready", ns);
                emitEvent(projectName, taskName, task.spec.type, "column.changed", { from: "in-progress", to: "ready", reason: "facilitator-retry-same" });
              } else {
                await patchWorker(taskName, {
                  status: "Escalated",
                  completedAt: new Date().toISOString(),
                  escalation: `Task: ${taskName}\nWorker: ${runName}\nFacilitator recommended retry_same, but retries are exhausted (${MAX_RETRIES}).\nDiagnosis: ${result.diagnosis}`,
                  facilitationResult: result,
                }, worker, ns);
                await moveTaskColumn(taskName, "review", ns);
                emitEvent(projectName, taskName, task.spec.type, "escalated", { retryCount: worker.retryCount ?? 0, reason: "facilitator-retry-same-retries-exhausted" });
              }
            } else if (result.recommendedAction === "retry_alternative" && result.alternativeAgent) {
              const teamNames = (fresh.spec.agents ?? []).map((a) => a.name);
              if (teamNames.includes(result.alternativeAgent)) {
                const newRunName = workerRunName(projectName, taskName, (worker.retryCount ?? 0) + 1);
                const reworkRun = buildWorkerRun(fresh, task, newRunName, (worker.retryCount ?? 0) + 1, undefined, freshTasks);
                reworkRun.spec.agent = result.alternativeAgent;
                const gitBranch = worker.gitBranch ?? resolveTaskBranch(task, fresh, freshTasks);
                const parentBranch = worker.parentBranch ?? resolveParentBranch(task, fresh, freshTasks);
                const mergeIntoBranch = worker.mergeIntoBranch ?? resolveMergeBranch(task, fresh, freshTasks);
                await patchTaskStatus(taskName, {
                  column: "in-progress",
                  worker: {
                    ...worker,
                    runName: newRunName,
                    status: "Running",
                    branch: gitBranch ?? `feat/${taskName}`,
                    gitBranch,
                    parentBranch,
                    mergeIntoBranch,
                    startedAt: new Date().toISOString(),
                    retryCount: (worker.retryCount ?? 0) + 1,
                    facilitated: true,
                    facilitationResult: result,
                  },
                }, ns);
                try {
                  await createRun(reworkRun, ns, k8s);
                } catch (e) {
                  err(`failed to create alternative-agent run for ${taskName}:`, (e as Error).message);
                  await patchWorker(taskName, {
                    status: "Escalated",
                    completedAt: new Date().toISOString(),
                    escalation: `Facilitator recommended retry_alternative with ${result.alternativeAgent} but run creation failed: ${(e as Error).message}`,
                  }, worker, ns);
                  await moveTaskColumn(taskName, "review", ns);
                  emitEvent(projectName, taskName, task.spec.type, "escalated", { reason: `Facilitator retry_alternative run creation failed` });
                }
              } else {
                await patchWorker(taskName, {
                  status: "Escalated",
                  completedAt: new Date().toISOString(),
                  escalation: `Task: ${taskName}\nFacilitator: ${result.diagnosis}\nAlternative agent "${result.alternativeAgent}" not in roster`,
                  facilitationResult: result,
                }, worker, ns);
                await moveTaskColumn(taskName, "review", ns);
                emitEvent(projectName, taskName, task.spec.type, "escalated", { reason: `Facilitator recommended unknown agent "${result.alternativeAgent}"` });
              }
            } else {
              await patchWorker(taskName, {
                status: "Escalated",
                completedAt: new Date().toISOString(),
                escalation: `Task: ${taskName}\nFacilitator: ${result.diagnosis}\nAction: skip`,
                facilitationResult: result,
              }, worker, ns);
              await moveTaskColumn(taskName, "review", ns);
              emitEvent(projectName, taskName, task.spec.type, "escalated", { reason: result.diagnosis ?? "facilitator-skip" });
            }
          } else {
            const facilitatorPhase = facRun?.status?.phase;
            if (facilitatorPhase === "Succeeded" || facilitatorPhase === "Failed") {
              if (isAgentReady()) {
                let rawContext = "";
                try {
                  const snapshot = await readSessionConfigMap(worker.facilitationRunName, "", ns);
                  if (snapshot) rawContext = JSON.stringify(snapshot.messages).slice(0, 12000);
                } catch { /* best effort */ }
                if (!rawContext) {
                  try {
                    const { readPodLog } = await import("@percussionist/kube");
                    rawContext = await readPodLog(worker.facilitationRunName, "opencode", 50, ns);
                  } catch { /* best effort */ }
                }
                const parsed = await parseRawFacilitation({
                  projectName,
                  taskId: taskName,
                  rawContext: rawContext || "no session data available",
                });
                if (parsed) {
                  log(`agent parsed facilitator output for ${taskName}: ${parsed.recommendedAction}`);
                  await patchWorker(taskName, {
                    facilitated: true,
                    facilitationResult: {
                      diagnosis: parsed.diagnosis,
                      recommendedAction: parsed.recommendedAction as never,
                      alternativeAgent: parsed.alternativeAgent,
                      suggestion: parsed.suggestion,
                    },
                  }, worker, ns);
                  continue;
                }
              }
            if ((worker.retryCount ?? 0) < MAX_RETRIES) {
                await cleanupWorktree(task, runName, cleanupProject, ns);
                await patchWorker(taskName, { retryCount: (worker.retryCount ?? 0) + 1, status: "Running", facilitated: true }, worker, ns);
                await moveTaskColumn(taskName, "ready", ns);
                emitEvent(projectName, taskName, task.spec.type, "run.failed", { runName, retryCount: (worker.retryCount ?? 0) + 1, reason: "facilitator-no-result" });
              } else {
                await patchWorker(taskName, {
                  status: "Escalated",
                  completedAt: new Date().toISOString(),
                  escalation: `Task: ${taskName}\nWorker: ${runName}\nFacilitator returned no result (${facilitatorPhase}), retries exhausted.`,
                }, worker, ns);
                await moveTaskColumn(taskName, "review", ns);
                emitEvent(projectName, taskName, task.spec.type, "escalated", { retryCount: worker.retryCount ?? 0, reason: "facilitator-no-result-retries-exhausted" });
              }
            }
          }
        } else if ((worker.retryCount ?? 0) < MAX_RETRIES) {
          await cleanupWorktree(task, runName, cleanupProject, ns);
          await patchWorker(taskName, { retryCount: (worker.retryCount ?? 0) + 1, status: "Running" }, worker, ns);
          await moveTaskColumn(taskName, "ready", ns);
          log(`task ${taskName} failed — retrying (${(worker.retryCount ?? 0) + 1}/${MAX_RETRIES})`);
          emitEvent(projectName, taskName, task.spec.type, "run.failed", { runName, retryCount: (worker.retryCount ?? 0) + 1, error: run.status?.message ?? "Unknown" });
        } else if (isAgentReady()) {
          let sessionSummary = "";
          if (run.status?.sessionID && run.status?.serviceName) {
            try {
              const sessionData = await fetchSessionMessages(run.status.serviceName, run.status.sessionID, ns);
              if (sessionData && typeof sessionData === "object" && "messages" in sessionData) {
                const msgs = (sessionData.messages as Array<{ content?: string }>)
                  .slice(-20).map((m) => m.content).filter(Boolean).join("\n");
                sessionSummary = msgs.slice(0, 8000);
              }
            } catch { /* best effort */ }
          }
          const decision = await analyzeFailure({
            projectName,
            taskId: taskName,
            taskTitle: task.spec.title,
            taskDescription: task.spec.description,
            agent: task.spec.agent ?? "",
            retryCount: worker.retryCount ?? 0,
            maxRetries: MAX_RETRIES,
            failureMessage: run.status?.message ?? "Unknown failure after retries",
            sessionSummary,
            alternativeAgents: (fresh.spec.agents ?? []).map((a) => a.name),
          });
          if (
            decision.action === "retry_same" ||
            (decision.action === "retry_alternative" && decision.agent &&
              (fresh.spec.agents ?? []).some((a) => a.name === decision.agent))
          ) {
            await patchWorker(taskName, {
              retryCount: (worker.retryCount ?? 0) + 1,
              status: "Running",
              ...(decision.action === "retry_alternative" ? { reworkAgent: decision.agent } : {}),
            }, worker, ns);
            await cleanupWorktree(task, runName, cleanupProject, ns);
            await moveTaskColumn(taskName, "ready", ns);
            emitEvent(projectName, taskName, task.spec.type, "decision", { action: decision.action, agent: decision.agent, reason: decision.reason });
            } else if (decision.action === "skip") {
             await patchWorker(taskName, { status: "Succeeded", completedAt: new Date().toISOString() }, worker, ns);
             await moveTaskColumn(taskName, "done", ns);
             await cleanupTaskWorktrees(task, cleanupProject, ns);
             emitEvent(projectName, taskName, task.spec.type, "decision", { action: "skip", reason: decision.reason });
          } else {
            await patchWorker(taskName, {
              status: "Escalated",
              completedAt: new Date().toISOString(),
              escalation: `Task: ${taskName}\nWorker: ${runName}\nAgent: ${decision.reason}\nRetries exhausted (${MAX_RETRIES}).`,
            }, worker, ns);
            await moveTaskColumn(taskName, "review", ns);
            emitEvent(projectName, taskName, task.spec.type, "escalated", { retryCount: worker.retryCount ?? 0, reason: decision.reason });
          }
        } else {
          await patchWorker(taskName, {
            status: "Escalated",
            completedAt: new Date().toISOString(),
            escalation: `Task: ${taskName}\nWorker: ${runName}\nError: ${run.status?.message ?? "Unknown"}\nRetries exhausted (${MAX_RETRIES}).`,
          }, worker, ns);
          await moveTaskColumn(taskName, "review", ns);
          log(`task ${taskName} escalated after ${MAX_RETRIES} retries`);
          emitEvent(projectName, taskName, task.spec.type, "escalated", { retryCount: worker.retryCount ?? 0, reason: run.status?.message ?? "retries exhausted" });
        }
      } else if (runPhase === "Cancelled") {
        await cleanupWorktree(task, runName, cleanupProject, ns);
        await patchWorker(taskName, { status: "Failed", completedAt: new Date().toISOString() }, worker, ns);
        await moveTaskColumn(taskName, "ready", ns);
        emitEvent(projectName, taskName, task.spec.type, "column.changed", { from: "in-progress", to: "ready", reason: "cancelled" });
      } else if (runPhase === "WaitingForInput") {
        const sessionID = run.status?.sessionID ?? "";
        const messageText = run.status?.message ?? `Worker ${taskName} is waiting for input`;
        // Reload pending questions from project status.
        const freshProj = await getProject(projectName, ns, k8s);
        const existingQs = (freshProj.status?.board?.pendingQuestions ?? []).filter(
          (q) => q.workerId !== taskName,
        );
        const updatedQs = [...existingQs, { workerId: taskName, sessionID, messageText }];
        await patchProjectStatus(projectName, { board: { pendingQuestions: updatedQs } }, ns);
      } else if (runPhase === "Running") {
        const runMessage = run.status?.message ?? "";
        log(`run ${runName} is Running (${runMessage}) for task ${taskName} — monitoring`);
      } else if (runPhase === "Initializing" || runPhase === "Pending") {
        log(`run ${runName} is ${runPhase} for task ${taskName} — waiting`);
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (/not found/i.test(msg)) {
        await patchWorker(taskName, {
          retryCount: (worker.retryCount ?? 0) + 1,
          status: "Failed",
          completedAt: new Date().toISOString(),
        }, worker, ns);
        // Only return to ready if task is still in-progress. If it was manually moved to
        // review/rework/blocked/done, respect that and leave the column alone — otherwise
        // deleting a run while reviewing causes an infinite recreate loop.
        const currentColumn = task.status?.column;
        if (currentColumn === "in-progress") {
          await moveTaskColumn(taskName, "ready", ns);
          log(`worker run ${runName} not found — ${taskName} returned to ready`);
        } else {
          log(`worker run ${runName} not found — ${taskName} column is '${currentColumn}', leaving in place`);
        }
        emitEvent(projectName, taskName, task.spec.type, "run.failed", { runName, reason: "run-not-found" });
      } else {
        err(`monitor worker ${runName}:`, msg);
      }
    }
  }

  // Reload after monitor phase.
  const postMonitorTasks = await listTasks(projectName, ns);

  // ------------------------------------------------------------------
  // REVIEW APPROVAL PHASE: handle approved PLAN tasks and request-changes.
  // ------------------------------------------------------------------
  const reviewTasks = postMonitorTasks.filter((t) => t.status?.column === "review");

  for (const task of reviewTasks) {
    const taskName = task.metadata.name;
    const worker = task.status?.worker;

    const approvedAnnotation = fresh.metadata.annotations?.[`percussionist.dev/approved-${taskName}`];
    const requestChangesAnnotation = fresh.metadata.annotations?.[`percussionist.dev/request-changes-${taskName}`];

    if (requestChangesAnnotation === "true") {
      const comment = fresh.metadata.annotations?.[`percussionist.dev/rework-${taskName}`] ?? "Please address the review feedback.";

      // If this is a PLAN task with BUILD tasks already created, delete them.
      if (task.spec.type === "PLAN") {
        const createdBuildTaskRefs = worker?.createdBuildTaskRefs ?? [];
        if (createdBuildTaskRefs.length > 0) {
          log(`deleting ${createdBuildTaskRefs.length} BUILD task CRs from PLAN ${taskName}`);
          for (const buildTaskRef of createdBuildTaskRefs) {
            try {
              await deleteTask(buildTaskRef, ns);
            } catch (e) {
              err(`failed to delete BUILD task ${buildTaskRef}:`, (e as Error).message);
            }
          }
          await patchWorker(taskName, {
            buildTasksFacilitatorRun: undefined,
            buildTasksCreated: false,
            createdBuildTaskRefs: [],
          }, worker, ns);
        }
      }

      await patchWorker(taskName, {
        reviewApproved: false,
        reviewFeedback: comment,
        reviewRunName: undefined,
        reworkAgent: undefined,
        mergeRunName: undefined,
        mergeError: undefined,
      }, worker, ns);
      await moveTaskColumn(taskName, "rework", ns);
      try {
        await patchProject(projectName, {
          metadata: {
            annotations: {
              [`percussionist.dev/request-changes-${taskName}`]: "false",
              [`percussionist.dev/approved-${taskName}`]: "false",
            },
          },
        }, ns, k8s);
      } catch (e) {
        err(`failed to clear review annotations for ${taskName}:`, (e as Error).message);
      }
      log(`task ${taskName} moved to rework with feedback`);
      emitEvent(projectName, taskName, task.spec.type, "column.changed", { from: "review", to: "rework", reason: "request-changes" });
      continue;
    }

    // BUILD tasks: require reviewer approval + human approval + successful merge.
    if (task.spec.type === "BUILD") {
      if (worker?.mergeRunName) {
        let mergeRun: Awaited<ReturnType<typeof getRun>> | null = null;
        try {
          mergeRun = await getRun(worker.mergeRunName, ns, k8s);
        } catch { mergeRun = null; }

        const mergePhase = mergeRun?.status?.phase;
        if (mergePhase === "Succeeded") {
          await patchWorker(taskName, {
            mergedAt: new Date().toISOString(),
            mergeError: undefined,
            mergeRunName: undefined,
            status: "Succeeded",
            completedAt: new Date().toISOString(),
          }, worker, ns);
          await moveTaskColumn(taskName, "done", ns);
          await cleanupTaskWorktrees(task, cleanupProject, ns);
          try {
            await patchProject(projectName, {
              metadata: { annotations: { [`percussionist.dev/approved-${taskName}`]: "false" } },
            }, ns, k8s);
          } catch (e) {
            err(`failed to reset approved annotation for ${taskName}:`, (e as Error).message);
          }
          log(`merge run ${worker.mergeRunName} succeeded for ${taskName} → done`);
          emitEvent(projectName, taskName, task.spec.type, "merged", { runName: worker.mergeRunName ?? "" });
          continue;
        }

        if (mergePhase === "Failed" || mergePhase === "Cancelled") {
          const mergeMessage = mergeRun?.status?.message ?? `merge run ended with ${mergePhase}`;
          await patchWorker(taskName, {
            status: "Escalated",
            mergeError: mergeMessage,
            escalation: `Merge failed for ${taskName}: ${mergeMessage}`,
            mergeRunName: undefined,
          }, worker, ns);
          await moveTaskColumn(taskName, "review", ns);
          emitEvent(projectName, taskName, task.spec.type, "escalated", { reason: `Merge ${mergePhase}: ${mergeMessage}` });
          continue;
        }
        // Merge still pending/running.
        continue;
      }

      if (approvedAnnotation === "true") {
        if (!worker?.reviewApproved) {
          log(`human approved ${taskName} but reviewer has not approved yet — waiting`);
          continue;
        }

        const mergeRunName = auxiliaryRunName(projectName, "merge", taskName, randomBytes(3).toString("hex"));
        const mergeRun = buildMergeRun(fresh, task, mergeRunName, freshTasks);
        try {
          await createRun(mergeRun, ns, k8s);
          await patchWorker(taskName, { mergeRunName, mergeError: undefined }, worker, ns);
          log(`spawned merge run ${mergeRunName} for approved BUILD ${taskName}`);
          emitEvent(projectName, taskName, task.spec.type, "run.created", { runName: mergeRunName, reason: "merge" });
        } catch (e) {
          await patchWorker(taskName, {
            status: "Escalated",
            mergeError: (e as Error).message,
            escalation: `Failed to create merge run for ${taskName}: ${(e as Error).message}`,
          }, worker, ns);
          err(`failed to create merge run for ${taskName}:`, (e as Error).message);
          emitEvent(projectName, taskName, task.spec.type, "escalated", { reason: `Merge run creation failed: ${(e as Error).message}` });
        }
      }
      continue;
    }

    // PLAN task approval.
    if (approvedAnnotation === "true" && task.spec.type === "PLAN") {
      if (!buildgenFacilitatorEnabled) {
        await patchWorker(taskName, {
          status: "Escalated",
          escalation: `BUILD generation agent "${BUILDGEN_FACILITATOR_AGENT}" not configured for PLAN ${taskName}.`,
          buildTasksCreated: true,
        }, worker, ns);
        continue;
      }

      if (!worker?.buildTasksFacilitatorRun) {
        // Fetch session data from the PLAN worker run to include as context.
        let planSessionSummary = "";
        try {
          const planRun = await getRun(worker?.runName ?? "", ns, k8s);
          if (planRun?.status?.sessionID && planRun?.status?.serviceName) {
            const sessionData = await fetchSessionMessages(planRun.status.serviceName, planRun.status.sessionID, ns);
            if (sessionData && typeof sessionData === "object" && "messages" in sessionData) {
              const msgs = (sessionData.messages as Array<{ content?: string }>)
                .slice(-30).map((m) => m.content).filter(Boolean).join("\n");
              planSessionSummary = msgs.slice(0, 10000);
            }
          }
        } catch { /* best effort */ }

        const buildGenRunName = auxiliaryRunName(projectName, "build-gen", taskName, randomBytes(3).toString("hex"));
        const buildGenRun = buildBuildTaskGeneratorRun(
          fresh, task, worker?.runName ?? "", buildGenRunName, planSessionSummary, BUILDGEN_FACILITATOR_AGENT, freshTasks,
        );
        try {
          await createRun(buildGenRun, ns, k8s);
          await patchWorker(taskName, { buildTasksFacilitatorRun: buildGenRunName }, worker, ns);
          log(`spawned BUILD task generator ${buildGenRunName} for PLAN ${taskName}`);
          emitEvent(projectName, taskName, task.spec.type, "facilitator.spawned", { runName: buildGenRunName, agent: BUILDGEN_FACILITATOR_AGENT, reason: "build-task-generation" });
        } catch (e) {
          err(`failed to create BUILD task generator for ${taskName}:`, (e as Error).message);
          await patchWorker(taskName, {
            status: "Escalated",
            escalation: `Failed to spawn BUILD task generator: ${(e as Error).message}`,
          }, worker, ns);
          emitEvent(projectName, taskName, task.spec.type, "escalated", { reason: `BUILD task generator spawn failed` });
        }
      } else if (!worker.buildTasksCreated) {
        let buildGenRun: Awaited<ReturnType<typeof getRun>> | null = null;
        try {
          buildGenRun = await getRun(worker.buildTasksFacilitatorRun, ns, k8s);
        } catch { /* not found yet */ }

        let buildTaskDefs: Awaited<ReturnType<typeof parseBuildTaskDefinitions>> | null = null;
        try {
          buildTaskDefs = await parseBuildTaskDefinitions(
            worker.buildTasksFacilitatorRun, ns,
            buildGenRun?.status?.serviceName, buildGenRun?.status?.sessionID,
          );
        } catch (e) {
          err(`failed to parse BUILD task definitions for ${taskName}:`, (e as Error).message);
        }

        if (buildTaskDefs !== null) {
          if (buildTaskDefs.length === 0) {
            await patchWorker(taskName, {
              status: "Escalated",
              escalation: `BUILD task generator returned empty array for PLAN ${taskName}. Manual BUILD task creation needed.`,
              buildTasksCreated: true,
            }, worker, ns);
          } else {
            const createdRefs: string[] = [];
            // First pass: allocate names so predecessorIndex can be resolved to CR names.
            const buildTaskNames: string[] = buildTaskDefs.map(() => `${projectName}-build-${randomBytes(3).toString("hex")}`);
            for (let i = 0; i < buildTaskDefs.length; i++) {
              const def = buildTaskDefs[i];
              if (!def) continue;
              const buildTaskName = buildTaskNames[i]!;
              const planPath = `.percussionist/plans/${taskName}.md`;
              const buildDescription = [
                def.description,
                "",
                "PLAN CONTEXT:",
                `Read ${planPath} before implementing. This BUILD task is one slice of that approved plan; preserve the full-plan context, acceptance criteria, risks, and sequencing notes while working.`,
                "If this task depends on a predecessor, read the predecessor's merged code changes and any named repo artifact explicitly referenced in this description. Do not assume informal handoff outside repo state.",
              ].filter(Boolean).join("\n");
              const predecessorRef =
                typeof def.predecessorIndex === "number" && def.predecessorIndex >= 0 && def.predecessorIndex < i
                  ? buildTaskNames[def.predecessorIndex]
                  : undefined;
              createdRefs.push(buildTaskName);
              const newTask = buildTask({
                name: buildTaskName,
                projectName,
                projectUid: fresh.metadata.uid!,
                ns,
                spec: {
                  projectRef: projectName,
                  type: "BUILD",
                  title: def.title,
                  description: buildDescription,
                  agent: def.agent ?? "builder",
                  priority: def.priority ?? "medium",
                  parentTaskRef: taskName,
                  ...(predecessorRef ? { predecessorRef } : {}),
                },
              });
              try {
                await createTask(newTask, ns);
                await patchTaskStatus(buildTaskName, { column: "ready", phase: "Pending" }, ns);
                log(`created BUILD task CR ${buildTaskName} from PLAN ${taskName}${predecessorRef ? ` (after ${predecessorRef})` : ""}`);
              } catch (e) {
                err(`failed to create BUILD task ${buildTaskName}:`, (e as Error).message);
              }
            }
            await patchWorker(taskName, {
              buildTasksCreated: true,
              createdBuildTaskRefs: createdRefs,
            }, worker, ns);
            await moveTaskColumn(taskName, "done", ns);
            log(`created ${createdRefs.length} BUILD task CRs from PLAN ${taskName}`);
            emitEvent(projectName, taskName, task.spec.type, "merged", { buildTaskCount: createdRefs.length, buildTasks: createdRefs });
          }
        } else {
          const buildGenPhase = buildGenRun?.status?.phase;
          if (buildGenPhase === "Succeeded" || buildGenPhase === "Failed") {
            if (isAgentReady()) {
              let rawContext = "";
              try {
                const snapshot = await readSessionConfigMap(worker.buildTasksFacilitatorRun, "", ns);
                if (snapshot) rawContext = JSON.stringify(snapshot.messages).slice(0, 12000);
              } catch { /* best effort */ }
              if (!rawContext) {
                try {
                  const { readPodLog } = await import("@percussionist/kube");
                  rawContext = await readPodLog(worker.buildTasksFacilitatorRun, "opencode", 50, ns);
                } catch { /* best effort */ }
              }
              const agentDefs = await parseRawBuildTaskGen({
                projectName,
                taskId: taskName,
                taskTitle: task.spec.title,
                rawContext: rawContext || "no session data available",
              });
              if (agentDefs && agentDefs.length > 0) {
                const createdRefs: string[] = [];
                // First pass: allocate names so predecessorIndex can be resolved.
                const buildTaskNames: string[] = agentDefs.map(() => `${projectName}-build-${randomBytes(3).toString("hex")}`);
                for (let i = 0; i < agentDefs.length; i++) {
                  const def = agentDefs[i];
                  if (!def) continue;
                  const buildTaskName = buildTaskNames[i]!;
                  const planPath = `.percussionist/plans/${taskName}.md`;
                  const buildDescription = [
                    def.description,
                    "",
                    "PLAN CONTEXT:",
                    `Read ${planPath} before implementing. This BUILD task is one slice of that approved plan; preserve the full-plan context, acceptance criteria, risks, and sequencing notes while working.`,
                    "If this task depends on a predecessor, read the predecessor's merged code changes and any named repo artifact explicitly referenced in this description. Do not assume informal handoff outside repo state.",
                  ].filter(Boolean).join("\n");
                  const predecessorRef =
                    typeof def.predecessorIndex === "number" && def.predecessorIndex >= 0 && def.predecessorIndex < i
                      ? buildTaskNames[def.predecessorIndex]
                      : undefined;
                  createdRefs.push(buildTaskName);
                  const newTask = buildTask({
                    name: buildTaskName,
                    projectName,
                    projectUid: fresh.metadata.uid!,
                    ns,
                    spec: {
                      projectRef: projectName,
                      type: "BUILD",
                      title: def.title,
                      description: buildDescription,
                      agent: def.agent ?? "builder",
                      priority: (def.priority === "high" || def.priority === "low" ? def.priority : "medium") as "high" | "medium" | "low",
                      parentTaskRef: taskName,
                      ...(predecessorRef ? { predecessorRef } : {}),
                    },
                  });
                  try {
                    await createTask(newTask, ns);
                    await patchTaskStatus(buildTaskName, { column: "ready", phase: "Pending" }, ns);
                  } catch (e) {
                    err(`failed to create BUILD task ${buildTaskName}:`, (e as Error).message);
                  }
                }
                await patchWorker(taskName, { buildTasksCreated: true, createdBuildTaskRefs: createdRefs }, worker, ns);
                await moveTaskColumn(taskName, "done", ns);
                log(`created ${createdRefs.length} BUILD tasks (via agent) from PLAN ${taskName}`);
                continue;
              }
            }
            await patchWorker(taskName, {
              status: "Escalated",
              escalation: `BUILD task generator (${buildGenPhase}) produced no valid result for PLAN ${taskName}.`,
              buildTasksCreated: true,
            }, worker, ns);
          }
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // REWORK PHASE: re-dispatch tasks in the "rework" column.
  // ------------------------------------------------------------------
  const postReviewTasks = await listTasks(projectName, ns);
  const tasksToRework = getTasksToRework(postReviewTasks);

  for (const task of tasksToRework) {
    const taskName = task.metadata.name;
    const existingWorker = task.status?.worker;

    if (existingWorker?.status === "Running") {
      log(`task ${taskName} already has a running worker (${existingWorker.runName}) — skipping rework`);
      continue;
    }

    tasksReworked++;

    const existingFeedback = existingWorker?.reviewFeedback;
    const feedback =
      fresh.metadata.annotations?.[`percussionist.dev/rework-${taskName}`] ??
      existingFeedback ??
      "Please address the feedback from the previous review.";
    const currentRetryCount = existingWorker?.retryCount ?? 0;
    const newRetryCount = currentRetryCount + 1;
    const runName = workerRunName(projectName, taskName, newRetryCount);
    const reworkRun = buildWorkerRun(fresh, task, runName, newRetryCount, feedback, freshTasks);
    if (existingWorker?.reworkAgent) {
      reworkRun.spec.agent = existingWorker.reworkAgent;
    }

    // Resolve branch metadata for rework (reuse existing if present).
    const gitBranch = existingWorker?.gitBranch ?? resolveTaskBranch(task, fresh, freshTasks);
    const parentBranch = existingWorker?.parentBranch ?? resolveParentBranch(task, fresh, freshTasks);
    const mergeIntoBranch = existingWorker?.mergeIntoBranch ?? resolveMergeBranch(task, fresh, freshTasks);

    await patchTaskStatus(taskName, {
      column: "in-progress",
      worker: {
        runName,
        status: "Running",
        branch: gitBranch ?? `feat/${taskName}`, // Legacy fallback
        gitBranch,
        parentBranch,
        mergeIntoBranch,
        startedAt: new Date().toISOString(),
        retryCount: newRetryCount,
        facilitated: false,
        reviewApproved: false,
        reviewFeedback: undefined,
        reworkAgent: undefined,
        mergeRunName: undefined,
        mergeError: undefined,
      },
    }, ns);

    try {
      await createRun(reworkRun, ns, k8s);
      log(`re-dispatched rework for task ${taskName}`);
      emitEvent(projectName, taskName, task.spec.type, "run.created", { runName, agent: reworkRun.spec.agent ?? "", retryCount: newRetryCount, reason: "rework" });
    } catch (e) {
      const msg = (e as Error).message;
      if (/AlreadyExists/i.test(msg)) {
        try {
          const existingRun = await getRun(runName, ns, k8s);
          const existingPhase = existingRun?.status?.phase;
          if (existingPhase === "Failed" || existingPhase === "Cancelled") {
            await deleteRun(runName, ns, k8s);
            await createRun(reworkRun, ns, k8s);
            log(`re-dispatched rework for ${taskName} after cleaning up failed run`);
          } else {
            log(`rework run already exists for ${taskName} (phase: ${existingPhase})`);
          }
        } catch (checkErr) {
          err(`failed to check existing run for ${taskName}:`, (checkErr as Error).message);
        }
      } else {
        err(`failed to create rework run for ${taskName}:`, msg);
        await patchWorker(taskName, { status: "Failed", runName: undefined }, existingWorker, ns);
        await moveTaskColumn(taskName, "rework", ns);
      }
    }
  }

  // ------------------------------------------------------------------
  // UPDATE PHASE: write summary metrics to project CR status.
  // ------------------------------------------------------------------
  const finalTasks = await listTasks(projectName, ns);
  const activeWorkers = finalTasks.filter(
    (t) => t.status?.column === "in-progress" && t.status?.worker?.status === "Running" && !!t.status?.worker?.runName,
  ).length;

  const pendingQuestions = (fresh.status?.board?.pendingQuestions ?? []).filter((q: { workerId: string }) =>
    finalTasks.some(
      (t) => t.metadata.name === q.workerId && t.status?.worker?.status === "Running",
    ),
  );

  const escalations = finalTasks
    .filter((t) => t.status?.worker?.escalation)
    .map((t) => t.status!.worker!.escalation!);

  const reconcileDuration = Date.now() - startTime;

  // Only patch status if there are meaningful changes (not just metrics updates).
  // Patching status triggers another reconciliation, so we must avoid infinite loops.
  const currentBoard = fresh.status?.board;
  const hasChanges =
    currentBoard?.activeWorkers !== activeWorkers ||
    JSON.stringify(currentBoard?.pendingQuestions) !== JSON.stringify(pendingQuestions) ||
    JSON.stringify(currentBoard?.escalations) !== JSON.stringify(escalations) ||
    tasksPulled > 0 ||
    tasksReworked > 0;

  if (hasChanges) {
    try {
      await patchProjectStatus(
        projectName,
        {
          board: {
            activeWorkers,
            lastEventAt: new Date().toISOString(),
            pendingQuestions,
            escalations,
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
      err(`patchProjectStatus failed: ${(e as Error).message}`);
      await patchProjectStatus(
        projectName,
        {
            board: {
              activeWorkers,
              managerMetrics: {
                lastReconcileAt: new Date().toISOString(),
                lastReconcileDurationMs: reconcileDuration,
                lastReconcileResult: "error",
                lastError: (e as Error).message,
                tasksPulled: 0,
                workersMonitored: 0,
                tasksReworked: 0,
              },
            },
        },
        ns,
      ).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Pause mechanism

let paused = false;
let pausedAt = 0;
let pauseTimer: ReturnType<typeof setTimeout> | null = null;

export function setPaused(v: boolean, durationMs = 0): void {
  paused = v;
  pausedAt = v ? Date.now() : 0;
  if (pauseTimer !== null) {
    clearTimeout(pauseTimer);
    pauseTimer = null;
  }
  if (v && durationMs > 0) {
    pauseTimer = setTimeout(() => {
      paused = false;
      pausedAt = 0;
      pauseTimer = null;
      log("auto-resumed reconciliation after pause timeout");
    }, durationMs).unref();
  }
}

export function getPauseStatus(): { paused: boolean; elapsedMs: number; remainingMs: number } {
  const elapsedMs = pausedAt ? Date.now() - pausedAt : 0;
  return { paused, elapsedMs, remainingMs: 0 };
}

// ---------------------------------------------------------------------------
// Work queue

const queue: string[] = [];
const pending = new Set<string>();
const processing = new Set<string>();
const dirty = new Set<string>();
const seen = new Map<string, Project>();

export function enqueue(project: Project): void {
  const key = `${project.metadata.namespace}/${project.metadata.name}`;
  seen.set(key, project);
  if (processing.has(key)) {
    dirty.add(key);
    return;
  }
  if (!pending.has(key)) {
    pending.add(key);
    queue.push(key);
  }
}

export function dequeue(key: string): void {
  seen.delete(key);
  pending.delete(key);
  processing.delete(key);
  dirty.delete(key);
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
    pending.delete(key);
    processing.add(key);
    try {
      if (paused) {
        dirty.add(key);
        continue;
      }
      await reconcile(project);
    } catch (e) {
      err(`reconcile(${key}) failed:`, (e as Error).message);
      setTimeout(() => {
        const current = seen.get(key);
        if (current) enqueue(current);
      }, 5000);
    } finally {
      processing.delete(key);
      if (dirty.delete(key)) {
        const current = seen.get(key);
        if (current) enqueue(current);
      }
    }
  }
}

export function startPeriodicResync(): void {
  setInterval(() => {
    for (const project of seen.values()) enqueue(project);
  }, 30_000).unref();
}

export { NAMESPACE };
