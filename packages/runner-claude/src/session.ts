// session.ts — one agent session driven by the Claude Agent SDK.
//
// The prompt is *always* an async iterable, never a string. That is what puts
// the SDK in streaming-input mode, which is the only mode where `interrupt()`
// and `setPermissionMode()` are available — and interrupt is how a run gets
// cancelled. Passing a plain string would close that door permanently.
//
// Note we own the iterable rather than calling `Query.streamInput()`: that
// method does not exist in the SDK version pinned here, and driving the queue
// ourselves works on every version.

import type {
  Options,
  PermissionMode,
  Query,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { isRetryableResultError, retryDelayMs } from './retryable.js';
import { type MessageInfo, TranscriptBuilder, type TranscriptMessage } from './translate.js';

/**
 * How many times a turn that ended in a transient API error is re-driven
 * before the run is allowed to fail. Overridable so a cluster seeing sustained
 * capacity pressure can raise it without a rebuild.
 */
const MAX_TRANSIENT_RETRIES = Number(process.env.CLAUDE_MAX_TRANSIENT_RETRIES ?? 3);

/** First backoff step; each later attempt quadruples it up to the cap. */
const RETRY_BASE_MS = Number(process.env.CLAUDE_RETRY_BASE_MS ?? 5_000);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** An async iterable that can be appended to after iteration has begun. */
class PushableQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiting: ((r: IteratorResult<T>) => void) | undefined;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const w = this.waiting;
    if (w) {
      this.waiting = undefined;
      w({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  close(): void {
    this.closed = true;
    const w = this.waiting;
    if (w) {
      this.waiting = undefined;
      w({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

export type SessionPhase = 'created' | 'running' | 'idle' | 'completed' | 'failed';

type Subscriber = (event: string, data: unknown) => void;

export type SessionConfig = {
  cwd: string;
  model?: string;
  permissionMode: PermissionMode;
  mcpServers?: Options['mcpServers'];
  appendSystemPrompt?: string;
  agents?: Options['agents'];
  resume?: string;
  /**
   * Path to the `claude` binary. The SDK ships a bundled one, but it lives in
   * an optional per-platform package that pnpm leaves dangling whenever its
   * (large) tarball fails to download — and the resulting failure surfaces only
   * at first query, not at install. Pointing at an explicitly installed CLI is
   * both deterministic and pins the runner's CLI version visibly in the image.
   */
  pathToExecutable?: string;
};

export class RunSession {
  title = '';
  phase: SessionPhase = 'created';
  error: string | undefined;
  /** The SDK's own session id, kept for resume/fork; not what we report outward. */
  sdkSessionId = '';

  private builder: TranscriptBuilder;
  private queue = new PushableQueue<SDKUserMessage>();
  private q: Query | undefined;
  private subscribers = new Set<Subscriber>();
  private pump: Promise<void> | undefined;
  private agent: string | undefined;
  /** Transient-error retries spent so far, across the whole session. */
  private attempt = 0;

  /**
   * `id` is the external session id handed to the dispatcher by POST /session.
   * Everything the dispatcher subsequently does is keyed by it, so the
   * transcript reports it rather than the SDK's internal id.
   */
  constructor(
    private cfg: SessionConfig,
    readonly id: string,
  ) {
    this.builder = new TranscriptBuilder(id);
  }

  setModelId(modelId: string): void {
    this.cfg.model = modelId;
  }

  /**
   * The requested agent name. Agent *behaviour* comes from CLAUDE.md and
   * .claude/agents/ written by the operator's config adapter, so this is
   * recorded for the transcript rather than used to build a system prompt here.
   */
  setAgent(agent: string): void {
    this.agent = agent;
  }

  /** Start the loop on the first turn; append to it on every later turn. */
  startOrSend(prompt: string): void {
    if (!this.pump) {
      this.title = this.title || prompt.slice(0, 120);
      this.enqueue(prompt);
      this.startLoop();
      return;
    }
    this.enqueue(prompt);
    if (this.phase === 'idle') this.phase = 'running';
  }

  private startLoop(): void {
    const options: Options = {
      cwd: this.cfg.cwd,
      permissionMode: this.cfg.permissionMode,
      model: this.cfg.model,
      mcpServers: this.cfg.mcpServers,
      agents: this.cfg.agents,
      resume: this.cfg.resume,
      pathToClaudeCodeExecutable: this.cfg.pathToExecutable,
      // 'project' is required for CLAUDE.md to load at all; without it the
      // workspace's own instructions are silently ignored.
      settingSources: ['user', 'project'],
      // The preset+append form *adds* to Claude Code's own system prompt. A
      // bare string here would replace it outright and take every piece of
      // built-in tool guidance with it.
      ...(this.cfg.appendSystemPrompt
        ? {
            systemPrompt: {
              type: 'preset' as const,
              preset: 'claude_code' as const,
              append: this.cfg.appendSystemPrompt,
            },
          }
        : {}),
    };
    // query() can throw synchronously — a missing CLI binary is the common
    // case. Record that as a failed session rather than letting it escape as
    // an opaque 500, so the dispatcher sees a run that failed for a stated
    // reason instead of a request that vanished.
    try {
      this.q = query({ prompt: this.queue, options });
    } catch (e) {
      this.phase = 'failed';
      this.error = e instanceof Error ? e.message : String(e);
      this.emit('error', { message: this.error });
      this.emit('done', { phase: this.phase, error: this.error });
      return;
    }
    this.pump = this.consume(this.q);
  }

  private enqueue(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: this.sdkSessionId,
    } as SDKUserMessage);
  }

  /**
   * Re-drive a turn that ended in a transient API error.
   *
   * The query is still alive at this point — an errored `result` closes the
   * turn, not the loop — so recovery is just another user message on the same
   * conversation, and the model keeps everything it had already established.
   * A fresh instruction is sent rather than the original prompt because the
   * original was already delivered and partially answered; re-sending it would
   * have the agent redo work it may have completed.
   *
   * Returns false when the budget is spent, which lets the error land in the
   * transcript and fail the run as before.
   */
  private retryTurn(msg: unknown): boolean {
    if (this.attempt >= MAX_TRANSIENT_RETRIES) {
      console.error(
        `[session ${this.id}] transient API error, ${this.attempt} retries exhausted — failing`,
      );
      return false;
    }
    this.attempt++;
    const detail = (msg as { result?: string }).result ?? 'unknown error';
    const delay = retryDelayMs(this.attempt, RETRY_BASE_MS);
    console.warn(
      `[session ${this.id}] transient API error (${detail.slice(0, 120)}) — ` +
        `retry ${this.attempt}/${MAX_TRANSIENT_RETRIES} in ${delay}ms`,
    );
    // Deliberately not awaited: consume() must keep draining the query, and the
    // queue is what the SDK is blocked on. Sleeping here would deadlock it.
    void sleep(delay).then(() => {
      if (this.phase === 'failed' || this.phase === 'completed') return;
      this.enqueue(
        `The previous turn ended with a transient API error: ${detail}\n` +
          'This was an infrastructure failure, not a problem with your work. ' +
          'Continue the task from where you left off.',
      );
    });
    return true;
  }

  private async consume(q: Query): Promise<void> {
    this.phase = 'running';
    try {
      for await (const msg of q) {
        const m = msg as { session_id?: string; type?: string };
        if (!this.sdkSessionId && m.session_id) this.sdkSessionId = m.session_id;

        // Decided before the push so the error never reaches the transcript on
        // a turn we are about to retry. Both run on the same tick, so no poll
        // of /session/:id/message can observe the intermediate state.
        const retrying = m.type === 'result' && isRetryableResultError(msg) && this.retryTurn(msg);

        this.builder.push(msg, { suppressError: retrying });
        this.emit('message', msg);
        if (m.type === 'result' && !retrying) {
          // The loop stays open for further turns pushed via startOrSend().
          this.phase = 'idle';
          this.emit('idle', { agent: this.agent });
        }
      }
      this.builder.finalizeOpenTools();
      this.phase = 'completed';
    } catch (e) {
      this.builder.finalizeOpenTools();
      this.phase = 'failed';
      this.error = e instanceof Error ? e.message : String(e);
      this.emit('error', { message: this.error });
    } finally {
      this.emit('done', { phase: this.phase, error: this.error });
    }
  }

  async interrupt(): Promise<void> {
    await this.q?.interrupt();
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.q?.setPermissionMode(mode);
  }

  /** Close the input queue so the agent loop can finish naturally. */
  finish(): void {
    this.queue.close();
  }

  messages(): TranscriptMessage[] {
    return this.builder.snapshot();
  }

  /** `info` of the most recent message — what SSE message.updated carries. */
  latestInfo(): MessageInfo | undefined {
    const all = this.builder.snapshot();
    return all[all.length - 1]?.info;
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  private emit(event: string, data: unknown): void {
    for (const fn of this.subscribers) {
      try {
        fn(event, data);
      } catch {
        // A broken SSE client must never take down the agent loop.
      }
    }
  }
}
