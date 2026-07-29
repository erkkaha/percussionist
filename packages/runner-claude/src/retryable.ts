// retryable.ts — decide whether an SDK `result` error is worth another attempt.
//
// The Claude Code CLI already retries inside a single API call. What reaches
// here is what survived that: a `result` message with `is_error`, which the
// transcript translator turns into `info.error`, which dispatcher/polling.ts
// treats as an unconditional run failure. Two of the first three claude-engine
// runs on one task died that way — a 529 before a single token was produced,
// and a mid-response disconnect six minutes and 15.7k output tokens in. Both
// are classes the API documents as retryable, and neither was.
//
// The distinction that matters is transport-and-capacity vs. request-is-wrong.
// Retrying a 400 or a 401 just burns the clock and lands in the same place.

/** HTTP statuses where the same request may well succeed on a later attempt. */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

/**
 * Statuses that will fail identically no matter how many times they are sent:
 * a malformed request, a rejected credential, a model that does not exist.
 * Listed explicitly so an unrecognised 4xx is treated as fatal by default.
 */
const FATAL_STATUS = new Set([400, 401, 403, 404, 405, 413, 422]);

/**
 * Message-text fallbacks for errors that arrive with no status at all.
 * "Connection closed mid-response" is the observed shape: `api_error_status`
 * was null and the text was the only signal.
 */
const RETRYABLE_TEXT =
  /\b(overloaded|rate.?limit|connection closed|connection error|connection reset|socket hang up|timed? ?out|econnreset|epipe|etimedout|service unavailable|bad gateway|internal server error)\b/i;

/**
 * The harness's own error banner, which it emits as the result text. This is the
 * one signal that a result claiming success is actually a truncated turn, so it
 * is matched anchored and case-sensitively in the prefix position rather than
 * anywhere in the prose.
 */
const API_ERROR_PREFIX = /^\s*API Error:/;

/** Reason string for a turn cut short mid-response, for logs and the retry prompt. */
export const TRUNCATED_DETAIL = 'the response was cut short mid-stream';

/**
 * True when an SDK `assistant` message is the harness's own error banner rather
 * than the model talking.
 *
 * This is the only place a dropped connection is visible: the banner arrives as
 * assistant text, and the `result` message that follows reports subtype success
 * with is_error false and api_error_status null. Four runs failed with "session
 * ended without completion signal" for want of this check, each having already
 * produced 18k-47k output tokens of real work.
 *
 * Anchored at the start of the first text block so an agent that merely mentions
 * an API error while summarising its work cannot trigger a retry.
 */
export function hasApiErrorBanner(raw: unknown): boolean {
  const content = (raw as { message?: { content?: unknown } })?.message?.content;
  if (typeof content === 'string') return API_ERROR_PREFIX.test(content);
  if (!Array.isArray(content)) return false;
  for (const block of content) {
    const b = block as { type?: string; text?: string };
    if (b?.type !== 'text' || typeof b.text !== 'string') continue;
    return API_ERROR_PREFIX.test(b.text);
  }
  return false;
}

type ResultLike = {
  is_error?: boolean;
  result?: string;
  api_error_status?: number | null;
};

/**
 * True when an errored `result` message describes a transient condition.
 *
 * Status wins when present — it is unambiguous. Text matching only runs when
 * there is no status, because a status we classify as fatal should not be
 * overridden by prose that happens to contain a matching word.
 */
export function isRetryableResultError(raw: unknown): boolean {
  const msg = raw as ResultLike;
  if (!msg) return false;
  // A dropped connection can arrive as a *successful* result whose text is the
  // apology: is_error false, api_error_status null, stop_reason "stop_sequence",
  // and result "API Error: Connection closed mid-response. The response above
  // may be incomplete." Observed on four separate runs, each of which had
  // already committed 20k-47k output tokens of real work and then failed with
  // "session ended without completion signal" because the is_error gate below
  // rejected them before any retry could happen.
  //
  // Only the explicit API-error prefix qualifies, not a bare text match: an
  // agent legitimately discussing a connection error in its own summary must not
  // trigger a retry.
  if (!msg.is_error && !API_ERROR_PREFIX.test(msg.result ?? '')) return false;

  const status = msg.api_error_status;
  if (typeof status === 'number') return RETRYABLE_STATUS.has(status);

  const text = msg.result ?? '';
  if (FATAL_STATUS.size > 0 && /\b(4\d\d)\b/.test(text)) {
    const code = Number(/\b(4\d\d)\b/.exec(text)?.[1]);
    if (FATAL_STATUS.has(code)) return false;
    if (RETRYABLE_STATUS.has(code)) return true;
  }
  return RETRYABLE_TEXT.test(text);
}

/**
 * Backoff before attempt `n` (1-based), in milliseconds.
 *
 * Capacity errors clear on the order of tens of seconds, so this climbs fast
 * and caps: 5s, 20s, 60s. Three attempts spend ~85s against the dispatcher's
 * 15-minute idle timeout, which leaves the run plenty of room to then do its
 * actual work.
 */
export function retryDelayMs(attempt: number, baseMs = 5_000, capMs = 60_000): number {
  return Math.min(baseMs * 4 ** (attempt - 1), capMs);
}
