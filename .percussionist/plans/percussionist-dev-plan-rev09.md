# PLAN: Dispatcher hard timeout — graceful failure, per-run deadline, analytics cursor fix

**Task ID:** percussionist-dev-plan-rev09
**Scope:** `packages/dispatcher` (with web-side idempotency verification)
**Status:** Plan — no code changes made in this run

---

## 1. Context

### 1.1 The problem (from the task)

`packages/dispatcher/src/polling.ts` enforces an overall run deadline with a
hard-timeout guard: `HARD_TIMEOUT_MS = FIRST_RESPONSE_TIMEOUT_MS + 300_000`
(60 min + 5 min = **65 minutes**, hardcoded, `polling.ts:111-112`). The original
guard called `process.exit(3)` directly, which skips the session snapshot, the
analytics flush and the `RunPhase.Failed` patch — exactly the "pathological"
exit the `FatalRunError` docstring warns about (`polling.ts:20-34`). A run left
in `Running` with no session ConfigMap feeds the operator's pod-recreate loop.

### 1.2 What is ALREADY fixed on this branch

Commit `82f325e` (`test(dispatcher): runPrompt race-path/retry tests and
hard-timeout guard fix`) converted the hard-timeout guard from `process.exit`
to a `FatalRunError`-rejecting promise raced inside `Promise.race`:

- `polling.ts:1172-1184` — `hardTimeout` promise rejects with
  `new FatalRunError('dispatcher hard timeout exceeded (...)')`; `hardTimeoutMs`
  is injectable via `RunPromptDeps.hardTimeoutMs` (`polling.ts:900-901`).
- `polling.ts:1296-1311` — the race-error branch does
  `sendStats(Failed)` → `patchStatus(Failed)` → rethrow, so `main().catch`
  (`index.ts:217-313`) finishes the work. Regression tests:
  `packages/dispatcher/src/__tests__/run-prompt.test.ts:317-367` assert
  snapshot + Failed stats + Failed patch and that `process.exit` is never
  reached from `runPrompt`.

The remaining `process.exit` calls in `index.ts` (lines 42, 60, 220, 273, 313)
are all outside the run-prompt path: pre-run env validation, the
`unhandledRejection` handler, or exits **after** the graceful work already ran
(shutdown-in-progress, aborted-message clean exit, final exit after Failed
patch). They are not part of this task.

### 1.3 The remaining gap (this task's core)

The overall deadline is still **hardcoded to 65 minutes** and ignores the
per-run `spec.timeoutSeconds`. The plumbing already exists on the operator side:

- `packages/operator/src/pod-builder.ts:850` — pod
  `activeDeadlineSeconds: spec.timeoutSeconds ?? 3600`
- `packages/operator/src/pod-builder.ts:1078` — dispatcher env
  `RUN_TIMEOUT_SECONDS: String(spec.timeoutSeconds ?? 3600)`
- `packages/api/src/index.ts:1978-1983` — `resolveRunConfig()` resolves
  `timeoutSeconds` from run overrides → board → project → cluster base → `3600`
  default; the manager and CLI bake it into `Run.spec.timeoutSeconds`
  (`worker-builder.ts:296,541,739`, `cli/src/submit.ts:118,167`).

But `packages/dispatcher` **never reads `RUN_TIMEOUT_SECONDS`** (grep: zero
matches). Consequences for a legitimately long run:

1. With the default `timeoutSeconds: 3600`, the **kubelet kills the pod at
   60 min** (`activeDeadlineSeconds`) — *before* the 65-min dispatcher guard
   ever fires. The SIGTERM is handled by the dispatcher's shutdown path:
   `runPrompt` sees `isShuttingDown()` (`polling.ts:1259-1264`) and does
   snapshot + `patchStatus({ message: 'dispatcher terminated' })` but **no
   terminal phase patch and no `sendStats`**. The Run stays in `Running`, the
   pod is gone → operator recreate loop.
2. Runs configured with a longer timeout (e.g. 2 h) never get the extra time:
   the kubelet still kills at `activeDeadlineSeconds`.
3. Runs configured with a *shorter* timeout still get the full 65-min
   dispatcher budget unless the kubelet kills them first — the dispatcher's
   guard is not aligned with the configured intent at all.

So the substantive remaining fix is: **make the dispatcher's overall deadline
derive from `spec.timeoutSeconds` (via the already-injected
`RUN_TIMEOUT_SECONDS` env) and fire it slightly *before* the pod's
`activeDeadlineSeconds` so the graceful snapshot → stats → Failed path always
wins the race with the kubelet.**

### 1.4 Related analytics issues (included in scope)

**Issue A — `incrementalFlush` cursor advances even when the PATCH failed**
(`packages/dispatcher/src/stats-reporter.ts:83-104`):

```ts
try {
  const res = await fetch(`${WEB_STATS_URL}/api/stats/session`, { method: 'PATCH', ... });
  if (res.ok) { log(...) } else { err(`incrementalFlush: web pod HTTP ${res.status}`); }
} catch (e) { err('incrementalFlush: POST failed (non-fatal):', ...); }
return rawMessages.length; // advance cursor to total seen — even on failure!
```

On HTTP error or exception the function still returns `rawMessages.length`, so
the caller (`polling.ts:512-518` interactive, `polling.ts:1126-1130` prompt)
advances the cursor and the failed delta is **permanently dropped**. The web
PATCH (`packages/web/src/server/routes/stats.ts:207-321`) is idempotent
(insert-or-ignore on messages/toolCalls/fileOps, upsert on the run row), so
re-sending a failed delta on the next turn is safe.

**Issue B — `runInteractive` never calls `sendStats`** (`polling.ts:586-589`):
the interactive termination path does `tokens.flush(patchStatus, true)` +
`snapshotAllSessions` + `patchStatus({ message: 'dispatcher terminated' })` but
no final full analytics flush. Prompt mode recovers lost deltas at completion
via `sendStats`; interactive runs lose them permanently. `sendStats` is already
imported in `polling.ts:13`.

---

## 2. Approach

### 2.1 Key decisions

1. **Read `RUN_TIMEOUT_SECONDS` lazily inside `runPrompt`** (via a helper), not
   at module scope like `MODEL/AGENT/TASK`. This keeps the value unit-testable
   (`process.env` can be set/restored per test) and matches the existing
   injectable-seam philosophy of `RunPromptDeps`. `deps.hardTimeoutMs` keeps
   precedence so existing tests are untouched.
2. **Deadline = `timeoutSeconds * 1000 − GRACE_MS`, floored at
   `MIN_HARD_TIMEOUT_MS`.** The grace lead (60 s) guarantees the dispatcher's
   graceful `FatalRunError` path (snapshot → `sendStats(Failed)` →
   `patchStatus(Failed)`) completes before the kubelet's SIGKILL/SIGTERM at
   `activeDeadlineSeconds`. Fall back to the legacy `HARD_TIMEOUT_MS` (65 min)
   when the env is missing/invalid (local runs, tests, legacy pods).
3. **Do NOT patch a terminal phase in the `isShuttingDown()` path.**
   SIGTERM is also sent by the operator when it deletes a pod for retry/rework;
   patching `Failed` there would break retries. Distinguishing kubelet-deadline
   termination from operator-initiated deletion is the operator-side companion
   task (Succeeded branch). The dispatcher's job is only to make its *own*
   deadline fire first with a graceful failure.
4. **Cursor fix: advance only on PATCH success.** On HTTP error or exception,
   return `fromIdx` so the next `session.idle` re-sends the same delta. Safe
   because the web PATCH is insert-or-ignore idempotent (verified in
   `stats.ts:207-321`).
5. **Interactive final flush: call `sendStats`** on the interactive
   termination path with `RunPhase.Running` (same convention as the
   aborted-message path in `polling.ts:1271-1278`), keyed on `firstSessionID`
   (the same session the incremental flush uses). Best-effort: `sendStats`
   already swallows all failures internally. For testability, add an optional
   injectable `deps?: { sendStats?: typeof sendStats }` parameter to
   `runInteractive`; `index.ts:187` call site passes nothing.
6. **Scope boundary:** only the prompt (`runPrompt`) path gets the deadline
   wiring. Interactive runs deliberately wait for a human to attach; enforcing
   a dispatcher-side deadline there would conflict with that use case (their
   pod deadline is already governed by the operator's `activeDeadlineSeconds`).
   The interactive task only gets the analytics fix (Issue B).

### 2.2 Behavior after the fix (prompt mode, default config)

- `timeoutSeconds: 3600` → dispatcher hard timeout fires at
  `max(30_000, 3_600_000 − 60_000) = 3_540_000 ms` (59 min), before the
  kubelet's 60-min deadline.
- Guard rejects `FatalRunError` → `Promise.race` catch → `raceError` branch
  (`polling.ts:1296-1311`): `tokens.flush(force)`, snapshot, `sendStats(Failed)`,
  `patchStatus(Failed)`, rethrow → `main().catch` re-patches idempotently →
  `process.exit(1)`.
- Result: session ConfigMap exists, analytics row exists, Run reaches
  `Failed` — no recreate loop, no silent kill.

---

## 3. Tasks

All paths are relative to the repo root. Run `pnpm test` in
`packages/dispatcher` (`bun test src/`) after each task; run
`pnpm typecheck && pnpm lint` from the root before committing.

### Task 1 — Wire `RUN_TIMEOUT_SECONDS` into `runPrompt`'s hard timeout (configurable overall deadline)

**File:** `packages/dispatcher/src/polling.ts`

1. Add constants near the existing timeout constants (`polling.ts:111-114`):
   - `HARD_TIMEOUT_GRACE_MS = 60_000` — lead time over the pod's
     `activeDeadlineSeconds` so the graceful path wins.
   - `MIN_HARD_TIMEOUT_MS = 30_000` — floor so tiny configured timeouts still
     get a boot window.
2. Add a helper (exported for unit testing):
   ```ts
   export function resolveHardTimeoutMs(envSeconds?: string): number {
     const seconds = envSeconds === undefined ? process.env.RUN_TIMEOUT_SECONDS : envSeconds;
     const n = seconds ? Number(seconds) : NaN;
     if (Number.isFinite(n) && n > 0) {
       return Math.max(MIN_HARD_TIMEOUT_MS, n * 1000 - HARD_TIMEOUT_GRACE_MS);
     }
     return HARD_TIMEOUT_MS; // legacy fallback: 65 min
   }
   ```
3. In `runPrompt`, replace `polling.ts:1172`:
   ```ts
   const hardTimeoutMs = d.hardTimeoutMs ?? resolveHardTimeoutMs();
   ```
   (keeps `deps.hardTimeoutMs` precedence for tests).
4. Update the `RunPromptDeps.hardTimeoutMs` doc comment (`polling.ts:900-901`)
   to mention the `RUN_TIMEOUT_SECONDS` default.
5. Optional polish (recommended): cap the poll loop's `firstResponseTimeoutMs`
   (`polling.ts:1092`) at the effective deadline minus one poll tick
   (`Math.min(FIRST_RESPONSE_TIMEOUT_MS, hardTimeoutMs - 2000)`) so a run whose
   configured deadline is under 1 h fails with the precise
   "no assistant response" message instead of the generic hard-timeout message.

**Tests** (`packages/dispatcher/src/__tests__/run-prompt.test.ts`):
- New `describe('resolveHardTimeoutMs')`:
  - `RUN_TIMEOUT_SECONDS=3600` → `3_540_000`
  - `RUN_TIMEOUT_SECONDS=120` → `60_000` (`120_000 − 60_000`)
  - `RUN_TIMEOUT_SECONDS=30` → `30_000` (floored)
  - unset / `''` / `'abc'` / `'0'` / `'-5'` → `HARD_TIMEOUT_MS`
- Keep the existing `hardTimeoutMs: 30` / `hardTimeoutMs: 60` regression tests
  unchanged (deps override wins).
- (Optional) an env-driven behavior test: set `process.env.RUN_TIMEOUT_SECONDS`
  before `runPrompt` and assert Failed patch/stats/snapshot — verify the timer
  actually derived from the env (use a tiny value with the floor in mind).

### Task 2 — Fix `incrementalFlush` cursor advancement on failed PATCH

**File:** `packages/dispatcher/src/stats-reporter.ts`

1. Restructure the PATCH block (`stats-reporter.ts:83-104`) so the cursor only
   advances on success:
   ```ts
   try {
     const res = await fetch(`${WEB_STATS_URL}/api/stats/session`, { method: 'PATCH', ... });
     if (res.ok) {
       log(`incrementalFlush: flushed ${newMessages.length} message(s) from idx ${fromIdx} (session ${sessionID})`);
       return rawMessages.length; // advance cursor to total seen
     }
     err(`incrementalFlush: web pod HTTP ${res.status} — keeping cursor at ${fromIdx} for retry`);
   } catch (e) {
     err(`incrementalFlush: POST failed (non-fatal): ${(e as Error).message} — keeping cursor at ${fromIdx} for retry`);
   }
   return fromIdx; // do not advance — the delta will be re-sent on the next turn
   ```
2. The early-return paths (`stats-reporter.ts:43-53`, `:55`) already return
   `fromIdx` — leave them.
3. No web-side change needed: PATCH is insert-or-ignore idempotent
   (`packages/web/src/server/routes/stats.ts:207-321`); re-sending the same
   delta cannot duplicate rows. Add a short comment in `incrementalFlush`
   noting this idempotency guarantee makes the retry safe.

**Tests** — new file `packages/dispatcher/src/__tests__/stats-reporter.test.ts`:
- `WEB_STATS_URL` is read at module scope (`stats-reporter.ts:14`), so set
  `process.env.WEB_STATS_URL = 'http://web.test'` **before** a dynamic
  `await import('../stats-reporter.js')` (bun evaluates module scope at
  import time); restore env in `afterAll`.
- Stub `globalThis.fetch`:
  - `200` → `incrementalFlush` returns `rawMessages.length`
    (fake `/session/{id}/message` returning 2 messages, fake PATCH 200).
  - `500` on the PATCH → returns `fromIdx` (cursor held).
  - PATCH throws → returns `fromIdx`.
  - message fetch fails (`!res.ok` / exception) → returns `fromIdx`
    (already true today; regression guard).
- No `WEB_STATS_URL` set (default import path, or `''`) → returns `fromIdx`.

### Task 3 — Final full analytics flush in `runInteractive`

**File:** `packages/dispatcher/src/polling.ts`

1. Add an optional injectable to `runInteractive`'s signature
   (`polling.ts:437-445`) for testability:
   ```ts
   export interface RunInteractiveDeps {
     sendStats?: typeof sendStats;
   }
   // ...
   export async function runInteractive(
     patchStatus, isShuttingDown, sleep, coreApi, runName, runNamespace, runUid,
     deps?: RunInteractiveDeps,
   ): Promise<void>
   ```
   `index.ts:187-195` call site passes nothing (defaults to the real
   `sendStats`).
2. In the termination path (`polling.ts:586-589`), after
   `await tokens.flush(patchStatus, true)`:
   ```ts
   const doSendStats = deps?.sendStats ?? sendStats;
   const totals = tokens.totals();
   if (firstSessionID) {
     await doSendStats(
       firstSessionID,
       RunPhase.Running,
       interactiveStartedAt,
       new Date().toISOString(),
       totals,
     );
   }
   log('interactive session ending — snapshotting');
   await snapshotAllSessions(coreApi, runName, runNamespace, runUid);
   await patchStatus({ message: 'dispatcher terminated' });
   ```
   `RunPhase` is already imported (`polling.ts:4`); `sendStats` is already
   imported (`polling.ts:13`). Phase `Running` matches the aborted-message
   convention (`polling.ts:1271-1278`) — interactive termination is not a
   failure.
3. Document in a comment that the flush is keyed on `firstSessionID`
   (pre-existing multi-session limitation, out of scope).

**Tests** (`packages/dispatcher/src/__tests__/run-prompt.test.ts`,
`runInteractive (smoke)` describe, lines 369-433):
- Extend the smoke test (or add a second one) to inject a `sendStats` spy via
  the new `deps` param, trigger shutdown (existing 300 ms timer), and assert
  the spy was called with `RunPhase.Running`, `firstSessionID` (`'s1'`), and
  `interactiveStartedAt`.
- Existing assertions (sessionID patch + ConfigMap create) must keep passing.

### Task 4 — Verification & docs

1. Run the full dispatcher suite: `bun test src/` in `packages/dispatcher`.
2. Run `pnpm typecheck` and `pnpm lint` (Biome) from the root.
3. Grep regression: no new `process.exit` reachable from
   `runPrompt`/`runInteractive`/`incrementalFlush` paths.
4. Docs: add a short note to `docs/testing-strategy.md`? Not required. Optionally
   update the `AGENTS.md` "Dispatcher SSE Event Streaming" section with a line
   about the per-run deadline (`RUN_TIMEOUT_SECONDS` → dispatcher hard timeout,
   grace lead over `activeDeadlineSeconds`). Keep this optional; the code
   comments are the primary documentation.

---

## 4. Acceptance criteria

1. A prompt-mode run whose `spec.timeoutSeconds` is set fails via the normal
   path — session snapshot ConfigMap created, `sendStats(Failed)` called,
   `Run.status.phase` reaches `Failed` — at approximately
   `timeoutSeconds − 60 s`, not at a hardcoded 65 min.
2. `resolveHardTimeoutMs()` returns the floored, grace-subtracted deadline for
   valid `RUN_TIMEOUT_SECONDS` and falls back to `HARD_TIMEOUT_MS` otherwise.
3. `incrementalFlush` returns `fromIdx` (holds the cursor) when the PATCH fails
   (HTTP error or exception) and advances only on success; re-sending a delta
   is safe because the web PATCH is insert-or-ignore idempotent.
4. `runInteractive` termination calls `sendStats` with phase `Running` and the
   first session's id, so interactive-run analytics are no longer permanently
   lossy on failed deltas.
5. No `process.exit` is reachable from the run-prompt/hard-timeout path
   (existing regression tests in `run-prompt.test.ts:317-367` continue to pass
   with the `process.exit` spy).
6. All existing dispatcher tests pass; `pnpm typecheck` and `pnpm lint` clean.

---

## 5. Risks / open questions

1. **Grace-buffer budget.** Runs lose up to 60 s of their configured budget
   (deadline fires at `timeoutSeconds − 60 s`). If the snapshot + stats + patch
   take longer than the lead (unlikely; they are a few seconds), the kubelet
   still wins. *Alternative:* give the operator-side the lead instead (bump
   `activeDeadlineSeconds` to `timeoutSeconds + 120`) so the dispatcher can use
   the exact value — but that is the operator side and couples the two tasks.
   Decision: dispatcher-side grace; revisit if the operator companion task
   lands a buffer.
2. **Init-container time counts against `activeDeadlineSeconds`** (kubelet
   starts the clock at pod creation, before worktree setup), so the dispatcher's
   deadline, measured from `runPrompt` start, can in principle land *after* the
   kubelet's for slow first-run mirror clones. The 60 s lead absorbs typical
   setup; very slow setups remain a race. A more robust fix would read the pod's
   `startTime` — out of scope; note it.
3. **SIGTERM (`isShuttingDown`) path still never patches a terminal phase.**
   Deliberate (see §2.1 decision 3): SIGTERM is also sent on operator-initiated
   deletes for retry. The kubelet-deadline-vs-operator-delete distinction is the
   operator-side companion task (Succeeded branch). The dispatcher fix only
   guarantees its own deadline fires first.
4. **Interactive runs keep no dispatcher-side deadline** (only the pod's
   `activeDeadlineSeconds`). A human actively attached to a long interactive
   session is still killed at `timeoutSeconds` with the snapshot-only shutdown
   path. Out of scope for this task; may deserve its own follow-up.
5. **Multi-session interactive analytics** only flush `firstSessionID`
   (pre-existing; both `incrementalFlush` and the new final `sendStats` are
   keyed on it). Out of scope.
6. **First-response message precision.** When `timeoutSeconds < 1 h`, the hard
   timeout fires before the poll loop's 1-h first-response check; Task 1 step 5
   (optional cap) improves the message but is not required for correctness.
7. **`incrementalFlush` env is module-scope.** `WEB_STATS_URL`/`WEB_AUTH_TOKEN`
   are read once at import (`stats-reporter.ts:14-16`); tests must set env
   before dynamic import. If this becomes a problem, a follow-up could make the
   reads lazy — not required for this task.

---

## 6. Proposed BUILD task breakdown

| # | Title | Files | Depends on |
|---|-------|-------|-----------|
| B1 | Wire `RUN_TIMEOUT_SECONDS` into `runPrompt` hard timeout (configurable overall deadline + grace lead) | `packages/dispatcher/src/polling.ts`, `packages/dispatcher/src/__tests__/run-prompt.test.ts` | — |
| B2 | Hold `incrementalFlush` cursor on failed PATCH (retry delta next turn) | `packages/dispatcher/src/stats-reporter.ts`, new `packages/dispatcher/src/__tests__/stats-reporter.test.ts` | — |
| B3 | Final full `sendStats` flush on `runInteractive` termination | `packages/dispatcher/src/polling.ts`, `packages/dispatcher/src/__tests__/run-prompt.test.ts` | — |
| B4 | Verification pass: full dispatcher tests + root `typecheck`/`lint` + grep for stray `process.exit` in run paths; optional AGENTS.md note | repo-wide (test-only) | B1, B2, B3 |

B1–B3 are independent and can be built in any order; B4 runs last as the gate.
Each BUILD must include its own tests and pass `pnpm test` for the dispatcher
package.
