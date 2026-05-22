// Config resolution — merges project + task + cluster defaults.

import type { Project, Task } from "@percussionist/api";
import type { ResolvedConfig } from "./types.js";

export function resolveConfig(project: Project, task: Task): ResolvedConfig {
  // Retry policy: task overrides project defaults.
  const projectRetry = project.spec.retryPolicy ?? {
    enabled: false,
    maxAttempts: 3,
    backoffSeconds: 30,
    backoffMultiplier: 2,
    maxBackoffSeconds: 300,
    poisonPillThresholdSeconds: 30,
  };
  const taskRetry = task.spec.retryPolicy ?? {};
  const retryPolicy = {
    enabled: taskRetry.enabled ?? projectRetry.enabled,
    maxAttempts: taskRetry.maxAttempts ?? projectRetry.maxAttempts,
    backoffSeconds: taskRetry.backoffSeconds ?? projectRetry.backoffSeconds,
    backoffMultiplier: projectRetry.backoffMultiplier,
    maxBackoffSeconds: projectRetry.maxBackoffSeconds,
    poisonPillThresholdSeconds: projectRetry.poisonPillThresholdSeconds,
  };

  // Review policy: project-level only.
  const reviewPolicy = project.spec.reviewPolicy ?? {
    aiReviewerEnabled: false,
    aiReviewerAgent: "reviewer",
    maxAutoReworks: 2,
  };

  return {
    retryPolicy,
    reviewPolicy,
    model: project.spec.model,
    image: project.spec.image ?? "percussionist/runner:dev",
    timeoutSeconds: project.spec.timeoutSeconds ?? 3600,
  };
}
