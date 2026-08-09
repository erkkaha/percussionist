// polling.ts — prompt-mode and interactive-mode polling loops.

import http from 'node:http';
import { LABELS, MANAGED_BY, RunPhase } from '@percussionist/api';
import {
  BASE_URL,
  checkHealth,
  compactMessagesForSnapshot,
  fetchMessages,
  listSessions,
  type RawMessage,
} from './session.js';
import { incrementalFlush, sendStats } from './stats-reporter.js';

const log = (...args: unknown[]) =>
  console.log(`[dispatcher ${new Date().toISOString()}]`, ...args);
const err = (...args: unknown[]) =>
  console.error(`[dispatcher ${new Date().toISOString()}]`, ...args);

/**
 * An unrecoverable condition detected inside the poll loop.
 *
 * The loop's catch deliberately swallows errors so a transient blip (a failed
 * fetchMessages, a momentary patch failure) doesn't kill a healthy run. But it
 * used to swallow the loop's *own* fatal throws too — opencode failing its
 * health check, never producing a first response, or returning an empty
 * assistant message. Those conditions never resolve, so the run kept polling
 * until the 65-minute hard timeout fired, exiting via a path that writes no
 * snapshot, no stats and no Failed phase.
 *
 * Throwing this type instead marks an error as "stop now": the catch re-raises
 * it, runPrompt rejects, and main()'s handler does the normal failure work
 * (snapshot, stats, patch Failed).
 */
export class FatalRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalRunError';
  }
}

function isMessageAbortedError(error: unknown): boolean {
  if (typeof error === 'string') return error.includes('Abort') || error === 'MessageAbortedError';
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>;
    if (
      e.name === 'MessageAbortedError' ||
      e.type === 'MessageAbortedError' ||
      e.code === 'MessageAbortedError'
    )
      return true;
    if (e.name === 'AbortError' || e.type === 'AbortError') return true;
    if (e.name === 'Aborted') return true;
  }
  return false;
}

function isAbortedMessageInError(e: Error): boolean {
  return (
    isMessageAbortedError(e) ||
    e.message?.includes('MessageAbortedError') ||
    e.message?.includes('AbortError') ||
    e.message?.includes('Aborted')
  );
}

function logEvent(evt: { type?: string; properties?: Record<string, unknown> }): void {
  if (!evt.type || evt.type === 'server.connected') return;
  const p = evt.properties ?? {};
  const info = p.info as
    | {
        sessionID?: string;
        id?: string;
        role?: string;
        tokens?: {
          input?: number;
          output?: number;
          reasoning?: number;
          cache?: { read?: number; write?: number };
        };
        cost?: number;
      }
    | undefined;
  const pieces = [
    info?.sessionID ? `session=${info.sessionID}` : undefined,
    info?.id ? `message=${info.id}` : undefined,
    info?.role ? `role=${info.role}` : undefined,
    typeof info?.tokens?.input === 'number'
      ? `tokens=${info.tokens.input}/${info.tokens.output ?? 0}`
      : undefined,
    typeof info?.cost === 'number' ? `cost=${info.cost}` : undefined,
  ].filter(Boolean);
  log(`[event] ${evt.type}${pieces.length ? ` ${pieces.join(' ')}` : ''}`);
}

function maybeLogStreamReconnect(mode: 'interactive' | 'prompt', reconnects: number): void {
  if (reconnects === 1 || reconnects % 60 === 0) {
    log(
      `[event] ${mode} SSE stream reconnected ${reconnects} time(s); OpenCode may be closing /event after server.connected`,
    );
  }
}

const MODEL = process.env.RUN_MODEL ?? '';
const AGENT = process.env.RUN_AGENT ?? '';
const TASK = process.env.RUN_TASK ?? '';
// Allow up to 1 hour for the model to produce its first assistant response.
// POST /session/{id}/message may remain open while opencode processes the
// model request, so the dispatcher starts it asynchronously and relies on the
// poll loop to enforce this first-response deadline.
const FIRST_RESPONSE_TIMEOUT_MS = 3_600_000;
const HARD_TIMEOUT_MS = FIRST_RESPONSE_TIMEOUT_MS + 300_000;
const SETTLE_MS = 10_000;
const IDLE_TIMEOUT_MS = 900_000;

// ---------------------------------------------------------------------------
// Token aggregator

export class TokenAggregator {
  // Per message, so repeated deliveries of the same message do not double-count
  // and distinct messages are summed rather than collapsed to the largest.
  private byMessage = new Map<
    string,
    {
      input: number;
      output: number;
      reasoning: number;
      cacheRead: number;
      cacheWrite: number;
      cost: number;
    }
  >();
  private lastWrite = 0;

  /**
   * Record one message's usage.
   *
   * Keyed by message id, not just session: the poller re-reads the whole
   * message list every tick and streaming updates re-deliver a message before
   * it settles, so the same message arrives many times. Taking the max within
   * an id absorbs those repeats (a message's counts only grow as it streams),
   * while totals() sums across distinct ids.
   *
   * This previously took the max across the entire session, which reported the
   * single largest message instead of the run: a build run that emitted 172
   * output tokens over 16 messages was recorded as 59, and because prompt
   * caching leaves each message's uncached `input` at 2, every run in the list
   * showed "2" for input regardless of size.
   */
  update(
    sessionID: string,
    messageID: string,
    input: number,
    output: number,
    reasoning?: number,
    cacheRead?: number,
    cacheWrite?: number,
    cost?: number,
  ): void {
    const key = `${sessionID}\u0000${messageID}`;
    const prev = this.byMessage.get(key) ?? {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    };
    this.byMessage.set(key, {
      input: Math.max(prev.input, input),
      output: Math.max(prev.output, output),
      reasoning: Math.max(prev.reasoning, reasoning ?? 0),
      cacheRead: Math.max(prev.cacheRead, cacheRead ?? 0),
      cacheWrite: Math.max(prev.cacheWrite, cacheWrite ?? 0),
      cost: Math.max(prev.cost, cost ?? 0),
    });
  }

  totals(): {
    tokensIn: number;
    tokensOut: number;
    tokensReasoning: number;
    tokensCacheRead: number;
    tokensCacheWrite: number;
    cost: number;
  } {
    let tokensIn = 0;
    let tokensOut = 0;
    let tokensReasoning = 0;
    let tokensCacheRead = 0;
    let tokensCacheWrite = 0;
    let cost = 0;
    for (const {
      input,
      output,
      reasoning,
      cacheRead,
      cacheWrite,
      cost: c,
    } of this.byMessage.values()) {
      tokensIn += input;
      tokensOut += output;
      tokensReasoning += reasoning;
      tokensCacheRead += cacheRead;
      tokensCacheWrite += cacheWrite;
      cost += c;
    }
    return { tokensIn, tokensOut, tokensReasoning, tokensCacheRead, tokensCacheWrite, cost };
  }

  async flush(patchStatus: (p: object) => Promise<void>, force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastWrite < 3000) return;
    this.lastWrite = now;
    await patchStatus(this.totals());
  }
}

/**
 * Feed every assistant message's usage into the aggregator.
 *
 * Safe to call on every poll with the whole transcript: the aggregator keys on
 * message id and keeps the max within an id, so repeats converge on each
 * message's final counts rather than adding up.
 *
 * A message with no usage and no cost is skipped so it cannot mint an entry that
 * contributes nothing but occupies an id.
 */
export function recordUsage(
  tokens: TokenAggregator,
  sessionID: string,
  msgs: readonly {
    info?: {
      id?: string;
      role?: string;
      cost?: number;
      tokens?: {
        input?: number;
        output?: number;
        reasoning?: number;
        cache?: { read?: number; write?: number };
      };
    };
  }[],
): void {
  for (let i = 0; i < msgs.length; i++) {
    const info = msgs[i]?.info;
    if (info?.role !== 'assistant') continue;
    const t = info.tokens;
    const cost = info.cost ?? 0;
    if (!t?.input && !t?.output && !t?.cache?.read && !t?.cache?.write && cost <= 0) continue;
    // Index is the fallback id so two usage-bearing messages without ids stay
    // distinct instead of collapsing into one entry.
    tokens.update(
      sessionID,
      info.id ?? `${sessionID}-idx-${i}`,
      t?.input ?? 0,
      t?.output ?? 0,
      t?.reasoning,
      t?.cache?.read,
      t?.cache?.write,
      cost,
    );
  }
}

// ---------------------------------------------------------------------------
// Session snapshot

const CM_MAX_BYTES = 900_000;

export async function snapshotAllSessions(
  coreApi: import('@kubernetes/client-node').CoreV1Api,
  runName: string,
  runNamespace: string,
  runUid: string,
  knownSessionID?: string,
): Promise<void> {
  const { API_GROUP_VERSION, KIND_RUN } = await import('@percussionist/api');
  const { PatchStrategy, setHeaderOptions } = await import('@kubernetes/client-node');

  let sessions = await listSessions();
  if (sessions.length === 0 && knownSessionID) {
    // opencode may already be shut down; fall back to snapshotting the known session.
    log(
      `snapshotAllSessions: listSessions() returned empty, falling back to knownSessionID ${knownSessionID}`,
    );
    sessions = [{ id: knownSessionID }];
  }
  if (sessions.length === 0) return;

  log(`snapshotAllSessions: snapshotting ${sessions.length} session(s)`);
  const perSessionBudget = Math.floor(CM_MAX_BYTES / sessions.length);
  const cmData: Record<string, string> = {
    'sessions.json': JSON.stringify(sessions.map((s) => s.id)),
  };

  for (const session of sessions) {
    let messages = compactMessagesForSnapshot(await fetchMessages(session.id));
    let json = JSON.stringify(messages);
    let truncated = false;
    while (Buffer.byteLength(json, 'utf8') > perSessionBudget && messages.length > 1) {
      truncated = true;
      messages = messages.slice(1);
      json = JSON.stringify(messages);
    }
    cmData[`messages-${session.id}.json`] = json;
    if (truncated) cmData[`truncated-${session.id}`] = 'true';
  }

  const cmMeta = {
    name: `${runName}-session`,
    namespace: runNamespace,
    labels: {
      [LABELS.managedBy]: MANAGED_BY,
      [LABELS.runName]: runName,
      'percussionist.dev/component': 'session-snapshot',
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
      body: { apiVersion: 'v1', kind: 'ConfigMap', metadata: cmMeta, data: cmData },
    });
    log(`snapshotAllSessions: created ConfigMap ${runName}-session`);
  } catch (createErr) {
    if (!/already exists/i.test((createErr as Error).message)) {
      err('snapshotAllSessions: create failed:', (createErr as Error).message);
      return;
    }
    try {
      await coreApi.patchNamespacedConfigMap(
        { name: `${runName}-session`, namespace: runNamespace, body: { data: cmData } },
        setHeaderOptions('Content-Type', PatchStrategy.MergePatch),
      );
    } catch (patchErr) {
      err('snapshotAllSessions: patch failed:', (patchErr as Error).message);
    }
  }
}

// ---------------------------------------------------------------------------
// Shared SSE transport
//
// Both runInteractive and runPrompt tail opencode's /event stream. The
// transport machinery — fetch with Accept: text/event-stream, reconnect
// counting, !ok/!body backoff, the \n\n buffer split / data: line filter /
// JSON.parse loop, logEvent, reader.cancel(), the 5-error fatal threshold and
// the 1 s inter-reconnect delay (the reconnect-storm fix per AGENTS.md) — is
// identical in both modes; only the per-event handlers differ. The wrappers
// supply mode/isTerminated/sleep and their own onEvent handler.

export interface SseStreamOptions {
  mode: 'interactive' | 'prompt';
  isTerminated: () => boolean;
  sleep: (ms: number) => Promise<void>;
  onEvent: (evt: { type?: string; properties?: Record<string, unknown> }) => void | Promise<void>;
}

export async function streamSseEvents(opts: SseStreamOptions): Promise<void> {
  const { mode, isTerminated, sleep, onEvent } = opts;
  let streamErrors = 0;
  let reconnects = 0;
  while (!isTerminated()) {
    try {
      if (reconnects > 0) maybeLogStreamReconnect(mode, reconnects);
      const evtRes = await fetch(`${BASE_URL}/event`, {
        headers: { Accept: 'text/event-stream' },
      });
      reconnects++;
      if (!evtRes.ok || !evtRes.body) {
        await sleep(5000);
        continue;
      }
      streamErrors = 0;
      const reader = evtRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!isTerminated()) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // biome-ignore lint/suspicious/noImplicitAnyLet: idx is inferred from indexOf
        let idx;
        // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic SSE parse loop
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLines = raw
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart());
          if (dataLines.length === 0) continue;
          let evt: { type?: string; properties?: Record<string, unknown> };
          try {
            evt = JSON.parse(dataLines.join('\n'));
          } catch {
            continue;
          }
          logEvent(evt);
          await onEvent(evt);
        }
      }
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
    } catch (e) {
      if (isTerminated()) return;
      streamErrors++;
      err('SSE stream error:', (e as Error).message, `(${streamErrors}/5)`);
      if (streamErrors >= 5) {
        throw new Error('opencode server unreachable: stream disconnected');
      }
      await sleep(5000);
    }
    // Add delay between all reconnection attempts (success or error) to prevent runaway loops
    if (!isTerminated()) await sleep(1000);
  }
}

// ---------------------------------------------------------------------------
// Interactive mode

export async function runInteractive(
  patchStatus: (p: object) => Promise<void>,
  isShuttingDown: () => boolean,
  sleep: (ms: number) => Promise<void>,
  coreApi: import('@kubernetes/client-node').CoreV1Api,
  runName: string,
  runNamespace: string,
  runUid: string,
): Promise<void> {
  await patchStatus({
    phase: RunPhase.Running,
    startedAt: new Date().toISOString(),
    message: 'waiting for attach or web session',
  });
  log('interactive mode — waiting for session via web UI or `beatctl attach`');

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
      .then(() => {
        hasSnapshotted = true;
      })
      .catch((e) => err(`snapshot (${reason}) failed:`, (e as Error).message))
      .finally(() => {
        snapshotPending = false;
      });
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
            await patchStatus({ sessionID: firstSessionID, message: 'session active' });
            // Snapshot immediately on first session discovery.
            maybeSnapshot('session discovered');
          }
        }
      }
      for (const sessionID of knownSessions) {
        recordUsage(tokens, sessionID, await fetchMessages(sessionID));
      }
      await tokens.flush(patchStatus);
      await sleep(3000);
    }
  };

  const streamEvents = async (): Promise<void> => {
    await streamSseEvents({
      mode: 'interactive',
      isTerminated: () => terminate,
      sleep,
      onEvent: async (evt) => {
        if (evt.type === 'session.idle') {
          // Snapshot after the first assistant turn completes.
          if (!hasSnapshotted) maybeSnapshot('first idle');
          // Incremental DB flush on each completed turn.
          if (firstSessionID) {
            const sid = firstSessionID;
            const totals = tokens.totals();
            incrementalFlush(sid, interactiveStartedAt, totals, interactiveFlushCursor)
              .then((newCursor) => {
                interactiveFlushCursor = newCursor;
              })
              .catch((e) =>
                err('interactive incrementalFlush failed (non-fatal):', (e as Error).message),
              );
          }
        }
        if (evt.type === 'message.updated') {
          const p = (evt.properties ?? {}) as {
            info?: {
              sessionID?: string;
              id?: string;
              tokens?: {
                input?: number;
                output?: number;
                reasoning?: number;
                cache?: { read?: number; write?: number };
              };
              cost?: number;
            };
          };
          const sid = p.info?.sessionID;
          if (sid) {
            if (!knownSessions.has(sid)) {
              knownSessions.add(sid);
              if (!firstSessionID) {
                firstSessionID = sid;
                await patchStatus({ sessionID: firstSessionID, message: 'session active' });
              }
            }
            if (typeof p.info?.tokens?.input === 'number' || typeof p.info?.cost === 'number')
              tokens.update(
                sid,
                p.info.id ?? `${sid}-live`,
                p.info.tokens?.input ?? 0,
                p.info.tokens?.output ?? 0,
                p.info.tokens?.reasoning,
                p.info.tokens?.cache?.read,
                p.info.tokens?.cache?.write,
                p.info.cost,
              );
            await tokens.flush(patchStatus);
          }
        }
      },
    });
  };

  const shutdown = new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (isShuttingDown()) {
        terminate = true;
        clearInterval(check);
        resolve();
      }
    }, 500);
  });

  // Periodic snapshot every 2 minutes as a safety net for long interactive sessions.
  const periodicInteractiveSnapshot = async (): Promise<void> => {
    while (!terminate) {
      await sleep(120_000);
      if (!terminate && firstSessionID) maybeSnapshot('periodic');
    }
  };

  await Promise.race([
    Promise.all([discoverSessions(), streamEvents(), periodicInteractiveSnapshot()]),
    shutdown,
  ]);
  terminate = true;

  await tokens.flush(patchStatus, true);
  log('interactive session ending — snapshotting');
  await snapshotAllSessions(coreApi, runName, runNamespace, runUid);
  await patchStatus({ message: 'dispatcher terminated' });
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
// Poll status loop
//
// Extracted from runPrompt so the message stream, timing and health-check
// behavior can be unit-tested with scripted deps. The loop owns its transient
// state (sawBusy, idle/completing timers, published phase) while the three
// fields that runPrompt's other actors (SSE stream handler, completion/failure
// signals, hard timeout) read and write stay in the shared `state` object.

export interface PollLoopSharedState {
  /** Set true to stop the loop; also set by the completion/failure signals. */
  terminate: boolean;
  /**
   * "The session is parked" — drives the idle timeout and the
   * don't-terminate-yet logic. Set by session.idle, which fires after EVERY
   * completed assistant turn — so it is not evidence that a human is needed.
   */
  waitingForInput: boolean;
  /**
   * The narrower question: is the run actually blocked on a person? Only a
   * permission prompt or a user-aborted message mean that. This is what gets
   * published as RunPhase.WaitingForInput, because the manager fails any
   * non-PLAN task that reports it ("BUILD tasks cannot wait for input").
   */
  needsHumanInput: boolean;
}

export interface RunPollStatusConstants {
  pollMs: number;
  firstResponseTimeoutMs: number;
  settleMs: number;
  idleTimeoutMs: number;
  healthFailThreshold: number;
}

export interface RunPollStatusDeps {
  fetchMessages: (sessionID: string) => Promise<RawMessage[]>;
  checkHealth: () => Promise<boolean>;
  patchStatus: (p: object) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  isShuttingDown: () => boolean;
  sessionID: string;
  state: PollLoopSharedState;
  tokens: TokenAggregator;
  constants: RunPollStatusConstants;
}

export async function runPollStatusLoop(deps: RunPollStatusDeps): Promise<void> {
  const {
    fetchMessages,
    checkHealth,
    patchStatus,
    sleep,
    now,
    isShuttingDown,
    sessionID,
    state,
    tokens,
    constants,
  } = deps;
  const { pollMs, firstResponseTimeoutMs, settleMs, idleTimeoutMs, healthFailThreshold } =
    constants;

  const startedAt = now();
  await sleep(1000);
  let iter = 0;
  let unhealthyCount = 0;
  // Set true only when the poll loop sees its first assistant message (and is
  // what keeps the first-response timeout from firing once the model is
  // mid-stream). Note it is deliberately NOT consulted by the zero-token guard
  // below — a zero-token first response must still throw FatalRunError.
  let sawBusy = false;
  // Last value of `needsHumanInput` published to the CR. The dispatcher is the
  // only component that can observe an agent pausing for clarification, so if
  // it doesn't write RunPhase.WaitingForInput nobody does.
  let publishedWaiting = false;
  let lastMessageId: string | undefined;
  let idleSince: number | undefined;
  let completingSince: number | undefined;

  while (!state.terminate && !isShuttingDown()) {
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
          if (unhealthyCount >= healthFailThreshold) {
            throw new FatalRunError('opencode server unreachable: health check failed');
          }
        } else {
          unhealthyCount = 0;
        }
      }

      const elapsedSinceStart = now() - startedAt;
      if (!sawBusy && elapsedSinceStart > firstResponseTimeoutMs) {
        throw new FatalRunError(
          `opencode did not produce an assistant response within ${firstResponseTimeoutMs / 1000}s of dispatch`,
        );
      }

      // Activity detection — any new message (user or assistant) resets
      // the idle timer and settling counter.
      if (last?.info?.id && last.info.id !== lastMessageId) {
        lastMessageId = last.info.id;
        idleSince = undefined;
        completingSince = undefined;
      }

      if (last?.info?.role === 'assistant') {
        sawBusy = true;
        // Record every message, not just the newest. This used to sample only
        // the tail, so a run's reported usage depended on how many distinct
        // messages happened to be last at a poll boundary: anything that
        // arrived and was superseded inside one 2s tick was never counted at
        // all. A build task that finished quickly reported 2 in / 56 out
        // because the tail was sampled about once, while a long one that
        // failed reported 1457 / 22943 from the same code — the difference was
        // poll cadence, not usage.
        //
        // Idempotent to repeat: the aggregator keys on message id and takes
        // the max within an id, so re-reading the whole list every tick
        // converges on each message's final counts instead of accumulating
        // them.
        recordUsage(tokens, sessionID, msgs);
        await tokens.flush(patchStatus);

        // Check for errors regardless of time.completed — OpenCode may set
        // a MessageAbortedError on the message without setting the completed
        // timestamp (aborted messages are never fully "completed").
        if (last.info.error) {
          if (isMessageAbortedError(last.info.error)) {
            if (!state.waitingForInput) {
              log('assistant message aborted by user — waiting for input');
              state.waitingForInput = true;
            }
            // A user-cancelled message genuinely leaves the run blocked on a
            // person deciding what to do next.
            state.needsHumanInput = true;
          } else {
            throw new Error(`session error: ${JSON.stringify(last.info.error)}`);
          }
        }

        if (last.info.time?.completed) {
          const totalTokens = tokens.totals();
          if (state.waitingForInput) {
            // Don't reset waitingForInput for abort errors on the current
            // message.  Only reset when a new non-aborted message arrives.
            if (!last.info.error && (totalTokens.tokensIn > 0 || totalTokens.tokensOut > 0)) {
              state.waitingForInput = false;
              // Work resumed, so whatever the human was needed for is done.
              state.needsHumanInput = false;
            }
            // If still waiting (aborted or idle), fall through without
            // terminating — the poll loop keeps running.
          } else if (totalTokens.tokensIn === 0 && totalTokens.tokensOut === 0) {
            // A completed assistant message with zero recorded usage means
            // opencode "answered" without producing anything. For the first
            // response this is fatal. (Regression: `sawBusy = true` used to be
            // set before this check, making the guard unreachable, so an empty
            // first response silently fell through to waitingForInput. Once
            // any usage has been recorded totalTokens is > 0, so this branch
            // can only ever fire on the first assistant message.)
            throw new FatalRunError(
              'opencode produced an assistant response with zero token usage before any work was done',
            );
          } else if (completingSince && now() - completingSince >= settleMs) {
            log('last assistant message completed — settled, done');
            state.terminate = true;
            return;
          } else if (!completingSince) {
            completingSince = now();
          }
        }
      }

      // --- idle timeout: terminate if session is idle for too long ---
      if (state.waitingForInput) {
        if (idleSince === undefined) idleSince = now();
        if (now() - idleSince >= idleTimeoutMs) {
          log('session idle for too long — terminating');
          state.terminate = true;
          return;
        }
      } else {
        idleSince = undefined;
      }

      // --- publish WaitingForInput <-> Running transitions to the CR ---
      // Done here rather than at each mutation site so it also picks up flips
      // made by the SSE handler, which runs outside this loop.
      if (state.needsHumanInput !== publishedWaiting) {
        publishedWaiting = state.needsHumanInput;
        const phase = state.needsHumanInput ? RunPhase.WaitingForInput : RunPhase.Running;
        log(`phase -> ${phase}`);
        await patchStatus({ phase });
      }
    } catch (e) {
      if (state.terminate) return;
      // Unrecoverable conditions must escape the loop so main() can snapshot,
      // report stats and patch Failed. Everything else is treated as a
      // transient blip and retried on the next tick.
      if (e instanceof FatalRunError) {
        err('pollStatus fatal:', e.message);
        throw e;
      }
      if ((e as Error).message?.startsWith('session error:')) throw e;
      err('pollStatus iter error:', (e as Error).message);
    }
    await sleep(pollMs);
  }
}

// ---------------------------------------------------------------------------
// Prompt-driven mode

export interface PromptPostResult {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/**
 * Injectable seams for runPrompt. Every field defaults to the real
 * implementation (the caller-provided patchStatus/sleep, the session.js
 * helpers, snapshotAllSessions, sendStats, the live /session POST), so passing
 * no deps is behavior-identical to the pre-seam code. Tests override the
 * fields to drive the race outcomes, the prompt-POST retry matrix and the
 * hard-timeout path deterministically.
 */
export interface RunPromptDeps {
  /** POST the prompt to the session; default hits opencode's /session/{id}/message. */
  postMessage?: (sessionID: string, body: Record<string, unknown>) => Promise<PromptPostResult>;
  /** Read messages for a session (poll loop + retry "already has messages" check). */
  fetchMessages?: typeof fetchMessages;
  /** opencode health probe (poll loop). */
  checkHealth?: typeof checkHealth;
  /** Sleep; default is the caller-provided sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock for the poll loop and timestamps; default Date.now. */
  now?: () => number;
  /** Status patcher; default is the caller-provided patchStatus. */
  patchStatus?: (p: object) => Promise<void>;
  /** Session snapshot; default snapshotAllSessions with the caller-provided coreApi. */
  snapshot?: typeof snapshotAllSessions;
  /** Full analytics flush on run completion; default sendStats. */
  sendStats?: typeof sendStats;
  /** Create the opencode session; default POSTs /session. */
  createSession?: () => Promise<{ id: string }>;
  /** Hard-timeout delay in ms; default HARD_TIMEOUT_MS. */
  hardTimeoutMs?: number;
}

export async function runPrompt(
  patchStatus: (p: object) => Promise<void>,
  isShuttingDown: () => boolean,
  sleep: (ms: number) => Promise<void>,
  coreApi: import('@kubernetes/client-node').CoreV1Api,
  runName: string,
  runNamespace: string,
  runUid: string,
  failureSignal: Promise<string>,
  completionSignal: Promise<string>,
  planSignal?: Promise<string>,
  deps?: RunPromptDeps,
): Promise<{ sessionID: string; startedAt: string }> {
  const d = deps ?? {};
  const tokens = new TokenAggregator();

  const doCreateSession =
    d.createSession ??
    (async () => {
      const sessionRes = await fetch(`${BASE_URL}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: `run/${runName}` }),
      });
      if (!sessionRes.ok) throw new Error(`Failed to create session: HTTP ${sessionRes.status}`);
      return (await sessionRes.json()) as { id: string };
    });
  const doNow = d.now ?? (() => Date.now());
  const doSleep = d.sleep ?? sleep;
  const doPatchStatus = d.patchStatus ?? patchStatus;
  const doFetchMessages = d.fetchMessages ?? fetchMessages;
  const doCheckHealth = d.checkHealth ?? checkHealth;
  const doSendStats = d.sendStats ?? sendStats;
  const doSnapshot =
    d.snapshot ?? ((c, rn, ns, ru, sid) => snapshotAllSessions(c, rn, ns, ru, sid));

  const sessionData = await doCreateSession();
  const sessionID = sessionData.id;
  log(`created session ${sessionID}`);
  const runStartedAt = new Date(doNow()).toISOString();
  await doPatchStatus({
    phase: RunPhase.Running,
    sessionID,
    startedAt: runStartedAt,
    message: 'dispatching prompt',
  });

  const promptBody: Record<string, unknown> = { parts: [{ type: 'text', text: TASK }] };
  if (AGENT) promptBody.agent = AGENT;
  if (MODEL) {
    const slashIdx = MODEL.indexOf('/');
    if (slashIdx !== -1) {
      promptBody.model = {
        providerID: MODEL.slice(0, slashIdx),
        modelID: MODEL.slice(slashIdx + 1),
      };
    } else {
      promptBody.model = { modelID: MODEL };
    }
  }

  // Shared state for the poll-status loop (extracted into runPollStatusLoop).
  // `waitingForInput` means "the session is parked" and drives the idle timeout
  // and the don't-terminate-yet logic. It is set by session.idle, which fires
  // after EVERY completed assistant turn — so it is not evidence that a human
  // is needed.
  // `needsHumanInput` is the narrower question: is the run actually blocked on a
  // person? Only a permission prompt or a user-aborted message mean that. This
  // is what gets published as RunPhase.WaitingForInput, because the manager
  // fails any non-PLAN task that reports it ("BUILD tasks cannot wait for
  // input"). Publishing on session.idle failed every BUILD task at the end of
  // its first turn.
  const pollState: PollLoopSharedState = {
    terminate: false,
    waitingForInput: false,
    needsHumanInput: false,
  };
  let promptFlushCursor = 0;

  // Transient error codes that warrant a retry of the prompt POST.
  const RETRYABLE_CODES = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ECONNABORTED',
    'EPIPE',
    'ETIMEDOUT',
  ]);
  const MAX_PROMPT_RETRIES = 3;

  const promptPostController = new AbortController();
  const doPostMessage =
    d.postMessage ??
    ((sid: string, body: Record<string, unknown>) =>
      httpJsonPost(
        `${BASE_URL}/session/${sid}/message`,
        body,
        FIRST_RESPONSE_TIMEOUT_MS,
        promptPostController.signal,
      ));

  // Retry wrapper around httpJsonPost: on transient network errors, wait for
  // opencode to become healthy, check whether the session already has messages
  // (prompt was received before the disconnect), and re-POST only if not.
  const promptPost = (async () => {
    let attempt = 0;
    while (true) {
      try {
        const syncRes = await doPostMessage(sessionID, promptBody);
        if (!syncRes.ok) {
          throw new Error(`prompt failed: HTTP ${syncRes.status} ${await syncRes.text()}`);
        }
        const syncData = (await syncRes.json()) as {
          info?: Record<string, unknown>;
          parts?: unknown[];
        };
        const syncTokens = syncData.info?.tokens as
          | {
              input?: number;
              output?: number;
              reasoning?: number;
              cache?: { read?: number; write?: number };
            }
          | undefined;
        const syncTokensIn = syncTokens?.input ?? 0;
        const syncTokensOut = syncTokens?.output ?? 0;
        const syncTokensReasoning = syncTokens?.reasoning ?? 0;
        const syncTokensCacheRead = syncTokens?.cache?.read ?? 0;
        const syncTokensCacheWrite = syncTokens?.cache?.write ?? 0;
        const syncCost = (syncData.info?.cost as number | undefined) ?? 0;
        if (syncTokensIn > 0 || syncTokensOut > 0 || syncCost > 0) {
          tokens.update(
            sessionID,
            (syncData.info?.id as string | undefined) ?? `${sessionID}-sync`,
            syncTokensIn,
            syncTokensOut,
            syncTokensReasoning,
            syncTokensCacheRead,
            syncTokensCacheWrite,
            syncCost,
          );
          await tokens.flush(doPatchStatus);
        }
        log('prompt completed (sync)', JSON.stringify(syncData.info));
        return;
      } catch (e) {
        if (pollState.terminate || promptPostController.signal.aborted) return;
        const code = (e as NodeJS.ErrnoException).code ?? '';
        const isRetryable =
          RETRYABLE_CODES.has(code) || (e as Error).message?.includes('socket hang up');
        if (!isRetryable || attempt >= MAX_PROMPT_RETRIES) throw e;
        attempt++;
        err(
          `prompt POST failed (${(e as Error).message}), retrying (${attempt}/${MAX_PROMPT_RETRIES})…`,
        );
        // Wait for opencode to be healthy before re-checking / re-posting.
        await doSleep(5000);
        // Check whether the prompt was already received (session has messages).
        // If so there's nothing to re-POST — the poll loop will handle completion.
        try {
          const existingMsgs = await doFetchMessages(sessionID);
          if (existingMsgs.length > 0) {
            log(
              `prompt POST failed but session already has ${existingMsgs.length} message(s) — skipping re-POST`,
            );
            return;
          }
        } catch {
          /* ignore — we'll retry the POST regardless */
        }
        log(`re-posting prompt (attempt ${attempt}/${MAX_PROMPT_RETRIES})`);
      }
    }
  })();
  const promptPostFailure = promptPost.then(() => new Promise<void>(() => {}));

  const pollStatus = (): Promise<void> =>
    runPollStatusLoop({
      fetchMessages: doFetchMessages,
      checkHealth: doCheckHealth,
      patchStatus: doPatchStatus,
      sleep: doSleep,
      now: doNow,
      isShuttingDown,
      sessionID,
      state: pollState,
      tokens,
      constants: {
        pollMs: 2000,
        firstResponseTimeoutMs: FIRST_RESPONSE_TIMEOUT_MS,
        settleMs: SETTLE_MS,
        idleTimeoutMs: IDLE_TIMEOUT_MS,
        healthFailThreshold: 3,
      },
    });

  const streamEvents = async (): Promise<void> => {
    await streamSseEvents({
      mode: 'prompt',
      isTerminated: () => pollState.terminate,
      sleep: doSleep,
      onEvent: async (evt) => {
        if (
          (evt.type === 'permission.updated' || evt.type === 'session.idle') &&
          !pollState.waitingForInput
        ) {
          pollState.waitingForInput = true;
          // Snapshot sessions immediately when parking so the manager can
          // read the conversation context even if this pod is killed while
          // waiting.
          doSnapshot(coreApi, runName, runNamespace, runUid, sessionID).catch((e) =>
            err('WaitingForInput snapshot failed:', (e as Error).message),
          );
        }
        // Only a permission prompt means a person has to act. session.idle
        // fires after every completed turn (see the flush below), so it
        // must not surface as RunPhase.WaitingForInput.
        if (evt.type === 'permission.updated') {
          pollState.needsHumanInput = true;
        }
        if (evt.type === 'session.idle') {
          // Incremental DB flush after each completed assistant turn.
          const totals = tokens.totals();
          incrementalFlush(sessionID, runStartedAt, totals, promptFlushCursor)
            .then((newCursor) => {
              promptFlushCursor = newCursor;
            })
            .catch((e) => err('prompt incrementalFlush failed (non-fatal):', (e as Error).message));
        }
        if (evt.type === 'message.updated') {
          const p = (evt.properties ?? {}) as {
            info?: {
              sessionID?: string;
              id?: string;
              tokens?: {
                input?: number;
                output?: number;
                reasoning?: number;
                cache?: { read?: number; write?: number };
              };
              cost?: number;
            };
          };
          if (p.info?.sessionID === sessionID) {
            if (typeof p.info.tokens?.input === 'number' || typeof p.info.cost === 'number')
              tokens.update(
                sessionID,
                p.info.id ?? `${sessionID}-live`,
                p.info.tokens?.input ?? 0,
                p.info.tokens?.output ?? 0,
                p.info.tokens?.reasoning,
                p.info.tokens?.cache?.read,
                p.info.tokens?.cache?.write,
                p.info.cost,
              );
            await tokens.flush(doPatchStatus);
          }
        }
      },
    });
  };

  // Hard-timeout guard. Previously this called process.exit(0)/process.exit(3)
  // directly, which skipped the session snapshot, sendStats and the
  // RunPhase.Failed patch — exactly the failure mode FatalRunError was
  // introduced to prevent (see the class comment above). Instead the timer
  // rejects a promise the Promise.race observes, so the run exits through the
  // normal snapshot → stats → Failed path and main()'s handler only has to do
  // the final (idempotent) status patch and process exit.
  const hardTimeoutMs = d.hardTimeoutMs ?? HARD_TIMEOUT_MS;
  let hardTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const hardTimeout = new Promise<never>((_resolve, reject) => {
    hardTimeoutHandle = setTimeout(() => {
      if (pollState.waitingForInput) {
        err('dispatcher timeout guard — waiting for input, failing run via normal path');
      } else {
        err('dispatcher timeout guard — hard timeout exceeded');
      }
      reject(new FatalRunError(`dispatcher hard timeout exceeded (${hardTimeoutMs}ms)`));
    }, hardTimeoutMs);
    hardTimeoutHandle.unref();
  });
  void streamEvents().catch((e) => {
    if (!pollState.terminate) err('streamEvents fatal:', (e as Error).message);
  });

  // Periodic snapshot every 30s for visibility during long-running tasks.
  // First iteration fires immediately (no initial delay) to capture early state.
  const periodicSnapshot = async (): Promise<void> => {
    let first = true;
    while (!pollState.terminate) {
      if (!first) await doSleep(30_000);
      first = false;
      if (!pollState.terminate) {
        doSnapshot(coreApi, runName, runNamespace, runUid, sessionID).catch((e) =>
          err('periodic snapshot failed:', (e as Error).message),
        );
      }
    }
  };
  void periodicSnapshot().catch((e) => {
    if (!pollState.terminate) err('periodicSnapshot fatal:', (e as Error).message);
  });

  // Race the normal poll loop against:
  // - fail_run: agent signals failure → throw "session error:" → Failed
  // - complete_run: agent signals explicit build success → succeed
  // - complete_plan: agent signals explicit plan success → succeed
  // If fail_run wins, throw a "session error:" so the standard failure
  // path in main().catch patches status to Failed.
  // If complete_run/complete_plan wins, resolve normally — the caller
  // patches Succeeded with the agent's summary as the completion message.
  let agentCompletionSummary: string | undefined;
  const failureRaced = failureSignal.then((reason) => {
    pollState.terminate = true;
    throw new Error(`session error: agent signalled failure — ${reason}`);
  });
  const completionRaced = completionSignal.then((summary) => {
    pollState.terminate = true;
    agentCompletionSummary = summary;
    log(`complete_run called by agent: ${summary}`);
  });
  const planRaced = planSignal?.then((summary) => {
    pollState.terminate = true;
    agentCompletionSummary = summary;
    log(`complete_plan called by agent: ${summary}`);
  });
  // Capture any failure thrown by pollStatus() or failureRaced so we can
  // still snapshot + persist stats before re-throwing.
  let raceError: Error | undefined;
  let aborting = false;
  try {
    await Promise.race(
      [
        pollStatus(),
        promptPostFailure,
        failureRaced,
        completionRaced,
        planRaced,
        hardTimeout,
      ].filter(Boolean),
    );
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      // not ours
    } else if (isAbortedMessageInError(e as Error)) {
      log('message aborted (caught in race) — treating as waiting for input');
      aborting = true;
    } else {
      raceError = e as Error;
    }
  }
  pollState.terminate = true;
  promptPostController.abort();
  if (hardTimeoutHandle) clearTimeout(hardTimeoutHandle);

  if (isShuttingDown()) {
    log('shutting down mid-run');
    await doSnapshot(coreApi, runName, runNamespace, runUid, sessionID);
    await doPatchStatus({ message: 'dispatcher terminated' });
    return { sessionID, startedAt: runStartedAt };
  }

  // If the race was won by an aborted message, keep the run in Running
  // phase and exit cleanly instead of crashing with Failed status.
  if (aborting) {
    await tokens.flush(doPatchStatus, true);
    await doSnapshot(coreApi, runName, runNamespace, runUid, sessionID);
    const totals = tokens.totals();
    await doSendStats(
      sessionID,
      RunPhase.Running,
      runStartedAt,
      new Date(doNow()).toISOString(),
      totals,
    );
    await doPatchStatus({
      phase: RunPhase.Running,
      message: 'waiting for input (message aborted)',
    });
    log('done (waiting for input after abort)');
    return { sessionID, startedAt: runStartedAt };
  }

  // Always flush tokens, snapshot, and persist stats — whether the run
  // succeeded or failed.  This ensures the manager always has a ConfigMap
  // to read for facilitation context and SQLite always has a record.
  await tokens.flush(doPatchStatus, true);
  await doSnapshot(coreApi, runName, runNamespace, runUid, sessionID);

  const completedAt = new Date(doNow()).toISOString();
  const totals = tokens.totals();

  if (raceError) {
    await doSendStats(
      sessionID,
      RunPhase.Failed,
      runStartedAt,
      completedAt,
      totals,
      raceError.message,
    );
    // Patch Failed here so the run's terminal phase is recorded even before
    // the error propagates to main()'s catch (which re-patches idempotently).
    // The hard-timeout guard relies on this path: previously it called
    // process.exit directly, leaving the run stuck in Running with no snapshot.
    await doPatchStatus({ phase: RunPhase.Failed, message: raceError.message, completedAt });
    throw raceError;
  }

  if (agentCompletionSummary) {
    await doSendStats(sessionID, RunPhase.Succeeded, runStartedAt, completedAt, totals);
    await doPatchStatus({
      phase: RunPhase.Succeeded,
      message: `agent signalled completion — ${agentCompletionSummary}`,
      completedAt,
    });
    log('done');
  } else {
    const msg = 'session ended without completion signal';
    await doSendStats(sessionID, RunPhase.Failed, runStartedAt, completedAt, totals, msg);
    await doPatchStatus({ phase: RunPhase.Failed, message: msg, completedAt });
    log('done (failed — no explicit completion signal)');
  }

  return { sessionID, startedAt: runStartedAt };
}
