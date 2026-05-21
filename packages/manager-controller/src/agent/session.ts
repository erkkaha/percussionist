// agent/session.ts — raw HTTP client for the opencode-web sidecar API.
//
// Instead of importing @opencode-ai/sdk, we use the same HTTP API the SDK
// calls internally. This avoids adding a runtime dependency to the manager.

import { OPENCODE_URL, AGENT_TIMEOUT_MS, DECISION_AGENT_NAME } from "./config.js";

const log = (...args: unknown[]) =>
  console.log(`[agent ${new Date().toISOString()}]`, ...args);
const err = (...args: unknown[]) =>
  console.error(`[agent ${new Date().toISOString()}]`, ...args);

interface SessionMessage {
  info?: {
    id?: string;
    sessionID?: string;
    role?: "user" | "assistant";
    time?: { created?: number; completed?: number };
    tokens?: { input?: number; output?: number };
    error?: unknown;
  };
  parts?: Array<{ type: string; text?: string }>;
}

// ---------------------------------------------------------------------------
// Session lifecycle

export async function createSession(title: string, agentName?: string): Promise<string> {
  const body: Record<string, unknown> = { title };
  if (agentName) body.agent = agentName;
  const res = await fetch(`${OPENCODE_URL}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`createSession failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as { id: string };
  log(`created session ${data.id}`);
  return data.id;
}

export async function sendPrompt(
  sessionId: string,
  prompt: string,
  agentName?: string,
): Promise<void> {
  const body: Record<string, unknown> = {
    parts: [{ type: "text", text: prompt }],
  };
  const agent = agentName ?? DECISION_AGENT_NAME;
  body.agent = agent;

  const res = await fetch(`${OPENCODE_URL}/session/${sessionId}/prompt_async`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 204) {
    const text = await res.text().catch(() => "");
    throw new Error(`sendPrompt failed (${res.status}): ${text}`);
  }
}

export async function getMessages(sessionId: string): Promise<SessionMessage[]> {
  const res = await fetch(`${OPENCODE_URL}/session/${sessionId}/message`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as SessionMessage[] | { items?: SessionMessage[] };
  return Array.isArray(data) ? data : (data.items ?? []);
}

export async function sendMessage(sessionId: string, text: string, agentName?: string): Promise<void> {
  const body: Record<string, unknown> = { parts: [{ type: "text", text }] };
  if (agentName) body.agent = agentName;
  const res = await fetch(`${OPENCODE_URL}/session/${sessionId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`sendMessage failed (${res.status}): ${body}`);
  }
}

export function extractLastAssistantText(messages: SessionMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.info?.role !== "assistant") continue;
    let text = "";
    for (const part of msg.parts ?? []) {
      if (part.type === "text" && part.text) text += part.text;
    }
    return text || "(empty)";
  }
  return "(no assistant message)";
}

export function extractAssistantTextWithTimeout(
  messages: SessionMessage[],
  completedSince: number,
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.info?.role !== "assistant") continue;
    const completed = msg.info.time?.completed;
    if (completed && completed > completedSince) {
      let text = "";
      for (const part of msg.parts ?? []) {
        if (part.type === "text" && part.text) text += part.text;
      }
      return text || null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sleep that short-circuits when the signal is aborted.

async function interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  return new Promise((resolve) => {
    if (signal) {
      const onAbort = () => { clearTimeout(timer); resolve(); };
      signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
    } else {
      setTimeout(resolve, ms);
    }
  });
}

// ---------------------------------------------------------------------------
// Wait for an assistant message to complete.
//
// Returns the full text of the last completed assistant message, or null.
//
// When `signal` is provided the loop stops as soon as the signal fires —
// no hard timeout. The `timeoutMs` parameter is kept for backward-compatible
// callers (decision-engine). Pass `0` or `undefined` to disable the hard
// deadline.

export async function waitForCompletion(
  sessionId: string,
  timeoutMs: number = AGENT_TIMEOUT_MS,
  firstResponseTimeoutMs?: number,
  signal?: AbortSignal,
): Promise<string | null> {
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;
  const startedAt = Date.now();
  let sawFirstResponse = false;
  const firstResponseTimeout = firstResponseTimeoutMs ?? (timeoutMs > 0 ? Math.min(timeoutMs, 60000) : 60000);

  while (!signal?.aborted && (deadline === 0 || Date.now() < deadline)) {
    const messages = await getMessages(sessionId);
    const lastAssistant = extractLastAssistantText(messages);

    if (lastAssistant !== "(no assistant message)") {
      sawFirstResponse = true;
    }

    // Check if the last assistant message has completed
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg || msg.info?.role !== "assistant") continue;
      if (msg.info?.time?.completed) {
        let text = "";
        for (const part of msg.parts ?? []) {
          if (part.type === "text" && part.text) text += part.text;
        }
        return text || null;
      }
    }

    // First response timeout
    if (!sawFirstResponse && Date.now() - startedAt > firstResponseTimeout) {
      log(`agent did not produce first response within ${firstResponseTimeout}ms`);
      return null;
    }

    await interruptibleSleep(2000, signal);
  }

  if (signal?.aborted) {
    log(`waitForCompletion cancelled via signal`);
  } else {
    log(`agent did not complete within ${timeoutMs}ms`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Health check

export async function waitForOpencodeWeb(
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${OPENCODE_URL}/global/health`, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) {
        const body = (await res.json()) as { healthy?: boolean };
        if (body.healthy !== false) return;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`opencode-web did not become healthy within ${timeoutMs}ms`);
}
