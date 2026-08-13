# Plan: Operator recreate loop — Succeeded pod is deleted without claiming a terminal Run phase

Task: `percussionist-dev-plan-rev04`
Revision: 2 (retry 3/3 — corrects the rev-1 plan's understated test impact and pins the exact fake-kube scripting required)

## Context

### The bug

`packages/operator/src/reconciler.ts` treats a `Succeeded` pod and a `Failed` pod
asymmetrically at the bottom of `reconcile()`:

- **Failed branch (lines 654-671):** when `podPhase === 'Failed'`, the operator
  patches `phase: RunPhase.Failed` (with `podPhase`, `summarizePodFailure(pod)`,
  `collectContainerExitCodes(pod)`) **before** calling
  `cleanupChildResources(run, ns)`. The comment (lines 655-663) explains why:
  the dispatcher normally owns terminal phase claims, but if it crashed/OOMed
  before patching, the run phase is still non-terminal — and because cleanup
  deletes the pod, the next resync would 404 on the pod, recreate it, and
  re-run the whole task forever, burning tokens. The terminal-phase guard then
  short-circuits future passes.
- **Succeeded branch (lines 652-653):** `if (podPhase === 'Succeeded') {
  await cleanupChildResources(run, ns); }` — deletes the pod + service (lines
  681-704: `cleanupChildResources` → `deleteNamespacedPod` +
  `deleteNamespacedService` + `revokeRunKey`) **without claiming any terminal
  phase**. This is the bug.

### Why that recreates the run forever

The reconcile-loop mechanics (`packages/operator/src/reconciler.ts`):

1. `reconcile()` starts with a terminal-phase guard (lines 424-445): if
   `run.status.phase` is in `TERMINAL_PHASES` (`packages/api/src/index.ts:744-748`
   — `Succeeded`/`Failed`/`Cancelled`), it revokes the run key, cleans up any
   surviving pod, and dequeues.
2. For a non-terminal run, the pod-ensure block (lines 587-634) reads the pod;
   on 404 it **mints a new run key** (`mintRunKey`, line 596) and **recreates
   the pod** (`createNamespacedPod`, line 604).
3. `startPeriodicResync()` (lines 889-893) re-enqueues every `seen` run every
   10 s, and `runWorkerOnce()` (lines 826-877) re-reads the Run CR fresh from
   the API before each `reconcile()` pass.

So: pod reaches `Succeeded` while the run phase is still non-terminal → operator
deletes the pod → next resync reads a non-terminal run, 404s on the pod, mints
a new run key, recreates the pod → the whole task re-runs. Indefinitely, burning
tokens each cycle. This is the exact failure mode the Failed branch guards
against, and the Succeeded branch has no equivalent guard.

### Confirmed dispatcher exit-0 paths that leave the phase non-terminal

Verified against the current tree (all line numbers re-checked this revision):

- **Message-abort path (prompt + interactive)** — `packages/dispatcher/src/index.ts:241-273`
  (`main().catch`): on `MessageAbortedError`/`AbortError`, patches
  `phase: RunPhase.Running` with `message: 'waiting for input (message aborted)'`
  (lines 268-272), then `process.exit(0)` (line 273).
- **Prompt-mode abort path** — `packages/dispatcher/src/polling.ts:1327-1343`
  (`runPrompt` race): on an aborted message, flushes tokens/snapshot, sends
  stats with `RunPhase.Running`, patches `phase: RunPhase.Running` (lines
  1338-1341), returns normally → process exits 0.
- **Shutdown mid-run** — `packages/dispatcher/src/polling.ts:1318-1323`
  (`runPrompt`) and `index.ts:217-221` (shutting-down in `main().catch`):
  patches only `{ message: 'dispatcher terminated' }` (phase untouched, still
  non-terminal) and exits 0.
- **Interactive session ending** — `packages/dispatcher/src/polling.ts:634-636`
  (`runInteractive`): sends stats with `RunPhase.Running` and patches only
  `{ message: 'dispatcher terminated' }`, then returns → exit 0.

Note: the task description cites `polling.ts:1051-1059` for a hard-timeout
exit-0 path — that reference is stale relative to the current tree. The
hard-timeout guard (`polling.ts:1225-1243`) was already fixed to reject with
`FatalRunError`, which routes through the normal snapshot → stats → **patch
`phase: Failed`** path (`polling.ts:1355-1369`) and exits 1. The live exit-0
gaps are the abort / shutdown / interactive-end paths listed above.

### Critical nuance: a Succeeded pod does NOT imply a non-terminal run

The dispatcher can also patch a **terminal Failed** and still exit 0:
`polling.ts:1380-1385` — "session ended without completion signal" → patch
`phase: Failed` → return → process exits 0 → all containers exit 0 → pod phase
becomes `Succeeded`. In that case the run phase is legitimately terminal
`Failed` while the pod reports `Succeeded`. The operator must therefore **not
blindly claim `Succeeded`** whenever the pod succeeded — it would clobber the
dispatcher's `Failed` claim and mark a failed task done on the board. The claim
must be guarded by a fresh terminal-phase check.

### Manager already consumes terminal Succeeded — no manager change needed

`packages/manager-controller/src/reconciler/decision.ts`:
- `getEffectiveRunPhase()` (lines 106-112) already heuristically treats a
  non-terminal run with `podPhase: 'Failed'` as `Failed` — but has **no**
  equivalent for `podPhase: 'Succeeded'` (a succeeded pod with a non-terminal
  phase falls through as non-terminal, so `decideRunning` (line 404) returns a
  no-decision and the task parks in `running` forever). The operator-side claim
  in this plan is the correct single place to close that gap.
- `decideRunning`/`decideInitializing` (lines 362-382, 406-418) transition the
  task to `succeeded` (worker status `Succeeded`) when the run phase is
  `Succeeded`. So an operator-claimed `Succeeded` run progresses the board with
  zero manager changes.

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

- Re-read the Run CR fresh via `co.getNamespacedCustomObject` (same call shape
  as `runWorkerOnce`, lines 845-854: `group: API_GROUP, version: API_VERSION,
  namespace: ns, plural: PLURAL_RUN, name: run.metadata.name`, cast `as Run`)
  at the top of the Succeeded branch.
- Claim `Succeeded` only when the fresh phase is missing or non-terminal
  (`!freshPhase || !TERMINAL_PHASES.has(freshPhase)`); on read error, fall back
  to the pass's `currentPhase` snapshot (which is itself fresh — `runWorkerOnce`
  re-reads before reconciling).
- If the fresh phase is already terminal, skip the claim and just clean up (this
  mirrors the terminal guard's "pod still alive → cleanup" path at lines
  430-443).

Rationale for claiming `Succeeded` rather than `Failed` on the
abort/waiting-for-input paths: a `Succeeded` pod means every container exited 0
(the user cancelled / the session parked — not a failure), and claiming the
terminal `Succeeded` lets the manager progress the board (task → succeeded)
instead of leaving the run stuck non-terminal forever. The dispatcher's
`message` field ('waiting for input (message aborted)', 'dispatcher terminated')
is preserved on the run for audit.

**Hardening (defense in depth, matches the task's "or refuse to delete the**
**pod while the Run phase is non-terminal" suggestion).** Make
`cleanupChildResources` refuse to delete the pod while the run phase is
non-terminal: re-read the Run CR fresh before `deleteNamespacedPod`, and skip
the pod deletion (still delete the service and revoke the key) when the fresh
phase is missing or non-terminal. On a fresh-read **error**, log and skip the
pod deletion too (fail-safe): the pod carries an ownerReference to the Run CR
(`packages/operator/src/pod-builder.ts:246`, `ownerRefsFor(run)`), so if the
run CR has been deleted, Kubernetes GC removes the orphaned pod anyway; if the
error is transient, the next resync retries the claim/cleanup and converges.
This protects the window where `patchStatus` silently fails — `patchStatus`
never throws, it logs and swallows (`reconciler.ts:95-111`) — so a failing
status patch could otherwise still reach the pod deletion and trigger the
recreate storm. The guard must re-read fresh because the passed `run` object is
stale after `patchStatus` (patchStatus does not mutate it). With the primary
fix in place, every `cleanupChildResources` caller (terminal guard at 435,
Failed branch at 670, Succeeded branch) has a terminal phase, so the guard never
blocks legitimate cleanup in production.

## Scope boundaries

**In scope:**

- `packages/operator/src/reconciler.ts` — Succeeded-branch terminal claim with
  fresh-read guard; refuse-to-delete guard in `cleanupChildResources`.
- `packages/operator/src/reconciler-flow.test.ts` — rewrite the pinned
  asymmetry test (lines 579-634); update the terminal-run table row (run-6,
  lines 502-511) for the new `getNamespacedCustomObject` call; add edge-case
  rows.
- `packages/operator/src/reconciler.test.ts` — add a
  `CustomObjectsApi.prototype.getNamespacedCustomObject` spy to the
  "does not dequeue while the Pod still exists" test (lines 82-92), which
  currently fakes only `CoreV1Api` and would otherwise hit a real cluster.
- Operator unit tests + `pnpm typecheck`.

**Out of scope (explicitly):**

- **Dispatcher changes.** The abort/waiting-for-input paths deliberately keep
  `Running` (the user pressed cancel — not a failure), and the shutdown paths
  are clean-exit designs. Changing dispatcher exit semantics is a separate
  product decision; the agreed fix per the task is operator-side fallback
  claiming. The BUILD task should only *verify* (grep) that no other exit-0
  path exists beyond the ones listed in Context; it must not modify the
  dispatcher.
- **Manager-controller changes.** `decision.ts` already consumes a terminal
  `Succeeded` run phase (`decideRunning`, lines 406-418). Extending
  `getEffectiveRunPhase` with a `podPhase: 'Succeeded'` heuristic is
  deliberately NOT done: it would mark tasks done on the manager side while the
  run CR (and operator resync) stayed non-terminal, and would race the
  dispatcher's terminal `Failed` claim for the exit-0 "no completion signal"
  path. Operator-side claiming is strictly better.
- Stats/session-summary semantics for runs claimed by the operator (the abort
  paths already snapshot + send stats before exiting; the operator claim adds
  no new data).
- Docs/UI.

## Tasks

1. **Claim Succeeded before cleanup (primary fix)** — In
   `packages/operator/src/reconciler.ts`, replace the Succeeded branch (lines
   652-653) with:
   - Fresh re-read of the Run CR via `co.getNamespacedCustomObject` (plural
     `PLURAL_RUN`; wrap in try/catch, falling back to `currentPhase` on error).
   - If the fresh phase is missing or `!TERMINAL_PHASES.has(freshPhase)`, call
     `patchStatus(run, { phase: RunPhase.Succeeded, podPhase,
     message: 'pod succeeded (operator claimed terminal phase; dispatcher exited
     without one)', completedAt: new Date().toISOString() })`.
   - Then `await cleanupChildResources(run, ns)` unconditionally.
   - Add a comment mirroring the Failed-branch comment (lines 655-663)
     explaining the recreate-loop rationale and the clobber guard.

2. **Refuse to delete the pod while the run phase is non-terminal (hardening)** —
   In `cleanupChildResources` (lines 681-704), before `deleteNamespacedPod`:
   re-read the Run CR fresh via `co.getNamespacedCustomObject`; skip the pod
   deletion when the read throws (any error — log it) or the fresh phase is
   missing/non-terminal; still delete the service and revoke the run key. Add a
   comment stating the invariant: never delete a run pod while the run phase is
   non-terminal, because deletion makes the next resync 404 and recreate the
   pod, re-running the task.

3. **Rewrite the pinned asymmetry test** — In
   `packages/operator/src/reconciler-flow.test.ts` (lines 579-634), replace the
   "pinned, not fixed" test with symmetric-behavior expectations. **Important —
   fake-kube scripting semantics:** in `test-helpers/fake-kube.ts` a *single*
   scripted response repeats for every call, while an *array* advances per call
   (final entry repeats). `happyPathScript` scripts
   `getNamespacedCustomObject: { value: projectWithUid(...) }` as a single
   response — so once the Succeeded branch and cleanup each add a fresh read,
   **every scenario reaching the Succeeded/Failed branches must override
   `getNamespacedCustomObject` with an ordered array**, in exact call order:
   (1) project read (reconcile line 548), (2) branch fresh read, (3) cleanup
   fresh read. Concretely:
   - **Succeeded pod + run phase `Running`** → script
     `getNamespacedCustomObject: [{ value: projectWithUid('test-project',
     'proj-uid') }, { value: makeRun('asym-succ', { status: { phase:
     RunPhase.Running } }) }, { value: makeRun('asym-succ', { status: { phase:
     RunPhase.Succeeded } }) }]` (entry 2 → non-terminal → claim fires; entry 3
     → terminal → pod delete allowed). Assert a patch containing
     `{ phase: RunPhase.Succeeded, podPhase: 'Succeeded' }` occurs before the
     pod delete, and `deleteNamespacedPod` is called once.
   - **Succeeded pod + fresh read returns terminal `Failed`** → script entries
     2 and 3 both as `{ status: { phase: RunPhase.Failed } }`. Assert no
     `Succeeded` claim patch, cleanup still deletes the pod (verifies the
     clobber guard).
   - **Failed pod scenario** (existing first half, lines 589-610) → the cleanup
     fresh read must be scripted: entries `[{ value: projectWithUid(...) },
     { value: makeRun('asym-fail', { status: { phase: RunPhase.Failed } }) }]`.
     Without this, the single-response project CR would make the fresh read see
     a non-terminal phase and skip the pod delete, breaking the existing
     `deleteNamespacedPod` length-1 assertion. The Failed-claim behavior itself
     is unchanged.
   - Update the test-name/comment block to describe the now-symmetric behavior.

4. **Update the terminal-run table row and add edge-case rows** —
   - The `run-6` row ("terminal run + pod still exists → cleanupChildResources,
     no dequeue", lines 502-511) must gain a
     `getNamespacedCustomObject: { value: makeRun('run-6', { status: { phase:
     RunPhase.Succeeded } }) }` script entry (a single response is fine — the
     terminal guard path never reaches the project read, so there is exactly
     one fresh read) and `expectedMethods` becomes
     `['readNamespacedPod', 'getNamespacedCustomObject', 'deleteNamespacedPod',
     'deleteNamespacedService']` (exact-order equality is asserted, line 565).
   - Add rows for: (a) Succeeded pod + fresh-read throws → falls back to
     `currentPhase` (non-terminal) and still claims `Succeeded`; (b) hardening
     guard: Succeeded pod + fresh read non-terminal at cleanup time → pod
     delete skipped, service delete + key revoke still happen (assert
     `deleteNamespacedPod` not called while `deleteNamespacedService` is).

5. **Fix `reconciler.test.ts` terminal-branch coverage** — The "does not dequeue
   while the Pod still exists" test (lines 82-92) calls `reconcile` with a
   terminal run whose pod exists → terminal guard → `cleanupChildResources`,
   which now performs a fresh run read via `co.getNamespacedCustomObject`. This
   test fakes only `CoreV1Api.prototype` methods, so the read would hit the
   real `CustomObjectsApi.prototype` and fail. Add
   `const getRunSpy = spyOn(CustomObjectsApi.prototype,
   'getNamespacedCustomObject').mockResolvedValue(makeTerminalRun() as never)`
   (import `CustomObjectsApi` from `@kubernetes/client-node`) with a matching
   `mockRestore()` in `afterEach`. The pod-404 and log-once tests (lines 68-80,
   94-112) never reach `cleanupChildResources` and need no change. Note: do NOT
   install `installFakeKube` here — the existing spies in this file are raw
   `spyOn` and the file intentionally stays independent of the BUILD-1 fake.

6. **Verify dispatcher exit-0 inventory** — Grep `packages/dispatcher/src` for
   `process.exit(0)` and `phase: RunPhase.Running` patches to confirm the list
   in Context is complete (index.ts:220, index.ts:273, polling.ts:1318-1323,
   1327-1343, 634-636). No code change. If a new exit-0 path is found that
   leaves a non-terminal phase, note it in the PR description (the operator
   fallback covers it regardless).

7. **Test + typecheck gate** — Run `bun test src/` in `packages/operator`
   (this exercises `reconciler.test.ts`, `reconciler-flow.test.ts`,
   `queue.test.ts`, `ttl*.test.ts`), plus `pnpm typecheck`. Confirm
   `queue.test.ts` is unaffected (it spies `reconciler.reconcile` directly,
   line 51) and the table-driven `reconcileCases` rows other than `run-6` are
   unaffected (none of the others reach `cleanupChildResources`).

## Acceptance criteria

1. A run whose pod reaches `Succeeded` while `status.phase` is non-terminal
   (`Running`/`Initializing`/`WaitingForInput`/unset) is patched to
   `phase: Succeeded` (with `completedAt`) **before** its pod is deleted; the
   next resync short-circuits at the terminal guard (reconciler.ts:424-445) and
   the pod is never recreated.
2. A run whose pod reaches `Succeeded` while the run phase is already terminal
   (dispatcher claimed `Succeeded`, or `Failed` via the "session ended without
   completion signal" exit-0 path, polling.ts:1380-1385) keeps that phase — the
   operator never overwrites an existing terminal claim.
3. All confirmed dispatcher exit-0 paths (abort → `Running`, shutdown mid-run,
   interactive end) that previously re-ran the task forever now converge: pod
   succeeds → operator claims `Succeeded` → manager transitions the task to
   `succeeded` (`decision.ts:406-418`) → no token burn.
4. The Failed branch is behaviorally unchanged: `Failed` pod → operator patches
   `Failed` → cleanup.
5. `cleanupChildResources` never deletes the pod of a non-terminal run
   (hardening invariant), even when the terminal-phase patch fails silently.
6. The pinned asymmetry test is rewritten and green; the run-6 terminal row and
   the `reconciler.test.ts` "pod still exists" test are updated and green;
   `bun test src/` in `packages/operator` and `pnpm typecheck` pass.

## Risks / open questions

- **Clobber race (residual).** Between the operator's fresh run read and its
  `patchStatus` in the Succeeded branch, the dispatcher could theoretically land
  a terminal claim. The window is sub-millisecond and the read + patch are
  adjacent; the guard reduces the already-narrow race to negligible. A
  watch/conditional-patch cycle is not worth it.
- **Semantic choice: aborted/waiting-for-input runs record as `Succeeded`.** A
  user-cancelled prompt-mode run whose pod exits 0 will be recorded as
  Succeeded (matching the pod's exit code) rather than Failed or left Running.
  This is deliberate — the alternatives are worse (Failed mislabels a cancel as
  a failure; leaving non-terminal is the bug). Flag for the reviewer; the
  dispatcher's `message` field preserves the "waiting for input" detail for
  audit. Alternative considered and rejected: extending the manager's
  `getEffectiveRunPhase` (decision.ts:106-112) with a `podPhase: 'Succeeded'`
  heuristic — it would race the dispatcher's terminal `Failed` claim and leave
  the operator's resync loop running.
- **Alternative hardening shape.** Instead of re-reading in
  `cleanupChildResources`, `patchStatus` could return a success boolean and
  callers could pass an explicit `podDeleteAllowed` flag. Rejected: the boolean
  only reflects whether the patch *call* succeeded, not whether the apiserver
  state is terminal (a patch that succeeds server-side but errors client-side
  would be treated as failed), and it requires signature changes at all three
  call sites. The fresh-read guard verifies actual apiserver state and needs no
  caller changes.
- **Hardening test churn.** The fresh read in `cleanupChildResources` touches
  three existing test sites (pinned test, run-6 row, `reconciler.test.ts` pod-
  exists test). This is the main cost of the hardening; if the reviewer prefers
  to defer it, drop Tasks 2/4b/5 and keep the primary fix (Task 1) alone — but
  then note in the PR that `patchStatus`'s silent-swallow (reconciler.ts:95-111)
  leaves a residual recreate-loop window during apiserver outages.
- **Stale line refs in the task description.** `polling.ts:1051-1059` describes
  a pre-fix hard-timeout exit-0 that no longer exists (now routes through the
  Failed path, polling.ts:1225-1243/1355-1369). The plan targets the current
  code; Task 6 re-verifies the inventory.
- **TTL interaction.** Setting `completedAt` on the operator's claim is correct
  and enables TTL-based run cleanup (`packages/operator/src/ttl.ts:67-70` keys
  expiry on `status.completedAt`).

## BUILD task breakdown

- **BUILD 1 — Operator terminal-claim fix (Tasks 1, 3, 4, 5, 7):** the
  Succeeded-branch claim with fresh-read guard + the pinned-test rewrite +
  run-6 row update + `reconciler.test.ts` spy + gate. Self-contained; fixes the
  reported bug. Test churn from the hardening is included here (Tasks 3/4/5 all
  script the cleanup fresh read), so do not split it out.
- **BUILD 2 — `cleanupChildResources` refuse-to-delete hardening (Tasks 2, 4b):**
  the guard inside `cleanupChildResources`. It is written in BUILD 1's tests as
  scripted scenarios, but the production guard itself can land in the same PR
  or a follow-up; if deferred, the scripted scenarios in Tasks 3/4 that expect
  the guard must be adjusted.
- Task 6 (dispatcher exit-0 inventory verification) is a read-only check folded
  into BUILD 1's PR description.
