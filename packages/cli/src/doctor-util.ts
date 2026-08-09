// doctor-util.ts — shared helpers for `beatctl doctor` check modules.
//
// `withProbeTimeout` lives here rather than in doctor.ts so the check modules
// (doctor-static.ts, doctor-runtime.ts) can import it without creating an
// import cycle back into the orchestrator: doctor.ts imports the check
// registries, and if those registries imported a runtime value from doctor.ts
// the module graph would be cyclic — a direct import of a check module (e.g.
// from a unit test) would then read doctor.ts's `DEFAULT_CHECKS` while the
// registry const is still in the temporal dead zone.

/**
 * Race a promise against an AbortSignal.timeout and reject with a labelled
 * timeout error if it does not settle in time. Every doctor network probe
 * must go through this (or pass `signal: AbortSignal.timeout(ms)` to a raw
 * fetch) so the `--timeout` bound is honoured.
 */
export async function withProbeTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  const signal = AbortSignal.timeout(ms);
  let onAbort: (() => void) | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error(`${label} timed out after ${ms}ms`));
      signal.addEventListener('abort', onAbort, { once: true });
    }),
  ]).finally(() => {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  });
}
