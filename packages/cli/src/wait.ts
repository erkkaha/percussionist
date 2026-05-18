// `beatctl wait <name>` — block until a run reaches a terminal phase (or a
// caller-specified phase). Designed for CI / shell scripting:
//
//   beatctl submit -t "lint" --name lint
//   beatctl wait lint                 # exits 0 iff Succeeded
//   beatctl logs lint -c dispatcher   # post-mortem on failure
//
// Exit codes:
//   0  — run reached the awaited phase (default: Succeeded)
//   1  — run reached a terminal phase other than the awaited one
//   2  — timeout before any terminal phase
//   3  — transient errors (CR not found, API error, etc.)
//
// We poll at ~1Hz. A Watch would be nicer but adds RBAC surface and edge
// cases (410 Gone resync, deleted-while-waiting) that aren't worth it for a
// short-lived CLI command; submit.ts already uses the same polling pattern.

import {
  RunPhase,
  TERMINAL_PHASES,
  type Run,
} from "@percussionist/api";
import { DEFAULT_NAMESPACE, getRun, loadKube } from "./kube.js";

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
    throw new Error(
      `unknown --for phase '${raw}'. Known: ${known.join(", ")}`,
    );
  }
  return match;
}

export async function runWait(name: string, opts: WaitOpts): Promise<void> {
  const ns = opts.namespace ?? DEFAULT_NAMESPACE;
  const timeoutSec = parseTimeoutSeconds(opts.timeout, 600);
  const awaited = normalisePhase(opts.for);

  const { custom } = loadKube();
  const deadline = Date.now() + timeoutSec * 1000;
  let lastPhase: string | undefined;
  let last: Run | undefined;

  const log = (msg: string) => {
    if (!opts.quiet) process.stderr.write(msg);
  };
  const stamp = () => new Date().toISOString().slice(11, 19);

  while (Date.now() < deadline) {
    try {
      last = await getRun(custom, ns, name);
    } catch (e) {
      const anyE = e as {
        body?: { message?: string; code?: number };
        message?: string;
        code?: number;
      };
      const code = anyE?.body?.code ?? anyE?.code;
      // 404 after we've already observed the run means it was deleted
      // mid-wait (e.g. `beatctl cancel`). Treat that as a terminal
      // "Cancelled" outcome rather than a transient error — the user
      // explicitly asked for the run to go away.
      if (code === 404) {
        log("\n");
        if (!opts.quiet) {
          console.error(
            `beatctl: run ${name} was deleted before settling` +
              (lastPhase ? ` (last phase=${lastPhase})` : ""),
          );
        }
        // If the caller was specifically waiting for a non-terminal phase
        // (e.g. `--for Running`) and we never saw it, that's still a
        // failure — same exit code as any other unmet-expectation.
        process.exit(1);
      }
      const msg = anyE?.body?.message ?? anyE?.message ?? String(e);
      console.error(`beatctl: wait: ${msg}`);
      process.exit(3);
    }

    const phase = last.status?.phase;
    if (phase !== lastPhase) {
      log(`\rbeatctl: [${stamp()}] phase=${phase ?? "-"}   `);
      lastPhase = phase;
    }

    // Specific-phase wait: succeed as soon as we see it, regardless of
    // whether it's terminal. (Useful for `--for Running` to gate attach.)
    if (awaited && phase === awaited) {
      log("\n");
      process.exit(0);
    }

    if (phase && TERMINAL_PHASES.has(phase as RunPhase)) {
      log("\n");
      // Default mode: Succeeded = 0, any other terminal = 1.
      // Explicit --for mode: we already handled the match above; landing
      // here means a *different* terminal phase was reached, which is a
      // failure for our wait.
      if (!awaited && phase === RunPhase.Succeeded) {
        process.exit(0);
      }
      if (!opts.quiet) {
        const statusMsg = last.status?.message;
        console.error(
          `beatctl: run ${name} reached ${phase}` +
            (statusMsg ? `: ${statusMsg}` : ""),
        );
      }
      process.exit(1);
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  log("\n");
  console.error(
    `beatctl: timed out after ${timeoutSec}s waiting for ${
      awaited ?? "a terminal phase"
    } (last phase=${lastPhase ?? "-"})`,
  );
  process.exit(2);
}
