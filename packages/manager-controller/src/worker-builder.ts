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
import {
  resolveTaskBranch,
  resolveParentBranch,
  resolveMergeBranch,
} from "./branch-resolver.js";

const MAX_RETRIES = 3;

export { MAX_RETRIES };

/**
 * Builds a fully-resolved Run for an Task CR.
 *
 * Config resolution order: project defaults → task-specific overrides.
 * When featureBranchingEnabled: true, overrides git ref with task's feature branch.
 */
export function buildWorkerRun(
  project: Project,
  task: Task,
  runName: string,
  retryCount: number,
  reworkFeedback?: string,
  allTasks?: Task[]
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
  const planPath = `.percussionist/plans/${taskName}.md`;

  if (task.spec.type === "PLAN") {
    promptLines.push(
      "PLAN ARTIFACT REQUIREMENTS:",
      `- Create or update ${planPath} in the repository.`,
      "- The file is the authoritative PLAN output and will be reviewed by facilitator/human reviewers.",
      "- Include implementation context, scope boundaries, risks, acceptance criteria, and proposed BUILD task breakdown.",
      "- Commit and push the plan artifact on this task branch before completing the run.",
      `- Mention ${planPath} in the completion summary.`,
      "",
    );
  } else if (task.spec.type === "BUILD" && task.spec.parentTaskRef) {
    const planPathForParent = `.percussionist/plans/${task.spec.parentTaskRef}.md`;
    promptLines.push(
      "PLAN CONTEXT:",
      `- Read ${planPathForParent} before implementing.`,
      "- Treat that PLAN artifact as the full feature context, even if this BUILD task covers only one slice.",
      "- Keep your changes aligned with the plan's acceptance criteria and sequencing notes.",
      "",
    );
  }

  // Feature branching: override git ref with task's branch.
  if (project.spec.featureBranchingEnabled && resolved.source?.git) {
    const gitBranch = resolveTaskBranch(task, project, allTasks ?? []);
    const parentBranch = resolveParentBranch(task, project, allTasks ?? []);
    
    if (gitBranch) {
      resolved.source.git.ref = gitBranch;
    }
    if (parentBranch) {
      resolved.source.git.parentRef = parentBranch;
    }
  }

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
  allTasks?: Task[]
): Run {
  const resolved = resolveRunConfig(project.spec);
  const projectName = project.metadata.name;
  const taskName = task.metadata.name;
  
  // Determine source and target branches based on feature branching config.
  let sourceBranch: string;
  let targetBranch: string;
  
  if (project.spec.featureBranchingEnabled) {
    const gitBranch = resolveTaskBranch(task, project, allTasks ?? []);
    const mergeBranch = resolveMergeBranch(task, project, allTasks ?? []);
    
    if (!gitBranch) {
      throw new Error(`Task ${taskName} has no git branch (feature branching enabled but branch not resolved)`);
    }
    
    sourceBranch = gitBranch;
    targetBranch = mergeBranch ?? "main"; // Fallback to main if no merge target
  } else {
    // Legacy: use feat/{taskName} branch
    sourceBranch = `feat/${taskName}`;
    targetBranch = "main";
  }

  // Use a dedicated merge agent if configured, otherwise fall back to the task's agent.
  const MERGING_AGENT = process.env.MERGING_AGENT;
  const mergeAgent =
    MERGING_AGENT && (project.spec.agents ?? []).some((a) => a.name === MERGING_AGENT)
      ? MERGING_AGENT
      : task.spec.agent;

  const promptLines = [
    `TASK: Merge approved changes for ${taskName}`,
    "",
    `Task title: ${task.spec.title}`,
    `Source branch: ${sourceBranch}`,
    `Target branch: ${targetBranch}`,
    "",
    "Requirements:",
    "- Merge the source branch into the target branch.",
    "- Do not perform any code changes.",
    "- If the branches are already merged, report success — do not re-create runs or PRs.",
    "- Push the merged result to the remote repository.",
    "",
    "## Completion",
    "",
    'When done, call `percussionist_dispatcher_complete_run` with a summary.',
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
      agent: mergeAgent,
      agents: (project.spec.agents ?? []).filter((a) => a.name !== mergeAgent),
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
