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
import { getClusterAgent, getClusterSettings } from "@percussionist/kube";
import { getContext } from "./agent/memory-client.js";

const MAX_RETRIES = 3;

export { MAX_RETRIES };

/**
 * Builds a fully-resolved Run for an Task CR.
 *
 * Config resolution order: project defaults → task-specific overrides.
 * When featureBranchingEnabled: true, overrides git ref with task's feature branch.
 */
export async function buildWorkerRun(
  project: Project,
  task: Task,
  runName: string,
  retryCount: number,
  reworkFeedback?: string,
  allTasks?: Task[]
): Promise<Run> {
  const clusterSettings = await getClusterSettings().catch(() => undefined);
  const resolved = resolveRunConfig(project.spec, undefined, undefined, {
    runner: {
      image: clusterSettings?.spec?.runner?.image,
      resources: clusterSettings?.spec?.runner?.resources,
    },
  });

  // Agent-level model override (between board and project in resolution hierarchy).
  try {
    const agent = await getClusterAgent(task.spec.agent);
    if (agent.spec.model) {
      resolved.model = agent.spec.model;
    }
  } catch {
    // Agent CR not found or inaccessible — fall back to project/cluster defaults.
  }

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
    // If this is a retry/rework, the agent should redo the plan. Otherwise,
    // instruct it to check for an existing plan first and short-circuit if found.
    const isRework = reworkFeedback != null || retryCount > 0;
    if (!isRework) {
      promptLines.push(
        "IDEMPOTENCY CHECK (do this first, before any exploration):",
        `- Run: \`cat ${planPath}\``,
        "- If the file exists and is non-empty:",
        `  1. Call write_plan(project="${projectName}", task="${taskName}", content=<file-content>) to ensure it is persisted.`,
        "  2. Call percussionist_dispatcher_complete_plan with a brief summary of the existing plan.",
        "  3. Do NOT re-explore or re-plan — the work is already done.",
        "- Only proceed with planning if the file does not exist or is empty.",
        "",
      );
    }
    promptLines.push(
      "PLAN ARTIFACT REQUIREMENTS:",
      `- Create or update ${planPath} in the repository.`,
      "- The file is the authoritative PLAN output and will be reviewed by facilitator/human reviewers.",
      "- Include implementation context, scope boundaries, risks, acceptance criteria, and proposed BUILD task breakdown.",
      "- Commit the plan artifact on this task branch before completing the run.",
      `- After committing, call write_plan(project="${projectName}", task="${taskName}", content=<plan-content>) to persist it to ConfigMap.`,
      `- Mention ${planPath} in the completion summary.`,
      `- When done, call percussionist_dispatcher_complete_plan instead of complete_run.`,
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

  // Inject relevant memory context if vector memory is enabled.
  if (project.spec.embedding?.enabled) {
    try {
      const query = task.spec.description ?? task.spec.title ?? taskName;
      const { context } = await getContext(projectName, query);
      if (context && context !== "No relevant context found.") {
        promptLines.push(
          "RELEVANT PROJECT CONTEXT:",
          context,
          "",
        );
      }
    } catch {
      // Memory service unavailable — skip silently.
    }
  }

  // Inject available system tools if declared.
  if (resolved.packages && resolved.packages.length > 0) {
    promptLines.push(
      "AVAILABLE SYSTEM TOOLS:",
      "The following packages are installed in this run environment:",
      resolved.packages.map((p) => `  - ${p}`).join("\n"),
      "",
      "The opencode-native tools grep, glob, read, list, edit, and bash are always available.",
      "Use `which <tool>` to check if a specific tool is available at runtime.",
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
        [LABELS.taskId]: truncateK8sName(taskName, 63),
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
      ttlSecondsAfterFinished: 7 * 86400,
      ...(resolved.resources ? { resources: resolved.resources } : {}),
      ...(resolved.secrets ? { secrets: resolved.secrets } : {}),
      ...(resolved.source ? { source: resolved.source } : {}),
      ...(resolved.sidecars?.length ? { sidecars: resolved.sidecars } : {}),
      ...(resolved.initScript ? { initScript: resolved.initScript } : {}),
      ...(resolved.injectFiles?.length ? { injectFiles: resolved.injectFiles } : {}),
      ...(resolved.data ? { data: resolved.data } : {}),
      ...(resolved.gitCache ? { gitCache: resolved.gitCache } : {}),
    } as RunSpec,
  };
}

const TTL_SECONDS = 7 * 86400;

export async function buildMergeRun(
  project: Project,
  task: Task,
  runName: string,
  allTasks?: Task[],
  mergeAgentName?: string,
): Promise<Run> {
  const clusterSettings = await getClusterSettings().catch(() => undefined);
  const resolved = resolveRunConfig(project.spec, undefined, undefined, {
    runner: {
      image: clusterSettings?.spec?.runner?.image,
      resources: clusterSettings?.spec?.runner?.resources,
    },
  });

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
  const mergeAgent =
    mergeAgentName && (project.spec.agents ?? []).some((a) => a.name === mergeAgentName)
      ? mergeAgentName
      : task.spec.agent;

  // Agent-level model override (between board and project in resolution hierarchy).
  try {
    const agent = await getClusterAgent(mergeAgent);
    if (agent.spec.model) {
      resolved.model = agent.spec.model;
    }
  } catch {
    // Agent CR not found or inaccessible — fall back to project/cluster defaults.
  }

  // Set git.ref so the init container checks out the source branch as a worktree.
  if (resolved.source?.git) {
    resolved.source.git.ref = sourceBranch;
    resolved.source.git.parentRef = targetBranch;
  }

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
    "- If the merge is a fast-forward (source contains target), use:",
    `    git push origin ${sourceBranch}:refs/heads/${targetBranch}`,
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
        [LABELS.taskId]: truncateK8sName(taskName, 63),
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
      ttlSecondsAfterFinished: TTL_SECONDS,
      ...(resolved.resources ? { resources: resolved.resources } : {}),
      ...(resolved.secrets ? { secrets: resolved.secrets } : {}),
      ...(resolved.source ? { source: resolved.source } : {}),
      ...(resolved.sidecars?.length ? { sidecars: resolved.sidecars } : {}),
      ...(resolved.initScript ? { initScript: resolved.initScript } : {}),
      ...(resolved.injectFiles?.length ? { injectFiles: resolved.injectFiles } : {}),
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
  // Strip project name prefix from the task name to avoid duplication
  // (e.g. "myproject-build-123" → "build-123" since project is already in the run name).
  const projKey = projectName.toLowerCase().replace(/[^a-z0-9]/g, "-");
  const stripped = sanitized.startsWith(`${projKey}-`) ? sanitized.slice(projKey.length + 1) : sanitized;
  const reserved = projectName.length + 1 + kind.length + 1 + 1 + randomSuffix.length;
  const maxMid = 63 - reserved;
  const mid = maxMid > 0 ? stripped.slice(0, maxMid).replace(/-+$/, "") : stripped.slice(0, 1);
  return truncateK8sName(`${projectName}-${kind}-${mid}-${randomSuffix}`);
}
