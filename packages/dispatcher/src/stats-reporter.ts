// stats-reporter.ts — sends full session analytics to the web pod.
//
// sendStats()         — full flush on run completion (POST /api/stats/session)
// incrementalFlush()  — delta flush after each assistant turn (PATCH /api/stats/session)

import { BASE_URL } from "./session.js";
import type { RawMessage, TextPart, ToolUsePart, ToolResultPart, FilePart, ToolPart } from "./session.js";

const err = (...args: unknown[]) =>
  console.error(`[dispatcher ${new Date().toISOString()}]`, ...args);
const log = (...args: unknown[]) =>
  console.log(`[dispatcher ${new Date().toISOString()}]`, ...args);

const WEB_STATS_URL = process.env.WEB_STATS_URL ?? "";
const WEB_AUTH_TOKEN = process.env.WEB_AUTH_TOKEN ?? "";
const RUN_NAME = process.env.RUN_NAME ?? "";
const RUN_NAMESPACE = process.env.RUN_NAMESPACE ?? "";
const TASK = process.env.RUN_TASK ?? "";
const MODEL = process.env.RUN_MODEL ?? "";
const AGENT = process.env.RUN_AGENT ?? "";

interface TokenTotals {
  tokensIn: number;
  tokensOut: number;
  tokensReasoning: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  cost: number;
}

// ---------------------------------------------------------------------------
// Incremental flush — called after each assistant turn completes.
// Fetches only messages from `fromIdx` onward, assembles the delta payload,
// and PATCHes the web server. Non-fatal on any error.

export async function incrementalFlush(
  sessionID: string,
  startedAt: string,
  totals: TokenTotals,
  fromIdx: number,
): Promise<number> {
  // Returns the new cursor (total messages seen) so the caller can advance it.
  if (!WEB_STATS_URL) return fromIdx;

  let rawMessages: RawMessage[] = [];
  try {
    const res = await fetch(`${BASE_URL}/session/${sessionID}/message`);
    if (!res.ok) return fromIdx;
    const data = (await res.json()) as RawMessage[] | { items?: RawMessage[] };
    rawMessages = Array.isArray(data) ? data : (data.items ?? []);
  } catch {
    return fromIdx; // OpenCode may be busy — skip silently
  }

  if (rawMessages.length <= fromIdx) return fromIdx; // nothing new

  const newMessages = rawMessages.slice(fromIdx);
  const { messagesPayload, toolCallsPayload, fileOpsPayload } = buildPayloads(newMessages, sessionID, fromIdx);

  const payload = {
    sessionID,
    run: {
      name: RUN_NAME, namespace: RUN_NAMESPACE,
      task: TASK || undefined, model: MODEL || undefined, agent: AGENT || undefined,
      phase: "Running",
      startedAt,
      tokensIn: totals.tokensIn, tokensOut: totals.tokensOut,
      cost: totals.cost || undefined,
    },
    messages: messagesPayload,
    toolCalls: toolCallsPayload,
    fileOps: fileOpsPayload,
  };

  try {
    const res = await fetch(`${WEB_STATS_URL}/api/stats/session`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(WEB_AUTH_TOKEN ? { Authorization: `Bearer ${WEB_AUTH_TOKEN}` } : {}) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      log(`incrementalFlush: flushed ${newMessages.length} message(s) from idx ${fromIdx} (session ${sessionID})`);
    } else {
      err(`incrementalFlush: web pod HTTP ${res.status}`);
    }
  } catch (e) {
    err("incrementalFlush: POST failed (non-fatal):", (e as Error).message);
  }

  return rawMessages.length; // advance cursor to total seen
}

// ---------------------------------------------------------------------------
// Full flush — called on run completion.

export async function sendStats(
  sessionID: string,
  phase: string,
  startedAt: string,
  completedAt: string | undefined,
  totals: TokenTotals,
  sessionError?: string,
): Promise<void> {
  if (!WEB_STATS_URL) return;

  let rawMessages: RawMessage[] = [];
  try {
    const res = await fetch(`${BASE_URL}/session/${sessionID}/message`);
    if (res.ok) {
      const data = (await res.json()) as RawMessage[] | { items?: RawMessage[] };
      rawMessages = Array.isArray(data) ? data : (data.items ?? []);
    }
  } catch (e) {
    err("sendStats: failed to fetch messages:", (e as Error).message);
  }

  const { messagesPayload, toolCallsPayload, fileOpsPayload } = buildPayloads(rawMessages, sessionID, 0);

  const payload = {
    sessionID,
    run: {
      name: RUN_NAME, namespace: RUN_NAMESPACE,
      task: TASK || undefined, model: MODEL || undefined, agent: AGENT || undefined,
      phase, startedAt, completedAt,
      tokensIn: totals.tokensIn, tokensOut: totals.tokensOut,
      cost: totals.cost || undefined,
      error: sessionError,
    },
    messages: messagesPayload,
    toolCalls: toolCallsPayload,
    fileOps: fileOpsPayload,
  };

  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${WEB_STATS_URL}/api/stats/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(WEB_AUTH_TOKEN ? { Authorization: `Bearer ${WEB_AUTH_TOKEN}` } : {}) },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        if (attempt < MAX_ATTEMPTS) {
          err(`sendStats: web pod HTTP ${res.status} (attempt ${attempt}/${MAX_ATTEMPTS}), retrying: ${body}`);
          await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
          continue;
        }
        err(`sendStats: web pod HTTP ${res.status} (all ${MAX_ATTEMPTS} attempts failed): ${body}`);
      } else {
        log(`sendStats: persisted ${sessionID} — ${messagesPayload.length} messages, ${toolCallsPayload.length} tool calls`);
      }
      return;
    } catch (e) {
      if (attempt < MAX_ATTEMPTS) {
        err(`sendStats: POST failed (attempt ${attempt}/${MAX_ATTEMPTS}), retrying:`, (e as Error).message);
        await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
        continue;
      }
      err("sendStats: POST failed (all attempts exhausted, non-fatal):", (e as Error).message);
    }
  }
}

// ---------------------------------------------------------------------------
// Shared payload builder — used by both full and incremental flush.

function buildPayloads(
  rawMessages: RawMessage[],
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
  const toolUseTimestamps = new Map<string, number>();

  for (let i = 0; i < rawMessages.length; i++) {
    const idx = baseIdx + i;
    const msg = rawMessages[i]!;
    const info = msg.info ?? {};
    const parts = msg.parts ?? [];
    const content = JSON.stringify(parts);
    const model = info.model
      ? `${info.model.providerID ?? ""}/${info.model.modelID ?? ""}`.replace(/^\/|\/$/g, "")
      : undefined;

    messagesPayload.push({
      id: info.id ?? `${sessionID}-${idx}`,
      idx,
      role: info.role,
      content,
      model,
      tokensIn: info.tokens?.input,
      tokensOut: info.tokens?.output,
      tokensReasoning: info.tokens?.reasoning,
      tokensCacheRead: info.tokens?.cache?.read,
      tokensCacheWrite: info.tokens?.cache?.write,
      cost: (info as { cost?: number }).cost,
      createdAt: info.time?.created ? new Date(info.time.created).toISOString() : undefined,
      completedAt: info.time?.completed ? new Date(info.time.completed).toISOString() : undefined,
    });

    for (const part of parts) {
      if (part.type === "tool") {
        const tp = part as ToolPart;
        const toolId = tp.callID ?? `${sessionID}-${idx}-${tp.tool}`;
        const state = tp.state;
        const isError = state?.status === "error" ||
          (typeof state?.metadata?.exit === "number" && state.metadata.exit !== 0);
        const durationMs = state?.time?.start != null && state?.time?.end != null
          ? state.time.end - state.time.start : undefined;

        toolCallsPayload.push({
          id: toolId, messageIdx: idx, tool: tp.tool,
          args: state?.input != null ? JSON.stringify(state.input) : undefined,
          success: !isError,
          error: isError ? (typeof state?.output === "string" ? state.output : JSON.stringify(state?.output ?? null)) : undefined,
          durationMs,
        });

        const toolName = tp.tool.toLowerCase();
        const input = state?.input as Record<string, unknown> | undefined;
        const fp = input?.filePath ?? input?.path ?? input?.file;
        if (typeof fp === "string") {
          fileOpsPayload.push({ messageIdx: idx, filePath: fp, operation: detectFileOp(toolName) });
        }
      } else if (part.type === "tool-use" || part.type === "tool_use") {
        const tp = part as ToolUsePart;
        const toolId = tp.id ?? `${sessionID}-${idx}-${tp.name}`;
        toolUseTimestamps.set(toolId, info.time?.created ?? Date.now());
        toolCallsPayload.push({
          id: toolId, messageIdx: idx, tool: tp.name ?? "unknown",
          args: tp.input != null ? JSON.stringify(tp.input) : undefined,
          success: true,
        });
        const fp = (tp.input as Record<string, unknown> | undefined)?.filePath ??
          (tp.input as Record<string, unknown> | undefined)?.path;
        if (typeof fp === "string") {
          fileOpsPayload.push({ messageIdx: idx, filePath: fp, operation: detectFileOp(tp.name ?? "") });
        }
      } else if (part.type === "tool-result" || part.type === "tool_result") {
        const rp = part as ToolResultPart;
        const refId = rp.toolUseId ?? rp.tool_use_id;
        if (refId) {
          const existing = toolCallsPayload.find(
            (t) => (t as { id: string }).id === refId,
          ) as Record<string, unknown> | undefined;
          if (existing) {
            existing.success = !rp.isError;
            if (rp.isError) {
              existing.error = typeof rp.content === "string" ? rp.content : JSON.stringify(rp.content);
            }
            const startTs = toolUseTimestamps.get(refId);
            if (startTs && info.time?.completed) {
              existing.durationMs = info.time.completed - startTs;
            }
          }
        }
      } else if (part.type === "file") {
        const fp = (part as FilePart).path ?? (part as FilePart).filename;
        if (fp) fileOpsPayload.push({ messageIdx: idx, filePath: fp, operation: "read" });
      }
    }
  }

  return { messagesPayload, toolCallsPayload, fileOpsPayload };
}

function detectFileOp(toolName: string): string {
  const t = toolName.toLowerCase();
  if (t === "read" || t === "readfile" || t === "read_file") return "read";
  if (t === "write" || t === "writefile" || t === "write_file" || t === "edit" || t === "multiedit") return "write";
  if (t === "delete" || t === "delete_file") return "delete";
  return "access";
}

