// agent/session.ts — raw HTTP client for the opencode-web sidecar API.
//
// Instead of importing @opencode-ai/sdk, we use the same HTTP API the SDK
// calls internally. This avoids adding a runtime dependency to the manager.

import http from 'node:http';
import { AGENT_TIMEOUT_MS, DECISION_AGENT_NAME, OPENCODE_URL } from './config.js';
import { incrementalFlushManagerSession, sendManagerSessionStats } from './stats-reporter.js';

const log = (...args: unknown[]) => console.log(`[agent ${new Date().toISOString()}]`, ...args);

interface SessionTokenInfo {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

interface SessionTimeInfo {
  created?: number;
  completed?: number;
}

export interface SessionMessage {
  info?: {
    id?: string;
    sessionID?: string;
    role?: 'user' | 'assistant';
    model?: { providerID?: string; modelID?: string } | string;
    time?: SessionTimeInfo;
    tokens?: SessionTokenInfo;
    cost?: number;
    error?: unknown;
  };
  parts?: Array<
    | { type: 'text'; text?: string }
    | { type: 'tool'; tool: string; callID?: string; state?: Record<string, unknown> }
    | { type: 'tool-use' | 'tool_use'; id?: string; name?: string; input?: Record<string, unknown> }
    | {
        type: 'tool-result' | 'tool_result';
        toolUseId?: string;
        tool_use_id?: string;
        content?: unknown;
        isError?: boolean;
      }
    | { type: 'file'; path?: string; filename?: string }
    | { type: string; [key: string]: unknown } // Unknown-safe fallback
  >;
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
        port: u.port === '' ? undefined : Number(u.port),
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
        signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
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
    req.on('timeout', () => {
      req.destroy(new Error(`Request timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Session lifecycle

export async function createSession(title: string, agentName?: string): Promise<string> {
  const body: Record<string, unknown> = { title };
  if (agentName) body.agent = agentName;
  const res = await fetch(`${OPENCODE_URL}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
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
  signal?: AbortSignal,
): Promise<void> {
  const body: Record<string, unknown> = {
    parts: [{ type: 'text', text: prompt }],
  };
  const agent = agentName ?? DECISION_AGENT_NAME;
  body.agent = agent;

  const res = await httpJsonPost(
    `${OPENCODE_URL}/session/${sessionId}/message`,
    body,
    300_000,
    signal,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`sendPrompt failed (${res.status}): ${text}`);
  }
}

export async function getMessages(sessionId: string): Promise<SessionMessage[]> {
  const res = await fetch(`${OPENCODE_URL}/session/${sessionId}/message`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as SessionMessage[] | { items?: SessionMessage[] };
  return Array.isArray(data) ? data : (data.items ?? []);
}

export async function sendMessage(
  sessionId: string,
  text: string,
  agentName?: string,
  signal?: AbortSignal,
): Promise<void> {
  const body: Record<string, unknown> = { parts: [{ type: 'text', text }] };
  if (agentName) body.agent = agentName;
  const res = await httpJsonPost(
    `${OPENCODE_URL}/session/${sessionId}/message`,
    body,
    300_000,
    signal,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`sendMessage failed (${res.status}): ${text}`);
  }
}

function sawAgentActivity(messages: SessionMessage[]): boolean {
  return messages.some((msg) => {
    if (msg.info?.role !== 'assistant') return false;
    const tokens = msg.info.tokens;
    return Boolean(
      msg.info.time?.created ||
        msg.info.time?.completed ||
        msg.info.error ||
        (tokens && ((tokens.input ?? 0) > 0 || (tokens.output ?? 0) > 0)) ||
        (msg.parts?.length ?? 0) > 0,
    );
  });
}

// ---------------------------------------------------------------------------
// Sleep that short-circuits when the signal is aborted.

async function interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  return new Promise((resolve) => {
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
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
  const startedAtIso = new Date().toISOString();
  const startedAtMs = Date.now();
  let sawActivity = false;
  let fromIdx = 0; // cursor for incremental flush idempotency
  const activityTimeout =
    firstResponseTimeoutMs ?? (timeoutMs > 0 ? Math.min(timeoutMs, 60000) : 0);

  while (!signal?.aborted && (deadline === 0 || Date.now() < deadline)) {
    const messages = await getMessages(sessionId);
    if (sawAgentActivity(messages)) sawActivity = true;

    // Incremental flush: send delta to web stats after each polling iteration.
    fromIdx = await incrementalFlushManagerSession(sessionId, startedAtIso, fromIdx);

    // Check if the last assistant message has completed
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.info?.role !== 'assistant') continue;
      if (msg.info?.time?.completed) {
        let text = '';
        for (const part of msg.parts ?? []) {
          if (
            part &&
            typeof part === 'object' &&
            'type' in part &&
            (part.type as string) === 'text' &&
            'text' in part &&
            part.text
          ) {
            text += String(part.text);
          }
        }
        // Final flush on success path
        await sendManagerSessionStats(
          sessionId,
          'Succeeded',
          startedAtIso,
          new Date().toISOString(),
        );
        if (text) return text;
        // Tool-call-only intermediate completion — keep polling
      }
    }

    // Activity timeout. We care that the agent started working, not that it
    // produced visible assistant text; tool calls and empty assistant messages
    // count as activity. A value of 0 disables this guard.
    if (!sawActivity && activityTimeout > 0 && Date.now() - startedAtMs > activityTimeout) {
      log(`agent did not start work within ${activityTimeout}ms`);
      await sendManagerSessionStats(sessionId, 'Failed', startedAtIso, new Date().toISOString());
      return null;
    }

    await interruptibleSleep(2000, signal);
  }

  // Final flush on terminal paths (timeout or cancelled)
  const phase = signal?.aborted ? 'Failed' : 'Failed';
  log(
    signal?.aborted
      ? `waitForCompletion cancelled via signal`
      : `agent did not complete within ${timeoutMs}ms`,
  );
  await sendManagerSessionStats(sessionId, phase, startedAtIso, new Date().toISOString());
  return null;
}

// ---------------------------------------------------------------------------
// Health check

export async function waitForOpencodeWeb(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${OPENCODE_URL}/global/health`, {
        signal: AbortSignal.timeout(5_000),
      });
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
