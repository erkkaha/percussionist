// worker-builder.ts — builds OpenCodeRun specs for board tasks.

import { randomBytes } from "node:crypto";
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
  const board = project.spec.board ?? {};
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
      agent: task.agent,
      agents: (board.agents ?? []).filter((a) => a.name !== task.agent),
      model: resolved.model,
      image: resolved.image,
      timeoutSeconds: resolved.timeoutSeconds,
      ...(resolved.resources ? { resources: resolved.resources } : {}),
      ...(resolved.secrets ? { secrets: resolved.secrets } : {}),
      ...(resolved.source ? { source: resolved.source } : {}),
    },
  };
}

export function workerRunName(
  projectName: string,
  taskId: string,
): string {
  const sanitized = taskId.toLowerCase().replace(/[^a-z0-9]/g, "-");
  // Use crypto-random suffix (5 bytes = 10 hex chars) to guarantee uniqueness
  // even when two reconciles fire in the same millisecond.
  const suffix = randomBytes(5).toString("hex");
  return `${projectName}-${sanitized}-${suffix}`;
}
