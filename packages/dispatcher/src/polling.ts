// polling.ts — prompt-mode and interactive-mode polling loops.

import { createOpencodeClient } from "@opencode-ai/sdk";
import { RunPhase } from "@percussionist/api";
import { BASE_URL, listSessions, fetchMessages } from "./session.js";
import { sendStats } from "./stats-reporter.js";
import type { RawMessage } from "./session.js";

const log = (...args: unknown[]) =>
  console.log(`[dispatcher ${new Date().toISOString()}]`, ...args);
const err = (...args: unknown[]) =>
  console.error(`[dispatcher ${new Date().toISOString()}]`, ...args);

const RUN_NAME = process.env.RUN_NAME ?? "";
const MODEL = process.env.RUN_MODEL ?? "";
const AGENT = process.env.RUN_AGENT ?? "";
const TASK = process.env.RUN_TASK ?? "";
// Derive the first-response deadline from the run's configured timeout. If the
// run has a long timeout (e.g. large repo clone), give the model up to half
// that time to produce its first assistant response; minimum 90 s, maximum 600 s.
const RUN_TIMEOUT_S = parseInt(process.env.RUN_TIMEOUT_SECONDS ?? "3600", 10);
const FIRST_RESPONSE_TIMEOUT_MS = Math.min(600_000, Math.max(90_000, Math.floor(RUN_TIMEOUT_S / 2) * 1000));

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
): Promise<void> {
  const { API_GROUP_VERSION, KIND_RUN } = await import("@percussionist/api");
  const { PatchStrategy, setHeaderOptions } = await import("@kubernetes/client-node");

  const sessions = await listSessions();
  if (sessions.length === 0) return;

  log(`snapshotAllSessions: snapshotting ${sessions.length} session(s)`);
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
    while (!terminate) {
      try {
        const evtRes = await fetch(`${BASE_URL}/event`, { headers: { Accept: "text/event-stream" } });
        if (!evtRes.ok || !evtRes.body) { await sleep(5000); continue; }
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
        err("SSE stream error:", (e as Error).message, "— retrying in 5s");
        await sleep(5000);
      }
    }
  };

  const shutdown = new Promise<void>((resolve) => {
    const check = setInterval(() => { if (isShuttingDown()) { terminate = true; clearInterval(check); resolve(); } }, 500);
  });
  await Promise.race([Promise.all([discoverSessions(), streamEvents()]), shutdown]);
  terminate = true;

  await tokens.flush(patchStatus, true);
  log("interactive session ending — snapshotting");
  await snapshotAllSessions(coreApi, runName, runNamespace, runUid);
  await patchStatus({ message: "dispatcher terminated" });
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
): Promise<{ sessionID: string; startedAt: string }> {
  const client = createOpencodeClient({ baseUrl: BASE_URL });
  const tokens = new TokenAggregator();

  const session = await client.session.create({ body: { title: `run/${runName}` } });
  const sessionID = (session.data as { id: string }).id;
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
  let waitingForInput = false;
  let terminate = false;

  const pollStatus = async (): Promise<void> => {
    const POLL_MS = 2000;
    const startedAt = Date.now();
    await sleep(1000);
    let iter = 0;
    while (!terminate && !isShuttingDown()) {
      iter++;
      try {
        const msgs = await fetchMessages(sessionID);
        const last = msgs.length > 0 ? msgs[msgs.length - 1] : undefined;

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
            const totalTokens = tokens.totals();
            if (waitingForInput) {
              if (totalTokens.tokensIn > 0 || totalTokens.tokensOut > 0) {
                waitingForInput = false;
              }
            } else if (last.info.error) {
              throw new Error(`session error: ${JSON.stringify(last.info.error)}`);
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
    while (!terminate) {
      try {
        const evtRes = await fetch(`${BASE_URL}/event`, { headers: { Accept: "text/event-stream" } });
        if (!evtRes.ok || !evtRes.body) { await sleep(5000); continue; }
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
            if ((evt.type === "permission.updated" || evt.type === "session.idle") && !waitingForInput) {
              waitingForInput = true;
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
        await sleep(5000);
      }
    }
  };

  const hardTimeout = setTimeout(() => { err("dispatcher timeout guard"); process.exit(3); }, 3_600_000);
  hardTimeout.unref();
  void streamEvents().catch((e) => { if (!terminate) err("streamEvents fatal:", (e as Error).message); });
  await pollStatus();
  terminate = true;
  clearTimeout(hardTimeout);

  if (isShuttingDown()) {
    log("shutting down mid-run");
    await snapshotAllSessions(coreApi, runName, runNamespace, runUid);
    await patchStatus({ message: "dispatcher terminated" });
    return { sessionID, startedAt: runStartedAt };
  }

  await tokens.flush(patchStatus, true);
  await snapshotAllSessions(coreApi, runName, runNamespace, runUid);

  const completedAt = new Date().toISOString();
  const { tokensIn, tokensOut } = tokens.totals();
  await sendStats(sessionID, RunPhase.Succeeded, runStartedAt, completedAt, tokensIn, tokensOut);
  await patchStatus({ phase: RunPhase.Succeeded, message: "session completed", completedAt });
  log("done");

  return { sessionID, startedAt: runStartedAt };
}
