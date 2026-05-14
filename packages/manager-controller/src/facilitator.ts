// facilitator.ts — builds and parses facilitator agent runs.
//
// When a worker task fails, the manager spawns a facilitator run that analyzes
// the failure and recommends an escalation action. The facilitator is a normal
// OpenCodeRun with the facilitator system prompt and structured output
// instructions embedded in the task description.

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

// Build the facilitator OpenCodeRun spec.
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
      // Facilitator runs do not need a git checkout — they only analyze text.
      // Omitting source keeps startup fast and avoids inheriting a broken git URL.
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
  recommendedAction: "retry_same" | "retry_alternative" | "skip";
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
      action === "skip"
    ) {
      return {
        diagnosis: parsed.diagnosis ?? "",
        recommendedAction: action as "retry_same" | "retry_alternative" | "skip",
        alternativeAgent: parsed.alternativeAgent,
        suggestion: parsed.suggestion,
      };
    }
  } catch {
    // Invalid JSON
  }
  return null;
}
