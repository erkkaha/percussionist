// translate.ts — turn the Agent SDK message stream into the OpenCode-shaped
// transcript percussionist already parses.
//
// The shape below is the contract, and it is the *only* contract the runner has
// with the rest of the system.  Match it and dispatcher/polling.ts,
// dispatcher/stats-reporter.ts, SessionTimeline.tsx and SessionView.tsx all work
// unchanged.  See packages/dispatcher/src/session.ts for the consumer's types.
//
// Three parts have no direct SDK equivalent and are synthesised here:
//   - `step-finish`  — emitted from the SDK `result` message, marks turn end
//   - `file`         — synthesised from Write/Edit tool inputs
//   - `subtask`      — synthesised from Task/Agent tool calls

import { isFileTool, isSubagentTool, normalizeToolName } from './tool-names.js';

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
  time?: { created?: number; completed?: number };
  tokens?: Tokens;
  cost?: number;
  model?: { providerID?: string; modelID?: string };
  error?: unknown;
};

export type TextPart = { type: 'text'; text: string };
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
    metadata?: { exit?: number; truncated?: boolean };
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

export type Part = TextPart | FilePart | SubtaskPart | ToolPart | StepFinishPart;
export type TranscriptMessage = { info: MessageInfo; parts: Part[] };

/** Loose views of the SDK payloads — narrowed defensively rather than typed hard. */
type ContentBlock = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

type SdkUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

// Cumulative per-model totals on the result message. Note the camelCase — the
// SDK spells this block differently from the snake_case per-message usage.
type SdkModelUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
};

type SdkMessageLike = {
  type?: string;
  uuid?: string;
  session_id?: string;
  parent_tool_use_id?: string | null;
  subagent_type?: string;
  message?: {
    role?: string;
    model?: string;
    content?: ContentBlock[] | string;
    usage?: SdkUsage;
    stop_reason?: string | null;
  };
  // result messages
  subtype?: string;
  total_cost_usd?: number;
  usage?: SdkUsage;
  modelUsage?: Record<string, SdkModelUsage>;
  stop_reason?: string | null;
  is_error?: boolean;
  result?: string;
  api_error_status?: number | null;
  tool_use_result?: unknown;
};

// The result message carries two usage fields and they mean different things.
// `usage` is a single message's usage — the last turn's — while `modelUsage`
// holds the run's cumulative totals per model, which is what pairs with
// total_cost_usd. Reporting `usage` as the run total made every run look tiny:
// a build task that implemented a whole state machine reported 2 input and 68
// output tokens, because with prompt caching a final turn's uncached input
// really is about 2 and its output is just the closing message. The rest of the
// transcript carries no usage at all, so nothing else made up the difference.
function sumModelUsage(mu: Record<string, SdkModelUsage> | undefined): Tokens | undefined {
  if (!mu) return undefined;
  const entries = Object.values(mu);
  if (entries.length === 0) return undefined;
  let input = 0;
  let output = 0;
  let read = 0;
  let write = 0;
  for (const m of entries) {
    input += m.inputTokens ?? 0;
    output += m.outputTokens ?? 0;
    read += m.cacheReadInputTokens ?? 0;
    write += m.cacheCreationInputTokens ?? 0;
  }
  return { input, output, cache: { read, write } };
}

function mapTokens(u: SdkUsage | undefined): Tokens | undefined {
  if (!u) return undefined;
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cache: {
      read: u.cache_read_input_tokens ?? 0,
      write: u.cache_creation_input_tokens ?? 0,
    },
  };
}

/** Tool results arrive as a string, a block array, or a structured object. */
function stringifyToolOutput(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const blk = b as ContentBlock;
        return typeof blk?.text === 'string' ? blk.text : JSON.stringify(b);
      })
      .join('\n');
  }
  if (content === undefined || content === null) return '';
  return JSON.stringify(content);
}

/**
 * Bash reports its exit code in the structured `tool_use_result`, which the
 * timeline surfaces as `state.metadata.exit`.  The shape is per-tool and
 * untyped, so probe the usual keys and give up quietly.
 */
function extractExitCode(toolUseResult: unknown): number | undefined {
  if (!toolUseResult || typeof toolUseResult !== 'object') return undefined;
  const r = toolUseResult as Record<string, unknown>;
  for (const key of ['exitCode', 'exit_code', 'exit', 'returnCode']) {
    const v = r[key];
    if (typeof v === 'number') return v;
  }
  return undefined;
}

function filePathOf(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  for (const key of ['file_path', 'filePath', 'notebook_path', 'path']) {
    const v = input[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Accumulates the transcript as SDK messages stream in.
 *
 * Stateful for one reason: a `tool_use` block and its `tool_result` arrive on
 * *different* messages, so the tool part has to be reopened and completed
 * later.  `toolIndex` holds that correlation by tool-use id.
 */
export class TranscriptBuilder {
  private messages: TranscriptMessage[] = [];
  private toolIndex = new Map<string, ToolPart>();
  private lastAssistant: TranscriptMessage | undefined;

  /**
   * `sessionIdOverride` makes `info.sessionID` report the id the dispatcher was
   * handed by `POST /session`, not the SDK's internal one. polling.ts patches
   * Run.status.sessionID from this field and then fetches
   * `/session/<id>/message` with it, so the two must be the same string.
   */
  constructor(private sessionIdOverride?: string) {}

  /**
   * Feed one SDK message. Unknown/among-many control messages are ignored.
   *
   * `suppressError` keeps an errored `result` out of `info.error` while its
   * turn is being retried. polling.ts fails the run the moment it sees that
   * field on the last message, so recording a transient error the session is
   * about to recover from would kill the run from the transcript alone. The
   * step-finish part, tokens and cost are still recorded — the attempt did
   * happen and was billed.
   */
  push(raw: unknown, opts?: { suppressError?: boolean }): void {
    const msg = raw as SdkMessageLike;
    switch (msg.type) {
      case 'assistant':
        this.pushAssistant(msg);
        break;
      case 'user':
        this.pushUser(msg);
        break;
      case 'result':
        this.pushResult(msg, opts?.suppressError === true);
        break;
      default:
        // system/init, status, retry, hook and partial-message events carry no
        // transcript content the dashboard renders.
        break;
    }
  }

  private pushAssistant(msg: SdkMessageLike): void {
    const now = Date.now();
    const parts: Part[] = [];
    const content = msg.message?.content;
    const blocks = Array.isArray(content) ? content : [];

    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push({ type: 'text', text: block.text });
        continue;
      }
      if (block.type === 'tool_use') {
        const rawName = block.name ?? 'unknown';
        const tool: ToolPart = {
          type: 'tool',
          tool: normalizeToolName(rawName),
          callID: block.id,
          state: {
            status: 'running',
            input: block.input,
            time: { start: now },
          },
        };
        parts.push(tool);
        if (block.id) this.toolIndex.set(block.id, tool);

        // Synthesised parts the SDK does not emit but the timeline renders.
        if (isFileTool(rawName)) {
          const path = filePathOf(block.input);
          if (path) {
            parts.push({ type: 'file', path, filename: path.split('/').pop() });
          }
        }
        if (isSubagentTool(rawName)) {
          const desc = block.input?.description ?? block.input?.prompt;
          parts.push({
            type: 'subtask',
            id: block.id,
            description: typeof desc === 'string' ? desc : undefined,
            agentType:
              typeof block.input?.subagent_type === 'string'
                ? block.input.subagent_type
                : undefined,
          });
        }
      }
      // `thinking` blocks are deliberately dropped: session.ts has no part type
      // for them, and their token cost is already carried in usage.
    }

    // A thinking-only or empty turn yields no renderable parts, and pushing it
    // would put a blank row in the dashboard timeline. Its token cost is
    // already accounted for in the result message's totals.
    if (parts.length === 0) return;

    const entry: TranscriptMessage = {
      info: {
        id: msg.uuid,
        sessionID: this.sessionIdOverride ?? msg.session_id,
        role: 'assistant',
        time: { created: now },
        tokens: mapTokens(msg.message?.usage),
        model: msg.message?.model
          ? { providerID: 'anthropic', modelID: msg.message.model }
          : undefined,
      },
      parts,
    };
    this.messages.push(entry);
    // Subagent output must not become the anchor for the next step-finish,
    // which belongs to the main loop's turn.
    if (!msg.parent_tool_use_id) this.lastAssistant = entry;
  }

  private pushUser(msg: SdkMessageLike): void {
    const now = Date.now();
    const content = msg.message?.content;

    // A plain string (or text-only blocks) is a genuine user turn. Anything
    // carrying tool_result blocks is the harness reporting tool output, which
    // belongs on the already-open tool part rather than as a new message.
    if (typeof content === 'string') {
      this.messages.push({
        info: {
          id: msg.uuid,
          sessionID: this.sessionIdOverride ?? msg.session_id,
          role: 'user',
          time: { created: now, completed: now },
        },
        parts: [{ type: 'text', text: content }],
      });
      return;
    }

    const blocks = Array.isArray(content) ? content : [];
    const textParts: Part[] = [];
    let sawToolResult = false;

    for (const block of blocks) {
      if (block.type === 'tool_result') {
        sawToolResult = true;
        const id = block.tool_use_id;
        const tool = id ? this.toolIndex.get(id) : undefined;
        if (!tool?.state) continue;
        tool.state.status = block.is_error ? 'error' : 'completed';
        tool.state.output = stringifyToolOutput(block.content);
        tool.state.time = { ...tool.state.time, end: now };
        const exit = extractExitCode(msg.tool_use_result);
        if (exit !== undefined) {
          tool.state.metadata = { ...tool.state.metadata, exit };
        }
        if (id) this.toolIndex.delete(id);
        continue;
      }
      if (block.type === 'text' && typeof block.text === 'string') {
        textParts.push({ type: 'text', text: block.text });
      }
    }

    if (!sawToolResult && textParts.length > 0) {
      this.messages.push({
        info: {
          id: msg.uuid,
          sessionID: this.sessionIdOverride ?? msg.session_id,
          role: 'user',
          time: { created: now, completed: now },
        },
        parts: textParts,
      });
    }
  }

  /**
   * The SDK `result` message closes a turn. percussionist reads turn
   * boundaries from `step-finish` parts, and the run's cost/token totals from
   * the assistant message's `info`, so both are filled here.
   */
  private pushResult(msg: SdkMessageLike, suppressError = false): void {
    const now = Date.now();
    // Prefer the cumulative per-model totals; fall back to the last turn's
    // usage only when the SDK did not send them.
    const tokens = sumModelUsage(msg.modelUsage) ?? mapTokens(msg.usage);

    // A run that produced no renderable assistant turn still has cost and token
    // totals worth reporting, so give them somewhere to land rather than
    // dropping them on the floor.
    let target = this.lastAssistant;
    if (!target) {
      target = {
        info: {
          id: msg.uuid,
          sessionID: this.sessionIdOverride ?? msg.session_id,
          role: 'assistant',
          time: { created: now },
        },
        parts: [],
      };
      this.messages.push(target);
      this.lastAssistant = target;
    }

    target.info.time = { ...target.info.time, completed: now };
    if (tokens) target.info.tokens = tokens;
    if (typeof msg.total_cost_usd === 'number') target.info.cost = msg.total_cost_usd;

    // dispatcher/polling.ts decides a run has settled by reading
    // `time.completed` off the *last element of the transcript*, not off the
    // main-loop turn. A subagent turn arriving after the final main turn would
    // otherwise leave the array ending on a message with no completed stamp, and
    // the run would never settle — it would hang to the idle timeout instead of
    // reaching Succeeded. Stamp the tail too when it differs.
    const tail = this.messages[this.messages.length - 1];
    if (tail && tail !== target) {
      tail.info.time = { ...tail.info.time, completed: now };
    }
    if (msg.is_error && !suppressError) {
      target.info.error = {
        message: msg.result ?? 'run failed',
        status: msg.api_error_status ?? undefined,
      };
    }

    target.parts.push({
      type: 'step-finish',
      id: msg.uuid,
      messageID: target.info.id,
      reason: msg.stop_reason ?? msg.subtype ?? 'end_turn',
      tokens,
      cost: msg.total_cost_usd,
    });
  }

  /** Any tool still open when the run ends would otherwise render as forever-running. */
  finalizeOpenTools(): void {
    const now = Date.now();
    for (const tool of this.toolIndex.values()) {
      if (!tool.state) continue;
      tool.state.status = 'error';
      tool.state.output = tool.state.output ?? 'run ended before the tool reported a result';
      tool.state.time = { ...tool.state.time, end: now };
    }
    this.toolIndex.clear();
  }

  snapshot(): TranscriptMessage[] {
    return this.messages;
  }
}
