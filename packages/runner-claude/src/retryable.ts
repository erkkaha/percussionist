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
  if (!msg?.is_error) return false;

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
