// worker-builder.ts — builds OpenCodeRun specs for board tasks.

import { createHash } from "node:crypto";
import {
  API_GROUP_VERSION,
  KIND_RUN,
  LABELS,
  MANAGED_BY,
  type OpenCodeProject,
  type BoardTask,
  type OpenCodeRun,
  resolveRunConfig,
} from "@percussionist/api";

const MAX_RETRIES = 3;

export { MAX_RETRIES };

/**
 * Builds a fully-resolved OpenCodeRun for a board task.
 *
 * Config resolution order: project defaults → board overrides → task-specific.
 */
export function buildWorkerRun(
  project: OpenCodeProject,
  task: BoardTask,
  runName: string,
  retryCount: number,
  reworkFeedback?: string,
): OpenCodeRun {
  const board: import("@percussionist/api").BoardSpec = project.spec.board ?? { maxParallel: 2, phase: "Active" };
  const resolved = resolveRunConfig(
    project.spec,
    board.overrides,
  );

  const promptLines = [
    `TASK: ${task.id} — ${task.title}`,
    "",
    "DESCRIPTION:",
    task.description ?? "No description provided.",
    "",
  ];

  // Completed sibling tasks — provide context on what's already done.
  // (Caller can pass nothing; dependency info is informational only.)

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
        [LABELS.taskId]: task.id,
      },
      ownerReferences: [
        {
          apiVersion: API_GROUP_VERSION,
          kind: "OpenCodeProject",
          name: projectName,
          uid: project.metadata.uid!,
          // controller:true means K8s treats the project as the owning
          // controller and will garbage-collect this run when the project
          // is deleted. blockOwnerDeletion:true makes project deletion wait
          // until all board runs have been cleaned up first.
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
    spec: {
      project: projectName,
      boardTask: task.id,
      task: promptLines.join("\n"),
      interactive: false,
      agent: task.agent,
      agents: (board.agents ?? []).filter((a: import("@percussionist/api").AgentRef) => a.name !== task.agent),
      model: resolved.model,
      image: resolved.image,
      timeoutSeconds: resolved.timeoutSeconds,
      ttlSecondsAfterFinished: 3600,
      ...(resolved.resources ? { resources: resolved.resources } : {}),
      ...(resolved.secrets ? { secrets: resolved.secrets } : {}),
      ...(resolved.source ? { source: resolved.source } : {}),
      ...(resolved.sidecars?.length ? { sidecars: resolved.sidecars } : {}),
    },
  };
}

export function buildMergeRun(
  project: OpenCodeProject,
  task: BoardTask,
  runName: string,
): OpenCodeRun {
  const board: import("@percussionist/api").BoardSpec = project.spec.board ?? { maxParallel: 2, phase: "Active" };
  const resolved = resolveRunConfig(
    project.spec,
    board.overrides,
  );
  const projectName = project.metadata.name;
  const branchName = `feat/${task.id}`;

  const promptLines = [
    `TASK: Merge approved PR for ${task.id}`,
    "",
    `Task title: ${task.title}`,
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
        [LABELS.taskId]: task.id,
      },
      ownerReferences: [
        {
          apiVersion: API_GROUP_VERSION,
          kind: "OpenCodeProject",
          name: projectName,
          uid: project.metadata.uid!,
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
    spec: {
      project: projectName,
      boardTask: task.id,
      task: promptLines.join("\n"),
      interactive: false,
      agent: task.agent,
      agents: (board.agents ?? []).filter((a: import("@percussionist/api").AgentRef) => a.name !== task.agent),
      model: resolved.model,
      image: resolved.image,
      timeoutSeconds: resolved.timeoutSeconds,
      ttlSecondsAfterFinished: 3600,
      ...(resolved.resources ? { resources: resolved.resources } : {}),
      ...(resolved.secrets ? { secrets: resolved.secrets } : {}),
      ...(resolved.source ? { source: resolved.source } : {}),
      ...(resolved.sidecars?.length ? { sidecars: resolved.sidecars } : {}),
    },
  };
}

export function workerRunName(
  projectName: string,
  taskId: string,
  retryCount: number = 0,
): string {
  const sanitized = taskId.toLowerCase().replace(/[^a-z0-9]/g, "-");
  // Derive a deterministic suffix from project + task + retryCount so that
  // re-reconciling after a failed status patch produces the same run name
  // instead of creating a duplicate. This makes the pull phase idempotent.
  const suffix = createHash("sha256")
    .update(`${projectName}:${taskId}:${retryCount}`)
    .digest("hex")
    .slice(0, 10);
  return `${projectName}-${sanitized}-${suffix}`;
}
