/**
 * Polling utility: waitFor()
 *
 * Repeatedly calls `fn` until it returns a non-null value or the timeout
 * expires. Prints a dot every interval to show progress.
 */

export class TimeoutError extends Error {
  constructor(desc: string, timeoutSec: number) {
    super(`TIMEOUT waiting for: ${desc} (${timeoutSec}s)`);
  }
}

/**
 * Poll `fn` every `intervalSec` seconds until it returns a non-null/undefined
 * value, or `timeoutSec` seconds have elapsed.
 *
 * @param desc       Human-readable description (printed on timeout).
 * @param timeoutSec Maximum seconds to wait.
 * @param intervalSec Seconds between attempts.
 * @param fn         Async probe. Return `null` / `undefined` to keep polling.
 * @returns          The first non-null value returned by `fn`.
 * @throws           `TimeoutError` if the deadline is exceeded.
 */
export async function waitFor<T>(
  desc: string,
  timeoutSec: number,
  intervalSec: number,
  fn: () => Promise<T | null | undefined>,
): Promise<T> {
  console.log(`==> Waiting: ${desc} (timeout ${timeoutSec}s)`);
  const deadline = Date.now() + timeoutSec * 1000;
  let first = true;
  while (true) {
    const result = await fn().catch(() => null);
    if (result !== null && result !== undefined) {
      if (!first) process.stdout.write("\n");
      return result;
    }
    if (Date.now() >= deadline) {
      if (!first) process.stdout.write("\n");
      throw new TimeoutError(desc, timeoutSec);
    }
    process.stdout.write(".");
    first = false;
    await Bun.sleep(intervalSec * 1000);
  }
}
