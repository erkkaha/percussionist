// translate.ts — turn OpenCode 2 session messages into the v1 transcript shape
// percussionist already parses.
//
// The v1 shape (`{ info, parts }` per message) is the only contract this runner
// has with the rest of the system: dispatcher/polling.ts, dispatcher/
// stats-reporter.ts, SessionTimeline.tsx and SessionView.tsx all consume it.
// packages/runner-claude/src/translate.ts does the same job for the Claude
// Agent SDK; the two must stay shape-compatible.
//
// OpenCode 2 changed the message model completely: messages are flat objects
// typed `user` / `assistant` / `idle` / `model-switched` / …, the assistant's
// `content[]` holds `text`, `reasoning` and `tool` parts, and tokens/cost sit on
// the message itself rather than under `info`. Tools are additionally wrapped
// in "Code Mode": the model calls a single `execute` tool whose input is a JS
// snippet, and the real tool calls appear in `state.metadata.toolCalls`. We
// unwrap those so tool counts and names stay meaningful downstream.

import { basename } from 'node:path';

export type Tokens = {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
};

export type MessageInfo = {
  id?: string;
  sessionID?: string;
  role?: 'user' | 'assistant';
  agent?: string;
  time?: { created?: number; completed?: number };
  tokens?: Tokens;
  cost?: number;
  model?: { providerID?: string; modelID?: string };
  error?: unknown;
};

export type TextPart = { type: 'text'; text: string };
export type ReasoningPart = { type: 'reasoning'; text: string };
export type FilePart = { type: 'file'; filename?: string; path?: string };
export type SubtaskPart = {
  type: 'subtask';
  id?: string;
  description?: string;
  agentType?: string;
};
export type ToolPart = {
  type: 'tool';
  tool: string;
  callID?: string;
  state?: {
    status?: 'running' | 'completed' | 'error';
    input?: unknown;
    output?: unknown;
    metadata?: { exit?: number; truncated?: boolean; codeMode?: boolean };
    time?: { start?: number; end?: number };
  };
};
export type StepFinishPart = {
  type: 'step-finish';
  id?: string;
  messageID?: string;
  reason?: string;
  tokens?: Tokens;
  cost?: number;
};

export type Part = TextPart | ReasoningPart | FilePart | SubtaskPart | ToolPart | StepFinishPart;
export type TranscriptMessage = { info: MessageInfo; parts: Part[] };

// ---------------------------------------------------------------------------
// Loose views of the v2 payloads. Narrowed defensively rather than importing
// the SDK schema types: the shapes below are what 2.0.10 actually emits, and a
// field the SDK drops or renames should degrade to a missing part, not a type
// error at build time in an unrelated package.

export type V2ToolCall = { tool?: string; status?: string; input?: unknown; output?: unknown };

export type V2Part = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  executed?: boolean;
  state?: {
    status?: string;
    input?: unknown;
    output?: unknown;
    content?: unknown;
    metadata?: { toolCalls?: V2ToolCall[]; truncated?: boolean; exit?: number } & Record<
      string,
      unknown
    >;
  };
  time?: { created?: number; ran?: number; completed?: number };
};

export type V2Message = {
  id?: string;
  sessionID?: string;
  type?: string;
  time?: { created?: number; completed?: number; streamed?: number };
  text?: string;
  agent?: string;
  model?: { id?: string; providerID?: string; variant?: string };
  content?: V2Part[];
  finish?: string;
  rawFinish?: string;
  cost?: number;
  tokens?: Tokens;
  error?: { type?: string; message?: string; status?: number } | unknown;
};

const FILE_TOOLS = new Set(['edit', 'write', 'patch', 'multiedit', 'apply_patch']);
const SUBTASK_TOOLS = new Set(['task', 'agent', 'subagent']);
/** The Code Mode wrapper: real calls live in state.metadata.toolCalls. */
const CODE_MODE_TOOL = 'execute';

function mapStatus(status: string | undefined): 'running' | 'completed' | 'error' | undefined {
  if (!status) return undefined;
  if (status === 'completed' || status === 'success') return 'completed';
  if (status === 'error' || status === 'failed') return 'error';
  return 'running';
}

/** Flatten a v2 tool result `content` (string or text-content array) to a string. */
export function contentToText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const texts = content
    .map((c) => (c && typeof c === 'object' ? (c as { text?: unknown }).text : undefined))
    .filter((t): t is string => typeof t === 'string');
  return texts.length > 0 ? texts.join('\n') : undefined;
}

function filePathOf(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const i = input as Record<string, unknown>;
  for (const k of ['filePath', 'file_path', 'path', 'filename']) {
    if (typeof i[k] === 'string') return i[k] as string;
  }
  return undefined;
}

function synthesizeFor(tool: string, callID: string | undefined, input: unknown): Part[] {
  const out: Part[] = [];
  if (FILE_TOOLS.has(tool)) {
    const p = filePathOf(input);
    if (p) out.push({ type: 'file', filename: basename(p), path: p });
  }
  if (SUBTASK_TOOLS.has(tool) && input && typeof input === 'object') {
    const i = input as Record<string, unknown>;
    out.push({
      type: 'subtask',
      id: callID,
      description:
        typeof i.description === 'string'
          ? i.description
          : typeof i.prompt === 'string'
            ? i.prompt.slice(0, 120)
            : undefined,
      agentType:
        typeof i.subagent_type === 'string'
          ? i.subagent_type
          : typeof i.agent === 'string'
            ? i.agent
            : undefined,
    });
  }
  return out;
}

function translateToolPart(part: V2Part): Part[] {
  const name = part.name ?? 'unknown';
  const state = part.state ?? {};
  const status = mapStatus(state.status);
  const output = contentToText(state.content) ?? state.output;
  const time = {
    start: part.time?.ran ?? part.time?.created,
    end: part.time?.completed,
  };
  const inner = state.metadata?.toolCalls;

  // Code Mode: report the calls the snippet made, not the snippet. A wrapper
  // with no recorded inner calls (pure computation) is reported as itself so
  // the activity is not lost entirely.
  if (name === CODE_MODE_TOOL && Array.isArray(inner) && inner.length > 0) {
    const out: Part[] = [];
    inner.forEach((tc, idx) => {
      const tool = tc.tool ?? CODE_MODE_TOOL;
      const callID = part.id ? `${part.id}:${idx}` : undefined;
      out.push({
        type: 'tool',
        tool,
        callID,
        state: {
          status: mapStatus(tc.status) ?? status,
          input: tc.input,
          // Only a single inner call can own the wrapper's output unambiguously.
          output: tc.output ?? (inner.length === 1 ? output : undefined),
          metadata: { codeMode: true, ...(state.metadata?.truncated ? { truncated: true } : {}) },
          time,
        },
      });
      out.push(...synthesizeFor(tool, callID, tc.input));
    });
    return out;
  }

  const metadata: { exit?: number; truncated?: boolean } = {};
  if (typeof state.metadata?.exit === 'number') metadata.exit = state.metadata.exit;
  if (state.metadata?.truncated) metadata.truncated = true;

  return [
    {
      type: 'tool',
      tool: name,
      callID: part.id,
      state: {
        status,
        input: state.input,
        output,
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        time,
      },
    },
    ...synthesizeFor(name, part.id, state.input),
  ];
}

function translateError(error: V2Message['error']): unknown {
  if (!error || typeof error !== 'object') return error ?? undefined;
  const e = error as { type?: string; message?: string; status?: number };
  return {
    name: e.type ?? 'error',
    message: e.message,
    ...(typeof e.status === 'number' ? { status: e.status } : {}),
  };
}

/**
 * Translate one v2 message. Returns undefined for message types that have no
 * v1 counterpart (`idle`, `model-switched`, `agent-switched`, …) — the
 * dispatcher's stats cursor is a plain index into the array, so the list must
 * only ever grow by messages that mean something.
 */
export function translateMessage(sessionID: string, m: V2Message): TranscriptMessage | undefined {
  if (m.type === 'user') {
    return {
      info: {
        id: m.id,
        sessionID,
        role: 'user',
        time: { created: m.time?.created },
      },
      parts: typeof m.text === 'string' ? [{ type: 'text', text: m.text }] : [],
    };
  }
  if (m.type !== 'assistant') return undefined;

  const parts: Part[] = [];
  for (const part of m.content ?? []) {
    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push({ type: 'text', text: part.text });
    } else if (part.type === 'reasoning' && typeof part.text === 'string') {
      parts.push({ type: 'reasoning', text: part.text });
    } else if (part.type === 'tool') {
      parts.push(...translateToolPart(part));
    }
  }
  if (m.finish !== undefined || m.tokens !== undefined || m.cost !== undefined) {
    parts.push({
      type: 'step-finish',
      id: m.id ? `${m.id}-finish` : undefined,
      messageID: m.id,
      reason: m.finish,
      tokens: m.tokens,
      cost: m.cost,
    });
  }

  const info: MessageInfo = {
    id: m.id,
    sessionID,
    role: 'assistant',
    agent: m.agent,
    time: { created: m.time?.created, completed: m.time?.completed },
    tokens: m.tokens,
    cost: m.cost,
    model: m.model ? { providerID: m.model.providerID, modelID: m.model.id } : undefined,
  };
  const error = translateError(m.error);
  if (error !== undefined) info.error = error;
  return { info, parts };
}

/**
 * Translate a whole session. Output is oldest-first regardless of input order,
 * because incrementalFlush in the dispatcher keeps a numeric cursor into it.
 */
export function translateMessages(sessionID: string, messages: V2Message[]): TranscriptMessage[] {
  return [...messages]
    .map((m, idx) => ({ m, idx }))
    .sort((a, b) => {
      const ta = a.m.time?.created ?? 0;
      const tb = b.m.time?.created ?? 0;
      return ta - tb || a.idx - b.idx;
    })
    .map(({ m }) => translateMessage(sessionID, m))
    .filter((m): m is TranscriptMessage => m !== undefined);
}

// ---------------------------------------------------------------------------
// v1 `GET /provider`
//
// The manager's list_models tool reads `{ all: [{ id, name, models }],
// default, connected }` and keeps only providers named in `connected`.

export type V2Provider = { id?: string; name?: string };
export type V2ModelEntry = { id?: string; modelID?: string; providerID?: string; name?: string };

export type ProviderListing = {
  all: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>;
  default: Record<string, string>;
  connected: string[];
};

export function providerListing(providers: V2Provider[], models: V2ModelEntry[]): ProviderListing {
  const byProvider = new Map<string, Array<{ id: string; name: string }>>();
  for (const m of models) {
    const id = m.id ?? m.modelID;
    if (!m.providerID || !id) continue;
    const list = byProvider.get(m.providerID) ?? [];
    list.push({ id, name: m.name ?? id });
    byProvider.set(m.providerID, list);
  }
  const all = providers
    .filter((p): p is V2Provider & { id: string } => typeof p.id === 'string')
    .map((p) => ({ id: p.id, name: p.name ?? p.id, models: byProvider.get(p.id) ?? [] }));
  return { all, default: {}, connected: all.map((p) => p.id) };
}
