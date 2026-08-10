// lib/run-housekeeping.ts — crash-proof wrapper for background housekeeping loops.
//
// pruneExpiredRunKeys and runRetentionCleanup run on timers and used to be
// invoked bare: a single failure (e.g. SQLITE_BUSY from a concurrent
// stats-POST write) rejected the promise / threw inside setInterval, landing in
// the process-level unhandledRejection / uncaughtException handlers and exiting
// the pod — killing every open SSE stream and attach terminal.
//
// This wrapper follows the established push-triggers tick() pattern
// (lib/push-triggers.ts): try/catch/finally around each invocation plus a
// re-entrancy guard so a slow tick (waiting on busy_timeout) cannot be stacked
// by the next interval fire. The returned run() never rejects.

export interface HousekeepingRunner {
  /**
   * Run the wrapped task once. Never rejects — failures are caught and logged
   * as a warning, and the next tick retries.
   */
  run(): Promise<void>;
}

export function runHousekeeping(
  name: string,
  fn: () => unknown | Promise<unknown>,
): HousekeepingRunner {
  let running = false;

  return {
    async run(): Promise<void> {
      // Re-entrancy guard: skip if the previous tick is still in flight (e.g.
      // blocked on busy_timeout). The next interval fire will pick it up.
      if (running) return;
      running = true;
      try {
        await fn();
      } catch (e) {
        // Housekeeping is best-effort. Log and move on — the error must never
        // reach unhandledRejection / uncaughtException, both of which would
        // terminate the whole web process.
        console.warn(`[web] ${name} failed:`, e instanceof Error ? e.message : e);
      } finally {
        running = false;
      }
    },
  };
}
