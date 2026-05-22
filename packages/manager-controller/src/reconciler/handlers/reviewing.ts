// Phase handler: reviewing → awaiting-human | rework-requested

import type { PhaseHandler, Transition } from "../types.js";
import { getRun } from "@percussionist/kube";
import { readSessionConfigMap } from "@percussionist/kube";

const REVIEW_STALENESS_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export const handleReviewing: PhaseHandler = async (ctx) => {
  const reviewRunName = ctx.task.status?.worker?.reviewRunName;
  
  if (!reviewRunName) {
    // No review run yet — skip to human (safety fallback).
    return {
      targetPhase: "awaiting-human",
      sideEffects: [],
    };
  }

  // Fetch review run.
  const reviewRun = await getRun(reviewRunName, ctx.namespace).catch(() => undefined);
  
  if (!reviewRun || reviewRun.status?.phase === "Failed") {
    // Review run failed — skip to human.
    return {
      targetPhase: "awaiting-human",
      sideEffects: [
        {
          type: "deleteRun",
          name: reviewRunName,
        },
      ],
    };
  }

  // Staleness check (5min).
  if (reviewRun.status?.phase === "Running") {
    const lastEvent = reviewRun.status?.lastEventAt;
    if (lastEvent && Date.now() - new Date(lastEvent).getTime() > REVIEW_STALENESS_THRESHOLD_MS) {
      return {
        targetPhase: "awaiting-human",
        sideEffects: [
          {
            type: "deleteRun",
            name: reviewRunName,
          },
          {
            type: "emitEvent",
            event: { reason: "ReviewStale", message: "Review run stale after 5 minutes" },
          },
        ],
      };
    }
    return null; // Still running.
  }

  if (reviewRun.status?.phase !== "Succeeded") {
    return null; // Still pending/initializing.
  }

  // Parse review result from session ConfigMap.
  try {
    const sessionData = await readSessionConfigMap(reviewRunName, ctx.namespace);
    if (!sessionData || !sessionData.messages) {
      throw new Error("No session data available");
    }
    
    const lastMessage = sessionData.messages[sessionData.messages.length - 1];
    const reviewText = (lastMessage as { textContent?: string })?.textContent ?? "";
    
    // Simple JSON extraction (look for {diagnosis, recommendedAction} pattern).
    const jsonMatch = reviewText.match(/\{[\s\S]*?"recommendedAction"[\s\S]*?\}/);
    if (!jsonMatch) {
      // Can't parse — escalate to human.
      return {
        targetPhase: "awaiting-human",
        sideEffects: [
          {
            type: "patchWorker",
            patch: { reviewFeedback: "AI review completed but output was unparseable." },
          },
        ],
      };
    }

    const result = JSON.parse(jsonMatch[0]) as {
      diagnosis?: string;
      recommendedAction: string;
      suggestion?: string;
    };

    const feedback = [result.diagnosis, result.suggestion].filter(Boolean).join("\n\n");

    if (result.recommendedAction === "approve") {
      return {
        targetPhase: "awaiting-human",
        sideEffects: [
          {
            type: "patchWorker",
            patch: { reviewApproved: true, reviewFeedback: feedback },
          },
        ],
      };
    }

    if (result.recommendedAction === "request_changes") {
      const aiCount = (ctx.task.status?.worker?.aiReworkCount ?? 0) + 1;
      const ceiling = ctx.config.reviewPolicy.maxAutoReworks;

      if (aiCount > ceiling) {
        // Ceiling reached — escalate to human with AI feedback.
        return {
          targetPhase: "awaiting-human",
          sideEffects: [
            {
              type: "patchWorker",
              patch: { aiReworkCount: aiCount, reviewFeedback: `${feedback}\n\n(AI rework ceiling reached)` },
            },
          ],
        };
      }

      // Auto-rework.
      return {
        targetPhase: "rework-requested",
        sideEffects: [
          {
            type: "patchWorker",
            patch: { aiReworkCount: aiCount, reviewFeedback: feedback },
          },
        ],
      };
    }

    // Default: escalate to human.
    return {
      targetPhase: "awaiting-human",
      sideEffects: [
        {
          type: "patchWorker",
          patch: { reviewFeedback: feedback },
        },
      ],
    };
  } catch (e) {
    console.error(`[reviewing] ${ctx.task.metadata.name} parse error:`, e);
    // Parse failed — escalate to human.
    return {
      targetPhase: "awaiting-human",
      sideEffects: [
        {
          type: "patchWorker",
          patch: { reviewFeedback: "AI review completed but result could not be parsed." },
        },
      ],
    };
  }
};

