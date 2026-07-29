import { describe, expect, it } from 'bun:test';
import { isRetryableResultError, retryDelayMs } from './retryable.js';

const result = (over: Record<string, unknown> = {}) => ({
  type: 'result',
  is_error: true,
  ...over,
});

describe('isRetryableResultError', () => {
  it('ignores a result that is not an error', () => {
    expect(isRetryableResultError({ type: 'result', is_error: false })).toBe(false);
    expect(isRetryableResultError({ type: 'result' })).toBe(false);
  });

  it('survives a null or non-object message', () => {
    expect(isRetryableResultError(null)).toBe(false);
    expect(isRetryableResultError(undefined)).toBe(false);
  });

  // The 529 that killed an observed PLAN run's second attempt at 0 tokens.
  it('retries the observed 529 overload', () => {
    expect(
      isRetryableResultError(
        result({
          api_error_status: 529,
          result:
            'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.',
        }),
      ),
    ).toBe(true);
  });

  // The mid-response disconnect that killed the earlier run six minutes in.
  // It arrived with no status at all, so only the text could classify it.
  it('retries the observed mid-response disconnect with no status', () => {
    expect(
      isRetryableResultError(
        result({
          result:
            'API Error: Connection closed mid-response. The response above may be incomplete.',
        }),
      ),
    ).toBe(true);
  });

  it('retries capacity and transport statuses', () => {
    for (const s of [408, 409, 425, 429, 500, 502, 503, 504, 529]) {
      expect(isRetryableResultError(result({ api_error_status: s }))).toBe(true);
    }
  });

  it('does not retry a request that will fail identically', () => {
    for (const s of [400, 401, 403, 404, 413, 422]) {
      expect(isRetryableResultError(result({ api_error_status: s }))).toBe(false);
    }
  });

  // A status is unambiguous; prose that happens to contain a matching word
  // must not promote a fatal status back to retryable.
  it('lets an explicit status win over the message text', () => {
    expect(
      isRetryableResultError(
        result({ api_error_status: 401, result: 'authentication_error: connection closed' }),
      ),
    ).toBe(false);
  });

  it('reads a status out of the text when the field is absent', () => {
    expect(isRetryableResultError(result({ result: 'API Error: 503 Service Unavailable' }))).toBe(
      true,
    );
    expect(isRetryableResultError(result({ result: 'API Error: 400 invalid_request_error' }))).toBe(
      false,
    );
  });

  it('does not retry an agent-authored failure with no transient signal', () => {
    expect(isRetryableResultError(result({ result: 'the task could not be completed' }))).toBe(
      false,
    );
    expect(isRetryableResultError(result({ result: '' }))).toBe(false);
  });

  it('treats a null status like a missing one', () => {
    expect(isRetryableResultError(result({ api_error_status: null, result: 'Overloaded' }))).toBe(
      true,
    );
  });
});

describe('retryDelayMs', () => {
  it('climbs fast and caps', () => {
    expect(retryDelayMs(1)).toBe(5_000);
    expect(retryDelayMs(2)).toBe(20_000);
    expect(retryDelayMs(3)).toBe(60_000);
    expect(retryDelayMs(9)).toBe(60_000);
  });

  // Three attempts must stay well inside dispatcher/polling.ts's 15-minute
  // idle timeout, or the retry itself terminates the run.
  it('spends well under the dispatcher idle timeout', () => {
    const total = [1, 2, 3].reduce((sum, n) => sum + retryDelayMs(n), 0);
    expect(total).toBeLessThan(900_000 / 4);
  });
});
