// facilitator.ts — builds facilitator agent runs.
//
// When a worker task succeeds, the manager spawns a success-review facilitator
// that approves the result or redirects it to another agent. Approved PLAN
// tasks also spawn a build-task-generator facilitator that breaks the plan into
// BUILD tasks. Failed worker runs are handled inline by the reconciler
// (decideFailed → awaiting-human/failed) — no facilitator run is spawned.

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
  getClusterSettings,
  listClusterAgents,
  readPlanFromConfigMap,
  validateModelAuth,
} from '@percussionist/kube';
import { resolveParentBranch, resolveTaskBranch } from './branch-resolver.js';
import { getErrorStatusCode, isKubeNotFoundError } from './kube-errors.js';
import { resolveAgentModel, truncateK8sName } from './worker-builder.js';

const FACILITATION_TIMEOUT_SECONDS = 4 * 60 * 60; // 4 hours

const NAMESPACE = process.env.PERCUSSIONIST_NAMESPACE ?? 'percussionist';

async function getOptionalClusterSettings(context: string) {
  try {
    return await getClusterSettings();
  } catch (e) {
    if (isKubeNotFoundError(e)) return undefined;
    console.error(
      `[facilitator] getClusterSettings failed (${context}) status=${getErrorStatusCode(e) ?? 'unknown'}`,
      e,
    );
    throw e;
  }
}

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

async function resolveEligibleBuildAgents(
  project: Project,
  facilitatorAgentName: string,
): Promise<string[]> {
  const roster = (project.spec.agents ?? []).map((a) => a.name);
  if (roster.length === 0) return [];

  const clusterAgents = await listClusterAgents().catch(() => []);
  const eligibleFromLive = new Set(
    clusterAgents
      .filter((agent) => (agent.spec.capabilities ?? []).includes('task.build.execute'))
      .map((agent) => agent.metadata.name),
  );

  return roster.filter((name) => name !== facilitatorAgentName && eligibleFromLive.has(name));
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
  const clusterSettings = await getOptionalClusterSettings('buildBuildTaskGeneratorRun');
  const resolved = resolveRunConfig(project.spec, undefined, undefined, {
    runner: {
      image: clusterSettings?.spec?.runner?.image,
      resources: clusterSettings?.spec?.runner?.resources,
    },
    secrets: clusterSettings?.spec?.secrets,
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

  const eligibleBuildAgents = await resolveEligibleBuildAgents(project, facilitatorAgentName);

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
    ...(eligibleBuildAgents.length > 0
      ? [
          `ELIGIBLE BUILD AGENTS (task.build.execute): ${eligibleBuildAgents.join(', ')}`,
          `For each BUILD task, specify the agent via the percussionist_dispatcher_create_task "agent" parameter from ELIGIBLE BUILD AGENTS only.`,
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
    `   - agent (required): agent name from ELIGIBLE BUILD AGENTS list`,
    `   - priority: "high", "medium", or "low" (default: "medium")`,
    `   - predecessorRef: the taskName returned by a previous percussionist_dispatcher_create_task call if this task depends on it`,
    `3. Each percussionist_dispatcher_create_task returns { taskName, ... }. Use the returned taskName as predecessorRef for dependent tasks.`,
    `4. After ALL tasks are created, call percussionist_dispatcher_complete_run with a summary of what was created.`,
    '',
    `REQUIREMENTS:`,
    `- BUILD tasks MUST be assigned only to agents that have capability task.build.execute (use only ELIGIBLE BUILD AGENTS listed above)`,
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

/**
 * Where a reviewer's output is supposed to go.
 *
 * Without this block the prompt only ever named `approved` and `diagnosis`, so a
 * reviewer learned about complete_review's `findings` array from the tool schema
 * at best and could not construct a matching `context` at all — line-specific
 * review points came back as unanchored prose in `feedback`, which the board
 * never renders next to the code. It also had no route for issues that are real
 * but not about this diff, so those were smuggled into the verdict prose too.
 *
 * The diffFingerprint recipe mirrors `computeDiffFingerprint` and the git
 * invocation in packages/web/src/server/routes/task-diff.ts. Keep them in step:
 * if the board's diff command changes, a reviewer following these instructions
 * computes a fingerprint that no longer matches and every finding renders stale.
 */
export function reviewOutputPromptLines(baseBranch: string, branch: string): string[] {
  return [
    `REVIEW FINDINGS — inline comments on the diff:`,
    `complete_review takes an optional findings array (max 25) alongside the verdict. Anything you`,
    `want to say about a specific line belongs there, not in feedback: findings are anchored to a`,
    `path and line and render inline in the board's diff view, while feedback prose is not anchored`,
    `and is easily missed. Emit findings whether you approve or request changes — an approval`,
    `carrying medium/low findings is the normal outcome for work that is correct but leaves a`,
    `caveat behind. Keep feedback for the overall verdict narrative.`,
    '',
    `Each finding needs: id (unique within this call), severity (critical|high|medium|low|info),`,
    `title (<=160 chars), comment (<=2000 chars), 1-3 anchors, and a context object.`,
    `An anchor is { path, side: "new" | "old", line, endLine?, hunkHeader? } — use side "new" and`,
    `post-image line numbers unless you are pointing at a deleted line.`,
    '',
    `Every finding in one call must carry the SAME context object, computed from git in your`,
    `workspace (findings whose context disagrees with the first one are dropped):`,
    `  FORK_SHA   = git merge-base ${baseBranch} ${branch}`,
    `  BASE_SHA   = git rev-parse ${baseBranch}^{commit}`,
    `  HEAD_SHA   = git rev-parse ${branch}^{commit}`,
    `  DIFF       = git diff --no-color --find-renames --binary $FORK_SHA..${branch} --`,
    `  diffFingerprint = sha256 of the string "$FORK_SHA\\n$HEAD_SHA\\n" followed by DIFF with`,
    `                    leading and trailing whitespace stripped (python3/node, not shell echo).`,
    `Prefer origin/<branch> for either ref when it resolves — the board computes its fingerprint`,
    `against the pushed refs. A fingerprint that disagrees with the board's only marks the finding`,
    `stale, it is still stored and read, so never drop a finding because you are unsure of it.`,
    '',
    `UNRELATED ISSUES — problems that are not about this diff:`,
    `A pre-existing bug you happened to notice, or a broken toolchain unrelated to this work, is`,
    `not a review finding. Report each one once with the percussionist_dispatcher_report_unrelated_issue`,
    `tool (title, description, severity, category, optional filePath/snippet) and carry on with the`,
    `review — it lands in the project's issue inbox for triage. Do not smuggle it into the verdict`,
    `prose as a caveat, and do not let it change approve/request_changes for this task.`,
    '',
  ];
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
  const clusterSettings = await getOptionalClusterSettings('buildReviewRun');
  const resolved = resolveRunConfig(project.spec, undefined, undefined, {
    runner: {
      image: undefined,
      resources: undefined,
    },
    secrets: clusterSettings?.spec?.secrets,
  });

  const completionMessage = succeededRunStatus.message ?? 'session completed';
  const branch = branchName ?? `feat/${task.metadata.name}`;
  // The board's diff view resolves the review base exactly this way
  // (packages/web/src/server/routes/task-diff.ts). The reviewer has to diff
  // against the same base, or the diffFingerprint it computes for its findings
  // will not match the board's and every finding renders as stale.
  const baseBranch =
    task.status?.worker?.mergeIntoBranch ??
    task.status?.worker?.parentBranch ??
    project.spec.source?.git?.ref ??
    'main';
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
    `BASE BRANCH: ${baseBranch}`,
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
          `Use git log to check whether commits exist on this branch.`,
          `If git log shows no commits and the session does not explain why (e.g., the task was informational, or the worker used "force" to bypass the git check), reject with request_changes — committed code changes are required.`,
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
            `If the plan artifact is missing, vague, or lacks enough context for builders, use request_changes and explain exactly what the plan must add; there is no 'escalate' verdict — substantive human judgment is requested through the task's awaiting-human flow after rework attempts.`,
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
    // A BUILD task description is a condensed brief of one plan slice, and the
    // reviewer was given only that brief. So the brief's ACCEPTANCE list became
    // the entire de facto spec: a plan requirement buildgen did not restate was
    // unenforced by the gate, even when the worker had read the plan itself.
    // Give the reviewer the same source of truth the worker has.
    ...(isBuildTask && task.spec.parentTaskRef
      ? [
          `PARENT PLAN: ${task.spec.parentTaskRef} (artifact path: ${`.percussionist/plans/${task.spec.parentTaskRef}.md`})`,
          `Call percussionist_dispatcher_read_plan(project="${project.metadata.name}", task="${task.spec.parentTaskRef}") to read it.`,
          `The TASK DESCRIPTION above is a condensed brief of one slice of that plan, so treat the plan as the`,
          `authority on intent. Judge the work against the task's stated acceptance criteria, but if the plan`,
          `requires something for this slice that the description omits — or the two contradict — call that out`,
          `in your feedback instead of approving against the shorter document alone.`,
          '',
        ]
      : []),
    '',
    ...(alternativeAgents.length > 0
      ? [`AVAILABLE ALTERNATIVE AGENTS: ${alternativeAgents.join(', ')}`, '']
      : []),
    ...reviewOutputPromptLines(baseBranch, branch),
    `Call the percussionist_dispatcher_complete_review MCP tool to submit your review verdict.`,
    `Use approved: true to approve, or approved: false to request changes.`,
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

/**
 * Build the PR-feedback evaluation run for PR-mode integration. Spawned when
 * new human comments land on an open PR (see decidePrStateOutcome). Runs the
 * review agent on the PR's head branch; its complete_review verdict either
 * declares the comments answered (approve) or distills them into rework
 * instructions (request_changes) that become a follow-up BUILD task.
 */
export async function buildPrFeedbackEvalRun(
  project: Project,
  task: Task,
  runName: string,
  prNumber: number,
  sinceIso: string | undefined,
  reviewAgentName: string,
  allTasks: Task[] = [],
): Promise<Run> {
  const clusterSettings = await getOptionalClusterSettings('buildPrFeedbackEvalRun');
  const resolved = resolveRunConfig(project.spec, undefined, undefined, {
    runner: {
      image: undefined,
      resources: undefined,
    },
    secrets: clusterSettings?.spec?.secrets,
  });

  const branch = task.status?.worker?.gitBranch ?? `feat/${task.metadata.name}`;
  const baseBranch =
    task.status?.worker?.mergeIntoBranch ??
    task.status?.worker?.parentBranch ??
    project.spec.source?.git?.ref ??
    'main';

  const promptLines = [
    `You are evaluating reviewer feedback on GitHub pull request #${prNumber}.`,
    '',
    `TASK: ${task.metadata.name} — ${task.spec.title}`,
    `PR HEAD BRANCH: ${branch} (checked out in your /workspace)`,
    `PR BASE BRANCH: ${baseBranch}`,
    ...(sinceIso
      ? [`FEEDBACK WATERMARK: only comments created after ${sinceIso} are unevaluated.`]
      : ['FEEDBACK WATERMARK: none — evaluate the full comment history of the PR.']),
    '',
    '## Gather the feedback',
    '',
    'Use `gh` (authenticated via the environment) to read every feedback source:',
    `    gh api user --jq .login                                  # your own account — ignore its comments`,
    `    gh api "repos/{owner}/{repo}/issues/${prNumber}/comments" # conversation comments`,
    `    gh api "repos/{owner}/{repo}/pulls/${prNumber}/comments"  # inline diff comments`,
    `    gh api "repos/{owner}/{repo}/pulls/${prNumber}/reviews"   # submitted reviews`,
    '',
    'Consider only comments newer than the watermark (when one is set above) and',
    'not authored by your own account. Read the code they refer to — the PR head',
    'is checked out in /workspace, so use git diff, git log, read, and grep to',
    'judge each comment against the actual implementation.',
    '',
    '## Act on it',
    '',
    'Sort the feedback into two buckets:',
    '',
    '1. Comments that are questions, clarifications, or observations needing no',
    '   code change: answer them directly on the PR with `gh pr comment` (or a',
    '   reply in the relevant thread via the API). Be brief and concrete; only',
    '   reply where you are confident the answer is correct.',
    '2. Comments that require code changes: do NOT implement them here. Distill',
    '   them into rework instructions for a builder agent.',
    '',
    '## Report the verdict',
    '',
    'Call the percussionist_dispatcher_complete_review MCP tool exactly once:',
    '',
    '- approved: true — when no comment requires a code change. Put a short',
    '  summary of what was asked and how you replied in `diagnosis`.',
    '- approved: false — when code changes are required. Put a one-line summary',
    '  in `diagnosis` and the full rework instructions in `feedback`: a numbered',
    '  list, each item quoting the reviewer comment (author and text), naming the',
    '  affected file/lines, and stating precisely what to change. This text',
    '  becomes the task description for a builder working on this same branch,',
    '  so it must stand alone without access to the PR conversation.',
    '',
    'Never push commits, close the PR, or merge anything from this run.',
  ].join('\n');

  const facilitationSpec: FacilitationSpec = {
    targetRunName: task.status?.worker?.runName ?? runName,
    targetTaskId: task.metadata.name,
    failureReason: '',
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
    reviewAgentName,
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
  // Per-agent model resolution, same as buildWorkerRun:
  // project roster model → ClusterAgent model → project/cluster default.
  const agentModel = await resolveAgentModel(project, facilitatorAgentName);
  if (agentModel) {
    resolved.model = agentModel;
  }

  // Validate auth against the model the run will actually use — after the
  // per-agent override, not before it.
  const authValidation = validateModelAuth(resolved.model, resolved.secrets);
  if (!authValidation.ok) {
    throw new Error(
      `Auth validation failed for facilitator run (task="${task.metadata.name}", agent="${facilitatorAgentName}"): ${authValidation.error}`,
    );
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
