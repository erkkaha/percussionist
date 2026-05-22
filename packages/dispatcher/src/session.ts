// session.ts — opencode API helpers for the dispatcher sidecar.

export const BASE_URL =
  process.env.OPENCODE_BASE_URL || "http://127.0.0.1:4096";

type SessionEntry = { id: string; title?: string };
export type MessagesEntry = {
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

export type TextPart = { type: "text"; text: string };
export type ToolUsePart = { type: "tool-use" | "tool_use"; id?: string; name?: string; input?: unknown };
export type ToolResultPart = {
  type: "tool-result" | "tool_result";
  toolUseId?: string;
  tool_use_id?: string;
  isError?: boolean;
  content?: unknown;
};
export type FilePart = { type: "file"; filename?: string; path?: string };
export type ToolPart = {
  type: "tool";
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
export type Part =
  | TextPart
  | ToolUsePart
  | ToolResultPart
  | FilePart
  | ToolPart
  | { type: string };
export type RawMessage = MessagesEntry;

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
    const data = (await res.json()) as RawMessage[] | { items?: RawMessage[] };
    return Array.isArray(data) ? data : (data.items ?? []);
  } catch {
    return [];
  }
}

export async function extractLastAssistantText(
  sessionID: string,
): Promise<string> {
  try {
    const msgs = await fetchMessages(sessionID);
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i]!;
      if (msg.info?.role === "assistant") {
        let text = "";
        for (const part of msg.parts ?? []) {
          if (
            (part as TextPart).type === "text" &&
            typeof (part as TextPart).text === "string"
          ) {
            text += (part as TextPart).text;
          }
        }
        return text || "(no text in last assistant message)";
      }
    }
  } catch {
    /* best-effort */
  }
  return "(could not extract question text)";
}

export async function postReply(
  sessionID: string,
  text: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/session/${sessionID}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text }] }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function postPermissionReply(
  sessionID: string,
  permissionID: string,
  response: "once" | "always" | "reject",
): Promise<boolean> {
  try {
    const res = await fetch(
      `${BASE_URL}/session/${sessionID}/permissions/${permissionID}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response }),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

export async function getPermissions(sessionID: string): Promise<unknown[]> {
  try {
    const res = await fetch(`${BASE_URL}/session/${sessionID}/permissions`);
    if (!res.ok) return [];
    return (await res.json()) as unknown[];
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
