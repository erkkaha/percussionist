// stats-reporter.ts — sends full session analytics to the web pod.
//
// sendManagerSessionStats()   — full flush on session completion (POST /api/stats/session)
// incrementalFlushManagerSession()  — delta flush after each assistant turn (PATCH /api/stats/session)

import type { SessionMessage } from "./session.js";
import { OPENCODE_URL as AGENT_OPENCODE_URL } from "./config.js";

const err = (...args: unknown[]) =>
  console.error(`[manager stats ${new Date().toISOString()}]`, ...args);
const log = (...args: unknown[]) =>
  console.log(`[manager stats ${new Date().toISOString()}]`, ...args);

// Config from environment (read dynamically for testability)
const getWebUrl = () => process.env.WEB_SERVICE_URL ?? "";
const getAuthToken = () => process.env.WEB_AUTH_TOKEN ?? "";
export const getNamespace = () =>
  process.env.PERCUSSIONIST_NAMESPACE ?? "percussionist";

/**
 * Synthetic agent name used for manager session stats.
 * This appears under Stats → Agents in the web UI.
 */
export const MANAGER_RUN_AGENT = "manager run";

/**
 * Generate a stable run name for manager sessions.
 * Uses sessionID to ensure idempotency across retries.
 */
export function getManagerRunName(sessionId: string): string {
  return `manager-session-${sessionId}`;
}

// ---------------------------------------------------------------------------
// Types

interface TokenTotals {
  tokensIn: number;
  tokensOut: number;
  cost: number;
}

/**
 * Build payloads from messages for stats ingestion.
 * Mirrors dispatcher/stats-reporter.ts logic.
 */
export function buildPayloads(
  rawMessages: SessionMessage[],
  sessionID: string,
  baseIdx: number,
): {
  messagesPayload: unknown[];
  toolCallsPayload: unknown[];
  fileOpsPayload: unknown[];
} {
  const messagesPayload: unknown[] = [];
  const toolCallsPayload: unknown[] = [];
  const fileOpsPayload: unknown[] = [];

  for (let i = 0; i < rawMessages.length; i++) {
    const idx = baseIdx + i;
    const msg = rawMessages[i]!;
    const info = msg.info ?? {};
    const parts = msg.parts ?? [];
    const content = JSON.stringify(parts);
    
    // Extract model - handle both string and object formats
    let model: string | undefined = undefined;
    if (info.model) {
      if (typeof info.model === "string") {
        model = info.model;
      } else if (
        typeof info.model === "object" &&
        !Array.isArray(info.model)
      ) {
        const m = info.model as any;
        model = `${m.providerID ?? ""}/${m.modelID ?? ""}`.replace(
          /^\/|\/$/g,
          "",
        );
      }
    }

    messagesPayload.push({
      id: info.id ?? `${sessionID}-${idx}`,
      idx,
      role: info.role,
      content,
      model,
      tokensIn: (info.tokens as { input?: number } | undefined)?.input,
      tokensOut: (info.tokens as { output?: number } | undefined)?.output,
      tokensReasoning: (info.tokens as { reasoning?: number } | undefined)
        ?.reasoning,
      tokensCacheRead: (
        info.tokens as { cache?: { read?: number } } | undefined
      )?.cache?.read,
      tokensCacheWrite: (
        info.tokens as { cache?: { write?: number } } | undefined
      )?.cache?.write,
      cost: (info as { cost?: number }).cost,
      createdAt: info.time?.created
        ? new Date(info.time.created).toISOString()
        : undefined,
      completedAt: info.time?.completed
        ? new Date(info.time.completed).toISOString()
        : undefined,
    });

    for (const part of parts) {
      // Handle tool-related parts (tool, tool-use, tool-result)
      if (
        part &&
        typeof part === "object" &&
        "type" in part &&
        (part.type === "tool" ||
          part.type === "tool-use" ||
          part.type === "tool_use" ||
          part.type === "tool-result" ||
          part.type === "tool_result")
      ) {
        const tp = part as Record<string, unknown>;

        // Extract tool name based on type
        let toolName = "";
        if (tp.tool) {
          toolName = String(tp.tool);
        } else if (tp.name) {
          toolName = String(tp.name);
        }

        // Detect file operations from tool args
        // Check both direct input and state.input (like dispatcher does)
        const stateInput =
          tp.state && typeof tp.state === "object" ? (tp.state as any).input : undefined;
        const input =
          (stateInput !== undefined ? stateInput : tp.input) as Record<string, unknown> | undefined;
        const fp = input?.filePath ?? input?.path ?? input?.file;

        if (typeof fp === "string") {
          fileOpsPayload.push({
            messageIdx: idx,
            filePath: String(fp),
            operation: detectFileOp(toolName),
          });
        }
      } else if (
        part &&
        typeof part === "object" &&
        "type" in part &&
        part.type === "file"
      ) {
        const fp = (part as { path?: string; filename?: string }).path ??
          (part as { path?: string; filename?: string }).filename;
        if (fp) {
          fileOpsPayload.push({
            messageIdx: idx,
            filePath: String(fp),
            operation: "read",
          });
        }
      }
    }
  }

  return { messagesPayload, toolCallsPayload, fileOpsPayload };
}

function detectFileOp(toolName: string): string {
  const t = toolName.toLowerCase();
  if (t === "read" || t === "readfile" || t === "read_file") return "read";
  if (
    t === "write" ||
    t === "writefile" ||
    t === "write_file" ||
    t === "edit" ||
    t === "multiedit"
  )
    return "write";
  if (t === "delete" || t === "delete_file") return "delete";
  return "access";
}

// ---------------------------------------------------------------------------
// Extract totals from messages

export function extractTokenTotals(
  rawMessages: SessionMessage[],
): TokenTotals {
  let tokensIn = 0;
  let tokensOut = 0;
  let cost = 0;

  for (const msg of rawMessages) {
    const info = msg.info ?? {};
    const tokens = info.tokens as
      | { input?: number; output?: number }
      | undefined;

    if (tokens?.input != null) tokensIn += tokens.input;
    if (tokens?.output != null) tokensOut += tokens.output;

    if ((info as { cost?: number }).cost != null) {
      cost += (info as { cost?: number }).cost!;
    }
  }

  return { tokensIn, tokensOut, cost };
}

// ---------------------------------------------------------------------------
// Incremental flush — called after each assistant turn completes.

export async function incrementalFlushManagerSession(
  sessionId: string,
  startedAt: string,
  fromIdx: number,
): Promise<number> {
  // Returns the new cursor (total messages seen)
  if (!getWebUrl()) return fromIdx;

  let rawMessages: SessionMessage[] = [];
  try {
    const res = await fetch(`${AGENT_OPENCODE_URL}/session/${sessionId}/message`);
    if (!res.ok) return fromIdx;
    const data = (await res.json()) as
      | SessionMessage[]
      | { items?: SessionMessage[] };
    rawMessages = Array.isArray(data) ? data : (data.items ?? []);
  } catch {
    return fromIdx; // OpenCode may be busy — skip silently
  }

  if (rawMessages.length <= fromIdx) return fromIdx; // nothing new

  const newMessages = rawMessages.slice(fromIdx);
  const { messagesPayload, toolCallsPayload, fileOpsPayload } = buildPayloads(
    newMessages,
    sessionId,
    fromIdx,
  );
  const totals = extractTokenTotals(newMessages);

  const payload = {
    sessionID: sessionId,
    run: {
      name: getManagerRunName(sessionId),
      namespace: getNamespace(),
      agent: MANAGER_RUN_AGENT,
      phase: "Running",
      startedAt,
      tokensIn: totals.tokensIn,
      tokensOut: totals.tokensOut,
      cost: totals.cost || undefined,
    },
    messages: messagesPayload,
    toolCalls: toolCallsPayload,
    fileOps: fileOpsPayload,
  };

  try {
    const res = await fetch(`${getWebUrl()}/api/stats/session`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...(getAuthToken() ? { Authorization: `Bearer ${getAuthToken()}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      log(
        `incrementalFlushManagerSession: flushed ${newMessages.length} message(s) from idx ${fromIdx} (session ${sessionId})`,
      );
    } else {
      err(
        `incrementalFlushManagerSession: web pod HTTP ${res.status}`,
      );
    }
  } catch (e) {
    err(
      "incrementalFlushManagerSession: PATCH failed (non-fatal):",
      (e as Error).message,
    );
  }

  return rawMessages.length; // advance cursor to total seen
}

// ---------------------------------------------------------------------------
// Full flush — called on session completion.

export async function sendManagerSessionStats(
  sessionId: string,
  phase: string,
  startedAt: string,
  completedAt: string | undefined,
): Promise<void> {
  if (!getWebUrl()) return;

  let rawMessages: SessionMessage[] = [];
  try {
    const res = await fetch(`${AGENT_OPENCODE_URL}/session/${sessionId}/message`);
    if (res.ok) {
      const data = (await res.json()) as
        | SessionMessage[]
        | { items?: SessionMessage[] };
      rawMessages = Array.isArray(data) ? data : (data.items ?? []);
    }
  } catch (e) {
    err(
      "sendManagerSessionStats: failed to fetch messages:",
      (e as Error).message,
    );
  }

  const { messagesPayload, toolCallsPayload, fileOpsPayload } = buildPayloads(
    rawMessages,
    sessionId,
    0,
  );
  const totals = extractTokenTotals(rawMessages);

  const payload = {
    sessionID: sessionId,
    run: {
      name: getManagerRunName(sessionId),
      namespace: getNamespace(),
      agent: MANAGER_RUN_AGENT,
      phase,
      startedAt,
      completedAt,
      tokensIn: totals.tokensIn,
      tokensOut: totals.tokensOut,
      cost: totals.cost || undefined,
    },
    messages: messagesPayload,
    toolCalls: toolCallsPayload,
    fileOps: fileOpsPayload,
  };

  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${getWebUrl()}/api/stats/session`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(getAuthToken() ? { Authorization: `Bearer ${getAuthToken()}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        if (attempt < MAX_ATTEMPTS) {
          err(
            `sendManagerSessionStats: web pod HTTP ${res.status} (attempt ${attempt}/${MAX_ATTEMPTS}), retrying: ${body}`,
          );
          await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
          continue;
        }
        err(
          `sendManagerSessionStats: web pod HTTP ${res.status} (all ${MAX_ATTEMPTS} attempts failed): ${body}`,
        );
      } else {
        log(
          `sendManagerSessionStats: persisted ${sessionId} — ${messagesPayload.length} messages`,
        );
      }
      return;
    } catch (e) {
      if (attempt < MAX_ATTEMPTS) {
        err(
          `sendManagerSessionStats: POST failed (attempt ${attempt}/${MAX_ATTEMPTS}), retrying:`,
          (e as Error).message,
        );
        await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
        continue;
      }
      err(
        "sendManagerSessionStats: POST failed (all attempts exhausted, non-fatal):",
        (e as Error).message,
      );
    }
  }
}
