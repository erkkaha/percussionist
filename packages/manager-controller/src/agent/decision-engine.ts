// agent/decision-engine.ts — called by the reconciler at escalation points.
//
// When deterministic logic hits a limit (retries exhausted, facilitation
// parse failure), the reconciler calls these functions. Each creates a
// short-lived agent session on the opencode-web sidecar, sends context,
// waits for a structured response, and returns the decision.

import { createSession, sendPrompt, waitForCompletion } from "./session.js";
import { AGENT_TIMEOUT_MS, FIRST_RESPONSE_TIMEOUT_MS, DECISION_AGENT_NAME, type AgentDecision } from "./config.js";

const FRTO = FIRST_RESPONSE_TIMEOUT_MS > 0 ? FIRST_RESPONSE_TIMEOUT_MS : undefined;

const log = (...args: unknown[]) =>
  console.log(`[agent-decision ${new Date().toISOString()}]`, ...args);
const err = (...args: unknown[]) =>
  console.error(`[agent-decision ${new Date().toISOString()}]`, ...args);

// ---------------------------------------------------------------------------
// Analyze a failed worker run when retries are exhausted.
//
// Context includes the run's status message, session summary, retry history,
// and available alternative agents.

export async function analyzeFailure(
  context: FailureContext,
): Promise<AgentDecision> {
  const prompt = buildFailureDiagnosisPrompt(context);

  try {
    const sessionId = await createSession(`failure-${context.taskId}`);
    await sendPrompt(sessionId, prompt, DECISION_AGENT_NAME);

    const response = await waitForCompletion(sessionId, AGENT_TIMEOUT_MS, FRTO);
    if (!response) {
      log(`agent timed out for failure analysis of ${context.taskId} — defaulting to escalate`);
      return { action: "escalate", reason: "agent did not respond in time" };
    }

    const decision = parseDecisionJson(response);
    if (!decision) {
      log(`agent returned unparseable response for ${context.taskId} — defaulting to escalate`);
      return { action: "escalate", reason: `agent response could not be parsed: ${response.slice(0, 500)}` };
    }

    log(`agent decision for ${context.taskId}: ${decision.action}${decision.agent ? ` (${decision.agent})` : ""} — ${decision.reason}`);
    return decision;
  } catch (e) {
    err(`agent failure analysis failed for ${context.taskId}:`, (e as Error).message);
    return { action: "escalate", reason: `agent error: ${(e as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Parse unstructured facilitation output when the standard regex parser fails.
//
// The agent reads the raw session ConfigMap and reconstructs a valid
// FacilitationResult.

export async function parseRawFacilitation(
  context: FacilitationContext,
): Promise<{ diagnosis: string; recommendedAction: string; alternativeAgent?: string; suggestion?: string } | null> {
  const prompt = buildFacilitationParsePrompt(context);

  try {
    const sessionId = await createSession(`parse-facilitation-${context.taskId}`);
    await sendPrompt(sessionId, prompt, DECISION_AGENT_NAME);

    const response = await waitForCompletion(sessionId, AGENT_TIMEOUT_MS, FRTO);
    if (!response) return null;

    return parseFacilitationJson(response);
  } catch (e) {
    err(`agent facilitation parse failed for ${context.taskId}:`, (e as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Prompt builders

interface FailureContext {
  projectName: string;
  taskId: string;
  taskTitle: string;
  taskDescription?: string;
  agent: string;
  retryCount: number;
  maxRetries: number;
  failureMessage: string;
  sessionSummary: string;
  alternativeAgents: string[];
}

function buildFailureDiagnosisPrompt(ctx: FailureContext): string {
  return [
    `You are a diagnostic agent for a Percussionist kanban board. A worker task has failed and exhausted its retries. Analyze the context and recommend the next action.`,
    ``,
    `PROJECT: ${ctx.projectName}`,
    `TASK: ${ctx.taskId} — ${ctx.taskTitle}`,
    `DESCRIPTION: ${ctx.taskDescription ?? "(none)"}`,
    `WORKER AGENT: ${ctx.agent}`,
    `RETRIES: ${ctx.retryCount}/${ctx.maxRetries}`,
    `FAILURE MESSAGE: ${ctx.failureMessage}`,
    ``,
    `RECENT SESSION MESSAGES:`,
    ctx.sessionSummary || "(none available)",
    ``,
    ctx.alternativeAgents.length > 0
      ? `AVAILABLE ALTERNATIVE AGENTS: ${ctx.alternativeAgents.join(", ")}`
      : "(no alternative agents available)",
    ``,
    `Output ONLY valid JSON (no markdown, no explanation):`,
    JSON.stringify({
      action: "(retry_same | retry_alternative | skip | escalate)",
      agent: "(if retry_alternative, name from AVAILABLE ALTERNATIVE AGENTS)",
      reason: "(1-2 sentences explaining the decision)",
    }),
  ].join("\n");
}

interface FacilitationContext {
  projectName: string;
  taskId: string;
  rawContext: string;
}

function buildFacilitationParsePrompt(ctx: FacilitationContext): string {
  return [
    `You are a parse assistant. The standard parser failed to extract a structured result from a facilitator agent's output.`,
    `Read the raw session output below and extract the facilitation decision.`,
    ``,
    `PROJECT: ${ctx.projectName}`,
    `TASK: ${ctx.taskId}`,
    ``,
    `RAW FACILITATOR OUTPUT:`,
    ctx.rawContext,
    ``,
    `Output ONLY valid JSON (no markdown, no explanation):`,
    JSON.stringify({
      diagnosis: "(root cause in 1-2 sentences)",
      recommendedAction: "(retry_same | retry_alternative | skip | approve | request_changes | escalate)",
      alternativeAgent: "(if applicable)",
      suggestion: "(optional)",
    }),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// JSON parsers

function parseDecisionJson(text: string): AgentDecision | null {
  const trimmed = text.trim();
  const match = trimmed.match(/\{[^{}]*"action"[^{}]*"reason"[^{}]*\}/s);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[0]);
    const action = parsed.action as string;
    if (!["retry_same", "retry_alternative", "skip", "escalate"].includes(action)) return null;
    return {
      action: action as AgentDecision["action"],
      agent: parsed.agent,
      reason: parsed.reason ?? "",
    };
  } catch {
    return null;
  }
}

function parseFacilitationJson(text: string): {
  diagnosis: string;
  recommendedAction: string;
  alternativeAgent?: string;
  suggestion?: string;
} | null {
  const trimmed = text.trim();
  const match = trimmed.match(/\{[^{}]*"diagnosis"[^{}]*"recommendedAction"[^{}]*\}/s);
  if (!match) return null;

  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Parse unstructured success-review output when the standard parser fails.
//
// The agent reads the raw review facilitator session and extracts an approval
// decision so that a non-parseable review doesn't default to a blind "approve."

export async function parseRawReview(
  context: ReviewContext,
): Promise<{ diagnosis: string; recommendedAction: string; alternativeAgent?: string; suggestion?: string } | null> {
  const prompt = buildReviewParsePrompt(context);

  try {
    const sessionId = await createSession(`parse-review-${context.taskId}`);
    await sendPrompt(sessionId, prompt, DECISION_AGENT_NAME);

    const response = await waitForCompletion(sessionId, AGENT_TIMEOUT_MS, FRTO);
    if (!response) return null;

    return parseFacilitationJson(response);
  } catch (e) {
    err(`agent review parse failed for ${context.taskId}:`, (e as Error).message);
    return null;
  }
}

interface ReviewContext {
  projectName: string;
  taskId: string;
  taskTitle: string;
  rawContext: string;
}

function buildReviewParsePrompt(ctx: ReviewContext): string {
  return [
    `You are a parse assistant. The standard parser failed to extract a structured approval/rejection from a success-review facilitator run.`,
    `Read the raw facilitator output below and determine whether the reviewer approved or rejected the work.`,
    ``,
    `PROJECT: ${ctx.projectName}`,
    `TASK: ${ctx.taskId} — ${ctx.taskTitle}`,
    ``,
    `RAW REVIEWER OUTPUT:`,
    ctx.rawContext,
    ``,
    `Output ONLY valid JSON (no markdown, no explanation):`,
    JSON.stringify({
      diagnosis: "(did the reviewer approve or reject? why?)",
      recommendedAction: "(approve | request_changes | retry_alternative | escalate)",
      alternativeAgent: "(if retry_alternative)",
      suggestion: "(optional)",
    }),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Parse unstructured BUILD task generator output when the standard parser fails.
//
// The agent reads the raw facilitator session and reconstructs a valid list
// of BUILD task definitions.

export async function parseRawBuildTaskGen(
  context: BuildTaskGenContext,
): Promise<Array<{ title: string; description?: string; agent?: string; priority?: string; predecessorIndex?: number | null }> | null> {
  const prompt = buildBuildTaskGenParsePrompt(context);

  try {
    const sessionId = await createSession(`parse-build-gen-${context.taskId}`);
    await sendPrompt(sessionId, prompt, DECISION_AGENT_NAME);

    const response = await waitForCompletion(sessionId, AGENT_TIMEOUT_MS, FRTO);
    if (!response) return null;

    return parseBuildTaskGenArray(response);
  } catch (e) {
    err(`agent BUILD task gen parse failed for ${context.taskId}:`, (e as Error).message);
    return null;
  }
}

interface BuildTaskGenContext {
  projectName: string;
  taskId: string;
  taskTitle: string;
  rawContext: string;
}

function buildBuildTaskGenParsePrompt(ctx: BuildTaskGenContext): string {
  return [
    `You are a parse assistant. The standard parser failed to extract a valid JSON array of BUILD task definitions from a BUILD task generator facilitator run.`,
    `Read the raw facilitator output below and reconstruct a valid list of BUILD tasks.`,
    ``,
    `PROJECT: ${ctx.projectName}`,
    `PLAN TASK: ${ctx.taskId} — ${ctx.taskTitle}`,
    ``,
    `RAW FACILITATOR OUTPUT:`,
    ctx.rawContext,
    ``,
    `Output ONLY valid JSON array (no markdown, no explanation):`,
    JSON.stringify([
      {
        title: "(short title for this BUILD task)",
        description: "(detailed description)",
        agent: "(optional agent name, default: builder)",
        priority: "(optional: high | medium | low, default: medium)",
        predecessorIndex: "(optional: 0-based index of task in this array that must complete first, or omit if independent)",
      },
    ]),
    ``,
    `If the output clearly indicates no BUILD tasks are needed, return empty array: []`,
    `Return valid JSON array ONLY - no markdown fences, no explanation.`,
  ].join("\n");
}

function parseBuildTaskGenArray(text: string): Array<{ title: string; description?: string; agent?: string; priority?: string; predecessorIndex?: number | null }> | null {
  const trimmed = text.trim();
  const match = trimmed.match(/\[[\s\S]*\]/);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[0]);
    if (Array.isArray(parsed) && parsed.every((item: unknown) => typeof item === "object" && item !== null && typeof (item as Record<string, unknown>).title === "string")) {
      return parsed.map((item: Record<string, unknown>, idx: number) => {
        const pi = item.predecessorIndex;
        const predecessorIndex = typeof pi === "number" && Number.isInteger(pi) && pi >= 0 && pi < idx ? pi : null;
        return {
          title: item.title as string,
          description: item.description as string | undefined,
          agent: item.agent as string | undefined,
          priority: item.priority as string | undefined,
          predecessorIndex,
        };
      });
    }
  } catch {
    // Invalid JSON
  }
  return null;
}
