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
  OpenCodeProject,
  OpenCodeRun,
  OpenCodeRunStatus,
  resolveRunConfig,
  type BoardTask,
} from "@percussionist/api";
import { fetchSessionMessages, readPodLog, core } from "@percussionist/kube";

const DEFAULT_FACILITATOR_AGENT_NAME = "facilitator";
const FACILITATION_TIMEOUT_SECONDS = 4 * 60 * 60; // 4 hours

// Build the facilitator OpenCodeRun spec for a FAILED worker run.
export function buildFacilitationRun(
  project: OpenCodeProject,
  task: BoardTask,
  failedRunName: string,
  failedRunStatus: OpenCodeRunStatus,
  sessionSummary: string,
  runName: string,
  facilitatorAgentName = DEFAULT_FACILITATOR_AGENT_NAME,
): OpenCodeRun {
  const board = project.spec.board ?? { maxParallel: 2, phase: "Active" };
  const resolved = resolveRunConfig(project.spec, board.overrides);

  const facilitationSpec: FacilitationSpec = {
    targetRunName: failedRunName,
    targetTaskId: task.id,
    failureReason: failedRunStatus.message ?? "Unknown failure",
    sessionSummary,
    successReview: false,
  };

  const alternativeAgents = (board.agents ?? [])
    .map((a) => a.name)
    .filter((n) => n !== facilitatorAgentName);

  const promptLines = [
    `You are a facilitator agent that analyzes failed worker runs and recommends actions.`,
    "",
    `TASK: ${task.id} — ${task.title}`,
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
  );
}

// Build the facilitator OpenCodeRun spec for a SUCCEEDED worker run (success review).
export function buildSuccessReviewRun(
  project: OpenCodeProject,
  task: BoardTask,
  succeededRunName: string,
  succeededRunStatus: OpenCodeRunStatus,
  sessionSummary: string,
  runName: string,
  facilitatorAgentName = DEFAULT_FACILITATOR_AGENT_NAME,
): OpenCodeRun {
  const board = project.spec.board ?? { maxParallel: 2, phase: "Active" };
  const resolved = resolveRunConfig(project.spec, board.overrides);

  const completionMessage = succeededRunStatus.message ?? "session completed";

  const facilitationSpec: FacilitationSpec = {
    targetRunName: succeededRunName,
    targetTaskId: task.id,
    failureReason: completionMessage, // reusing field for completion message
    sessionSummary,
    successReview: true,
  };

  const alternativeAgents = (board.agents ?? [])
    .map((a) => a.name)
    .filter((n) => n !== facilitatorAgentName);

  const promptLines = [
    `You are a reviewer agent that checks whether a completed worker run actually fulfilled its task.`,
    "",
    `TASK: ${task.id} — ${task.title}`,
    `TASK DESCRIPTION: ${task.description ?? "(none)"}`,
    `WORKER RUN: ${succeededRunName}`,
    `COMPLETION MESSAGE: ${completionMessage}`,
    "",
    `RECENT SESSION MESSAGES:`,
    sessionSummary || "(none available)",
    "",
    ...(alternativeAgents.length > 0
      ? [
          `AVAILABLE ALTERNATIVE AGENTS: ${alternativeAgents.join(", ")}`,
          "",
        ]
      : []),
    `Review the session above and output ONLY valid JSON (no markdown, no explanation):`,
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
  );
}

// Build the facilitator OpenCodeRun spec for generating BUILD tasks from an approved PLAN task.
export function buildBuildTaskGeneratorRun(
  project: OpenCodeProject,
  planTask: BoardTask,
  succeededRunName: string,
  runName: string,
  facilitatorAgentName = DEFAULT_FACILITATOR_AGENT_NAME,
): OpenCodeRun {
  const board = project.spec.board ?? { maxParallel: 2, phase: "Active" };
  const resolved = resolveRunConfig(project.spec, board.overrides);

  const facilitationSpec: FacilitationSpec = {
    targetRunName: succeededRunName,
    targetTaskId: planTask.id,
    failureReason: "BUILD task generation from approved PLAN",
    sessionSummary: "", // Facilitator will fetch full session using tools
    successReview: false,
  };

  const availableAgents = (board.agents ?? [])
    .map((a) => a.name)
    .filter((n) => n !== facilitatorAgentName);

  const promptLines = [
    `You are a facilitator agent that breaks down approved PLAN tasks into concrete BUILD tasks.`,
    "",
    `PLAN TASK: ${planTask.id} — ${planTask.title}`,
    `PLAN DESCRIPTION: ${planTask.description ?? "(none)"}`,
    `PLAN WORKER RUN: ${succeededRunName}`,
    "",
    `The PLAN task has been approved by a human reviewer. Your job is to analyze the complete session`,
    `from the PLAN worker run and generate a list of BUILD tasks that implement the plan.`,
    "",
    `Use your tools to fetch the full session from run: ${succeededRunName}`,
    `Review the complete session carefully to understand what was planned.`,
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
        description: "(detailed description with context from PLAN session)",
        agent: "(optional: name from AVAILABLE AGENTS list, defaults to 'builder')",
        priority: "(optional: 'high' | 'medium' | 'low', defaults to 'medium')",
      },
    ]),
    "",
    `Requirements:`,
    `- Each BUILD task should be concrete and actionable`,
    `- Include relevant context from the PLAN session in each description`,
    `- Order tasks logically (dependencies first)`,
    `- If the PLAN requires no BUILD tasks (was purely research/planning), return empty array: []`,
    `- Return valid JSON array ONLY - no markdown fences, no explanation`,
  ].join("\n");

  return buildFacilitatorRun(
    project,
    planTask,
    runName,
    facilitationSpec,
    promptLines,
    resolved,
    facilitatorAgentName,
  );
}

// Shared helper — constructs the OpenCodeRun for any facilitator invocation.
function buildFacilitatorRun(
  project: OpenCodeProject,
  task: BoardTask,
  runName: string,
  facilitationSpec: FacilitationSpec,
  promptLines: string,
  resolved: ReturnType<typeof resolveRunConfig>,
  facilitatorAgentName: string,
): OpenCodeRun {
  const board = project.spec.board ?? { maxParallel: 2, phase: "Active" };
  return {
    apiVersion: API_GROUP_VERSION,
    kind: KIND_RUN,
    metadata: {
      name: runName,
      labels: {
        [LABELS.managedBy]: MANAGED_BY,
        [LABELS.projectName]: project.metadata.name,
        [LABELS.taskId]: task.id,
      },
      ownerReferences: [
        {
          apiVersion: API_GROUP_VERSION,
          kind: "OpenCodeProject",
          name: project.metadata.name,
          uid: project.metadata.uid!,
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
    spec: {
      project: project.metadata.name,
      boardTask: task.id,
      task: promptLines,
      interactive: false,
      agent: facilitatorAgentName,
      agents: (board.agents ?? []).filter(
        (a) => a.name !== facilitatorAgentName,
      ),
      model: resolved.model,
      image: resolved.image,
      timeoutSeconds: FACILITATION_TIMEOUT_SECONDS,
      ttlSecondsAfterFinished: 3600,
      facilitation: facilitationSpec,
      ...(resolved.resources ? { resources: resolved.resources } : {}),
      ...(resolved.secrets ? { secrets: resolved.secrets } : {}),
      ...(resolved.sidecars?.length ? { sidecars: resolved.sidecars } : {}),
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

// Extract a JSON array of BUILD task definitions from text.
function extractBuildTasksJson(text: string): Array<{
  title: string;
  description?: string;
  agent?: string;
  priority?: "high" | "medium" | "low";
}> | null {
  const validateBuildTasks = (value: unknown): Array<{
    title: string;
    description?: string;
    agent?: string;
    priority?: "high" | "medium" | "low";
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
          return parsed.map((item) => ({
            title: item.title,
            description: item.description,
            agent: item.agent,
            priority: item.priority === "high" || item.priority === "low" ? item.priority : "medium",
          }));
        }
      }
    } catch {
      // Invalid JSON
    }
    return null;
  };

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
