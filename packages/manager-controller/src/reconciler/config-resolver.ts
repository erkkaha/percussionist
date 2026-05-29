// Config resolution — merges project + task + cluster defaults.

import type { Project, Task } from "@percussionist/api";
import type { ResolvedConfig } from "./types.js";
import { resolveFlow } from "./flow.js";

export function resolveConfig(project: Project, task: Task): ResolvedConfig {
  const flow = resolveFlow(project);

  // Retry policy: flow resolver already merged task overrides and legacy policies.
  const retryPolicy = flow.retry;

  // Review policy: flow resolver already merged legacy reviewPolicy.
  const reviewPolicy = flow.review;

  return {
    retryPolicy,
    reviewPolicy,
    model: project.spec.model,
    image: project.spec.image ?? "percussionist/runner:dev",
    timeoutSeconds: project.spec.timeoutSeconds ?? 3600,
    flow,
  };
}
