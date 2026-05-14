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

const FACILITATOR_AGENT_NAME = "facilitator";
const FACILITATION_TIMEOUT_SECONDS = 4 * 60 * 60; // 4 hours

// Build the facilitator OpenCodeRun spec for a FAILED worker run.
export function buildFacilitationRun(
  project: OpenCodeProject,
  task: BoardTask,
  failedRunName: string,
  failedRunStatus: OpenCodeRunStatus,
  sessionSummary: string,
  runName: string,
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
    .filter((n) => n !== FACILITATOR_AGENT_NAME);

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

  return buildFacilitatorRun(project, task, runName, facilitationSpec, promptLines, resolved);
}

// Build the facilitator OpenCodeRun spec for a SUCCEEDED worker run (success review).
export function buildSuccessReviewRun(
  project: OpenCodeProject,
  task: BoardTask,
  succeededRunName: string,
  succeededRunStatus: OpenCodeRunStatus,
  sessionSummary: string,
  runName: string,
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
    .filter((n) => n !== FACILITATOR_AGENT_NAME);

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
      recommendedAction: "(approve | retry_alternative | escalate)",
      alternativeAgent: "(required if recommendedAction is retry_alternative — must be one of the AVAILABLE ALTERNATIVE AGENTS listed above)",
      suggestion: "(optional — what to improve or why escalating)",
    }),
    "",
    `Use "approve" if the task was completed satisfactorily.`,
    `Use "retry_alternative" only if a different agent should redo the task.`,
    `Use "escalate" if human review is needed.`,
  ].join("\n");

  return buildFacilitatorRun(project, task, runName, facilitationSpec, promptLines, resolved);
}

// Shared helper — constructs the OpenCodeRun for any facilitator invocation.
function buildFacilitatorRun(
  project: OpenCodeProject,
  task: BoardTask,
  runName: string,
  facilitationSpec: FacilitationSpec,
  promptLines: string,
  resolved: ReturnType<typeof resolveRunConfig>,
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
      agent: FACILITATOR_AGENT_NAME,
      agents: (board.agents ?? []).filter(
        (a) => a.name !== FACILITATOR_AGENT_NAME,
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
  recommendedAction: "retry_same" | "retry_alternative" | "skip" | "approve" | "escalate";
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
      action === "escalate"
    ) {
      return {
        diagnosis: parsed.diagnosis ?? "",
        recommendedAction: action as "retry_same" | "retry_alternative" | "skip" | "approve" | "escalate",
        alternativeAgent: parsed.alternativeAgent,
        suggestion: parsed.suggestion,
      };
    }
  } catch {
    // Invalid JSON
  }
  return null;
}
