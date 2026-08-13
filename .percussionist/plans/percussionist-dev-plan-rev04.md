# Plan: Operator recreate loop — Succeeded pod is deleted without claiming a terminal Run phase

Task: `percussionist-dev-plan-rev04`

## Context

### The bug

`packages/operator/src/reconciler.ts` treats a `Succeeded` pod and a `Failed` pod
asymmetrically at the bottom of `reconcile()`:

- **Failed branch (lines 654-671):** when `podPhase === 'Failed'`, the operator
  patches `phase: RunPhase.Failed` (with `podPhase`, `summarizePodFailure(pod)`,
  `collectContainerExitCodes(pod)`) **before** calling
  `cleanupChildResources(run, ns)`. The comment explains why: the dispatcher
  normally owns terminal phase claims, but if it crashed/OOMed before patching,
  the run phase is still non-terminal — and because cleanup deletes the pod, the
  next resync would 404 on the pod, recreate it, and re-run the whole task
  forever, burning tokens. The terminal-phase guard then short-circuits future
  passes.
- **Succeeded branch (lines 652-653):** `if (podPhase === 'Succeeded') {
  await cleanupChildResources(run, ns); }` — deletes the pod + service (lines
  681-704: `cleanupChildResources` → `deleteNamespacedPod` + `deleteNamespacedService`
  + `revokeRunKey`) **without claiming any terminal phase**.

### Why that recreates the run forever

The reconcile loop mechanics (`packages/operator/src/reconciler.ts`):

1. `reconcile()` starts with a terminal-phase guard (lines 418-445): if
   `run.status.phase` is in `TERMINAL_PHASES` (`packages/api/src/index.ts:744-748`
   — `Succeeded`/`Failed`/`Cancelled`), it revokes the run key, cleans up any
   surviving pod, and dequeues.
2. For a non-terminal run, the pod-ensure block (lines 587-634) reads the pod;
   on 404 it **mints a new run key** (`mintRunKey`) and **recreates the pod**
   (`createNamespacedPod`).
3. `startPeriodicResync()` (lines 889-893) re-enqueues every `seen` run every
   10 s, and `runWorkerOnce()` (lines 826-877) re-reads the Run CR fresh from the
   API before each `reconcile()` pass.

So: pod reaches `Succeeded` while the run phase is still non-terminal → operator
deletes the pod → next resync reads a non-terminal run, 404s on the pod, mints a
new run key, recreates the pod → the whole task re-runs. Indefinitely, burning
tokens each cycle. This is the exact failure mode the Failed branch guards
against, and the Succeeded branch has no equivalent guard.

### Confirmed dispatcher exit-0 paths that leave the phase non-terminal

- **Message-abort path** — `packages/dispatcher/src/index.ts:241-273`
  (`main().catch`): on `MessageAbortedError`/`AbortError`, patches
  `phase: RunPhase.Running` with `message: 'waiting for input (message aborted)'`,
  then `process.exit(0)`.
- **Prompt-mode abort path** — `packages/dispatcher/src/polling.ts:1327-1343`
  (`runPrompt` race): on an aborted message, flushes tokens/snapshot, sends stats
  with `RunPhase.Running`, patches `phase: RunPhase.Running`, returns normally →
  process exits 0.
- **Shutdown mid-run** — `packages/dispatcher/src/polling.ts:1318-1323` +
  `index.ts:217-221`: patches only `{ message: 'dispatcher terminated' }` (phase
  untouched, still non-terminal) and exits 0.
- **Interactive session ending** — `packages/dispatcher/src/polling.ts:600-637`
  (`runInteractive`): sends stats with `RunPhase.Running` and patches only
  `{ message: 'dispatcher terminated' }`, then exits 0.

Note: the task description cites `polling.ts:1051-1059` for a hard-timeout
exit-0 path — that reference is stale relative to the current tree. The
hard-timeout guard (`polling.ts:1225-1243`) was already fixed to reject with
`FatalRunError`, which routes through the normal snapshot → stats → **patch
`phase: Failed`** path (`polling.ts:1355-1369`) and exits 1. The live exit-0
gaps are the abort / waiting-for-input / shutdown paths listed above.

### Critical nuance: a Succeeded pod does NOT imply a non-terminal run

The dispatcher can also patch a **terminal Failed** and still exit 0:
`polling.ts:1380-1385` — "session ended without completion signal" → patch
`phase: Failed` → return → process exits 0 → all containers exit 0 → pod phase
becomes `Succeeded`. In that case the run phase is legitimately terminal `Failed`
while the pod reports `Succeeded`. The operator must therefore **not blindly
claim `Succeeded`** whenever the pod succeeded — it would clobber the
dispatcher's `Failed` claim and mark a failed task done on the board. The claim
must be guarded by a terminal-phase check.

### Existing test pins the buggy asymmetry

`packages/operator/src/reconciler-flow.test.ts:579-634` — a test literally named
"Succeeded/Failed asymmetry — pinned, not fixed" asserts that a Succeeded pod
gets cleanup only (no terminal claim) and documents the retry storm as a known,
accepted consequence. This test must be rewritten as part of the fix.

## Approach

**Primary fix — mirror the Failed branch in the Succeeded branch.** Claim
`phase: Succeeded` (with `podPhase`, an explanatory `message`, and
`completedAt`) **before** `cleanupChildResources(run, ns)`. Because a
concurrent dispatcher terminal claim can land mid-pass (the "session ended
without completion signal" → Failed → exit 0 path above), the claim is guarded:

- Re-read the Run CR fresh via `co.getNamespacedCustomObject` (same call shape as
  `runWorkerOnce`, lines 845-854) at the top of the Succeeded branch.
- Claim `Succeeded` only when the fresh phase is missing or non-terminal
  (`!freshPhase || !TERMINAL_PHASES.has(freshPhase)`); on read error, fall back
  to the pass's `currentPhase` snapshot (which is itself fresh — `runWorkerOnce`
  re-reads before reconciling).
- If the fresh phase is already terminal, skip the claim and just clean up (this
  mirrors the terminal guard's "pod still alive → cleanup" path at lines
  430-443).

This makes the operator's behavior symmetric: a terminal pod phase always yields
a terminal run phase before the pod is deleted, so no code path can delete the
pod while the run is non-terminal. Rationale for claiming `Succeeded` rather than
`Failed` on the abort/waiting-for-input paths: a `Succeeded` pod means every
container exited 0 (the user cancelled / the session parked — not a failure), and
claiming the terminal `Succeeded` lets the manager progress the board
(task → done) instead of leaving the run stuck non-terminal forever.

**Hardening (defense in depth, matches the task's "or refuse to delete"**
**suggestion).** Make `cleanupChildResources` refuse to delete the pod while the
run phase is non-terminal: re-read the Run CR fresh before
`deleteNamespacedPod`, and skip the pod deletion (still delete the service and
revoke the key) when the fresh phase is missing or non-terminal. This protects
the window where `patchStatus` silently fails — `patchStatus` never throws, it
logs and swallows (`reconciler.ts:95-111`) — so a failing status patch could
otherwise still reach the pod deletion and trigger the recreate storm. The guard
must re-read fresh because the passed `run` object is stale after `patchStatus`
(patchStatus does not mutate it). This is a pure safety net: with the primary fix
in place, every `cleanupChildResources` caller (terminal guard at 430-435, Failed
branch at 670, Succeeded branch) has a terminal phase, so the guard never blocks
legitimate cleanup.

## Scope boundaries

**In scope:**

- `packages/operator/src/reconciler.ts` — Succeeded branch claim + fresh-read
  guard; optional refuse-to-delete guard in `cleanupChildResources`.
- `packages/operator/src/reconciler-flow.test.ts` — rewrite the pinned
  asymmetry test (lines 579-634); add coverage for the new branches.
- Operator unit tests, typecheck.

**Out of scope (explicitly):**

- **Dispatcher changes.** The abort/waiting-for-input paths deliberately keep
  `Running` (the user pressed cancel — not a failure), and the interactive
  shutdown path is a clean-exit design. Changing dispatcher exit semantics is a
  separate product decision; the agreed fix per the task is operator-side
  fallback claiming. The BUILD task should only *verify* (grep) that no other
  exit-0 path exists beyond the ones listed; it must not modify the dispatcher.
- Manager-controller changes (run-phase → board transitions already consume
  terminal phases).
- Stats/session-summary semantics for runs claimed by the operator (the abort
  paths already snapshot + send stats before exiting; the operator claim adds no
  new data).
- Docs/UI.

## Tasks

1. **Claim Succeeded before cleanup (primary fix)** — In
   `packages/operator/src/reconciler.ts`, replace the Succeeded branch (lines
   652-653) with: fresh re-read of the Run CR via `co.getNamespacedCustomObject`
   (plural `PLURAL_RUN`; wrap in try/catch, falling back to `currentPhase` on
   error); if the fresh phase is missing or `!TERMINAL_PHASES.has(freshPhase)`,
   `patchStatus(run, { phase: RunPhase.Succeeded, podPhase, message: 'pod
   succeeded (operator claimed terminal phase; dispatcher exited without one)',
   completedAt: new Date().toISOString() })`; then `await
   cleanupChildResources(run, ns)`. Keep a comment mirroring the Failed-branch
   comment explaining the recreate-loop rationale.

2. **Refuse to delete the pod while the run phase is non-terminal (hardening)** —
   In `cleanupChildResources` (lines 681-704), before `deleteNamespacedPod`,
   re-read the Run CR fresh; if its phase is missing or non-terminal, log and
   skip the pod deletion (still delete the service and revoke the run key). Add
   a comment stating the invariant: never delete a run pod while the run phase
   is non-terminal, because deletion makes the next resync 404 and recreate the
   pod, re-running the task.

3. **Rewrite the pinned asymmetry test** — In
   `packages/operator/src/reconciler-flow.test.ts` (lines 579-634), replace the
   "pinned, not fixed" test with symmetric-behavior expectations:
   - Succeeded pod + run phase `Running` → expects a patch containing
     `{ phase: RunPhase.Succeeded, podPhase: 'Succeeded' }` before the pod
     delete; stub `getNamespacedCustomObject` (fresh run read) to return the run
     with its non-terminal phase.
   - Succeeded pod + fresh read returns terminal phase (e.g. `Failed`) → no
     `Succeeded` claim; cleanup only (verifies the clobber guard).
   - Failed pod scenario stays as-is (behavior unchanged).
   Update the test-name/comment block to describe the now-symmetric behavior.

4. **Add unit-test rows for edge cases** — Cover: (a) fresh-read throws →
   falls back to `currentPhase` and still claims `Succeeded` when `currentPhase`
   is non-terminal; (b) run phase already `Succeeded` at reconcile start with pod
   present → terminal guard path unchanged (existing `reconcileCases` row at
   lines 502-511 already covers cleanup; keep it green); (c) hardening guard:
   `cleanupChildResources` with a fresh non-terminal read skips the pod delete
   (assert `deleteNamespacedPod` not called while `deleteNamespacedService` is).

5. **Verify dispatcher exit-0 inventory** — Grep `packages/dispatcher/src` for
   `process.exit(0)` and `RunPhase.Running` patches to confirm the list in
   Context is complete (abort paths, shutdown, interactive end); no code change.
   If a new exit-0 path is found that leaves a non-terminal phase, note it in the
   PR description (the operator fallback covers it regardless).

6. **Test + typecheck gate** — Run `bun test src/` in `packages/operator`
   (and the full `pnpm test` if cheap), plus `pnpm typecheck`. Confirm
   `reconciler.test.ts` terminal-run rows and the table-driven
   `reconcileCases` are unaffected.

## Acceptance criteria

1. A run whose pod reaches `Succeeded` while `status.phase` is non-terminal
   (`Running`/`Initializing`/`WaitingForInput`/unset) is patched to
   `phase: Succeeded` (with `completedAt`) **before** its pod is deleted; the
   next resync short-circuits at the terminal guard (reconciler.ts:418-445) and
   the pod is never recreated.
2. A run whose pod reaches `Succeeded` while the run phase is already terminal
   (dispatcher claimed `Succeeded`, or `Failed` via the "session ended without
   completion signal" exit-0 path) keeps that phase — the operator never
   overwrites an existing terminal claim.
3. All confirmed dispatcher exit-0 paths (abort → `Running`, shutdown mid-run,
   interactive end) that previously re-ran the task forever now converge: pod
   succeeds → operator claims `Succeeded` → task completes, no token burn.
4. The Failed branch is behaviorally unchanged: `Failed` pod → operator patches
   `Failed` → cleanup.
5. `cleanupChildResources` never deletes the pod of a non-terminal run (hardening
   invariant), even when the terminal-phase patch fails silently.
6. The pinned asymmetry test is rewritten and green; `bun test src/` in
   `packages/operator` and `pnpm typecheck` pass.

## Risks / open questions

- **Clobber race (residual).** Between the operator's fresh run read and its
  `patchStatus` in the Succeeded branch, the dispatcher could theoretically land
  a terminal claim. The window is sub-millisecond and the read + patch are
  adjacent; the guard reduces the already-narrow race to negligible. Not worth a
  watch/conditional-patch cycle.
- **Semantic choice: aborted/waiting-for-input runs record as `Succeeded`.** A
  user-cancelled prompt-mode run whose pod exits 0 will be recorded as
  Succeeded (matching the pod's exit code) rather than Failed or left Running.
  This is deliberate — the alternatives are worse (Failed mislabels a cancel as
  a failure; leaving non-terminal is the bug). Flag for the reviewer; the
  dispatcher's `message` field preserves the "waiting for input" detail for
  audit.
- **Stale line refs in the task description.** `polling.ts:1051-1059` describes
  a pre-fix hard-timeout exit-0 that no longer exists (now routes through the
  Failed path). The plan targets the current code; Task 5 re-verifies the
  inventory.
- **TTL interaction.** Setting `completedAt` on the operator's claim is
  correct and enables TTL-based run cleanup (`packages/operator/src/ttl.ts`
  keys expiry on `status.completedAt`).
- **patchStatus swallows errors** (reconciler.ts:95-111) — this is why the
  primary fix alone can still, in a pathological apiserver-outage window, delete
  the pod while the phase is unclaimed; the Task 2 hardening closes that exact
  gap. If Task 2 is deferred, call it out in the PR.

## BUILD task breakdown

- **BUILD 1 — Operator terminal-claim fix (Tasks 1, 3, 4, 6):** the Succeeded
  branch claim with fresh-read guard + test rewrites + gate. Self-contained;
  fixes the reported bug.
- **BUILD 2 — cleanupChildResources refuse-to-delete hardening (Tasks 2, 4c):**
  optional defense-in-depth, independently reviewable; can be landed in the same
  PR or a follow-up.
- Task 5 (dispatcher exit-0 inventory verification) is a read-only check folded
  into BUILD 1's PR description.
