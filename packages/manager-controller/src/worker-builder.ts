// worker-builder.ts — builds Run specs for Task CRs.

import { createHash } from 'node:crypto';
import {
  API_GROUP_VERSION,
  KIND_RUN,
  LABELS,
  MANAGED_BY,
  type Project,
  type Run,
  type RunSpec,
  resolveRunConfig,
  type Task,
} from '@percussionist/api';
import { getClusterAgent, getClusterSettings } from '@percussionist/kube';
import { getContext } from './agent/memory-client.js';
import { resolveMergeBranch, resolveParentBranch, resolveTaskBranch } from './branch-resolver.js';
import { getErrorStatusCode, isKubeNotFoundError } from './kube-errors.js';

const MAX_RETRIES = 3;

export { MAX_RETRIES };

async function getOptionalClusterSettings(context: string) {
  try {
    return await getClusterSettings();
  } catch (e) {
    if (isKubeNotFoundError(e)) return undefined;
    console.error(
      `[worker-builder] getClusterSettings failed (${context}) status=${getErrorStatusCode(e) ?? 'unknown'}`,
      e,
    );
    throw e;
  }
}

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
  allTasks?: Task[],
): Promise<Run> {
  const clusterSettings = await getOptionalClusterSettings('buildWorkerRun');
  const resolved = resolveRunConfig(project.spec, undefined, undefined, {
    runner: {
      image: clusterSettings?.spec?.runner?.image,
      resources: clusterSettings?.spec?.runner?.resources,
    },
  });

  // ClusterAgent model override (overrides project default, not per-agent).
  // Resolution order (highest → lowest):
  //   explicit run override (MCP tool) → per-agent model → ClusterAgent model → project.spec.model
  try {
    const agent = await getClusterAgent(task.spec.agent);
    if (agent.spec.model) {
      resolved.model = agent.spec.model;
    }
  } catch {
    // Agent CR not found or inaccessible — fall back to project/cluster defaults.
  }

  // Per-agent model override: if the task's agent has a `model` field set in
  // the project roster, use it instead of the ClusterAgent or project-level default.
  const agentOverride = (project.spec.agents ?? []).find((a) => a.name === task.spec.agent);
  if (agentOverride?.model) {
    resolved.model = agentOverride.model;
  }

  const taskName = task.metadata.name;
  const promptLines = [
    `TASK: ${taskName} — ${task.spec.title}`,
    '',
    'DESCRIPTION:',
    task.spec.description ?? 'No description provided.',
    '',
  ];

  if (retryCount > 0) {
    promptLines.push(
      `RETRY ${retryCount}/${MAX_RETRIES}:`,
      reworkFeedback ?? 'Previous attempt failed. Review the error and try a different approach.',
      '',
    );
  } else if (reworkFeedback) {
    promptLines.push('HUMAN FEEDBACK (rework):', reworkFeedback, '');
  }

  const projectName = project.metadata.name;
  const planPath = `.percussionist/plans/${taskName}.md`;

  if (task.spec.type === 'PLAN') {
    // If this is a retry/rework, the agent should redo the plan. Otherwise,
    // instruct it to check for an existing plan first and short-circuit if found.
    const isRework = reworkFeedback != null || retryCount > 0;
    if (!isRework) {
      promptLines.push(
        'IDEMPOTENCY CHECK (do this first, before any exploration):',
        `- Run: \`cat ${planPath}\``,
        '- If the file exists and is non-empty:',
        `  1. Call percussionist_dispatcher_write_plan(project="${projectName}", task="${taskName}", content=<file-content>) to ensure it is persisted.`,
        '  2. Call percussionist_dispatcher_complete_plan with a brief summary of the existing plan.',
        '  3. Do NOT re-explore or re-plan — the work is already done.',
        '- Only proceed with planning if the file does not exist or is empty.',
        '',
      );
    }
    promptLines.push(
      'PLAN ARTIFACT REQUIREMENTS:',
      `- Create or update ${planPath} in the repository.`,
      '- The file is the authoritative PLAN output and will be reviewed by facilitator/human reviewers.',
      '- Include implementation context, scope boundaries, risks, acceptance criteria, and proposed BUILD task breakdown.',
      '- Commit the plan artifact on this task branch before completing the run.',
      `- After committing, call percussionist_dispatcher_write_plan(project="${projectName}", task="${taskName}", content=<plan-content>) to persist it to ConfigMap.`,
      `- Mention ${planPath} in the completion summary.`,
      `- When done, call percussionist_dispatcher_complete_plan instead of complete_run.`,
      '',
    );
  } else if (task.spec.type === 'BUILD' && task.spec.parentTaskRef) {
    const planPathForParent = `.percussionist/plans/${task.spec.parentTaskRef}.md`;
    promptLines.push(
      'PLAN CONTEXT:',
      `- Read ${planPathForParent} before implementing.`,
      '- Treat that PLAN artifact as the full feature context, even if this BUILD task covers only one slice.',
      "- Keep your changes aligned with the plan's acceptance criteria and sequencing notes.",
      '',
    );
  }

  // Inject relevant memory context if vector memory is enabled.
  if (project.spec.embedding?.enabled) {
    try {
      const query = task.spec.description ?? task.spec.title ?? taskName;
      const { context } = await getContext(projectName, query, taskName);
      if (context && context !== 'No relevant context found.') {
        promptLines.push('RELEVANT PROJECT CONTEXT:', context, '');
      }
    } catch {
      // Memory service unavailable — skip silently.
    }
  }

  // Inject available system tools if declared.
  if (resolved.packages && resolved.packages.length > 0) {
    promptLines.push(
      'AVAILABLE SYSTEM TOOLS:',
      'The following packages are installed in this run environment:',
      resolved.packages.map((p) => `  - ${p}`).join('\n'),
      '',
      'The opencode-native tools grep, glob, read, list, edit, bash, and todowrite are always available.',
      'Note: the task tracking tool is called `todowrite`, not `todo`.',
      'Use `which <tool>` to check if a specific tool is available at runtime.',
      '',
    );
  }

  // Off-task finding reporting prompt — only for BUILD and PLAN runs, not merge.
  if (task.spec.type !== 'BUILD' || !task.spec.description?.toLowerCase().includes('merge')) {
    promptLines.push(
      'OFF-TASK FINDINGS:',
      '- Your job is the TASK above. Stay on it.',
      '- If, while working, you notice a SEPARATE problem unrelated to your task — a security hole,',
      '  a real bug, a performance trap, or notable tech debt — report it ONCE with the',
      '  `percussionist_dispatcher_report_finding` tool, then continue your task. Do not investigate it further.',
      '- Provide: a one-line title, a short description (what is wrong + why it matters +',
      '  suggested fix), severity (low/medium/high/critical), category',
      '  (bug/security/performance/debt/docs/other), and filePath/snippet when you have them.',
      '- Do NOT report: style nits, things already covered by your task, speculative',
      '  "could be better" ideas, or anything you are not fairly confident about.',
      '- One finding per distinct issue. The manager de-duplicates, so do not worry about',
      '  repeats — but do not spam.',
      '',
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
          kind: 'Project',
          name: projectName,
          uid: project.metadata.uid ?? '',
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
    spec: {
      project: projectName,
      boardTask: taskName,
      task: promptLines.join('\n'),
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
  const clusterSettings = await getOptionalClusterSettings('buildMergeRun');
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
      throw new Error(
        `Task ${taskName} has no git branch (feature branching enabled but branch not resolved)`,
      );
    }

    if (!mergeBranch) {
      throw new Error(
        `Task ${taskName} has no merge target (feature branching enabled but merge branch not resolved)`,
      );
    }
    sourceBranch = gitBranch;
    targetBranch = mergeBranch;
  } else {
    // Legacy: use feat/{taskName} branch
    sourceBranch = `feat/${taskName}`;
    targetBranch = 'main';
  }

  // Determine merge agent: prefer explicit name, then env var, then task agent.
  const MERGING_AGENT = process.env.MERGING_AGENT;
  const mergeAgent =
    mergeAgentName && (project.spec.agents ?? []).some((a) => a.name === mergeAgentName)
      ? mergeAgentName
      : MERGING_AGENT && (project.spec.agents ?? []).some((a) => a.name === MERGING_AGENT)
        ? MERGING_AGENT
        : task.spec.agent;

  // ClusterAgent model override (overrides project default, not per-agent).
  try {
    const agent = await getClusterAgent(mergeAgent);
    if (agent.spec.model) {
      resolved.model = agent.spec.model;
    }
  } catch {
    // Agent CR not found or inaccessible — fall back to project/cluster defaults.
  }

  // Per-agent model override (project roster takes priority over ClusterAgent).
  const mergeAgentOverride = (project.spec.agents ?? []).find((a) => a.name === mergeAgent);
  if (mergeAgentOverride?.model) {
    resolved.model = mergeAgentOverride.model;
  }

  // Set git.ref so the init container checks out the source branch as a worktree.
  if (resolved.source?.git) {
    resolved.source.git.ref = sourceBranch;
    resolved.source.git.parentRef = targetBranch;
  }
  const promptLines = [
    `TASK: Merge approved changes for ${taskName}`,
    '',
    `Task title: ${task.spec.title}`,
    `Source branch: ${sourceBranch}`,
    `Target branch: ${targetBranch}`,
    '',
    '## Pre-flight Check',
    '',
    'Ensure the worktree is at the latest remote source branch state:',
    `    git fetch origin ${sourceBranch}`,
    '    CURRENT=$(git rev-parse HEAD)',
    `    LATEST=$(git rev-parse origin/${sourceBranch})`,
    '    if [ "$CURRENT" != "$LATEST" ]; then',
    `      echo "WARNING: HEAD stale, resetting to origin/${sourceBranch}"`,
    '      git reset --hard "origin/${sourceBranch}"',
    '    fi',
    '',
    '## Merge Steps',
    '',
    '1. Fetch both branches:',
    `    git fetch origin ${targetBranch}`,
    `    git fetch origin ${sourceBranch}`,
    '',
    '2. Check if fast-forward (source contains target):',
    `    if git merge-base --is-ancestor origin/${targetBranch} origin/${sourceBranch}; then`,
    `      echo "Fast-forward: pushing ${sourceBranch} -> ${targetBranch}"`,
    `      git push origin ${sourceBranch}:refs/heads/${targetBranch}`,
    '    else',
    `      echo "Non-fast-forward: merging ${targetBranch} into ${sourceBranch}"`,
    `      git merge origin/${targetBranch} --no-edit`,
    `      git push origin HEAD:refs/heads/${targetBranch}`,
    '    fi',
    '',
    '3. Verify the push landed:',
    `    git fetch origin ${targetBranch}`,
    `    if ! git merge-base --is-ancestor origin/${sourceBranch} origin/${targetBranch}; then`,
    '      echo "ERROR: push verification failed — target does not contain source"',
    '      exit 1',
    '    fi',
    `    echo "Verified: ${sourceBranch} is now in ${targetBranch}"`,
    '',
    '- Do not perform any code changes.',
    '- If the branches are already fully merged, the push will be a no-op — do not re-create runs or PRs.',
    '',
    '## Completion',
    '',
    'When done, call `percussionist_dispatcher_complete_merge` with a structured merge outcome.',
    'Use this outcome mapping exactly:',
    '- Success and push verified: outcome=`merged` and include `mergeCommitSha`.',
    '- Branches already aligned / no-op push: outcome=`already-merged`.',
    '- Merge conflict that needs human intervention: outcome=`conflict`, requiresHuman=true.',
    '- Push rejected (auth/protection/remote rejection): outcome=`push-failed`.',
    '- Transient infra/network/git-host error: outcome=`transient-failure`.',
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
          kind: 'Project',
          name: projectName,
          uid: project.metadata.uid ?? '',
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
    spec: {
      project: projectName,
      boardTask: taskName,
      task: promptLines.join('\n'),
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
  return name.slice(0, max).replace(/-+$/, '');
}

/**
 * workerRunName computes a deterministic run name for worker runs.
 *
 * The name is keyed by project, task, retryCount (human rework), and aiReworkCount
 * (AI auto-rework). Both counters must be included to ensure each attempt gets a
 * unique name — human rework increments retryCount and resets aiReworkCount,
 * while AI rework increments only aiReworkCount.
 */
export function workerRunName(
  projectName: string,
  taskName: string,
  retryCount: number = 0,
  aiReworkCount: number = 0,
): string {
  const sanitized = taskName.toLowerCase().replace(/[^a-z0-9]/g, '-');
  // Deterministic suffix — same inputs always produce the same run name,
  // preventing duplicate runs across reconcile cycles.
  const suffix = createHash('sha256')
    .update(`${projectName}:${taskName}:${retryCount}:${aiReworkCount}`)
    .digest('hex')
    .slice(0, 10);
  // suffix + 2 separating hyphens = 12 chars reserved; project prefix = projectName.length + 1
  const reserved = projectName.length + 1 + 1 + suffix.length; // "{project}-{mid}-{suffix}"
  const maxMid = 63 - reserved;
  const mid = maxMid > 0 ? sanitized.slice(0, maxMid).replace(/-+$/, '') : sanitized.slice(0, 1);
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
  const sanitized = taskName.toLowerCase().replace(/[^a-z0-9]/g, '-');
  // Strip project name prefix from the task name to avoid duplication
  // (e.g. "myproject-build-123" → "build-123" since project is already in the run name).
  const projKey = projectName.toLowerCase().replace(/[^a-z0-9]/g, '-');
  const stripped = sanitized.startsWith(`${projKey}-`)
    ? sanitized.slice(projKey.length + 1)
    : sanitized;
  const reserved = projectName.length + 1 + kind.length + 1 + 1 + randomSuffix.length;
  const maxMid = 63 - reserved;
  const mid = maxMid > 0 ? stripped.slice(0, maxMid).replace(/-+$/, '') : stripped.slice(0, 1);
  return truncateK8sName(`${projectName}-${kind}-${mid}-${randomSuffix}`);
}
