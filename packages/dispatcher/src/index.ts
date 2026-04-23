// Dispatcher sidecar.
//
// Runs alongside `opencode serve` inside an OpenCodeRun pod. Responsibilities:
//   1. Wait for the server to be reachable on 127.0.0.1:4096.
//   2. (prompt mode) Create a session, fire the task as a prompt (async).
//      (interactive mode) Wait for the user to start a session via the web UI
//      or `beatctl attach`; observe all sessions that appear.
//   3. Mirror session activity (sessionID, token counters, lastEventAt) into
//      the OpenCodeRun status subresource via merge-patch.
//   4. (prompt mode) Exit 0 when the session completes.
//      (interactive mode) Sleep until SIGTERM; snapshot all sessions on exit.
//
// Environment (injected by the operator):
//   RUN_NAME, RUN_NAMESPACE         — which CR to update
//   OPENCODE_BASE_URL               — http://127.0.0.1:4096 (same pod)
//   RUN_TASK                        — the prompt text (prompt mode only)
//   RUN_MODEL                       — optional, "provider/model"
//   RUN_AGENT                       — optional
//   RUN_INTERACTIVE                 — "1" for interactive mode

import {
  KubeConfig,
  CustomObjectsApi,
  CoreV1Api,
  PatchStrategy,
  setHeaderOptions,
} from "@kubernetes/client-node";
import { createOpencodeClient } from "@opencode-ai/sdk";
import {
  API_GROUP,
  API_VERSION,
  API_GROUP_VERSION,
  KIND_RUN,
  PLURAL_RUN,
  RunPhase,
  type OpenCodeRunStatus,
} from "@percussionist/api";

const env = (k: string, required = true): string => {
  const v = process.env[k];
  if (!v && required) {
    console.error(`[dispatcher] missing required env: ${k}`);
    process.exit(2);
  }
  return v ?? "";
};

const RUN_NAME = env("RUN_NAME");
const RUN_NAMESPACE = env("RUN_NAMESPACE");
const RUN_UID = env("RUN_UID");
const BASE_URL = env("OPENCODE_BASE_URL", false) || "http://127.0.0.1:4096";
// In interactive mode the operator leaves RUN_TASK unset on purpose.
const INTERACTIVE = env("RUN_INTERACTIVE", false) === "1";
const TASK = env("RUN_TASK", !INTERACTIVE);
const MODEL = env("RUN_MODEL", false);
const AGENT = env("RUN_AGENT", false);
// Optional: web pod stats service URL. When set, the dispatcher POSTs the
// full session data here after completion for persistent analytics storage.
// Example: http://percussionist-web.percussionist.svc.cluster.local:8080
const WEB_STATS_URL = env("WEB_STATS_URL", false);

const log = (...args: unknown[]) =>
  console.log(`[dispatcher ${new Date().toISOString()}]`, ...args);
const err = (...args: unknown[]) =>
  console.error(`[dispatcher ${new Date().toISOString()}]`, ...args);

// ---------------------------------------------------------------------------
// Graceful shutdown

let shuttingDown = false;
const shutdownSignalled = new Promise<void>((resolve) => {
  const onSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${signal}, shutting down`);
    resolve();
  };
  process.once("SIGTERM", () => onSignal("SIGTERM"));
  process.once("SIGINT", () => onSignal("SIGINT"));
});

function interruptibleSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
    shutdownSignalled.then(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// K8s client + status patching

const kc = new KubeConfig();
kc.loadFromDefault();
const k8s = kc.makeApiClient(CustomObjectsApi);
const coreApi = kc.makeApiClient(CoreV1Api);

async function patchStatus(patch: OpenCodeRunStatus): Promise<void> {
  const body = { status: { ...patch, lastEventAt: new Date().toISOString() } };
  try {
    await k8s.patchNamespacedCustomObjectStatus(
      {
        group: API_GROUP,
        version: API_VERSION,
        namespace: RUN_NAMESPACE,
        plural: PLURAL_RUN,
        name: RUN_NAME,
        body,
      },
      setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
    );
  } catch (e) {
    err("patchStatus failed:", (e as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Session snapshot — persist all conversations to a ConfigMap.
//
// Fetches the list of all sessions from the opencode server and writes their
// messages into a single ConfigMap named `<runName>-session`. Each session
// gets its own key: `messages-<sessionID>.json`. A `sessions.json` key holds
// the list of session IDs in order. This lets the web dashboard render
// conversations even after the runner pod has been deleted.
//
// The ConfigMap is owned by the OpenCodeRun CR and gets GC'd with it.
// ConfigMaps have a 1 MiB etcd limit; individual session message lists are
// truncated from the front if they exceed their share.

const CM_MAX_BYTES = 900_000;

type SessionEntry = { id: string; title?: string };
type MessagesEntry = {
  info?: {
    role?: "user" | "assistant";
    time?: { created?: number; completed?: number };
    tokens?: { input?: number; output?: number };
    error?: unknown;
  };
};

async function listSessions(): Promise<SessionEntry[]> {
  try {
    const res = await fetch(`${BASE_URL}/session`);
    if (!res.ok) return [];
    const data = (await res.json()) as SessionEntry[] | { sessions?: SessionEntry[] };
    // opencode returns either an array or { sessions: [...] } depending on version
    return Array.isArray(data) ? data : (data.sessions ?? []);
  } catch {
    return [];
  }
}

async function fetchMessages(sessionID: string): Promise<MessagesEntry[]> {
  try {
    const res = await fetch(`${BASE_URL}/session/${sessionID}/message`);
    if (!res.ok) return [];
    return (await res.json()) as MessagesEntry[];
  } catch {
    return [];
  }
}

async function snapshotAllSessions(): Promise<void> {
  const sessions = await listSessions();
  if (sessions.length === 0) {
    log("snapshotAllSessions: no sessions to snapshot");
    return;
  }

  log(`snapshotAllSessions: snapshotting ${sessions.length} session(s)`);

  // Per-session budget: divide headroom evenly (rough heuristic).
  const perSessionBudget = Math.floor(CM_MAX_BYTES / sessions.length);

  const cmData: Record<string, string> = {
    "sessions.json": JSON.stringify(sessions.map((s) => s.id)),
  };

  for (const session of sessions) {
    let messages = await fetchMessages(session.id);
    let json = JSON.stringify(messages);
    let truncated = false;
    while (Buffer.byteLength(json, "utf8") > perSessionBudget && messages.length > 1) {
      truncated = true;
      messages = messages.slice(1);
      json = JSON.stringify(messages);
    }
    cmData[`messages-${session.id}.json`] = json;
    if (truncated) cmData[`truncated-${session.id}`] = "true";
    log(
      `snapshotAllSessions: session ${session.id} — ${messages.length} messages, ` +
        `${Buffer.byteLength(json, "utf8")} bytes${truncated ? " (truncated)" : ""}`,
    );
  }

  // Upsert: try create, fall back to patch if already exists (e.g. operator restart).
  const cmMeta = {
    name: `${RUN_NAME}-session`,
    namespace: RUN_NAMESPACE,
    labels: {
      "app.kubernetes.io/managed-by": "percussionist",
      "percussionist.dev/run-name": RUN_NAME,
      "percussionist.dev/component": "session-snapshot",
    },
    ownerReferences: [
      {
        apiVersion: API_GROUP_VERSION,
        kind: KIND_RUN,
        name: RUN_NAME,
        uid: RUN_UID,
        controller: true,
        blockOwnerDeletion: true,
      },
    ],
  };

  try {
    await coreApi.createNamespacedConfigMap({
      namespace: RUN_NAMESPACE,
      body: { apiVersion: "v1", kind: "ConfigMap", metadata: cmMeta, data: cmData },
    });
    log(`snapshotAllSessions: created ConfigMap ${RUN_NAME}-session`);
  } catch (createErr) {
    if (!/already exists/i.test((createErr as Error).message)) {
      err("snapshotAllSessions: create failed:", (createErr as Error).message);
      return;
    }
    // Already exists — replace data via merge patch.
    try {
      await coreApi.patchNamespacedConfigMap(
        { name: `${RUN_NAME}-session`, namespace: RUN_NAMESPACE, body: { data: cmData } },
        setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
      );
      log(`snapshotAllSessions: updated ConfigMap ${RUN_NAME}-session`);
    } catch (patchErr) {
      err("snapshotAllSessions: patch failed:", (patchErr as Error).message);
    }
  }
}

// ---------------------------------------------------------------------------
// Stats reporting — POST full session data to the web pod for persistent
// analytics storage. Non-fatal: a failure here never blocks the run from
// completing. Only called when WEB_STATS_URL is configured.

// Part shapes we care about for stats extraction.
type TextPart = { type: "text"; text: string };
type ToolUsePart = {
  type: "tool-use" | "tool_use";
  id?: string;
  name?: string;
  input?: unknown;
};
type ToolResultPart = {
  type: "tool-result" | "tool_result";
  toolUseId?: string;
  tool_use_id?: string;
  isError?: boolean;
  content?: unknown;
};
type FilePart = { type: "file"; filename?: string; path?: string };
type Part = TextPart | ToolUsePart | ToolResultPart | FilePart | { type: string };

type RawMessage = {
  info?: {
    id?: string;
    sessionID?: string;
    role?: "user" | "assistant";
    time?: { created?: number; completed?: number };
    tokens?: { input?: number; output?: number };
    model?: { providerID?: string; modelID?: string };
    error?: unknown;
  };
  parts?: Part[];
};

async function sendStats(
  sessionID: string,
  phase: string,
  startedAt: string,
  completedAt: string | undefined,
  tokensIn: number,
  tokensOut: number,
  sessionError?: string,
): Promise<void> {
  if (!WEB_STATS_URL) return;

  // Fetch full message list from opencode.
  let rawMessages: RawMessage[] = [];
  try {
    const res = await fetch(`${BASE_URL}/session/${sessionID}/message`);
    if (res.ok) rawMessages = (await res.json()) as RawMessage[];
  } catch (e) {
    err("sendStats: failed to fetch messages:", (e as Error).message);
  }

  // Build structured payloads from the raw message list.
  const messagesPayload: unknown[] = [];
  const toolCallsPayload: unknown[] = [];
  const fileOpsPayload: unknown[] = [];

  // Track tool-use parts so we can match them with tool-result parts for
  // duration estimation (opencode doesn't expose duration directly).
  const toolUseTimestamps = new Map<string, number>();

  for (let idx = 0; idx < rawMessages.length; idx++) {
    const msg = rawMessages[idx]!;
    const info = msg.info ?? {};
    const parts = msg.parts ?? [];

    // Full content as JSON — preserves all part types for LLM analysis.
    const content = JSON.stringify(parts);
    const model =
      info.model
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
      createdAt: info.time?.created
        ? new Date(info.time.created).toISOString()
        : undefined,
      completedAt: info.time?.completed
        ? new Date(info.time.completed).toISOString()
        : undefined,
    });

    // Extract tool invocations and file accesses from parts.
    for (const part of parts) {
      if (part.type === "tool-use" || part.type === "tool_use") {
        const tp = part as ToolUsePart;
        const toolId = tp.id ?? `${sessionID}-${idx}-${tp.name}`;
        toolUseTimestamps.set(toolId, info.time?.created ?? Date.now());
        toolCallsPayload.push({
          id: toolId,
          messageIdx: idx,
          tool: tp.name ?? "unknown",
          args: tp.input != null ? JSON.stringify(tp.input) : undefined,
          success: true, // assume success until tool-result says otherwise
        });

        // Detect file reads/writes from well-known tool names.
        const toolName = (tp.name ?? "").toLowerCase();
        if (
          toolName === "read" ||
          toolName === "readfile" ||
          toolName === "read_file"
        ) {
          const fp =
            (tp.input as Record<string, unknown>)?.filePath ??
            (tp.input as Record<string, unknown>)?.path;
          if (typeof fp === "string") {
            fileOpsPayload.push({ messageIdx: idx, filePath: fp, operation: "read" });
          }
        } else if (
          toolName === "write" ||
          toolName === "writefile" ||
          toolName === "write_file" ||
          toolName === "edit" ||
          toolName === "multiedit"
        ) {
          const fp =
            (tp.input as Record<string, unknown>)?.filePath ??
            (tp.input as Record<string, unknown>)?.path;
          if (typeof fp === "string") {
            fileOpsPayload.push({ messageIdx: idx, filePath: fp, operation: "write" });
          }
        }
      } else if (part.type === "tool-result" || part.type === "tool_result") {
        const rp = part as ToolResultPart;
        const refId = rp.toolUseId ?? rp.tool_use_id;
        // Update the matching tool call with error/success info.
        if (refId) {
          const existing = toolCallsPayload.find(
            (t) => (t as { id: string }).id === refId,
          ) as Record<string, unknown> | undefined;
          if (existing) {
            existing.success = !rp.isError;
            if (rp.isError) {
              existing.error =
                typeof rp.content === "string"
                  ? rp.content
                  : JSON.stringify(rp.content);
            }
            const startTs = toolUseTimestamps.get(refId);
            if (startTs && info.time?.completed) {
              existing.durationMs = info.time.completed - startTs;
            }
          }
        }
      } else if (part.type === "file") {
        const fp = part as FilePart;
        const filePath = fp.path ?? fp.filename;
        if (filePath) {
          fileOpsPayload.push({ messageIdx: idx, filePath, operation: "read" });
        }
      }
    }
  }

  const payload = {
    sessionID,
    run: {
      name: RUN_NAME,
      namespace: RUN_NAMESPACE,
      task: TASK || undefined,
      model: MODEL || undefined,
      agent: AGENT || undefined,
      phase,
      startedAt,
      completedAt,
      tokensIn,
      tokensOut,
      error: sessionError,
    },
    messages: messagesPayload,
    toolCalls: toolCallsPayload,
    fileOps: fileOpsPayload,
  };

  try {
    const res = await fetch(`${WEB_STATS_URL}/api/stats/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      err(`sendStats: web pod responded HTTP ${res.status}: ${await res.text().catch(() => "")}`);
    } else {
      log(
        `sendStats: persisted session ${sessionID} — ${messagesPayload.length} messages, ` +
          `${toolCallsPayload.length} tool calls, ${fileOpsPayload.length} file ops`,
      );
    }
  } catch (e) {
    err("sendStats: POST failed (non-fatal):", (e as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Wait for opencode serve to be healthy

async function waitForHealthy(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline && !shuttingDown) {
    try {
      const res = await fetch(`${BASE_URL}/global/health`);
      if (res.ok) {
        const body = (await res.json()) as { healthy?: boolean; version?: string };
        if (body.healthy) {
          log(`opencode server healthy, version=${body.version ?? "?"}`);
          return;
        }
      } else {
        lastErr = new Error(`HTTP ${res.status}`);
      }
    } catch (e) {
      lastErr = e;
    }
    await interruptibleSleep(1000);
  }
  if (shuttingDown) return;
  throw new Error(
    `opencode server did not become healthy within ${timeoutMs}ms: ${String(lastErr)}`,
  );
}

// ---------------------------------------------------------------------------
// Token aggregator — accumulates input/output tokens across all tracked
// sessions and debounces status patches.

class TokenAggregator {
  private bySession = new Map<string, { input: number; output: number }>();
  private lastWrite = 0;

  update(sessionID: string, input: number, output: number): void {
    const prev = this.bySession.get(sessionID) ?? { input: 0, output: 0 };
    this.bySession.set(sessionID, {
      input: Math.max(prev.input, input),
      output: Math.max(prev.output, output),
    });
  }

  totals(): { tokensIn: number; tokensOut: number } {
    let tokensIn = 0;
    let tokensOut = 0;
    for (const { input, output } of this.bySession.values()) {
      tokensIn += input;
      tokensOut += output;
    }
    return { tokensIn, tokensOut };
  }

  async flush(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastWrite < 3000) return;
    this.lastWrite = now;
    await patchStatus(this.totals());
  }
}

// ---------------------------------------------------------------------------
// Interactive mode: observe all sessions, mirror activity into CR status.
//
// - Polls GET /session every 3 s to discover sessions created by the web UI
//   or by `beatctl attach`.
// - When the first session appears, patches status with sessionID + "session active".
// - SSE /event stream updates token counts across all sessions.
// - Blocks until SIGTERM; snapshots all sessions on exit.

async function runInteractive(): Promise<void> {
  await patchStatus({
    phase: RunPhase.Running,
    startedAt: new Date().toISOString(),
    message: "waiting for attach or web session",
  });
  log("interactive mode — waiting for session via web UI or `beatctl attach`");

  const tokens = new TokenAggregator();
  let firstSessionID: string | undefined;
  const knownSessions = new Set<string>();
  let terminate = false; // set when SIGTERM arrives

  // Wire SIGTERM → terminate flag so inner loops exit.
  shutdownSignalled.then(() => { terminate = true; });

  // ------- Session discovery poller ------------------------------------------
  const discoverSessions = async (): Promise<void> => {
    while (!terminate) {
      const sessions = await listSessions();
      for (const s of sessions) {
        if (!knownSessions.has(s.id)) {
          knownSessions.add(s.id);
          log(`discovered session ${s.id}${s.title ? ` ("${s.title}")` : ""}`);
          if (!firstSessionID) {
            firstSessionID = s.id;
            await patchStatus({
              sessionID: firstSessionID,
              message: "session active",
            });
            log(`patched status sessionID=${firstSessionID}`);
          }
        }
      }
      // Also refresh token counts from any known sessions.
      for (const sessionID of knownSessions) {
        const msgs = await fetchMessages(sessionID);
        for (const msg of msgs) {
          const t = msg.info?.tokens;
          if (t?.input || t?.output) {
            tokens.update(sessionID, t.input ?? 0, t.output ?? 0);
          }
        }
      }
      await tokens.flush();
      await interruptibleSleep(3000);
    }
  };

  // ------- SSE event stream (low-latency token updates) ---------------------
  const streamEvents = async (): Promise<void> => {
    while (!terminate) {
      try {
        const evtRes = await fetch(`${BASE_URL}/event`, {
          headers: { Accept: "text/event-stream" },
        });
        if (!evtRes.ok || !evtRes.body) {
          err(`event stream failed: HTTP ${evtRes.status}; retrying in 5s`);
          await interruptibleSleep(5000);
          continue;
        }

        const reader = evtRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!terminate) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let idx;
          while ((idx = buffer.indexOf("\n\n")) >= 0) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const dataLines = raw
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trimStart());
            if (dataLines.length === 0) continue;
            let evt: { type?: string; properties?: Record<string, unknown> };
            try {
              evt = JSON.parse(dataLines.join("\n"));
            } catch {
              continue;
            }

            if (evt.type === "message.updated") {
              const p = (evt.properties ?? {}) as {
                info?: {
                  sessionID?: string;
                  tokens?: { input?: number; output?: number };
                };
              };
              const sid = p.info?.sessionID;
              if (sid) {
                // Register newly seen sessions from SSE (faster than poll).
                if (!knownSessions.has(sid)) {
                  knownSessions.add(sid);
                  log(`discovered session via SSE: ${sid}`);
                  if (!firstSessionID) {
                    firstSessionID = sid;
                    await patchStatus({
                      sessionID: firstSessionID,
                      message: "session active",
                    });
                  }
                }
                if (typeof p.info?.tokens?.input === "number")
                  tokens.update(sid, p.info.tokens.input, p.info.tokens?.output ?? 0);
                if (typeof p.info?.tokens?.output === "number")
                  tokens.update(sid, p.info.tokens?.input ?? 0, p.info.tokens.output);
                await tokens.flush();
              }
            }
          }
        }
        try { await reader.cancel(); } catch { /* ignore */ }
      } catch (e) {
        if (terminate) return;
        err("SSE stream error:", (e as Error).message, "— retrying in 5s");
        await interruptibleSleep(5000);
      }
    }
  };

  // Run both concurrently; both exit when terminate flips.
  await Promise.all([discoverSessions(), streamEvents()]);

  // Flush final token counts.
  await tokens.flush(true);

  log("interactive session ending — snapshotting all sessions");
  await snapshotAllSessions();
  // Don't mark Succeeded — the run was interactive (no automated task to complete).
  // The operator will reflect the pod's terminal phase (Cancelled/Failed/etc).
  await patchStatus({ message: "dispatcher terminated" });
}

// ---------------------------------------------------------------------------
// Prompt-driven mode: create a session, dispatch the task, observe to completion.

async function runPrompt(): Promise<void> {
  const client = createOpencodeClient({ baseUrl: BASE_URL });
  const tokens = new TokenAggregator();

  // Create a session for this run.
  const session = await client.session.create({
    body: { title: `run/${RUN_NAME}` },
  });
  const sessionID = (session.data as { id: string }).id;
  log(`created session ${sessionID}`);

  const runStartedAt = new Date().toISOString();

  await patchStatus({
    phase: RunPhase.Running,
    sessionID,
    startedAt: runStartedAt,
    message: "dispatching prompt",
  });

  const promptBody: Record<string, unknown> = {
    parts: [{ type: "text", text: TASK }],
  };
  if (AGENT) promptBody.agent = AGENT;
  if (MODEL) {
    const [providerID, ...rest] = MODEL.split("/");
    const modelID = rest.join("/");
    if (providerID && modelID) promptBody.model = { providerID, modelID };
  }

  const asyncRes = await fetch(`${BASE_URL}/session/${sessionID}/prompt_async`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(promptBody),
  });
  if (!asyncRes.ok && asyncRes.status !== 204) {
    throw new Error(`prompt_async failed: HTTP ${asyncRes.status} ${await asyncRes.text()}`);
  }
  log("prompt dispatched (async)");

  let sawBusy = false;
  let terminate = false;
  shutdownSignalled.then(() => { terminate = true; });

  // ------- Termination poller ------------------------------------------------
  const pollStatus = async (): Promise<void> => {
    const POLL_MS = 2000;
    const startedAt = Date.now();
    log("pollStatus: starting");
    await interruptibleSleep(1000);
    let iter = 0;
    while (!terminate && !shuttingDown) {
      iter++;
      try {
        const msgs = await fetchMessages(sessionID);
        const last = msgs.length > 0 ? msgs[msgs.length - 1] : undefined;
        if (iter <= 3 || iter % 10 === 0) {
          log(
            `pollStatus iter=${iter} msgs=${msgs.length} lastRole=${last?.info?.role} completed=${last?.info?.time?.completed ?? "-"}`,
          );
        }
        if (last?.info?.role === "assistant") {
          sawBusy = true;
          const t = last.info.tokens;
          if (t?.input || t?.output) {
            tokens.update(sessionID, t.input ?? 0, t.output ?? 0);
          }
          await tokens.flush();
          if (last.info.time?.completed) {
            if (last.info.error) {
              err("session ended with error:", JSON.stringify(last.info.error));
              throw new Error(`session error: ${JSON.stringify(last.info.error)}`);
            }
            log("last assistant message completed — treating as done");
            terminate = true;
            return;
          }
        }
      } catch (e) {
        if (terminate) return;
        if ((e as Error).message?.startsWith("session error:")) throw e;
        err("pollStatus iter error:", (e as Error).message);
      }
      if (Date.now() - startedAt > 30 * 60 * 1000) {
        err("pollStatus: 30 minutes elapsed without completion");
      }
      await interruptibleSleep(POLL_MS);
    }
  };

  // ------- Event stream (progress only) --------------------------------------
  const streamEvents = async (): Promise<void> => {
    const evtRes = await fetch(`${BASE_URL}/event`, {
      headers: { Accept: "text/event-stream" },
    });
    if (!evtRes.ok || !evtRes.body) {
      err(`event stream failed: HTTP ${evtRes.status}; continuing on polling only`);
      return;
    }

    const reader = evtRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (!terminate) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLines = raw
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart());
        if (dataLines.length === 0) continue;
        let evt: { type?: string; properties?: Record<string, unknown> };
        try {
          evt = JSON.parse(dataLines.join("\n"));
        } catch {
          continue;
        }

        if (evt.type === "message.updated") {
          const p = (evt.properties ?? {}) as {
            info?: {
              sessionID?: string;
              tokens?: { input?: number; output?: number };
            };
          };
          if (p.info?.sessionID === sessionID) {
            if (typeof p.info.tokens?.input === "number")
              tokens.update(sessionID, p.info.tokens.input, p.info.tokens?.output ?? 0);
            if (typeof p.info.tokens?.output === "number")
              tokens.update(sessionID, p.info.tokens?.input ?? 0, p.info.tokens.output);
            await tokens.flush();
          }
        }
      }
    }
    try { await reader.cancel(); } catch { /* ignore */ }
  };

  const hardTimeout = setTimeout(() => {
    err("dispatcher hit its own timeout guard");
    process.exit(3);
  }, 3_600_000);
  hardTimeout.unref();

  await Promise.race([pollStatus(), streamEvents()]);
  terminate = true;
  clearTimeout(hardTimeout);

  if (shuttingDown) {
    log("shutting down mid-run; not claiming Succeeded");
    await snapshotAllSessions();
    await patchStatus({ message: "dispatcher terminated" });
    return;
  }

  await tokens.flush(true);
  void sawBusy; // accessed above, suppress unused warning

  await snapshotAllSessions();

  const completedAt = new Date().toISOString();
  const { tokensIn, tokensOut } = tokens.totals();

  // Send full session stats to web pod for persistent analytics (best-effort).
  await sendStats(
    sessionID,
    RunPhase.Succeeded,
    runStartedAt,
    completedAt,
    tokensIn,
    tokensOut,
  );

  await patchStatus({
    phase: RunPhase.Succeeded,
    message: "session completed",
    completedAt,
  });
  log("done");
}

// ---------------------------------------------------------------------------
// Main

async function main(): Promise<void> {
  await patchStatus({ phase: RunPhase.Initializing, message: "waiting for opencode" });
  await waitForHealthy();

  if (INTERACTIVE) {
    await runInteractive();
  } else {
    await runPrompt();
  }
}

main().catch(async (e) => {
  if (shuttingDown) {
    log("shutdown in progress; suppressing fatal:", (e as Error).message ?? e);
    process.exit(0);
  }
  err("fatal:", e);
  try {
    await patchStatus({
      phase: RunPhase.Failed,
      message: String((e as Error).message ?? e),
      completedAt: new Date().toISOString(),
    });
  } catch {
    /* best effort */
  }
  process.exit(1);
});
