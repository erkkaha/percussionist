// worker-builder.ts — builds Run specs for Task CRs.

import { createHash } from "node:crypto";
import {
  API_GROUP_VERSION,
  KIND_RUN,
  LABELS,
  MANAGED_BY,
  type Project,
  type Task,
  type Run,
  type RunSpec,
  resolveRunConfig,
} from "@percussionist/api";

const MAX_RETRIES = 3;

export { MAX_RETRIES };

/**
 * Builds a fully-resolved Run for an Task CR.
 *
 * Config resolution order: project defaults → task-specific overrides.
 */
export function buildWorkerRun(
  project: Project,
  task: Task,
  runName: string,
  retryCount: number,
  reworkFeedback?: string,
): Run {
  const resolved = resolveRunConfig(project.spec);

  const taskName = task.metadata.name;
  const promptLines = [
    `TASK: ${taskName} — ${task.spec.title}`,
    "",
    "DESCRIPTION:",
    task.spec.description ?? "No description provided.",
    "",
  ];

  if (retryCount > 0) {
    promptLines.push(
      `RETRY ${retryCount}/${MAX_RETRIES}:`,
      reworkFeedback ?? "Previous attempt failed. Review the error and try a different approach.",
      "",
    );
  } else if (reworkFeedback) {
    promptLines.push(
      "HUMAN FEEDBACK (rework):",
      reworkFeedback,
      "",
    );
  }

  const projectName = project.metadata.name;

  return {
    apiVersion: API_GROUP_VERSION,
    kind: KIND_RUN,
    metadata: {
      name: runName,
      labels: {
        [LABELS.managedBy]: MANAGED_BY,
        [LABELS.projectName]: projectName,
        [LABELS.taskId]: taskName,
      },
      ownerReferences: [
        {
          apiVersion: API_GROUP_VERSION,
          kind: "Project",
          name: projectName,
          uid: project.metadata.uid!,
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
    spec: {
      project: projectName,
      boardTask: taskName,
      task: promptLines.join("\n"),
      interactive: false,
      agent: task.spec.agent,
      agents: (project.spec.agents ?? []).filter((a) => a.name !== task.spec.agent),
      model: resolved.model,
      image: resolved.image,
      timeoutSeconds: resolved.timeoutSeconds,
      ttlSecondsAfterFinished: 3600,
      ...(resolved.resources ? { resources: resolved.resources } : {}),
      ...(resolved.secrets ? { secrets: resolved.secrets } : {}),
      ...(resolved.source ? { source: resolved.source } : {}),
      ...(resolved.sidecars?.length ? { sidecars: resolved.sidecars } : {}),
      ...(resolved.initScript ? { initScript: resolved.initScript } : {}),
      ...(resolved.data ? { data: resolved.data } : {}),
      ...(resolved.gitCache ? { gitCache: resolved.gitCache } : {}),
    } as RunSpec,
  };
}

export function buildMergeRun(
  project: Project,
  task: Task,
  runName: string,
): Run {
  const resolved = resolveRunConfig(project.spec);
  const projectName = project.metadata.name;
  const taskName = task.metadata.name;
  const branchName = `feat/${taskName}`;

  const promptLines = [
    `TASK: Merge approved PR for ${taskName}`,
    "",
    `Task title: ${task.spec.title}`,
    `Expected branch: ${branchName}`,
    "",
    "Requirements:",
    "- Use GitHub CLI and repository context in this workspace.",
    "- Find the open PR for the expected branch.",
    "- Merge it with SQUASH strategy.",
    "- Do not perform any code changes.",
    "- If no matching open PR exists, fail with a clear reason.",
    "",
    "Suggested commands:",
    `- gh pr list --head \"${branchName}\" --state open --json number,title,headRefName,baseRefName,url`,
    "- gh pr merge <number> --squash --delete-branch",
  ];

  return {
    apiVersion: API_GROUP_VERSION,
    kind: KIND_RUN,
    metadata: {
      name: runName,
      labels: {
        [LABELS.managedBy]: MANAGED_BY,
        [LABELS.projectName]: projectName,
        [LABELS.taskId]: taskName,
      },
      ownerReferences: [
        {
          apiVersion: API_GROUP_VERSION,
          kind: "Project",
          name: projectName,
          uid: project.metadata.uid!,
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
    spec: {
      project: projectName,
      boardTask: taskName,
      task: promptLines.join("\n"),
      interactive: false,
      agent: task.spec.agent,
      agents: (project.spec.agents ?? []).filter((a) => a.name !== task.spec.agent),
      model: resolved.model,
      image: resolved.image,
      timeoutSeconds: resolved.timeoutSeconds,
      ttlSecondsAfterFinished: 3600,
      ...(resolved.resources ? { resources: resolved.resources } : {}),
      ...(resolved.secrets ? { secrets: resolved.secrets } : {}),
      ...(resolved.source ? { source: resolved.source } : {}),
      ...(resolved.sidecars?.length ? { sidecars: resolved.sidecars } : {}),
      ...(resolved.initScript ? { initScript: resolved.initScript } : {}),
      ...(resolved.data ? { data: resolved.data } : {}),
      ...(resolved.gitCache ? { gitCache: resolved.gitCache } : {}),
    } as RunSpec,
  };
}

/**
 * Truncate a K8s name to at most `max` characters, preserving the suffix.
 * Removes trailing hyphens left by truncation.
 */
export function truncateK8sName(name: string, max: number = 63): string {
  if (name.length <= max) return name;
  return name.slice(0, max).replace(/-+$/, "");
}

export function workerRunName(
  projectName: string,
  taskName: string,
  retryCount: number = 0,
): string {
  const sanitized = taskName.toLowerCase().replace(/[^a-z0-9]/g, "-");
  // Deterministic suffix — same inputs always produce the same run name,
  // preventing duplicate runs across reconcile cycles.
  const suffix = createHash("sha256")
    .update(`${projectName}:${taskName}:${retryCount}`)
    .digest("hex")
    .slice(0, 10);
  // suffix + 2 separating hyphens = 12 chars reserved; project prefix = projectName.length + 1
  const reserved = projectName.length + 1 + 1 + suffix.length; // "{project}-{mid}-{suffix}"
  const maxMid = 63 - reserved;
  const mid = maxMid > 0 ? sanitized.slice(0, maxMid).replace(/-+$/, "") : sanitized.slice(0, 1);
  return truncateK8sName(`${projectName}-${mid}-${suffix}`);
}

/**
 * Build a run name for review/facilitation runs, capped at 63 chars.
 * Uses a random 6-hex suffix (non-deterministic — these are one-shot runs).
 */
export function auxiliaryRunName(
  projectName: string,
  kind: string,
  taskName: string,
  randomSuffix: string,
): string {
  const sanitized = taskName.toLowerCase().replace(/[^a-z0-9]/g, "-");
  const reserved = projectName.length + 1 + kind.length + 1 + 1 + randomSuffix.length;
  const maxMid = 63 - reserved;
  const mid = maxMid > 0 ? sanitized.slice(0, maxMid).replace(/-+$/, "") : sanitized.slice(0, 1);
  return truncateK8sName(`${projectName}-${kind}-${mid}-${randomSuffix}`);
}
