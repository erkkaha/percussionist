// `beatctl wait <name>` — block until a run reaches a terminal phase (or a
// caller-specified phase). Designed for CI / shell scripting:
//
//   beatctl submit -t "lint" --name lint
//   beatctl wait lint                 # exits 0 iff Succeeded
//   beatctl logs lint -c dispatcher   # post-mortem on failure
//
// Exit codes:
//   0  — run reached the awaited phase (default: Succeeded)
//   1  — run reached a terminal phase other than the awaited one, or was
//        deleted mid-wait after being observed at least once (e.g. cancel)
//   2  — timeout before any terminal phase
//   3  — transient errors (API error), or the run CR was never found on the
//        first poll (typo'd name / wrong namespace) — a usage error, not a
//        run outcome, so it prints even with --quiet
//
// We poll at ~1Hz. A Watch would be nicer but adds RBAC surface and edge
// cases (410 Gone resync, deleted-while-waiting) that aren't worth it for a
// short-lived CLI command; submit.ts already uses the same polling pattern.
//
// The polling/decision loop lives in `waitForOutcome`, a pure core that
// takes an injected `getRunFn` and returns `{ code, message }` without
// calling `process.exit` or printing — so the exit-code contract is unit-
// testable without a cluster. `runWait` is a thin wrapper: run the core,
// print the message, exit with the code.

import { type Run, RunPhase, TERMINAL_PHASES } from '@percussionist/api';
import { DEFAULT_NAMESPACE, getRun, loadKube } from './kube.js';

export interface WaitOpts {
  namespace?: string;
  timeout?: string; // seconds, string because commander hands us raw option values
  for?: string; // phase name to await; default = any terminal phase, success = Succeeded
  quiet?: boolean;
}

// commander passes option values as strings; normalise here so callers
// don't have to think about it.
function parseTimeoutSeconds(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`invalid --timeout value: ${raw}`);
  }
  return n;
}

// Accept any case for convenience (`--for succeeded` or `--for Succeeded`),
// and reject anything that isn't a known phase so users don't wait forever
// on a typo.
function normalisePhase(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const known = Object.values(RunPhase);
  const match = known.find((p) => p.toLowerCase() === raw.toLowerCase());
  if (!match) {
    throw new Error(`unknown --for phase '${raw}'. Known: ${known.join(', ')}`);
  }
  return match;
}

export interface WaitForOutcomeOptions {
  ns: string;
  timeoutSec: number;
  /** Phase to await; when set, seeing it (terminal or not) succeeds immediately. */
  awaited?: string;
  /** Suppress progress lines when no `emit` hook is supplied. */
  quiet?: boolean;
  /**
   * Fetches the Run CR. Must throw an error whose `code` (or `body.code`)
   * is 404 when the CR does not exist, mirroring the k8s client behaviour.
   */
  getRunFn: (ns: string, name: string) => Promise<Run>;
  /** Progress-line render hook (phase changes, trailing newlines). */
  emit?: (line: string) => void;
}

export interface WaitOutcome {
  code: 0 | 1 | 2 | 3;
  /** Fully-formatted final message (with `beatctl: ` prefix), if the caller should show one. */
  message?: string;
  /**
   * When true, the message is a normal run outcome and should be suppressed
   * in quiet mode. Absent/false messages are usage errors or hard failures
   * and are always printed (e.g. CR not found, API error, timeout).
   */
  shownOnlyWhenNotQuiet?: boolean;
}

/**
 * Polling/decision loop for `beatctl wait`. Pure: no cluster access (the
 * fetch is injected), no printing, no `process.exit` — returns the exit code
 * and message for `runWait` to render.
 */
export async function waitForOutcome(
  name: string,
  opts: WaitForOutcomeOptions,
): Promise<WaitOutcome> {
  const { ns, timeoutSec, awaited, getRunFn } = opts;
  const log = opts.emit ?? (opts.quiet ? () => {} : (line: string) => process.stderr.write(line));
  const deadline = Date.now() + timeoutSec * 1000;
  let lastPhase: string | undefined;
  const stamp = () => new Date().toISOString().slice(11, 19);

  while (Date.now() < deadline) {
    let last: Run;
    try {
      last = await getRunFn(ns, name);
    } catch (e) {
      const anyE = e as {
        body?: { message?: string; code?: number };
        message?: string;
        code?: number;
      };
      const code = anyE?.body?.code ?? anyE?.code;
      if (code === 404) {
        if (lastPhase) {
          // 404 after we've already observed the run means it was deleted
          // mid-wait (e.g. `beatctl cancel`). Treat that as a terminal
          // "Cancelled" outcome rather than a transient error — the user
          // explicitly asked for the run to go away.
          log('\n');
          return {
            code: 1,
            message: `beatctl: run ${name} was deleted before settling (last phase=${lastPhase})`,
            shownOnlyWhenNotQuiet: true,
          };
        }
        // 404 on the first poll: the run was never observed, so this is a
        // usage error (typo'd name, wrong namespace), not a run outcome.
        log('\n');
        return {
          code: 3,
          message: `beatctl: run ${name} not found in namespace ${ns}`,
        };
      }
      const msg = anyE?.body?.message ?? anyE?.message ?? String(e);
      return { code: 3, message: `beatctl: wait: ${msg}` };
    }

    const phase = last.status?.phase;
    if (phase !== lastPhase) {
      log(`\rbeatctl: [${stamp()}] phase=${phase ?? '-'}   `);
      lastPhase = phase;
    }

    // Specific-phase wait: succeed as soon as we see it, regardless of
    // whether it's terminal. (Useful for `--for Running` to gate attach.)
    if (awaited && phase === awaited) {
      log('\n');
      return { code: 0 };
    }

    if (phase && TERMINAL_PHASES.has(phase as RunPhase)) {
      log('\n');
      // Default mode: Succeeded = 0, any other terminal = 1.
      // Explicit --for mode: we already handled the match above; landing
      // here means a *different* terminal phase was reached, which is a
      // failure for our wait.
      if (!awaited && phase === RunPhase.Succeeded) {
        return { code: 0 };
      }
      const statusMsg = last.status?.message;
      return {
        code: 1,
        message: `beatctl: run ${name} reached ${phase}${statusMsg ? `: ${statusMsg}` : ''}`,
        shownOnlyWhenNotQuiet: true,
      };
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  log('\n');
  return {
    code: 2,
    message: `beatctl: timed out after ${timeoutSec}s waiting for ${
      awaited ?? 'a terminal phase'
    } (last phase=${lastPhase ?? '-'})`,
  };
}

export async function runWait(name: string, opts: WaitOpts): Promise<void> {
  const ns = opts.namespace ?? DEFAULT_NAMESPACE;
  const timeoutSec = parseTimeoutSeconds(opts.timeout, 600);
  const awaited = normalisePhase(opts.for);

  const { custom } = loadKube();

  const outcome = await waitForOutcome(name, {
    ns,
    timeoutSec,
    awaited,
    quiet: opts.quiet,
    getRunFn: (n, nm) => getRun(custom, n, nm),
    emit: (line) => {
      if (!opts.quiet) process.stderr.write(line);
    },
  });

  if (outcome.message && (!outcome.shownOnlyWhenNotQuiet || !opts.quiet)) {
    console.error(outcome.message);
  }
  process.exit(outcome.code);
}
