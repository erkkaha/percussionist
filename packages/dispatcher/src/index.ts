// Dispatcher sidecar.
//
// Runs alongside `opencode serve` inside an OpenCodeRun pod. Responsibilities:
//   1. Wait for the server to be reachable on 127.0.0.1:4096 (auth via
//      OPENCODE_SERVER_PASSWORD).
//   2. Create a session, fire the task as a prompt (async — server does the
//      work; we don't block on the model roundtrip).
//   3. Subscribe to /event SSE, mirror interesting events into the
//      OpenCodeRun status subresource (phase, sessionID, lastEventAt, token
//      counters).
//   4. Exit 0 when the session reports idle after completion, non-zero on
//      error. The Job controller then marks the Job Complete / Failed and
//      the operator reflects that into the CR terminal phase.
//
// Environment (injected by the operator):
//   RUN_NAME, RUN_NAMESPACE         — which CR to update
//   OPENCODE_BASE_URL               — http://127.0.0.1:4096 (same pod)
//   OPENCODE_SERVER_USERNAME        — defaults to "opencode"
//   OPENCODE_SERVER_PASSWORD        — matches the opencode container
//   RUN_TASK                        — the prompt text
//   RUN_MODEL                       — optional, "provider/model"
//   RUN_AGENT                       — optional

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
const USERNAME = env("OPENCODE_SERVER_USERNAME", false) || "opencode";
const PASSWORD = env("OPENCODE_SERVER_PASSWORD");
// In interactive mode the operator leaves RUN_TASK unset on purpose.
const INTERACTIVE = env("RUN_INTERACTIVE", false) === "1";
const TASK = env("RUN_TASK", !INTERACTIVE);
const MODEL = env("RUN_MODEL", false);
const AGENT = env("RUN_AGENT", false);

const log = (...args: unknown[]) =>
  console.log(`[dispatcher ${new Date().toISOString()}]`, ...args);
const err = (...args: unknown[]) =>
  console.error(`[dispatcher ${new Date().toISOString()}]`, ...args);

const authHeader = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64")}`;

// ---------------------------------------------------------------------------
// Graceful shutdown
//
// kubelet sends SIGTERM when a pod is being deleted (user ran
// `beatctl cancel`, CR was removed, activeDeadlineSeconds fired, etc).
// Without a handler we'd keep sleeping/polling until the 30s grace period
// runs out and kubelet SIGKILLs us — visible as "pod takes forever to
// terminate". Install a handler that flips a shared flag, patches a final
// "shutting down" status, and exits 0. Long-running waits in main() check
// `shuttingDown` to exit their loops promptly.

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

// Sleep that wakes early if a shutdown signal arrives. Use this in loops
// so we don't spend the tail end of a poll interval blocking on
// setTimeout after SIGTERM.
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
kc.loadFromDefault(); // in-cluster service account when running in a pod
const k8s = kc.makeApiClient(CustomObjectsApi);
const coreApi = kc.makeApiClient(CoreV1Api);

async function patchStatus(patch: OpenCodeRunStatus): Promise<void> {
  // Merge-patch against the /status subresource. The CRD enables the status
  // subresource, so writing spec fields from here is ignored by the API
  // server even if accidentally included.
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
// Session snapshot — persist conversation to a ConfigMap
//
// After the session finishes successfully the dispatcher writes the full
// message list to a ConfigMap named `<runName>-session`. This lets the web
// dashboard render the conversation even after the runner pod has been
// deleted. The ConfigMap is owned by the OpenCodeRun CR so it gets GC'd
// together with the rest of the child resources.
//
// ConfigMaps have a 1 MiB etcd limit. If the payload is larger we truncate
// old messages until it fits and include a truncation marker.

const CM_MAX_BYTES = 900_000; // leave headroom under the 1 MiB etcd limit

async function snapshotSession(sessionID: string): Promise<void> {
  log("snapshotSession: fetching messages");
  const res = await fetch(`${BASE_URL}/session/${sessionID}/message`, {
    headers: { Authorization: authHeader },
  });
  if (!res.ok) {
    err(`snapshotSession: GET /message failed HTTP ${res.status}`);
    return;
  }
  let messages: unknown[] = (await res.json()) as unknown[];
  let json = JSON.stringify(messages);

  // Truncate from the front (oldest messages) if too large.
  let truncated = false;
  while (Buffer.byteLength(json, "utf8") > CM_MAX_BYTES && messages.length > 1) {
    truncated = true;
    messages = messages.slice(1);
    json = JSON.stringify(messages);
  }

  const cmData: Record<string, string> = { "messages.json": json };
  if (truncated) {
    cmData["truncated"] = "true";
  }

  try {
    await coreApi.createNamespacedConfigMap({
      namespace: RUN_NAMESPACE,
      body: {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: {
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
        },
        data: cmData,
      },
    });
    log(`snapshotSession: created ConfigMap ${RUN_NAME}-session (${Buffer.byteLength(json, "utf8")} bytes${truncated ? ", truncated" : ""})`);
  } catch (e) {
    err("snapshotSession: failed to create ConfigMap:", (e as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Wait for opencode serve to be healthy

async function waitForHealthy(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline && !shuttingDown) {
    try {
      const res = await fetch(`${BASE_URL}/global/health`, {
        headers: { Authorization: authHeader },
      });
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
// Main

async function main(): Promise<void> {
  await patchStatus({ phase: RunPhase.Initializing, message: "waiting for opencode" });
  await waitForHealthy();

  if (INTERACTIVE) {
    // Interactive mode: don't create a session or dispatch any prompt. The
    // runner container keeps `opencode serve` alive; the user connects via
    // `beatctl attach` and drives the session by hand.
    //
    // We still want the CR to show a sensible phase so `beatctl ls` looks
    // right. Use Running + a clear message. The dispatcher then sleeps
    // until SIGTERM (CR deletion) or activeDeadlineSeconds (pod Failed →
    // CR Failed via the operator's pod-phase mirror, which also honours
    // spec.timeoutSeconds).
    await patchStatus({
      phase: RunPhase.Running,
      startedAt: new Date().toISOString(),
      message: "waiting for attach",
    });
    log("interactive mode — sleeping; use `beatctl attach` to connect");
    // Block until SIGTERM flips the shutdown flag. On kubelet pod delete
    // we want to unblock immediately rather than eat the 30s grace
    // before the SIGKILL.
    await shutdownSignalled;
    log("interactive session ending");
    return;
  }

  const client = createOpencodeClient({
    baseUrl: BASE_URL,
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", authHeader);
      return fetch(input, { ...init, headers });
    },
  });

  // Create a session for this run.
  const session = await client.session.create({
    body: { title: `run/${RUN_NAME}` },
  });
  const sessionID = (session.data as { id: string }).id;
  log(`created session ${sessionID}`);

  await patchStatus({
    phase: RunPhase.Running,
    sessionID,
    startedAt: new Date().toISOString(),
    message: "dispatching prompt",
  });

  // Dispatch the prompt asynchronously so the dispatcher doesn't hold an
  // HTTP connection open for the duration of the run.
  const promptBody: Record<string, unknown> = {
    parts: [{ type: "text", text: TASK }],
  };
  if (AGENT) promptBody.agent = AGENT;
  if (MODEL) {
    const [providerID, ...rest] = MODEL.split("/");
    const modelID = rest.join("/");
    if (providerID && modelID) {
      promptBody.model = { providerID, modelID };
    }
  }

  // `prompt_async` returns 204 and does the work in the background.
  const asyncRes = await fetch(`${BASE_URL}/session/${sessionID}/prompt_async`, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(promptBody),
  });
  if (!asyncRes.ok && asyncRes.status !== 204) {
    throw new Error(`prompt_async failed: HTTP ${asyncRes.status} ${await asyncRes.text()}`);
  }
  log("prompt dispatched (async)");

  // Subscribe to SSE events for token/progress updates. Termination is
  // detected by polling /session/status: once the session appears in the
  // status map with a busy flag and later disappears (or flips to idle),
  // we consider it done. Polling is dramatically simpler than getting SSE
  // event shapes exactly right across opencode versions.
  let sawBusy = false;
  let tokensIn = 0;
  let tokensOut = 0;
  let lastStatusWrite = 0;
  let terminate = false;

  const flushStatus = async (force = false) => {
    const now = Date.now();
    if (!force && now - lastStatusWrite < 3000) return;
    lastStatusWrite = now;
    await patchStatus({ tokensIn, tokensOut });
  };

  // ------- Termination poller ------------------------------------------------
  // We can't rely on /session/status (returns {} in many versions) or on
  // the session.updated SSE event shape (inconsistent across versions).
  // Pragmatic signal: GET /session/:id/message and look at the tail. The
  // dispatch is complete when the last *assistant* message has a
  // `time.completed` timestamp and is not followed by a pending user turn.
  type MessagesEntry = {
    info?: {
      role?: "user" | "assistant";
      time?: { created?: number; completed?: number };
      tokens?: { input?: number; output?: number };
      error?: unknown;
    };
  };

  const pollStatus = async (): Promise<void> => {
    const POLL_MS = 2000;
    const startedAt = Date.now();
    log("pollStatus: starting");
    await interruptibleSleep(1000);
    let iter = 0;
    while (!terminate && !shuttingDown) {
      iter++;
      try {
        const res = await fetch(
          `${BASE_URL}/session/${sessionID}/message`,
          { headers: { Authorization: authHeader } },
        );
        if (!res.ok) {
          if (iter <= 3 || iter % 10 === 0) {
            err(`pollStatus: GET /message -> HTTP ${res.status}`);
          }
        } else {
          const msgs = (await res.json()) as MessagesEntry[];
          const last = msgs.length > 0 ? msgs[msgs.length - 1] : undefined;
          if (iter <= 3 || iter % 10 === 0) {
            log(
              `pollStatus iter=${iter} msgs=${msgs.length} lastRole=${last?.info?.role} completed=${last?.info?.time?.completed ?? "-"}`,
            );
          }
          if (last?.info?.role === "assistant") {
            sawBusy = true;
            const tokens = last.info.tokens;
            if (tokens?.input) tokensIn = Math.max(tokensIn, tokens.input);
            if (tokens?.output) tokensOut = Math.max(tokensOut, tokens.output);
            await flushStatus();
            if (last.info.time?.completed) {
              if (last.info.error) {
                err(
                  "session ended with error:",
                  JSON.stringify(last.info.error),
                );
                throw new Error(
                  `session error: ${JSON.stringify(last.info.error)}`,
                );
              }
              log("last assistant message completed — treating as done");
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
      if (Date.now() - startedAt > 30 * 60 * 1000) {
        err("pollStatus: 30 minutes elapsed without completion");
      }
      await interruptibleSleep(POLL_MS);
    }
  };

  // ------- Event stream (progress only) --------------------------------------
  const streamEvents = async (): Promise<void> => {
    const evtRes = await fetch(`${BASE_URL}/event`, {
      headers: { Authorization: authHeader, Accept: "text/event-stream" },
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
        const payload = dataLines.join("\n");
        let evt: { type?: string; properties?: Record<string, unknown> };
        try {
          evt = JSON.parse(payload);
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
              tokensIn = Math.max(tokensIn, p.info.tokens.input);
            if (typeof p.info.tokens?.output === "number")
              tokensOut = Math.max(tokensOut, p.info.tokens.output);
            await flushStatus();
          }
        }
      }
    }
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  };

  // Hard timeout guard (operator also enforces activeDeadlineSeconds).
  const hardTimeout = setTimeout(() => {
    err("dispatcher hit its own timeout guard");
    process.exit(3);
  }, 3_600_000);
  hardTimeout.unref();

  await Promise.race([pollStatus(), streamEvents()]);
  terminate = true;
  clearTimeout(hardTimeout);

  if (shuttingDown) {
    // SIGTERM arrived mid-run — the CR is being deleted (Cancelled) or the
    // pod is being torn down externally. Don't overwrite phase to Succeeded;
    // let the operator/GC decide the terminal state. A best-effort message
    // helps post-mortem if the CR somehow survives (it shouldn't, since
    // owner refs cascade).
    log("shutting down mid-run; not claiming Succeeded");
    await patchStatus({ message: "dispatcher terminated" });
    return;
  }

  await flushStatus(true);

  // Persist the conversation to a ConfigMap before marking the run as
  // Succeeded. This must happen while the opencode server is still
  // reachable (it is — the runner container stays alive; only the
  // dispatcher container exits when main() returns).
  await snapshotSession(sessionID);

  await patchStatus({
    phase: RunPhase.Succeeded,
    message: "session completed",
    completedAt: new Date().toISOString(),
  });
  log("done");
}

main().catch(async (e) => {
  // If we're already shutting down, whatever blew up is probably just a
  // cancelled fetch (the k8s client's HTTPS agent tends to throw when the
  // process is torn down mid-request). Don't overwrite the status with a
  // misleading Failed in that case; let the operator/GC finish.
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
