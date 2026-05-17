// stats-backfill.ts — Reconciler-side stats backfill for runs that missed the
// dispatcher's POST to /api/stats/session (e.g. pod was killed before it could
// send, or the web service was temporarily unreachable).
//
// Called from the monitor phase whenever a run transitions to Succeeded/Failed
// so that every completed run eventually appears in the stats DB.

import { readSessionConfigMap } from "@percussionist/kube";

const NAMESPACE = process.env.PERCUSSIONIST_NAMESPACE ?? "percussionist";

const WEB_URL =
  process.env.WEB_SERVICE_URL ??
  `http://percussionist-web.${NAMESPACE}.svc.cluster.local:8080`;

const log = (...args: unknown[]) =>
  console.log(`[stats-backfill ${new Date().toISOString()}]`, ...args);
const err = (...args: unknown[]) =>
  console.error(`[stats-backfill ${new Date().toISOString()}]`, ...args);

// ---------------------------------------------------------------------------
// Types (mirrors the opencode raw message format, kept local to avoid
// importing from @percussionist/dispatcher).

interface RawInfo {
  id?: string;
  role?: string;
  model?: { providerID?: string; modelID?: string };
  tokens?: { input?: number; output?: number };
  time?: { created?: number; completed?: number };
}

interface ToolPart {
  type: "tool";
  tool: string;
  callID?: string;
  state?: {
    status?: string;
    input?: unknown;
    output?: unknown;
    metadata?: { exit?: number };
    time?: { start?: number; end?: number };
  };
}

interface ToolUsePart {
  type: "tool-use" | "tool_use";
  id?: string;
  name?: string;
  input?: unknown;
}

interface ToolResultPart {
  type: "tool-result" | "tool_result";
  toolUseId?: string;
  tool_use_id?: string;
  isError?: boolean;
  content?: unknown;
}

interface FilePart {
  type: "file";
  path?: string;
  filename?: string;
}

interface RawMessage {
  info?: RawInfo;
  parts?: Array<ToolPart | ToolUsePart | ToolResultPart | FilePart | { type: string }>;
}

// ---------------------------------------------------------------------------

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

function buildPayload(
  sessionID: string,
  runName: string,
  runNamespace: string,
  phase: string,
  task: string | undefined,
  model: string | undefined,
  agent: string | undefined,
  startedAt: string | undefined,
  completedAt: string | undefined,
  rawMessages: unknown[],
): unknown {
  const messagesPayload: unknown[] = [];
  const toolCallsPayload: Array<Record<string, unknown>> = [];
  const fileOpsPayload: unknown[] = [];
  const toolUseTimestamps = new Map<string, number>();

  for (let idx = 0; idx < rawMessages.length; idx++) {
    const msg = rawMessages[idx] as RawMessage;
    const info = msg.info ?? {};
    const parts = msg.parts ?? [];
    const content = JSON.stringify(parts);
    const modelStr = info.model
      ? `${info.model.providerID ?? ""}/${info.model.modelID ?? ""}`.replace(
          /^\/|\/$/g,
          "",
        )
      : undefined;

    messagesPayload.push({
      id: info.id ?? `${sessionID}-${idx}`,
      idx,
      role: info.role,
      content,
      model: modelStr,
      tokensIn: info.tokens?.input,
      tokensOut: info.tokens?.output,
      createdAt: info.time?.created
        ? new Date(info.time.created).toISOString()
        : undefined,
      completedAt: info.time?.completed
        ? new Date(info.time.completed).toISOString()
        : undefined,
    });

    for (const part of parts) {
      if (part.type === "tool") {
        const tp = part as ToolPart;
        const toolId = tp.callID ?? `${sessionID}-${idx}-${tp.tool}`;
        const state = tp.state;
        const isError =
          state?.status === "error" ||
          (typeof state?.metadata?.exit === "number" &&
            state.metadata.exit !== 0);
        const durationMs =
          state?.time?.start != null && state?.time?.end != null
            ? state.time.end - state.time.start
            : undefined;
        toolCallsPayload.push({
          id: toolId,
          messageIdx: idx,
          tool: tp.tool,
          args:
            state?.input != null ? JSON.stringify(state.input) : undefined,
          success: !isError,
          error: isError
            ? typeof state?.output === "string"
              ? state.output
              : JSON.stringify(state?.output ?? null)
            : undefined,
          durationMs,
        });
        const input = state?.input as Record<string, unknown> | undefined;
        const fp = input?.filePath ?? input?.path ?? input?.file;
        if (typeof fp === "string") {
          fileOpsPayload.push({
            messageIdx: idx,
            filePath: fp,
            operation: detectFileOp(tp.tool),
          });
        }
      } else if (part.type === "tool-use" || part.type === "tool_use") {
        const tp = part as ToolUsePart;
        const toolId = tp.id ?? `${sessionID}-${idx}-${tp.name}`;
        toolUseTimestamps.set(toolId, info.time?.created ?? Date.now());
        toolCallsPayload.push({
          id: toolId,
          messageIdx: idx,
          tool: tp.name ?? "unknown",
          args: tp.input != null ? JSON.stringify(tp.input) : undefined,
          success: true,
        });
        const fp =
          (tp.input as Record<string, unknown> | undefined)?.filePath ??
          (tp.input as Record<string, unknown> | undefined)?.path;
        if (typeof fp === "string") {
          fileOpsPayload.push({
            messageIdx: idx,
            filePath: fp,
            operation: detectFileOp(tp.name ?? ""),
          });
        }
      } else if (
        part.type === "tool-result" ||
        part.type === "tool_result"
      ) {
        const rp = part as ToolResultPart;
        const refId = rp.toolUseId ?? rp.tool_use_id;
        if (refId) {
          const existing = toolCallsPayload.find((t) => t["id"] === refId);
          if (existing) {
            existing["success"] = !rp.isError;
            if (rp.isError) {
              existing["error"] =
                typeof rp.content === "string"
                  ? rp.content
                  : JSON.stringify(rp.content);
            }
            const startTs = toolUseTimestamps.get(refId);
            if (startTs && info.time?.completed) {
              existing["durationMs"] = info.time.completed - startTs;
            }
          }
        }
      } else if (part.type === "file") {
        const fp = (part as FilePart).path ?? (part as FilePart).filename;
        if (fp) {
          fileOpsPayload.push({
            messageIdx: idx,
            filePath: fp,
            operation: "read",
          });
        }
      }
    }
  }

  return {
    sessionID,
    run: {
      name: runName,
      namespace: runNamespace,
      task,
      model,
      agent,
      phase,
      startedAt,
      completedAt,
    },
    messages: messagesPayload,
    toolCalls: toolCallsPayload,
    fileOps: fileOpsPayload,
  };
}

// ---------------------------------------------------------------------------
// Public API

/**
 * Check if stats already exist for a sessionID in the web server's DB.
 */
async function statsExist(sessionID: string): Promise<boolean> {
  try {
    const res = await fetch(`${WEB_URL}/api/stats/exists/${sessionID}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { exists?: boolean };
    return data.exists === true;
  } catch {
    // Network error — assume exists to avoid redundant backfill noise.
    return true;
  }
}

/**
 * Best-effort stats backfill for a completed run.
 *
 * If the session is not already in the stats DB, reads the session ConfigMap
 * and posts the data to /api/stats/session. Safe to call fire-and-forget.
 */
export async function backfillStats(
  runName: string,
  sessionID: string,
  runNamespace: string,
  phase: string,
  task: string | undefined,
  model: string | undefined,
  agent: string | undefined,
  startedAt: string | undefined,
  completedAt: string | undefined,
): Promise<void> {
  if (!WEB_URL) return;

  try {
    const exists = await statsExist(sessionID);
    if (exists) return;

    const snapshot = await readSessionConfigMap(runName, sessionID, runNamespace);
    if (!snapshot) {
      log(`no ConfigMap snapshot for ${runName}/${sessionID} — skipping backfill`);
      return;
    }

    const payload = buildPayload(
      sessionID,
      runName,
      runNamespace,
      phase,
      task,
      model,
      agent,
      startedAt,
      completedAt,
      snapshot.messages,
    );

    const res = await fetch(`${WEB_URL}/api/stats/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      err(`backfillStats: POST failed for ${runName}/${sessionID}: HTTP ${res.status}: ${body}`);
    } else {
      log(
        `backfillStats: backfilled ${sessionID} for run ${runName} (${snapshot.messages.length} messages)`,
      );
    }
  } catch (e) {
    err(`backfillStats: error for ${runName}/${sessionID}:`, (e as Error).message);
  }
}
