// Phase handler: succeeded → reviewing | awaiting-human

import type { PhaseHandler, Transition } from "../types.js";
import { buildSuccessReviewRun } from "../../facilitator.js";
import { auxiliaryRunName } from "../../worker-builder.js";
import { readAllSessionsFromConfigMap } from "@percussionist/kube";

export const handleSucceeded: PhaseHandler = async (ctx) => {
  // Check if AI reviewer is enabled and agent exists.
  const { aiReviewerEnabled, aiReviewerAgent } = ctx.config.reviewPolicy;
  
  if (!aiReviewerEnabled) {
    // No AI reviewer — straight to human.
    return {
      targetPhase: "awaiting-human",
      sideEffects: [],
    };
  }

  // Check if reviewer agent exists in project roster.
  const agentExists = ctx.project.spec.agents?.some((a) => a.name === aiReviewerAgent);
  if (!agentExists) {
    console.warn(
      `[succeeded] AI reviewer agent "${aiReviewerAgent}" not found in project roster, skipping AI review`,
    );
    return {
      targetPhase: "awaiting-human",
      sideEffects: [],
    };
  }

  // Check if review run already created.
  if (ctx.task.status?.worker?.reviewRunName) {
    // Review run already exists — move to reviewing phase.
    return {
      targetPhase: "reviewing",
      sideEffects: [],
    };
  }

  // Create review run.
  const workerRunName = ctx.task.status?.worker?.runName;
  if (!workerRunName || !ctx.run) {
    // No worker run to review — skip to human.
    return {
      targetPhase: "awaiting-human",
      sideEffects: [],
    };
  }

  try {
    // Fetch session summary from worker run.
    const sessionData = await readAllSessionsFromConfigMap(workerRunName, ctx.namespace);
    if (!sessionData || !sessionData.allMessages || sessionData.allMessages.length === 0) {
      throw new Error("No session data available");
    }
    
    const messages = sessionData.allMessages;
    const lastN = messages.slice(-10); // Last 10 messages for context.
    const sessionSummary = lastN
      .map((m: unknown) => {
        const msg = m as { info?: { role?: string }; parts?: Array<{ type: string; text?: string }> };
        const role = msg.info?.role ?? "unknown";
        const text = (msg.parts ?? [])
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join(" ");
        return `[${role}] ${text || "(no text)"}`;
      })
      .join("\n\n");

    // Seq number for review run: use sum of retryCount + aiReworkCount to avoid collisions.
    const retryCount = ctx.task.status?.worker?.retryCount ?? 0;
    const aiReworkCount = ctx.task.status?.worker?.aiReworkCount ?? 0;
    const reviewSeq = String(retryCount + aiReworkCount);

    const reviewRunName = auxiliaryRunName(
      ctx.project.metadata.name,
      "review",
      ctx.task.metadata.name,
      reviewSeq,
    );

    const reviewRun = await buildSuccessReviewRun(
      ctx.project,
      ctx.task,
      workerRunName,
      ctx.run.status ?? {},
      sessionSummary,
      reviewRunName,
      ctx.task.status?.worker?.gitBranch,
      aiReviewerAgent,
      ctx.allTasks,
    );

    return {
      targetPhase: "reviewing",
      sideEffects: [
        {
          type: "createRun",
          run: reviewRun,
        },
        {
          type: "patchWorker",
          patch: { reviewRunName },
        },
      ],
    };
  } catch (e) {
    console.error(`[succeeded] ${ctx.task.metadata.name} review run creation failed:`, e);
    // Failed to create review — skip to human.
    return {
      targetPhase: "awaiting-human",
      sideEffects: [],
    };
  }
};

