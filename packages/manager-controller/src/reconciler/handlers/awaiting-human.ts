// Phase handler: awaiting-human → awaiting-merge | generating-builds | rework-requested | done

import type { PhaseHandler, Transition } from "../types.js";
import { getProject } from "@percussionist/kube";
import { buildMergeRun, auxiliaryRunName } from "../../worker-builder.js";

export const handleAwaitingHuman: PhaseHandler = async (ctx) => {
  // Human actions are stored as annotations on the Project CR.
  const project = await getProject(ctx.project.metadata.name, ctx.namespace);
  const annotations = project.metadata.annotations ?? {};
  const taskName = ctx.task.metadata.name;

  // Check for approval annotation.
  const approvalKey = `percussionist.dev/approved-${taskName}`;
  if (annotations[approvalKey]) {
    if (ctx.task.spec.type === "BUILD") {
      // BUILD task approved → create merge run and transition to awaiting-merge.
      // Seq number: use retryCount to avoid collisions after rework.
      const retryCount = ctx.task.status?.worker?.retryCount ?? 0;
      const mergeSeq = String(retryCount);
      
      const mergeRunName = auxiliaryRunName(
        ctx.project.metadata.name,
        "merge",
        taskName,
        mergeSeq,
      );

      const mergeRun = buildMergeRun(
        ctx.project,
        ctx.task,
        mergeRunName,
        ctx.allTasks,
      );

      return {
        targetPhase: "awaiting-merge",
        sideEffects: [
          {
            type: "createRun",
            run: mergeRun,
          },
          {
            type: "patchWorker",
            patch: { mergeRunName },
          },
          {
            type: "clearProjectAnnotations",
            keys: [approvalKey],
          },
        ],
      };
    } else if (ctx.task.spec.type === "PLAN") {
      // PLAN task approved → transition to generating-builds.
      return {
        targetPhase: "generating-builds",
        sideEffects: [
          {
            type: "clearProjectAnnotations",
            keys: [approvalKey],
          },
        ],
      };
    }
  }

  // Check for request-changes annotation.
  const reworkKey = `percussionist.dev/request-changes-${taskName}`;
  const feedbackKey = `percussionist.dev/rework-${taskName}`;
  if (annotations[reworkKey]) {
    const feedback = annotations[feedbackKey] ?? "No feedback provided";
    // Store feedback in worker for consumption on next run.
    return {
      targetPhase: "rework-requested",
      sideEffects: [
        {
          type: "patchWorker",
          patch: {
            reviewFeedback: feedback,
            aiReworkCount: 0, // Reset AI rework count on human action.
          },
        },
        {
          type: "clearProjectAnnotations",
          keys: [reworkKey, feedbackKey],
        },
      ],
    };
  }

  // Check for abandon annotation.
  const abandonKey = `percussionist.dev/abandon-${taskName}`;
  if (annotations[abandonKey]) {
    // Mark as done (abandoned).
    return {
      targetPhase: "done",
      sideEffects: [
        {
          type: "patchWorker",
          patch: {
            status: "Succeeded",
            completedAt: new Date().toISOString(),
          },
        },
        {
          type: "clearProjectAnnotations",
          keys: [abandonKey],
        },
      ],
    };
  }

  // No action yet — stay in awaiting-human.
  return null;
};
