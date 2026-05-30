// facilitator.ts — builds and parses facilitator agent runs.
//
// When a worker task fails, the manager spawns a facilitator run that analyzes
// the failure and recommends an escalation action. When a worker task succeeds,
// the manager spawns a success-review facilitator that approves the result or
// redirects it to another agent.

import {
  API_GROUP_VERSION,
  KIND_RUN,
  LABELS,
  MANAGED_BY,
  FacilitationSpec,
  Project,
  Run,
  RunStatus,
  Task,
  resolveRunConfig,
} from "@percussionist/api";
import { fetchSessionMessages, readPodLog, core, getClusterSettings } from "@percussionist/kube";
import { resolveParentBranch, resolveTaskBranch } from "./branch-resolver.js";
import { truncateK8sName } from "./worker-builder.js";

const DEFAULT_FACILITATOR_AGENT_NAME = "facilitator";
const FACILITATION_TIMEOUT_SECONDS = 4 * 60 * 60; // 4 hours

// Build the facilitator Run spec for a FAILED worker run.
export async function buildFacilitationRun(
  project: Project,
  task: Task,
  failedRunName: string,
  failedRunStatus: RunStatus,
  sessionSummary: string,
  runName: string,
  facilitatorAgentName = DEFAULT_FACILITATOR_AGENT_NAME,
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
    failureReason: failedRunStatus.message ?? "Unknown failure",
    sessionSummary,
    successReview: false,
  };

  const alternativeAgents = (project.spec.agents ?? [])
    .map((a) => a.name)
    .filter((n) => n !== facilitatorAgentName);

  const promptLines = [
    `You are a facilitator agent that analyzes failed worker runs and recommends actions.`,
    "",
    `TASK: ${task.metadata.name} — ${task.spec.title}`,
    `WORKER RUN: ${failedRunName}`,
    `FAILURE: ${facilitationSpec.failureReason}`,
    "",
    `RECENT SESSION MESSAGES:`,
    sessionSummary || "(none available)",
    "",
    ...(alternativeAgents.length > 0
      ? [
          `AVAILABLE ALTERNATIVE AGENTS: ${alternativeAgents.join(", ")}`,
          `NOTE: If the failure is due to the specific worker agent refusing or being incapable, `,
          `recommend retry_alternative with one of the available alternative agents.`,
          `Only recommend skip if the task itself is inherently impossible or harmful.`,
          "",
        ]
      : []),
    `Analyze the failure above and output ONLY valid JSON (no markdown, no explanation):`,
    JSON.stringify({
      diagnosis: "(root cause in 1-2 sentences)",
      recommendedAction: "(retry_same | retry_alternative | skip)",
      alternativeAgent: "(required if recommendedAction is retry_alternative — must be one of the AVAILABLE ALTERNATIVE AGENTS listed above)",
      suggestion: "(optional — fix suggestion for next attempt)",
    }),
  ].join("\n");

  return buildFacilitatorRun(
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
  branchName?: string,
  facilitatorAgentName = DEFAULT_FACILITATOR_AGENT_NAME,
  allTasks: Task[] = [],
): Promise<Run> {
  const clusterSettings = await getClusterSettings().catch(() => undefined);
  const resolved = resolveRunConfig(project.spec, undefined, undefined, {
    runner: {
      image: clusterSettings?.spec?.runner?.image,
      resources: clusterSettings?.spec?.runner?.resources,
    },
  });

  const completionMessage = succeededRunStatus.message ?? "session completed";

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

  const taskTypeLabel = task.spec.type ? `TASK TYPE: ${task.spec.type}` : "";
  const isBuildTask = task.spec.type === "BUILD";
  const isPlanTask = task.spec.type === "PLAN";
  const planPath = `.percussionist/plans/${task.metadata.name}.md`;

  const promptLines = [
    `You are a reviewer agent that checks whether a completed worker run actually fulfilled its task.`,
    ...(taskTypeLabel ? [taskTypeLabel] : []),
    "",
    `TASK: ${task.metadata.name} — ${task.spec.title}`,
    `TASK DESCRIPTION: ${task.spec.description ?? "(none)"}`,
    `WORKER RUN: ${succeededRunName}`,
    `BRANCH: ${branch}`,
    `COMPLETION MESSAGE: ${completionMessage}`,
    "",
    ...(isBuildTask
      ? [
          `This is a BUILD task. The worker was validated by the dispatcher to have committed, pushed, and created a PR before calling complete_run.`,
          `The COMPLETION MESSAGE above contains the worker's summary and should reference the PR that was created.`,
          `Check the completion message for evidence of PR creation (URL, number, or explicit confirmation).`,
          `If the completion message clearly indicates a PR was created, approve the task.`,
          `If the completion message is missing or unclear, use request_changes.`,
          "",
        ]
      : isPlanTask
        ? [
            `This is a PLAN task. Do not review code implementation quality.`,
            `Review the plan artifact at ${planPath}.`,
            `Approve only if the plan file exists and contains enough context to generate BUILD tasks: scope, assumptions, risks, acceptance criteria, and a concrete implementation breakdown.`,
            `Use request_changes if the plan artifact is missing, vague, or lacks enough context for builders.`,
            `Use escalate only for cases that require human judgment beyond improving the plan artifact.`,
            "",
          ]
      : [
          `The COMPLETION MESSAGE above summarizes what the worker accomplished.`,
          `Check the completion message and session data to verify the task was completed.`,
          "",
        ]),
    `RECENT SESSION MESSAGES:`,
    sessionSummary || "(none available)",
    "",
    ...(isPlanTask
      ? [
           `PLAN ARTIFACT PATH: ${planPath}`,
           `Call the read_plan MCP tool (read_plan(project="<project>", task="<task-id>")) to retrieve plan content.`,
          "",
        ]
      : []),
    "",
    ...(alternativeAgents.length > 0
      ? [
          `AVAILABLE ALTERNATIVE AGENTS: ${alternativeAgents.join(", ")}`,
          "",
        ]
      : []),
    `Review the above and output ONLY valid JSON (no markdown, no explanation):`,
    JSON.stringify({
      diagnosis: "(1-2 sentences: did the worker actually complete the task?)",
      recommendedAction: "(approve | request_changes | retry_alternative | escalate)",
      alternativeAgent: "(required if recommendedAction is retry_alternative — must be one of the AVAILABLE ALTERNATIVE AGENTS listed above)",
      suggestion: "(optional — what to improve or why escalating)",
    }),
    "",
    `Use "approve" if the task was completed satisfactorily.`,
    `Use "request_changes" if implementation changes are needed before human approval.`,
    `Use "retry_alternative" only if a different agent should redo the task.`,
    `Use "escalate" if human review is needed.`,
  ].join("\n");

  return buildFacilitatorRun(
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
  facilitatorAgentName = DEFAULT_FACILITATOR_AGENT_NAME,
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
    targetRunName: succeededRunName,
    targetTaskId: planTask.metadata.name,
    failureReason: "BUILD task generation from approved PLAN",
    sessionSummary: "", 
    successReview: false,
  };

  const availableAgents = (project.spec.agents ?? [])
    .map((a) => a.name)
    .filter((n) => n !== facilitatorAgentName);

  const promptLines = [
    `You are a facilitator agent that breaks down approved PLAN tasks into concrete BUILD tasks.`,
    `You do NOT implement code. You do NOT write, edit, or modify any files. You do NOT run git commands. You do NOT create pull requests. You do NOT explore the codebase. Your ONLY output is a JSON array of BUILD task definitions.`,
    "",
    `PLAN TASK: ${planTask.metadata.name} — ${planTask.spec.title}`,
    `PLAN DESCRIPTION: ${planTask.spec.description ?? "(none)"}`,
    `PLAN WORKER RUN: ${succeededRunName}`,
    "",
    `PLAN SESSION CONTEXT:`,
    sessionSummary || "(none available — use the task description above)",
    "",
    `PLAN ARTIFACT PATH: .percussionist/plans/${planTask.metadata.name}.md`,
    "",
    `The PLAN task has been approved by a human reviewer. Your job is to generate a list`,
    `of BUILD tasks that implement the plan. Work ONLY from the task description and plan`,
    `session context provided above. Do NOT read any workspace files. Do NOT explore the codebase.`,
    `Do NOT run shell commands. Do NOT write or edit any files.`,
    "",
    `If the context above is insufficient to derive concrete BUILD tasks, return an empty array: []`,
    `so the PLAN escalates for manual BUILD task creation.`,
    "",
    ...(availableAgents.length > 0
      ? [
          `AVAILABLE AGENTS: ${availableAgents.join(", ")}`,
          `For each BUILD task, you may optionally specify which agent should handle it.`,
          `If not specified, the default "builder" agent will be used.`,
          "",
        ]
      : []),
    `Output ONLY valid JSON array (no markdown, no explanation, no extra text):`,
    JSON.stringify([
      {
        title: "(short title for this BUILD task)",
        description: "(detailed description including the relevant slice plus full-plan context)",
        agent: "(optional: name from AVAILABLE AGENTS list, defaults to 'builder')",
        priority: "(optional: 'high' | 'medium' | 'low', defaults to 'medium')",
        predecessorIndex: "(optional: 0-based index of the task in this array that must complete first, or omit/null if independent)",
      },
    ]),
    "",
    `Requirements:`,
    `- Each BUILD task should be concrete and actionable — one logical change that justifies its own commit and review cycle`,
    `- Bundle tightly-coupled changes into a single BUILD task: schema + Zod types + CRD regeneration (pnpm codegen) is ONE task; API change + operator consumers is ONE task`,
    `- Build verification (pnpm build, pnpm typecheck) is the builder's responsibility — never create a standalone BUILD task for it`,
    `- CRD regeneration triggered by a schema change belongs in the same BUILD task as the schema update`,
    `- Split only when changes are truly independent: disjoint packages, no shared types, can merge in any order`,
    `- A task should represent roughly 1–4 hours of focused implementation work`,
    `- If a PLAN item is large but tightly coupled (e.g., refactoring one module), keep it as one BUILD task rather than splitting by file or function`,
    `- Include relevant local task instructions AND enough full-plan context that the build agent understands the larger feature`,
    `- Do not create standalone audit/research tasks that only document findings unless a later task explicitly consumes a named repo artifact produced by that task`,
    `- Prefer combining discovery with the implementation task that uses the discoveries`,
    `- If a discovery task is genuinely necessary, require it to write a specific repo file such as .percussionist/findings/{task-id}.md and require every dependent task to read that exact file`,
    `- Do not use predecessorIndex merely to sequence vague context handoff; use it only when the predecessor produces code changes or a named artifact that the successor task description explicitly references`,
    `- Tasks that are independent MUST omit predecessorIndex so they run in parallel`,
    `- Only set predecessorIndex when a task genuinely cannot start until another is done (imports code it creates, migrates schema it defines, etc.)`,
    `- predecessorIndex must be a 0-based index strictly less than the task's own index (no forward references, no cycles)`,
    `- If the PLAN requires no BUILD tasks (was purely research/planning), return empty array: []`,
    `- Return valid JSON array ONLY - no markdown fences, no explanation`,
    "",
    `CRITICAL — DO NOT:`,
    `- Do NOT create standalone BUILD tasks for build verification, type-checking, or CRD regeneration. These are part of every builder's verification step.`,
    `- Do NOT split tightly-coupled changes (schema + codegen, API + consumers) into separate BUILD tasks. Bundle them as one logical change.`,
    `- Do NOT write or edit any files. You have NO file write access.`,
    `- Do NOT run any shell commands. You have NO shell access.`,
    `- Do NOT read any workspace files. You have NO file read access.`,
    `- Do NOT run git commands, commit, push, or create pull requests.`,
    `- Do NOT explore the codebase. Do NOT browse directories.`,
    `- Do NOT use any tool other than percussionist_dispatcher_complete_run.`,
    `- Do NOT output anything other than the JSON array via the summary field.`,
    `- If you are unsure, still output ONLY the JSON array — never output prose or attempts.`,
    `- Do NOT create standalone BUILD tasks for build verification, type-checking, or CRD regeneration. These are part of every builder's verification step.`,
    `- Do NOT split tightly-coupled changes (schema + codegen, API + consumers) into separate BUILD tasks. Bundle them as one logical change.`,
  ].join("\n");

  return buildFacilitatorRun(
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
// The reviewer agent uses MCP tools (read_session_live) to fetch session data itself.
export function buildReviewRun(
  project: Project,
  task: Task,
  succeededRunName: string,
  succeededRunStatus: RunStatus,
  runName: string,
  branchName: string | undefined,
  facilitatorAgentName = DEFAULT_FACILITATOR_AGENT_NAME,
  allTasks: Task[] = [],
): Run {
  const resolved = resolveRunConfig(project.spec, undefined, undefined, {
    runner: {
      image: undefined,
      resources: undefined,
    },
  });

  const completionMessage = succeededRunStatus.message ?? "session completed";
  const branch = branchName ?? `feat/${task.metadata.name}`;
  const taskTypeLabel = task.spec.type ? `TASK TYPE: ${task.spec.type}` : "";
  const isBuildTask = task.spec.type === "BUILD";
  const isPlanTask = task.spec.type === "PLAN";
  const planPath = `.percussionist/plans/${task.metadata.name}.md`;

  const alternativeAgents = (project.spec.agents ?? [])
    .map((a) => a.name)
    .filter((n) => n !== facilitatorAgentName);

  const promptLines = [
    `You are a reviewer agent that checks whether a completed worker run actually fulfilled its task.`,
    ...(taskTypeLabel ? [taskTypeLabel] : []),
    "",
    `TASK: ${task.metadata.name} — ${task.spec.title}`,
    `TASK DESCRIPTION: ${task.spec.description ?? "(none)"}`,
    `WORKER RUN: ${succeededRunName}`,
    `BRANCH: ${branch}`,
    `COMPLETION MESSAGE: ${completionMessage}`,
    "",
    `SESSION DATA: Use the read_session_live MCP tool (runName="${succeededRunName}") to read the full session.`,
    `Start with since=0 and paginate using nextSince until you have all messages.`,
    "",
    ...(isBuildTask
      ? [
          `This is a BUILD task. The worker was validated by the dispatcher to have committed, pushed, and created a PR before calling complete_run.`,
          `The COMPLETION MESSAGE above contains the worker's summary and should reference the PR that was created.`,
          `Check the completion message for evidence of PR creation (URL, number, or explicit confirmation).`,
          `If the completion message clearly indicates a PR was created, approve the task.`,
          `If the completion message is missing or unclear, use request_changes.`,
          "",
        ]
      : isPlanTask
        ? [
            `This is a PLAN task. Do not review code implementation quality.`,
            `Review the plan artifact at ${planPath}.`,
            `Approve only if the plan file exists and contains enough context to generate BUILD tasks: scope, assumptions, risks, acceptance criteria, and a concrete implementation breakdown.`,
            `Use request_changes if the plan artifact is missing, vague, or lacks enough context for builders.`,
            `Use escalate only for cases that require human judgment beyond improving the plan artifact.`,
            "",
          ]
      : [
          `The COMPLETION MESSAGE above summarizes what the worker accomplished.`,
          `Check the completion message and session data to verify the task was completed.`,
          "",
        ]),
    ...(isPlanTask
      ? [
           `PLAN ARTIFACT PATH: ${planPath}`,
           `Call the read_plan MCP tool (read_plan(project="<project>", task="<task-id>")) to retrieve plan content.`,
          "",
        ]
      : []),
    "",
    ...(alternativeAgents.length > 0
      ? [
          `AVAILABLE ALTERNATIVE AGENTS: ${alternativeAgents.join(", ")}`,
          "",
        ]
      : []),
    `Review the above and output ONLY valid JSON (no markdown, no explanation):`,
    JSON.stringify({
      diagnosis: "(1-2 sentences: did the worker actually complete the task?)",
      recommendedAction: "(approve | request_changes | retry_alternative | escalate)",
      alternativeAgent: "(required if recommendedAction is retry_alternative — must be one of the AVAILABLE ALTERNATIVE AGENTS listed above)",
      suggestion: "(optional — what to improve or why escalating)",
    }),
    "",
    `Use "approve" if the task was completed satisfactorily.`,
    `Use "request_changes" if implementation changes are needed before human approval.`,
    `Use "retry_alternative" only if a different agent should redo the task.`,
    `Use "escalate" if human review is needed.`,
  ].join("\n");

  const facilitationSpec: FacilitationSpec = {
    targetRunName: succeededRunName,
    targetTaskId: task.metadata.name,
    failureReason: completionMessage,
    sessionSummary: "",
    successReview: true,
  };

  return buildFacilitatorRun(
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
function buildFacilitatorRun(
  project: Project,
  task: Task,
  runName: string,
  facilitationSpec: FacilitationSpec,
  promptLines: string,
  resolved: ReturnType<typeof resolveRunConfig>,
  facilitatorAgentName: string,
  allTasks: Task[] = [],
): Run {
  const source = resolved.source
    ? { ...resolved.source, ...(resolved.source.git ? { git: { ...resolved.source.git } } : {}) }
    : undefined;
  const data = resolved.data ? { ...resolved.data, mountPath: resolved.data.mountPath ?? "/data" } : undefined;
  const gitCache = resolved.gitCache ? { worktreeReuse: resolved.gitCache.worktreeReuse ?? true } : undefined;
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
          kind: "Project",
          name: project.metadata.name,
          uid: project.metadata.uid!,
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
      agents: (project.spec.agents ?? []).filter(
        (a) => a.name !== facilitatorAgentName,
      ),
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
  recommendedAction: "retry_same" | "retry_alternative" | "skip" | "approve" | "request_changes" | "escalate";
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
      if (!key.startsWith("messages-")) continue;
      const messages: Array<{
        info: { role: string };
        parts: Array<{ type: string; text?: string }>;
      }> = JSON.parse(value);
      // Walk messages in reverse to find the last assistant text.
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (!msg || msg.info.role !== "assistant") continue;
        for (const part of msg.parts) {
          if (part.type === "text" && part.text) {
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
  if (runStatus && typeof runStatus === "object" && "messages" in runStatus) {
    const messages = (runStatus.messages as Array<{
      role: string;
      content: string;
    }>).filter((m) => m.role === "assistant");
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (!message) continue;
      const result = extractFacilitationJson(message.content);
      if (result) return result;
    }
  }

  // Last resort: pod log.
  try {
    const logs = await readPodLog(runName, "opencode", undefined, ns);
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
      action === "retry_same" ||
      action === "retry_alternative" ||
      action === "skip" ||
      action === "approve" ||
      action === "request_changes" ||
      action === "escalate"
    ) {
      return {
        diagnosis: parsed.diagnosis ?? "",
        recommendedAction: action as "retry_same" | "retry_alternative" | "skip" | "approve" | "request_changes" | "escalate",
        alternativeAgent: parsed.alternativeAgent,
        suggestion: parsed.suggestion,
      };
    }
  } catch {
    // Invalid JSON
  }
  return null;
}

// Parse BUILD task definitions from a BUILD task generator facilitator run.
export async function parseBuildTaskDefinitions(
  runName: string,
  ns: string,
  serviceName?: string,
  sessionID?: string,
): Promise<Array<{
  title: string;
  description?: string;
  agent?: string;
  priority?: "high" | "medium" | "low";
  predecessorIndex?: number | null;
}> | null> {
  // Primary: try the session ConfigMap snapshot saved by the dispatcher.
  try {
    const cm = await core().readNamespacedConfigMap({
      name: `${runName}-session`,
      namespace: ns,
    });
    const data = cm.data ?? {};
    for (const [key, value] of Object.entries(data)) {
      if (!key.startsWith("messages-")) continue;
      const messages: Array<{
        info: { role: string };
        parts: Array<{
          type: string;
          text?: string;
          tool?: string;
          state?: { input?: { summary?: string } };
        }>;
      }> = JSON.parse(value);
      // Walk messages in reverse to find the last assistant text.
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (!msg || msg.info.role !== "assistant") continue;
        for (const part of msg.parts) {
          if (part.type === "text" && part.text) {
            const result = extractBuildTasksJson(part.text);
            if (result) return result;
          }
          if (
            part.type === "tool" &&
            part.tool === "percussionist-dispatcher_complete_run" &&
            part.state?.input?.summary
          ) {
            const result = extractBuildTasksJson(part.state.input.summary);
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
  if (runStatus && typeof runStatus === "object" && "messages" in runStatus) {
    const messages = (runStatus.messages as Array<{
      role: string;
      content: string;
    }>).filter((m) => m.role === "assistant");
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (!message) continue;
      const result = extractBuildTasksJson(message.content);
      if (result) return result;
    }
  }

  // Last resort: pod log.
  try {
    const logs = await readPodLog(runName, "opencode", undefined, ns);
    const result = extractBuildTasksJson(logs);
    if (result) return result;
  } catch {
    // Ignore
  }

  return null;
}

// Patterns that indicate the agent went off-script and self-reports having implemented code.
// These must NOT match BUILD task descriptions which naturally describe future work.
const OFF_SCRIPT_PATTERNS = [
  /\bI\s+(?:will\s+)?(?:have\s+)?(?:just\s+)?(?:added|created|implemented|written|built|modified|changed|pushed|committed)\b/i,
  /\bI(?:'ve|'d)\s+(?:already\s+|just\s+|now\s+)?(?:added|created|implemented|written|built|modified|changed|pushed|committed)\b/i,
  /\blet me\s+(implement|write|create|add|build|modify|change|commit|push)\b/i,
  /(?:git\s+)?(?:committed|pushed)\s+(?:the\s+)?(?:changes|code)\s+(?:to|on|in)/i,
  /\b(?:creating|opening?|submitting?)\s+(?:a\s+)?pull\s*[_-]?\s*request\b/i,
];

// Extract a JSON array of BUILD task definitions from text.
function extractBuildTasksJson(text: string): Array<{
  title: string;
  description?: string;
  agent?: string;
  priority?: "high" | "medium" | "low";
  predecessorIndex?: number | null;
}> | null {
  const validateBuildTasks = (value: unknown): Array<{
    title: string;
    description?: string;
    agent?: string;
    priority?: "high" | "medium" | "low";
    predecessorIndex?: number | null;
  }> | null => {
    try {
      const parsed = value;
      if (Array.isArray(parsed)) {
        // Validate each item has at least a title
        const valid = parsed.every(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            typeof item.title === "string" &&
            item.title.length > 0
        );
        if (valid) {
          return parsed.map((item, idx) => {
            // Validate predecessorIndex: must be a non-negative integer less than current index
            let predecessorIndex: number | null = null;
            if (typeof item.predecessorIndex === "number" && Number.isInteger(item.predecessorIndex) && item.predecessorIndex >= 0 && item.predecessorIndex < idx) {
              predecessorIndex = item.predecessorIndex;
            }
            return {
              title: item.title,
              description: item.description,
              agent: item.agent,
              priority: item.priority === "high" || item.priority === "low" ? item.priority : "medium",
              predecessorIndex,
            };
          });
        }
      }
    } catch {
      // Invalid JSON
    }
    return null;
  };

  // Reject responses that look like the agent went off-script (implemented code instead of outputting JSON).
  if (OFF_SCRIPT_PATTERNS.some((p) => p.test(text))) {
    return null;
  }

  // Reject responses that are too long (agent went off-script with prose/implementation).
  if (text.length > 15000) {
    return null;
  }

  // Most common case: response is pure JSON array.
  const trimmed = text.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const direct = JSON.parse(trimmed);
      const validated = validateBuildTasks(direct);
      if (validated) return validated;
    } catch {
      // Not pure JSON; continue with extraction heuristics.
    }
  }

  // Extract the first JSON array that starts with objects.
  const arrayMatch = text.match(/\[\s*\{[\s\S]*?\}\s*\]/);
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      const validated = validateBuildTasks(parsed);
      if (validated) return validated;
    } catch {
      // Invalid JSON
    }
  }

  return null;
}
