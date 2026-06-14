// facilitator.ts — builds and parses facilitator agent runs.
//
// When a worker task fails, the manager spawns a facilitator run that analyzes
// the failure and recommends an escalation action. When a worker task succeeds,
// the manager spawns a success-review facilitator that approves the result or
// redirects it to another agent.

import {
  API_GROUP_VERSION,
  type FacilitationSpec,
  KIND_RUN,
  LABELS,
  MANAGED_BY,
  type Project,
  type Run,
  type RunStatus,
  resolveRunConfig,
  type Task,
} from '@percussionist/api';
import {
  core,
  fetchSessionMessages,
  getClusterAgent,
  getClusterSettings,
  readPlanFromConfigMap,
  readPodLog,
} from '@percussionist/kube';
import { resolveParentBranch, resolveTaskBranch } from './branch-resolver.js';
import { truncateK8sName } from './worker-builder.js';

const FACILITATION_TIMEOUT_SECONDS = 4 * 60 * 60; // 4 hours

const NAMESPACE = process.env.PERCUSSIONIST_NAMESPACE ?? 'percussionist';

// Resolve summary source precedence and log the selection.
// Precedence: explicit arg → stored ConfigMap summary → none.
export function resolveSummarySource(
  sessionSummary: string,
  storedSummary: string | undefined,
): { source: 'arg' | 'configmap' | 'none'; summary: string } {
  if (sessionSummary) {
    console.log(
      `[facilitator] buildBuildTaskGeneratorRun: using explicit session summary (${sessionSummary.length} chars)`,
    );
    return { source: 'arg', summary: sessionSummary };
  }
  if (storedSummary) {
    console.log(
      `[facilitator] buildBuildTaskGeneratorRun: using stored ConfigMap summary (${storedSummary.length} chars)`,
    );
    return { source: 'configmap', summary: storedSummary };
  }
  console.log('[facilitator] buildBuildTaskGeneratorRun: no session summary available');
  return { source: 'none', summary: '' };
}

// Read a stored session summary from the run's session ConfigMap, if one exists.
// Scans for any `summary-*` key since we may not know the sessionID at call time.
async function readStoredSessionSummary(runName: string): Promise<string | undefined> {
  try {
    const cm = await core().readNamespacedConfigMap({
      name: `${runName}-session`,
      namespace: NAMESPACE,
    });
    const data = cm.data ?? {};
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith('summary-') && typeof value === 'string' && value.length > 0) {
        return value;
      }
    }
  } catch {
    // ConfigMap not found — summary not available yet.
  }
  return undefined;
}

// Build the facilitator Run spec for a FAILED worker run.
export async function buildFacilitationRun(
  project: Project,
  task: Task,
  failedRunName: string,
  failedRunStatus: RunStatus,
  sessionSummary: string,
  runName: string,
  facilitatorAgentName: string,
  allTasks: Task[] = [],
): Promise<Run> {
  const clusterSettings = await getClusterSettings().catch(() => undefined);
  const resolved = resolveRunConfig(project.spec, undefined, undefined, {
    runner: {
      image: clusterSettings?.spec?.runner?.image,
      resources: clusterSettings?.spec?.runner?.resources,
    },
  });

  const facilitationSpec: FacilitationSpec = {
    targetRunName: failedRunName,
    targetTaskId: task.metadata.name,
    failureReason: failedRunStatus.message ?? 'Unknown failure',
    sessionSummary,
    successReview: false,
  };

  const alternativeAgents = (project.spec.agents ?? [])
    .map((a) => a.name)
    .filter((n) => n !== facilitatorAgentName);

  const promptLines = [
    `You are a facilitator agent that analyzes failed worker runs and recommends actions.`,
    '',
    `TASK: ${task.metadata.name} — ${task.spec.title}`,
    `WORKER RUN: ${failedRunName}`,
    `FAILURE: ${facilitationSpec.failureReason}`,
    '',
    `RECENT SESSION MESSAGES:`,
    sessionSummary || '(none available)',
    '',
    ...(alternativeAgents.length > 0
      ? [
          `AVAILABLE ALTERNATIVE AGENTS: ${alternativeAgents.join(', ')}`,
          `NOTE: If the failure is due to the specific worker agent refusing or being incapable, `,
          `recommend retry_alternative with one of the available alternative agents.`,
          `Only recommend skip if the task itself is inherently impossible or harmful.`,
          '',
        ]
      : []),
    project.spec.runner?.packages?.length
      ? `RUNNER PACKAGES: ${project.spec.runner.packages.join(', ')}`
      : 'RUNNER PACKAGES: (base image only)',
    '',
    `Analyze the failure above and output ONLY valid JSON (no markdown, no explanation):`,
    JSON.stringify({
      diagnosis: '(root cause in 1-2 sentences)',
      recommendedAction: '(retry_same | retry_alternative | skip)',
      alternativeAgent:
        '(required if recommendedAction is retry_alternative — must be one of the AVAILABLE ALTERNATIVE AGENTS listed above)',
      suggestion: '(optional — fix suggestion for next attempt)',
    }),
  ].join('\n');

  return await buildFacilitatorRun(
    project,
    task,
    runName,
    facilitationSpec,
    promptLines,
    resolved,
    facilitatorAgentName,
    allTasks,
  );
}

// Build the facilitator Run spec for a SUCCEEDED worker run (success review).
export async function buildSuccessReviewRun(
  project: Project,
  task: Task,
  succeededRunName: string,
  succeededRunStatus: RunStatus,
  sessionSummary: string,
  runName: string,
  facilitatorAgentName: string,
  branchName?: string,
  allTasks: Task[] = [],
): Promise<Run> {
  const clusterSettings = await getClusterSettings().catch(() => undefined);
  const resolved = resolveRunConfig(project.spec, undefined, undefined, {
    runner: {
      image: clusterSettings?.spec?.runner?.image,
      resources: clusterSettings?.spec?.runner?.resources,
    },
  });

  const completionMessage = succeededRunStatus.message ?? 'session completed';

  const facilitationSpec: FacilitationSpec = {
    targetRunName: succeededRunName,
    targetTaskId: task.metadata.name,
    failureReason: completionMessage, // reusing field for completion message
    sessionSummary,
    successReview: true,
  };

  const alternativeAgents = (project.spec.agents ?? [])
    .map((a) => a.name)
    .filter((n) => n !== facilitatorAgentName);

  const branch = branchName ?? `feat/${task.metadata.name}`;

  const taskTypeLabel = task.spec.type ? `TASK TYPE: ${task.spec.type}` : '';
  const isBuildTask = task.spec.type === 'BUILD';
  const isPlanTask = task.spec.type === 'PLAN';
  const planPath = `.percussionist/plans/${task.metadata.name}.md`;

  const promptLines = [
    `You are a reviewer agent that checks whether a completed worker run actually fulfilled its task.`,
    ...(taskTypeLabel ? [taskTypeLabel] : []),
    '',
    `TASK: ${task.metadata.name} — ${task.spec.title}`,
    `TASK DESCRIPTION: ${task.spec.description ?? '(none)'}`,
    `WORKER RUN: ${succeededRunName}`,
    `BRANCH: ${branch}`,
    `COMPLETION MESSAGE: ${completionMessage}`,
    '',
    ...(isBuildTask
      ? [
          `This is a BUILD task. The worker should have committed the completed work before calling complete_run.`,
          `The COMPLETION MESSAGE above contains the worker's summary of what was accomplished.`,
          `Review the session data to verify the task was completed satisfactorily.`,
          `If the completion message and session data indicate the task was completed, approve it.`,
          `If the work is incomplete or incorrect, use request_changes.`,
          '',
        ]
      : isPlanTask
        ? [
            `This is a PLAN task. Do not review code implementation quality.`,
            `Review the plan artifact at ${planPath}.`,
            `Approve only if the plan file exists and contains enough context to generate BUILD tasks: scope, assumptions, risks, acceptance criteria, and a concrete implementation breakdown.`,
            `Use request_changes if the plan artifact is missing, vague, or lacks enough context for builders.`,
            `Use escalate only for cases that require human judgment beyond improving the plan artifact.`,
            '',
          ]
        : [
            `The COMPLETION MESSAGE above summarizes what the worker accomplished.`,
            `Check the completion message and session data to verify the task was completed.`,
            '',
          ]),
    `RECENT SESSION MESSAGES:`,
    sessionSummary || '(none available)',
    '',
    ...(isPlanTask
      ? [
          `PLAN ARTIFACT PATH: ${planPath}`,
          `Call the percussionist_dispatcher_read_plan MCP tool (percussionist_dispatcher_read_plan(project="<project>", task="<task-id>")) to retrieve plan content.`,
          '',
        ]
      : []),
    '',
    ...(alternativeAgents.length > 0
      ? [`AVAILABLE ALTERNATIVE AGENTS: ${alternativeAgents.join(', ')}`, '']
      : []),
    project.spec.runner?.packages?.length
      ? `RUNNER PACKAGES: ${project.spec.runner.packages.join(', ')}`
      : 'RUNNER PACKAGES: (base image only)',
    '',
    `Call the percussionist_dispatcher_complete_review MCP tool to submit your review verdict.`,
    `Use approved: true to approve, or approved: false to request changes.`,
    '',
    'Payload schema:',
    JSON.stringify({
      approved: true,
      diagnosis: '(1-2 sentences: did the worker actually complete the task?)',
      feedback: '(optional — detailed feedback, retry_alternative: <agent>, or escalate reason)',
      suggestion: '(optional — what to improve)',
      findings: [
        {
          id: 'f1',
          severity: 'high',
          score: 85,
          title: '(max 160 chars) concise finding title',
          comment: '(max 2000 chars) detailed explanation and fix guidance',
          category: '(optional, max 64 chars) e.g. correctness',
          anchors: [
            {
              path: 'src/index.ts',
              side: 'new',
              line: 42,
              endLine: 44,
              hunkHeader: '(optional, max 256 chars)',
            },
          ],
          context: {
            baseSha: '(git rev-parse base ref)',
            headSha: '(git rev-parse head ref)',
            forkSha: '(git merge-base base head)',
            diffFingerprint: '(deterministic hash of the diff)',
          },
          createdAt: '(ISO timestamp)',
          authorRunName: '(optional)',
        },
      ],
    }),
    '',
    'Findings caps (enforced automatically; overflow is dropped):',
    '- findings array: max 25 items',
    '- anchors per finding: 1-3',
    '- title: max 160 chars',
    '- comment: max 2000 chars',
    '- category: max 64 chars',
    '- hunkHeader: max 256 chars',
    '- severity: critical | high | medium | low | info',
    '- score: optional number 0-100',
    '',
    'Fill context.baseSha/headSha/forkSha/diffFingerprint from the current git state (use git rev-parse and git merge-base).',
    'If you cannot provide accurate diff context, omit the findings field entirely rather than guessing.',
    '',
    `Use approved: false if implementation changes are needed before human approval.`,
    `If a different agent should redo the task, include "retry_alternative: <agent>" in the feedback field.`,
    `If human review is needed, include "escalate" in the diagnosis or feedback.`,
  ].join('\n');

  return await buildFacilitatorRun(
    project,
    task,
    runName,
    facilitationSpec,
    promptLines,
    resolved,
    facilitatorAgentName,
    allTasks,
  );
}

// Build the facilitator Run spec for generating BUILD tasks from an approved PLAN task.
export async function buildBuildTaskGeneratorRun(
  project: Project,
  planTask: Task,
  succeededRunName: string,
  runName: string,
  sessionSummary: string,
  facilitatorAgentName: string,
  allTasks: Task[] = [],
  defaultBuildAgent: string = 'builder',
): Promise<Run> {
  const clusterSettings = await getClusterSettings().catch(() => undefined);
  const resolved = resolveRunConfig(project.spec, undefined, undefined, {
    runner: {
      image: clusterSettings?.spec?.runner?.image,
      resources: clusterSettings?.spec?.runner?.resources,
    },
  });

  // Prefer explicitly passed summary, then fall back to stored ConfigMap summary.
  const { summary: actualSummary } = resolveSummarySource(
    sessionSummary,
    await readStoredSessionSummary(succeededRunName),
  );

  // Read the full plan artifact from ConfigMap so the buildgen agent can work
  // from the actual plan content without needing workspace file access.
  const planContent = await readPlanFromConfigMap(
    project.metadata.name,
    planTask.metadata.name,
  ).catch(() => null);

  const facilitationSpec: FacilitationSpec = {
    targetRunName: succeededRunName,
    targetTaskId: planTask.metadata.name,
    failureReason: 'BUILD task generation from approved PLAN',
    sessionSummary: actualSummary,
    successReview: false,
  };

  const availableAgents = (project.spec.agents ?? [])
    .map((a) => a.name)
    .filter((n) => n !== facilitatorAgentName);

  const promptLines = [
    `You are a facilitator agent that breaks down approved PLAN tasks into concrete BUILD tasks.`,
    `You do NOT implement code. You do NOT write, edit, or modify any files. You do NOT run git commands. You do NOT create pull requests. You do NOT explore the codebase.`,
    '',
    `PLAN TASK: ${planTask.metadata.name} — ${planTask.spec.title}`,
    `PLAN DESCRIPTION: ${planTask.spec.description ?? '(none)'}`,
    `PLAN WORKER RUN: ${succeededRunName}`,
    '',
    `PLAN SESSION CONTEXT:`,
    actualSummary || '(none available — use the task description above)',
    '',
    ...(planContent ? ['', `PLAN ARTIFACT CONTENT:`, planContent, ''] : []),
    `PLAN ARTIFACT PATH: .percussionist/plans/${planTask.metadata.name}.md`,
    '',
    `The PLAN task has been approved by a human reviewer. Your job is to call the`,
    `percussionist_dispatcher_create_task tool for each BUILD task that implements the plan. Work ONLY from`,
    `the task description and plan session context provided above. Do NOT read any`,
    `workspace files. Do NOT explore the codebase. Do NOT run shell commands.`,
    `Do NOT write or edit any files.`,
    '',
    ...(availableAgents.length > 0
      ? [
          `AVAILABLE AGENTS: ${availableAgents.join(', ')}`,
          `For each BUILD task, specify the agent via the percussionist_dispatcher_create_task "agent" parameter.`,
          `If not specified, the "${defaultBuildAgent}" agent will be used.`,
          '',
        ]
      : []),
    project.spec.runner?.packages?.length
      ? `RUNNER PACKAGES: ${project.spec.runner.packages.join(', ')}`
      : 'RUNNER PACKAGES: (none declared beyond base image)',
    '',
    `AVAILABLE TOOLS:`,
    `- percussionist_dispatcher_create_task(title, description?, agent, priority?, predecessorRef?) — creates a BUILD Task CR and returns { taskName, project, type, phase }`,
    `- percussionist_dispatcher_complete_run — call after all BUILD tasks are created to signal completion`,
    '',
    `If the context above is insufficient to derive concrete BUILD tasks, call percussionist_dispatcher_complete_run`,
    `with summary "no build tasks required" so the PLAN escalates for manual BUILD task creation.`,
    '',
    `WORKFLOW:`,
    `1. Decide your BUILD tasks and their order.`,
    `2. Call percussionist_dispatcher_create_task for each task IN ORDER:`,
    `   - title (required): short actionable title`,
    `   - description: detailed implementation context including the relevant PLAN slice`,
    `   - agent (required): agent name from AVAILABLE AGENTS list`,
    `   - priority: "high", "medium", or "low" (default: "medium")`,
    `   - predecessorRef: the taskName returned by a previous percussionist_dispatcher_create_task call if this task depends on it`,
    `3. Each percussionist_dispatcher_create_task returns { taskName, ... }. Use the returned taskName as predecessorRef for dependent tasks.`,
    `4. After ALL tasks are created, call percussionist_dispatcher_complete_run with a summary of what was created.`,
    '',
    `REQUIREMENTS:`,
    `- PLAN ARTIFACT CONTENT (if provided above) is the source of truth for task decomposition and ordering; session summaries may be stale or incomplete`,
    `- If the plan artifact defines an ordered/phased BUILD breakdown (for example BUILD A/B/C/D), preserve that order when creating tasks`,
    `- For ordered/phased BUILD work, set predecessorRef to enforce the sequence (each dependent task points to the prior taskName returned by create_task)`,
    `- Each BUILD task should be concrete and actionable — one logical concern per task (roughly 1-4 hours of work)`,
    `- Split large PLAN items into multiple smaller BUILD tasks`,
    `- Include enough full-plan context in each task description that the build agent understands the larger feature`,
    `- Do not create standalone audit/research tasks that only document findings unless a later task explicitly consumes a named repo artifact produced by that task`,
    `- Prefer combining discovery with the implementation task that uses the discoveries`,
    `- If a discovery task is genuinely necessary, require it to write a specific repo file such as .percussionist/findings/{task-id}.md and require every dependent task to read that exact file`,
    `- Tasks that are independent MUST NOT be chained via predecessorRef — they run in parallel`,
    `- Mark tasks as independent only when they are genuinely disjoint (different files/modules with low merge-conflict risk); when uncertain, prefer sequencing with predecessorRef`,
    `- Only set predecessorRef when one task genuinely cannot start until another is done (imports code it creates, migrates schema it defines, etc.)`,
    `- If the PLAN requires no BUILD tasks (was purely research/planning), call percussionist_dispatcher_complete_run with summary "no build tasks required"`,
    '',
    `CRITICAL — DO NOT:`,
    `- Do NOT write or edit any files. You have NO file write access.`,
    `- Do NOT run any shell commands. You have NO shell access.`,
    `- Do NOT read any workspace files. You have NO file read access.`,
    `- Do NOT run git commands, commit, push, or create pull requests.`,
    `- Do NOT explore the codebase. Do NOT browse directories.`,
    `- Do NOT output JSON or prose — just call the tools.`,
  ].join('\n');

  return await buildFacilitatorRun(
    project,
    planTask,
    runName,
    facilitationSpec,
    promptLines,
    resolved,
    facilitatorAgentName,
    allTasks,
  );
}

// Build a review Run spec without session summary.
// The reviewer agent uses MCP tools (percussionist_dispatcher_read_session) to fetch session data itself.
export async function buildReviewRun(
  project: Project,
  task: Task,
  succeededRunName: string,
  succeededRunStatus: RunStatus,
  runName: string,
  branchName: string | undefined,
  facilitatorAgentName: string,
  allTasks: Task[] = [],
): Promise<Run> {
  const resolved = resolveRunConfig(project.spec, undefined, undefined, {
    runner: {
      image: undefined,
      resources: undefined,
    },
  });

  const completionMessage = succeededRunStatus.message ?? 'session completed';
  const branch = branchName ?? `feat/${task.metadata.name}`;
  const taskTypeLabel = task.spec.type ? `TASK TYPE: ${task.spec.type}` : '';
  const isBuildTask = task.spec.type === 'BUILD';
  const isPlanTask = task.spec.type === 'PLAN';
  const planPath = `.percussionist/plans/${task.metadata.name}.md`;

  const alternativeAgents = (project.spec.agents ?? [])
    .map((a) => a.name)
    .filter((n) => n !== facilitatorAgentName);

  const promptLines = [
    `You are a reviewer agent that checks whether a completed worker run actually fulfilled its task.`,
    ...(taskTypeLabel ? [taskTypeLabel] : []),
    '',
    `TASK: ${task.metadata.name} — ${task.spec.title}`,
    `TASK DESCRIPTION: ${task.spec.description ?? '(none)'}`,
    `WORKER RUN: ${succeededRunName}`,
    `BRANCH: ${branch}`,
    `COMPLETION MESSAGE: ${completionMessage}`,
    '',
    `SESSION DATA: Use the percussionist_dispatcher_read_session MCP tool (runName="${succeededRunName}") to read the full session.`,
    `The session data is persisted as a ConfigMap snapshot.`,
    '',
    ...(isBuildTask
      ? [
          `This is a BUILD task. The worker should have committed the completed work before calling complete_run.`,
          `The COMPLETION MESSAGE above contains the worker's summary of what was accomplished.`,
          `Review the session data to verify the task was completed satisfactorily.`,
          `If the completion message and session data indicate the task was completed, approve it.`,
          `If the work is incomplete or incorrect, use request_changes.`,
          '',
          `CODE ACCESS: The worker's committed code is on the same branch this reviewer is running on. Your /workspace contains the worker's committed changes.`,
          `Use git log, git diff, read, grep, or the percussionist_dispatcher_search_code MCP tool to inspect files and review the changes.`,
          '',
        ]
      : isPlanTask
        ? [
            `This is a PLAN task. Do not review code implementation quality.`,
            `Review the plan artifact at ${planPath}.`,
            `Approve only if the plan file exists and contains enough context to generate BUILD tasks: scope, assumptions, risks, acceptance criteria, and a concrete implementation breakdown.`,
            `Use request_changes if the plan artifact is missing, vague, or lacks enough context for builders.`,
            `Use escalate only for cases that require human judgment beyond improving the plan artifact.`,
            '',
          ]
        : [
            `The COMPLETION MESSAGE above summarizes what the worker accomplished.`,
            `Check the completion message and session data to verify the task was completed.`,
            '',
          ]),
    ...(isPlanTask
      ? [
          `PLAN ARTIFACT PATH: ${planPath}`,
          `Call the percussionist_dispatcher_read_plan MCP tool (percussionist_dispatcher_read_plan(project="<project>", task="<task-id>")) to retrieve plan content.`,
          '',
        ]
      : []),
    '',
    ...(alternativeAgents.length > 0
      ? [`AVAILABLE ALTERNATIVE AGENTS: ${alternativeAgents.join(', ')}`, '']
      : []),
    `Call the percussionist_dispatcher_complete_review MCP tool to submit your review verdict.`,
    `Use approved: true to approve, or approved: false to request changes.`,
    ``,
    `Payload schema:`,
    JSON.stringify({
      approved: true,
      diagnosis: '(1-2 sentences: did the worker actually complete the task?)',
      feedback: '(optional — detailed feedback, retry_alternative: <agent>, or escalate reason)',
      suggestion: '(optional — what to improve)',
      findings: [
        {
          id: 'f1',
          severity: 'high',
          score: 85,
          title: '(max 160 chars) concise finding title',
          comment: '(max 2000 chars) detailed explanation and fix guidance',
          category: '(optional, max 64 chars) e.g. correctness',
          anchors: [
            {
              path: 'src/index.ts',
              side: 'new',
              line: 42,
              endLine: 44,
              hunkHeader: '(optional, max 256 chars)',
            },
          ],
          context: {
            baseSha: '(git rev-parse base ref)',
            headSha: '(git rev-parse head ref)',
            forkSha: '(git merge-base base head)',
            diffFingerprint: '(deterministic hash of the diff)',
          },
          createdAt: '(ISO timestamp)',
          authorRunName: '(optional)',
        },
      ],
    }),
    '',
    'Findings caps (enforced automatically; overflow is dropped):',
    '- findings array: max 25 items',
    '- anchors per finding: 1-3',
    '- title: max 160 chars',
    '- comment: max 2000 chars',
    '- category: max 64 chars',
    '- hunkHeader: max 256 chars',
    '- severity: critical | high | medium | low | info',
    '- score: optional number 0-100',
    '',
    'Fill context.baseSha/headSha/forkSha/diffFingerprint from the current git state (use git rev-parse and git merge-base).',
    'If you cannot provide accurate diff context, omit the findings field entirely rather than guessing.',
    '',
    `Use approved: false if implementation changes are needed before human approval.`,
    `If a different agent should redo the task, include "retry_alternative: <agent>" in the feedback field.`,
    `If human review is needed, include "escalate" in the diagnosis or feedback.`,
  ].join('\n');

  const facilitationSpec: FacilitationSpec = {
    targetRunName: succeededRunName,
    targetTaskId: task.metadata.name,
    failureReason: completionMessage,
    sessionSummary: '',
    successReview: true,
  };

  return await buildFacilitatorRun(
    project,
    task,
    runName,
    facilitationSpec,
    promptLines,
    resolved,
    facilitatorAgentName,
    allTasks,
  );
}

// Shared helper — constructs the Run for any facilitator invocation.
async function buildFacilitatorRun(
  project: Project,
  task: Task,
  runName: string,
  facilitationSpec: FacilitationSpec,
  promptLines: string,
  resolved: ReturnType<typeof resolveRunConfig>,
  facilitatorAgentName: string,
  allTasks: Task[] = [],
): Promise<Run> {
  // Resolve agent-level model override, same as buildWorkerRun does.
  try {
    const agent = await getClusterAgent(facilitatorAgentName);
    if (agent.spec.model) {
      resolved.model = agent.spec.model;
    }
  } catch {
    // Agent CR not found or inaccessible — fall back to project/cluster defaults.
  }
  const source = resolved.source
    ? { ...resolved.source, ...(resolved.source.git ? { git: { ...resolved.source.git } } : {}) }
    : undefined;
  const data = resolved.data
    ? { ...resolved.data, mountPath: resolved.data.mountPath ?? '/data' }
    : undefined;
  const gitCache = resolved.gitCache
    ? { worktreeReuse: resolved.gitCache.worktreeReuse ?? true }
    : undefined;
  if (source?.git) {
    let gitBranch: string | undefined;
    let parentBranch: string | undefined;
    try {
      gitBranch = resolveTaskBranch(task, project, allTasks);
      parentBranch = resolveParentBranch(task, project, allTasks);
    } catch {
      gitBranch = task.status?.worker?.gitBranch ?? source.git.ref;
      parentBranch = task.status?.worker?.parentBranch ?? source.git.parentRef;
    }
    if (gitBranch) source.git = { ...source.git, ref: gitBranch };
    if (parentBranch) source.git = { ...source.git, parentRef: parentBranch };
  }

  return {
    apiVersion: API_GROUP_VERSION,
    kind: KIND_RUN,
    metadata: {
      name: runName,
      labels: {
        [LABELS.managedBy]: MANAGED_BY,
        [LABELS.projectName]: project.metadata.name,
        [LABELS.taskId]: truncateK8sName(task.metadata.name, 63),
      },
      ownerReferences: [
        {
          apiVersion: API_GROUP_VERSION,
          kind: 'Project',
          name: project.metadata.name,
          uid: project.metadata.uid ?? '',
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
    spec: {
      project: project.metadata.name,
      boardTask: task.metadata.name,
      task: promptLines,
      interactive: false,
      agent: facilitatorAgentName,
      agents: (project.spec.agents ?? []).filter((a) => a.name !== facilitatorAgentName),
      model: resolved.model,
      image: resolved.image,
      timeoutSeconds: FACILITATION_TIMEOUT_SECONDS,
      ttlSecondsAfterFinished: 7 * 86400,
      facilitation: facilitationSpec,
      ...(resolved.resources ? { resources: resolved.resources } : {}),
      ...(resolved.secrets ? { secrets: resolved.secrets } : {}),
      ...(source ? { source } : {}),
      ...(data ? { data } : {}),
      ...(gitCache ? { gitCache } : {}),
      ...(resolved.sidecars?.length ? { sidecars: resolved.sidecars } : {}),
      ...(resolved.initScript ? { initScript: resolved.initScript } : {}),
      ...(resolved.injectFiles?.length ? { injectFiles: resolved.injectFiles } : {}),
    },
  };
}

// Parse the final messages from a facilitation run to extract the recommendation.
export async function parseFacilitationResult(
  runName: string,
  ns: string,
  serviceName?: string,
  sessionID?: string,
): Promise<{
  diagnosis: string;
  recommendedAction:
    | 'retry_same'
    | 'retry_alternative'
    | 'skip'
    | 'approve'
    | 'request_changes'
    | 'escalate';
  alternativeAgent?: string;
  suggestion?: string;
} | null> {
  // Primary: try the session ConfigMap snapshot saved by the dispatcher.
  // This works even after the pod has exited.
  try {
    const cm = await core().readNamespacedConfigMap({
      name: `${runName}-session`,
      namespace: ns,
    });
    const data = cm.data ?? {};
    for (const [key, value] of Object.entries(data)) {
      if (!key.startsWith('messages-')) continue;
      const messages: Array<{
        info: { role: string };
        parts: Array<{ type: string; text?: string }>;
      }> = JSON.parse(value);
      // Walk messages in reverse to find the last assistant text.
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg?.info.role !== 'assistant') continue;
        for (const part of msg.parts) {
          if (part.type === 'text' && part.text) {
            const result = extractFacilitationJson(part.text);
            if (result) return result;
          }
        }
      }
    }
  } catch {
    // ConfigMap not yet available — fall through to live API.
  }

  // Fallback: live OpenCode API (works while pod is still running).
  let runStatus: unknown = null;
  if (serviceName && sessionID) {
    try {
      runStatus = await fetchSessionMessages(serviceName, sessionID, ns);
    } catch {
      runStatus = null;
    }
  }
  if (runStatus && typeof runStatus === 'object' && 'messages' in runStatus) {
    const messages = (
      runStatus.messages as Array<{
        role: string;
        content: string;
      }>
    ).filter((m) => m.role === 'assistant');
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (!message) continue;
      const result = extractFacilitationJson(message.content);
      if (result) return result;
    }
  }

  // Last resort: pod log.
  try {
    const logs = await readPodLog(runName, 'opencode', undefined, ns);
    const result = extractFacilitationJson(logs);
    if (result) return result;
  } catch {
    // Ignore
  }

  return null;
}

// Extract a JSON object from a string that may contain surrounding text.
function extractFacilitationJson(text: string) {
  // Find JSON object in the text
  const jsonMatch = text.match(/\{[^{}]*"diagnosis"[^{}]*"recommendedAction"[^{}]*\}/s);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const action = parsed.recommendedAction as string;
    if (
      action === 'retry_same' ||
      action === 'retry_alternative' ||
      action === 'skip' ||
      action === 'approve' ||
      action === 'request_changes' ||
      action === 'escalate'
    ) {
      return {
        diagnosis: parsed.diagnosis ?? '',
        recommendedAction: action as
          | 'retry_same'
          | 'retry_alternative'
          | 'skip'
          | 'approve'
          | 'request_changes'
          | 'escalate',
        alternativeAgent: parsed.alternativeAgent,
        suggestion: parsed.suggestion,
      };
    }
  } catch {
    // Invalid JSON
  }
  return null;
}
