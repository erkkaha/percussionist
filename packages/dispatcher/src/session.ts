// session.ts — opencode API helpers for the dispatcher sidecar.

export const BASE_URL = process.env.OPENCODE_BASE_URL || 'http://127.0.0.1:4096';

type SessionEntry = { id: string; title?: string };
export type MessagesEntry = {
  info?: {
    id?: string;
    sessionID?: string;
    role?: 'user' | 'assistant';
    time?: { created?: number; completed?: number };
    tokens?: {
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
    cost?: number;
    model?: { providerID?: string; modelID?: string };
    error?: unknown;
  };
  parts?: Part[];
};

export type TextPart = { type: 'text'; text: string };
export type ToolUsePart = {
  type: 'tool-use' | 'tool_use';
  id?: string;
  name?: string;
  input?: unknown;
};
export type ToolResultPart = {
  type: 'tool-result' | 'tool_result';
  toolUseId?: string;
  tool_use_id?: string;
  isError?: boolean;
  content?: unknown;
};
export type FilePart = { type: 'file'; filename?: string; path?: string };
export type ToolPart = {
  type: 'tool';
  tool: string;
  callID?: string;
  state?: {
    status?: string;
    input?: unknown;
    output?: unknown;
    metadata?: { exit?: number; truncated?: boolean };
    time?: { start?: number; end?: number };
  };
};
export type StepFinishPart = {
  type: 'step-finish';
  id?: string;
  messageID?: string;
  reason?: string;
  tokens?: { input?: number; output?: number; reasoning?: number };
  cost?: number;
};

export type Part =
  | TextPart
  | ToolUsePart
  | ToolResultPart
  | FilePart
  | ToolPart
  | StepFinishPart
  | { type: string };
export type RawMessage = MessagesEntry;

export const SESSION_RESPONSE_MAX_BYTES = 20_000_000;

async function readJsonWithLimit(res: Response, maxBytes: number): Promise<unknown> {
  if (!res.body) return null;

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      throw new Error(`OpenCode session response too large (${total} bytes)`);
    }
    chunks.push(value);
  }

  return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as unknown;
}

export function compactMessagesForSnapshot(messages: RawMessage[]): RawMessage[] {
  return messages.map((msg) => ({
    info: msg.info,
    parts: (msg.parts ?? []).map((part) => {
      if (part.type === 'tool') {
        const p = part as ToolPart;
        return {
          ...p,
          state: p.state
            ? {
                ...p.state,
                output:
                  typeof p.state.output === 'string' && p.state.output.length > 4000
                    ? `${p.state.output.slice(0, 4000)}\n... (truncated for snapshot)`
                    : p.state.output,
                metadata: { ...p.state.metadata, truncated: true },
              }
            : p.state,
        };
      }
      if (part.type === 'text') {
        const p = part as TextPart;
        return p.text.length > 20_000
          ? { ...p, text: `${p.text.slice(0, 20_000)}\n... (truncated for snapshot)` }
          : p;
      }
      return part;
    }),
  }));
}

export async function listSessions(): Promise<SessionEntry[]> {
  try {
    const res = await fetch(`${BASE_URL}/session`);
    if (!res.ok) return [];
    const data = (await res.json()) as
      | SessionEntry[]
      | { items?: SessionEntry[]; sessions?: SessionEntry[] };
    return Array.isArray(data) ? data : (data.items ?? data.sessions ?? []);
  } catch {
    return [];
  }
}

export async function fetchMessages(sessionID: string): Promise<RawMessage[]> {
  try {
    const res = await fetch(`${BASE_URL}/session/${sessionID}/message`);
    if (!res.ok) return [];
    const data = (await readJsonWithLimit(res, SESSION_RESPONSE_MAX_BYTES)) as
      | RawMessage[]
      | { items?: RawMessage[] };
    return Array.isArray(data) ? data : (data.items ?? []);
  } catch {
    return [];
  }
}

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/global/health`);
    if (res.ok) {
      const body = (await res.json()) as { healthy?: boolean; version?: string };
      return !!body.healthy;
    }
    return false;
  } catch {
    return false;
  }
}

export async function waitForHealthy(
  timeoutMs = 120_000,
  shuttingDown: () => boolean,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline && !shuttingDown()) {
    try {
      const res = await fetch(`${BASE_URL}/global/health`);
      if (res.ok) {
        const body = (await res.json()) as { healthy?: boolean; version?: string };
        if (body.healthy) return;
      } else {
        lastErr = new Error(`HTTP ${res.status}`);
      }
    } catch (e) {
      lastErr = e;
    }
    await sleep(1000);
  }
  if (shuttingDown()) return;
  throw new Error(
    `opencode server did not become healthy within ${timeoutMs}ms: ${String(lastErr)}`,
  );
}
