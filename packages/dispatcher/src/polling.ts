// polling.ts — prompt-mode and interactive-mode polling loops.

import { RunPhase } from "@percussionist/api";
import { BASE_URL, listSessions, fetchMessages, checkHealth, compactMessagesForSnapshot } from "./session.js";
import http from "node:http";
import { sendStats, incrementalFlush } from "./stats-reporter.js";
import type { RawMessage } from "./session.js";

const log = (...args: unknown[]) =>
  console.log(`[dispatcher ${new Date().toISOString()}]`, ...args);
const err = (...args: unknown[]) =>
  console.error(`[dispatcher ${new Date().toISOString()}]`, ...args);

function logEvent(evt: { type?: string; properties?: Record<string, unknown> }): void {
  if (!evt.type || evt.type === "server.connected") return;
  const p = evt.properties ?? {};
  const info = p.info as { sessionID?: string; id?: string; role?: string; tokens?: { input?: number; output?: number } } | undefined;
  const pieces = [
    info?.sessionID ? `session=${info.sessionID}` : undefined,
    info?.id ? `message=${info.id}` : undefined,
    info?.role ? `role=${info.role}` : undefined,
    typeof info?.tokens?.input === "number" ? `tokens=${info.tokens.input}/${info.tokens.output ?? 0}` : undefined,
  ].filter(Boolean);
  log(`[event] ${evt.type}${pieces.length ? ` ${pieces.join(" ")}` : ""}`);
}

function maybeLogStreamReconnect(mode: "interactive" | "prompt", reconnects: number): void {
  if (reconnects === 1 || reconnects % 60 === 0) {
    log(`[event] ${mode} SSE stream reconnected ${reconnects} time(s); OpenCode may be closing /event after server.connected`);
  }
}

const RUN_NAME = process.env.RUN_NAME ?? "";
const MODEL = process.env.RUN_MODEL ?? "";
const AGENT = process.env.RUN_AGENT ?? "";
const TASK = process.env.RUN_TASK ?? "";
// Allow up to 1 hour for the model to produce its first assistant response.
// POST /session/{id}/message may remain open while opencode processes the
// model request, so the dispatcher starts it asynchronously and relies on the
// poll loop to enforce this first-response deadline.
const FIRST_RESPONSE_TIMEOUT_MS = 3_600_000;
const HARD_TIMEOUT_MS = FIRST_RESPONSE_TIMEOUT_MS + 300_000;

// ---------------------------------------------------------------------------
// Token aggregator

export class TokenAggregator {
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

  async flush(
    patchStatus: (p: object) => Promise<void>,
    force = false,
  ): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastWrite < 3000) return;
    this.lastWrite = now;
    await patchStatus(this.totals());
  }
}

// ---------------------------------------------------------------------------
// Session snapshot

const CM_MAX_BYTES = 900_000;

export async function snapshotAllSessions(
  coreApi: import("@kubernetes/client-node").CoreV1Api,
  runName: string,
  runNamespace: string,
  runUid: string,
  knownSessionID?: string,
): Promise<void> {
  const { API_GROUP_VERSION, KIND_RUN } = await import("@percussionist/api");
  const { PatchStrategy, setHeaderOptions } = await import("@kubernetes/client-node");

  let sessions = await listSessions();
  if (sessions.length === 0 && knownSessionID) {
    // opencode may already be shut down; fall back to snapshotting the known session.
    log(`snapshotAllSessions: listSessions() returned empty, falling back to knownSessionID ${knownSessionID}`);
    sessions = [{ id: knownSessionID }];
  }
  if (sessions.length === 0) return;

  log(`snapshotAllSessions: snapshotting ${sessions.length} session(s)`);
  const perSessionBudget = Math.floor(CM_MAX_BYTES / sessions.length);
  const cmData: Record<string, string> = {
    "sessions.json": JSON.stringify(sessions.map((s) => s.id)),
  };

  for (const session of sessions) {
    let messages = compactMessagesForSnapshot(await fetchMessages(session.id));
    let json = JSON.stringify(messages);
    let truncated = false;
    while (Buffer.byteLength(json, "utf8") > perSessionBudget && messages.length > 1) {
      truncated = true;
      messages = messages.slice(1);
      json = JSON.stringify(messages);
    }
    cmData[`messages-${session.id}.json`] = json;
    if (truncated) cmData[`truncated-${session.id}`] = "true";
  }

  const cmMeta = {
    name: `${runName}-session`,
    namespace: runNamespace,
    labels: {
      "app.kubernetes.io/managed-by": "percussionist",
      "percussionist.dev/run-name": runName,
      "percussionist.dev/component": "session-snapshot",
    },
    ownerReferences: [
      {
        apiVersion: API_GROUP_VERSION,
        kind: KIND_RUN,
        name: runName,
        uid: runUid,
        controller: true,
        blockOwnerDeletion: true,
      },
    ],
  };

  try {
    await coreApi.createNamespacedConfigMap({
      namespace: runNamespace,
      body: { apiVersion: "v1", kind: "ConfigMap", metadata: cmMeta, data: cmData },
    });
    log(`snapshotAllSessions: created ConfigMap ${runName}-session`);
  } catch (createErr) {
    if (!/already exists/i.test((createErr as Error).message)) {
      err("snapshotAllSessions: create failed:", (createErr as Error).message);
      return;
    }
    try {
      await coreApi.patchNamespacedConfigMap(
        { name: `${runName}-session`, namespace: runNamespace, body: { data: cmData } },
        setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
      );
    } catch (patchErr) {
      err("snapshotAllSessions: patch failed:", (patchErr as Error).message);
    }
  }
}

// ---------------------------------------------------------------------------
// Interactive mode

export async function runInteractive(
  patchStatus: (p: object) => Promise<void>,
  isShuttingDown: () => boolean,
  sleep: (ms: number) => Promise<void>,
  coreApi: import("@kubernetes/client-node").CoreV1Api,
  runName: string,
  runNamespace: string,
  runUid: string,
): Promise<void> {
  await patchStatus({
    phase: RunPhase.Running,
    startedAt: new Date().toISOString(),
    message: "waiting for attach or web session",
  });
  log("interactive mode — waiting for session via web UI or `beatctl attach`");

  const tokens = new TokenAggregator();
  let firstSessionID: string | undefined;
  const knownSessions = new Set<string>();
  let terminate = false;
  let snapshotPending = false;
  let hasSnapshotted = false;
  let interactiveFlushCursor = 0;
  const interactiveStartedAt = new Date().toISOString();

  // Fire a single best-effort snapshot (deduped with a flag to avoid overlap).
  const maybeSnapshot = (reason: string): void => {
    if (snapshotPending) return;
    snapshotPending = true;
    snapshotAllSessions(coreApi, runName, runNamespace, runUid, firstSessionID)
      .then(() => { hasSnapshotted = true; })
      .catch((e) => err(`snapshot (${reason}) failed:`, (e as Error).message))
      .finally(() => { snapshotPending = false; });
  };

  const discoverSessions = async (): Promise<void> => {
    while (!terminate) {
      const sessions = await listSessions();
      for (const s of sessions) {
          if (!knownSessions.has(s.id)) {
            knownSessions.add(s.id);
            log(`discovered session ${s.id}`);
            if (!firstSessionID) {
              firstSessionID = s.id;
              await patchStatus({ sessionID: firstSessionID, message: "session active" });
              // Snapshot immediately on first session discovery.
              maybeSnapshot("session discovered");
            }
          }
      }
      for (const sessionID of knownSessions) {
        const msgs = await fetchMessages(sessionID);
        for (const msg of msgs) {
          const t = msg.info?.tokens;
          if (t?.input || t?.output) tokens.update(sessionID, t.input ?? 0, t.output ?? 0);
        }
      }
      await tokens.flush(patchStatus);
      await sleep(3000);
    }
  };

  const streamEvents = async (): Promise<void> => {
    let streamErrors = 0;
    let reconnects = 0;
    while (!terminate) {
      try {
        if (reconnects > 0) maybeLogStreamReconnect("interactive", reconnects);
        const evtRes = await fetch(`${BASE_URL}/event`, { headers: { Accept: "text/event-stream" } });
        reconnects++;
        if (!evtRes.ok || !evtRes.body) { await sleep(5000); continue; }
        streamErrors = 0;
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
            const dataLines = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart());
            if (dataLines.length === 0) continue;
            let evt: { type?: string; properties?: Record<string, unknown> };
            try { evt = JSON.parse(dataLines.join("\n")); } catch { continue; }
            logEvent(evt);
            if (evt.type === "session.status") {
              // Snapshot after the first assistant turn completes.
              const p = evt.properties as { busy?: boolean } | undefined;
              if (p?.busy === false && !hasSnapshotted) maybeSnapshot("first idle");
              // Incremental DB flush on each completed turn.
              if (p?.busy === false && firstSessionID) {
                const sid = firstSessionID;
                const { tokensIn, tokensOut } = tokens.totals();
                incrementalFlush(sid, interactiveStartedAt, tokensIn, tokensOut, interactiveFlushCursor)
                  .then((newCursor) => { interactiveFlushCursor = newCursor; })
                  .catch((e) => err("interactive incrementalFlush failed (non-fatal):", (e as Error).message));
              }
            }
            if (evt.type === "message.updated") {
              const p = (evt.properties ?? {}) as { info?: { sessionID?: string; tokens?: { input?: number; output?: number } } };
              const sid = p.info?.sessionID;
              if (sid) {
                if (!knownSessions.has(sid)) {
                  knownSessions.add(sid);
                  if (!firstSessionID) {
                    firstSessionID = sid;
                    await patchStatus({ sessionID: firstSessionID, message: "session active" });
                  }
                }
                if (typeof p.info?.tokens?.input === "number")
                  tokens.update(sid, p.info.tokens.input, p.info.tokens?.output ?? 0);
                await tokens.flush(patchStatus);
              }
            }
          }
        }
        try { await reader.cancel(); } catch { /* ignore */ }
      } catch (e) {
        if (terminate) return;
        streamErrors++;
        err("SSE stream error:", (e as Error).message, `(${streamErrors}/5)`);
        if (streamErrors >= 5) {
          throw new Error("opencode server unreachable: stream disconnected");
        }
        await sleep(5000);
      }
      // Add delay between all reconnection attempts (success or error) to prevent runaway loops
      if (!terminate) await sleep(1000);
    }
  };

  const shutdown = new Promise<void>((resolve) => {
    const check = setInterval(() => { if (isShuttingDown()) { terminate = true; clearInterval(check); resolve(); } }, 500);
  });

  // Periodic snapshot every 2 minutes as a safety net for long interactive sessions.
  const periodicInteractiveSnapshot = async (): Promise<void> => {
    while (!terminate) {
      await sleep(120_000);
      if (!terminate && firstSessionID) maybeSnapshot("periodic");
    }
  };

  await Promise.race([Promise.all([discoverSessions(), streamEvents(), periodicInteractiveSnapshot()]), shutdown]);
  terminate = true;

  await tokens.flush(patchStatus, true);
  log("interactive session ending — snapshotting");
  await snapshotAllSessions(coreApi, runName, runNamespace, runUid);
  await patchStatus({ message: "dispatcher terminated" });
}

// ---------------------------------------------------------------------------
// HTTP helper with custom socket timeout (bypasses undici's default 300s
// headersTimeout that can't be configured from user code).

async function httpJsonPost(
  url: string,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }> {
  const u = new URL(url);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port === "" ? undefined : Number(u.port),
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
        signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          const status = res.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            json: () => Promise.resolve(JSON.parse(text)),
            text: () => Promise.resolve(text),
          });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error(`Request timeout after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Prompt-driven mode

export async function runPrompt(
  patchStatus: (p: object) => Promise<void>,
  isShuttingDown: () => boolean,
  sleep: (ms: number) => Promise<void>,
  coreApi: import("@kubernetes/client-node").CoreV1Api,
  runName: string,
  runNamespace: string,
  runUid: string,
  failureSignal: Promise<string>,
  completionSignal: Promise<string>,
): Promise<{ sessionID: string; startedAt: string }> {
  const tokens = new TokenAggregator();

  const sessionRes = await fetch(`${BASE_URL}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: `run/${runName}` }),
  });
  if (!sessionRes.ok) throw new Error(`Failed to create session: HTTP ${sessionRes.status}`);
  const sessionData = (await sessionRes.json()) as { id: string };
  const sessionID = sessionData.id;
  log(`created session ${sessionID}`);

  const runStartedAt = new Date().toISOString();
  await patchStatus({ phase: RunPhase.Running, sessionID, startedAt: runStartedAt, message: "dispatching prompt" });

  const promptBody: Record<string, unknown> = { parts: [{ type: "text", text: TASK }] };
  if (AGENT) promptBody.agent = AGENT;
  if (MODEL) {
    const slashIdx = MODEL.indexOf("/");
    if (slashIdx !== -1) {
      promptBody.model = { providerID: MODEL.slice(0, slashIdx), modelID: MODEL.slice(slashIdx + 1) };
    } else {
      promptBody.model = { modelID: MODEL };
    }
  }

  let sawBusy = false; // set true only when poll loop sees first assistant message
  let waitingForInput = false;
  let terminate = false;
  let promptFlushCursor = 0;

  // Transient error codes that warrant a retry of the prompt POST.
  const RETRYABLE_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EPIPE", "ETIMEDOUT"]);
  const MAX_PROMPT_RETRIES = 3;

  const promptPostController = new AbortController();

  // Retry wrapper around httpJsonPost: on transient network errors, wait for
  // opencode to become healthy, check whether the session already has messages
  // (prompt was received before the disconnect), and re-POST only if not.
  const promptPost = (async () => {
    let attempt = 0;
    while (true) {
      try {
        const syncRes = await httpJsonPost(
          `${BASE_URL}/session/${sessionID}/message`,
          promptBody,
          FIRST_RESPONSE_TIMEOUT_MS,
          promptPostController.signal,
        );
        if (!syncRes.ok) {
          throw new Error(`prompt failed: HTTP ${syncRes.status} ${await syncRes.text()}`);
        }
        const syncData = (await syncRes.json()) as { info?: Record<string, unknown>; parts?: unknown[] };
        const syncTokensIn = (syncData.info?.tokens as { input?: number })?.input ?? 0;
        const syncTokensOut = (syncData.info?.tokens as { output?: number })?.output ?? 0;
        if (syncTokensIn > 0 || syncTokensOut > 0) {
          tokens.update(sessionID, syncTokensIn, syncTokensOut);
          await tokens.flush(patchStatus);
        }
        log("prompt completed (sync)", JSON.stringify(syncData.info));
        return;
      } catch (e) {
        if (terminate || promptPostController.signal.aborted) return;
        const code = (e as NodeJS.ErrnoException).code ?? "";
        const isRetryable = RETRYABLE_CODES.has(code) || (e as Error).message?.includes("socket hang up");
        if (!isRetryable || attempt >= MAX_PROMPT_RETRIES) throw e;
        attempt++;
        err(`prompt POST failed (${(e as Error).message}), retrying (${attempt}/${MAX_PROMPT_RETRIES})…`);
        // Wait for opencode to be healthy before re-checking / re-posting.
        await sleep(5000);
        // Check whether the prompt was already received (session has messages).
        // If so there's nothing to re-POST — the poll loop will handle completion.
        try {
          const existingMsgs = await fetchMessages(sessionID);
          if (existingMsgs.length > 0) {
            log(`prompt POST failed but session already has ${existingMsgs.length} message(s) — skipping re-POST`);
            return;
          }
        } catch { /* ignore — we'll retry the POST regardless */ }
        log(`re-posting prompt (attempt ${attempt}/${MAX_PROMPT_RETRIES})`);
      }
    }
  })();
  const promptPostFailure = promptPost.then(() => new Promise<void>(() => {}));

  const pollStatus = async (): Promise<void> => {
    const POLL_MS = 2000;
    const startedAt = Date.now();
    await sleep(1000);
    let iter = 0;
    let unhealthyCount = 0;
    while (!terminate && !isShuttingDown()) {
      iter++;
      try {
        const msgs = await fetchMessages(sessionID);
        const last = msgs.length > 0 ? msgs[msgs.length - 1] : undefined;

        // Periodic health check every 10s (5 iterations). If opencode is
        // OOM-killed this detects it faster than waiting for stream failure.
        if (iter % 5 === 0) {
          const healthy = await checkHealth();
          if (!healthy) {
            unhealthyCount++;
            if (unhealthyCount >= 3) {
              throw new Error("opencode server unreachable: health check failed");
            }
          } else {
            unhealthyCount = 0;
          }
        }

        const elapsedSinceStart = Date.now() - startedAt;
        if (!sawBusy && elapsedSinceStart > FIRST_RESPONSE_TIMEOUT_MS) {
          throw new Error(`opencode did not produce an assistant response within ${FIRST_RESPONSE_TIMEOUT_MS / 1000}s of dispatch`);
        }

        if (last?.info?.role === "assistant") {
          sawBusy = true;
          const t = last.info.tokens;
          if (t?.input || t?.output) tokens.update(sessionID, t.input ?? 0, t.output ?? 0);
          await tokens.flush(patchStatus);
          if (last.info.time?.completed) {
            // Check for errors first, before any other logic
            if (last.info.error) {
              // A MessageAbortedError means the user manually aborted the message.
              // Treat it as "waiting for input" so the run can continue rather
              // than failing — the next prompt dispatch will resume the session.
              if ((last.info.error as { name?: string }).name === "MessageAbortedError") {
                log("assistant message aborted by user — treating as waiting for input");
                waitingForInput = true;
              } else {
                throw new Error(`session error: ${JSON.stringify(last.info.error)}`);
              }
            }

            const totalTokens = tokens.totals();
            if (waitingForInput) {
              if (totalTokens.tokensIn > 0 || totalTokens.tokensOut > 0) {
                waitingForInput = false;
              }
            } else if (totalTokens.tokensIn === 0 && totalTokens.tokensOut === 0) {
              if (!sawBusy) {
                throw new Error("opencode produced an assistant response with zero token usage before any work was done");
              }
              waitingForInput = true;
            } else {
              log("last assistant message completed — done");
              terminate = true;
              return;
            }
          }
        }
      } catch (e) {
        if (terminate) return;
        if ((e as Error).message?.startsWith("session error:")) throw e;
        err("pollStatus iter error:", (e as Error).message);
      }
      await sleep(POLL_MS);
    }
  };

  const streamEvents = async (): Promise<void> => {
    let streamErrors = 0;
    let reconnects = 0;
    while (!terminate) {
      try {
        if (reconnects > 0) maybeLogStreamReconnect("prompt", reconnects);
        const evtRes = await fetch(`${BASE_URL}/event`, { headers: { Accept: "text/event-stream" } });
        reconnects++;
        if (!evtRes.ok || !evtRes.body) { await sleep(5000); continue; }
        streamErrors = 0;
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
            const dataLines = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart());
            if (dataLines.length === 0) continue;
            let evt: { type?: string; properties?: Record<string, unknown> };
            try { evt = JSON.parse(dataLines.join("\n")); } catch { continue; }
            logEvent(evt);
            if ((evt.type === "permission.updated" || evt.type === "session.idle") && !waitingForInput) {
              waitingForInput = true;
              // Snapshot sessions immediately when entering WaitingForInput so
              // the manager can read the conversation context even if this pod
              // is killed while waiting.
              snapshotAllSessions(coreApi, runName, runNamespace, runUid, sessionID).catch((e) =>
                err("WaitingForInput snapshot failed:", (e as Error).message),
              );
            }
            if (evt.type === "session.status") {
              // Incremental DB flush after each completed assistant turn.
              const p = evt.properties as { busy?: boolean } | undefined;
              if (p?.busy === false) {
                const { tokensIn, tokensOut } = tokens.totals();
                incrementalFlush(sessionID, runStartedAt, tokensIn, tokensOut, promptFlushCursor)
                  .then((newCursor) => { promptFlushCursor = newCursor; })
                  .catch((e) => err("prompt incrementalFlush failed (non-fatal):", (e as Error).message));
              }
            }
            if (evt.type === "message.updated") {
              const p = (evt.properties ?? {}) as { info?: { sessionID?: string; tokens?: { input?: number; output?: number } } };
              if (p.info?.sessionID === sessionID) {
                if (typeof p.info.tokens?.input === "number")
                  tokens.update(sessionID, p.info.tokens.input, p.info.tokens?.output ?? 0);
                await tokens.flush(patchStatus);
              }
            }
          }
        }
        try { await reader.cancel(); } catch { /* ignore */ }
      } catch (e) {
        if (terminate) return;
        streamErrors++;
        err("SSE stream error:", (e as Error).message, `(${streamErrors}/5)`);
        if (streamErrors >= 5) {
          throw new Error("opencode server unreachable: stream disconnected");
        }
        await sleep(5000);
      }
      // Add delay between all reconnection attempts (success or error) to prevent runaway loops
      if (!terminate) await sleep(1000);
    }
  };

  const hardTimeout = setTimeout(() => { err("dispatcher timeout guard"); process.exit(3); }, HARD_TIMEOUT_MS);
  hardTimeout.unref();
  void streamEvents().catch((e) => { if (!terminate) err("streamEvents fatal:", (e as Error).message); });

  // Periodic snapshot every 30s for visibility during long-running tasks.
  // First iteration fires immediately (no initial delay) to capture early state.
  const periodicSnapshot = async (): Promise<void> => {
    let first = true;
    while (!terminate) {
      if (!first) await sleep(30_000);
      first = false;
      if (!terminate) {
        snapshotAllSessions(coreApi, runName, runNamespace, runUid, sessionID).catch((e) =>
          err("periodic snapshot failed:", (e as Error).message),
        );
      }
    }
  };
  void periodicSnapshot().catch((e) => { if (!terminate) err("periodicSnapshot fatal:", (e as Error).message); });

  // Race the normal poll loop against:
  // - fail_run: agent signals failure → throw "session error:" → Failed
  // - complete_run: agent signals explicit success → succeed immediately
  // If fail_run wins, throw a "session error:" so the standard failure
  // path in main().catch patches status to Failed.
  // If complete_run wins, resolve normally — the caller patches Succeeded
  // with the agent's summary as the completion message.
  let agentCompletionSummary: string | undefined;
  const failureRaced = failureSignal.then((reason) => {
    terminate = true;
    throw new Error(`session error: agent signalled failure — ${reason}`);
  });
  const completionRaced = completionSignal.then((summary) => {
    terminate = true;
    agentCompletionSummary = summary;
    log(`complete_run called by agent: ${summary}`);
  });
  // Capture any failure thrown by pollStatus() or failureRaced so we can
  // still snapshot + persist stats before re-throwing.
  let raceError: Error | undefined;
  try {
    await Promise.race([pollStatus(), promptPostFailure, failureRaced, completionRaced]);
  } catch (e) {
    if ((e as Error).name !== "AbortError") raceError = e as Error;
  }
  terminate = true;
  promptPostController.abort();
  clearTimeout(hardTimeout);

  if (isShuttingDown()) {
    log("shutting down mid-run");
    await snapshotAllSessions(coreApi, runName, runNamespace, runUid, sessionID);
    await patchStatus({ message: "dispatcher terminated" });
    return { sessionID, startedAt: runStartedAt };
  }

  // Always flush tokens, snapshot, and persist stats — whether the run
  // succeeded or failed.  This ensures the manager always has a ConfigMap
  // to read for facilitation context and SQLite always has a record.
  await tokens.flush(patchStatus, true);
  await snapshotAllSessions(coreApi, runName, runNamespace, runUid, sessionID);

  const completedAt = new Date().toISOString();
  const { tokensIn, tokensOut } = tokens.totals();

  if (raceError) {
    await sendStats(
      sessionID,
      RunPhase.Failed,
      runStartedAt,
      completedAt,
      tokensIn,
      tokensOut,
      raceError.message,
    );
    throw raceError;
  }

  await sendStats(sessionID, RunPhase.Succeeded, runStartedAt, completedAt, tokensIn, tokensOut);
  const completionMessage = agentCompletionSummary
    ? `agent signalled completion — ${agentCompletionSummary}`
    : "session completed";
  await patchStatus({ phase: RunPhase.Succeeded, message: completionMessage, completedAt });
  log("done");

  return { sessionID, startedAt: runStartedAt };
}
