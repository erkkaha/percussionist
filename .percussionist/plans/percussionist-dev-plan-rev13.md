# Plan: Fix merge/PR recovery — closed-PR loop, PLAN merge-retry bypassing the PR gate, and `runName: undefined` merge-patch bug

Task: `percussionist-dev-plan-rev13`

## Context

Three confirmed recovery bugs in the manager's decision engine and admin tools.

### Bug 1 — PR closed without merge loops forever

PR-mode integration flow (`integration.mode: 'pr'`, feature branching enabled):

1. PLAN task sits in `awaiting-feature-merge` with `worker.prNumber = 42` set and
   no active `mergeRunName` (the PR-open run completed with a `pr-opened` verdict;
   `decideAwaitingFeatureMerge`, `decision.ts:1583-1600`).
2. Each reconcile cycle `observe()` polls GitHub for PR #42
   (`observations.ts:66-81`, cached 15 min in `github-client.ts:45`).
3. PR #42 is closed without being merged → `decidePrStateOutcome`
   (`decision.ts:1782-1799`) moves the task to `awaiting-human` with
   `statusPatch.worker.mergeError = 'PR #42 was closed without merging'` —
   **but does not clear `worker.prNumber`**.
4. Human approves (`action-approved` annotation). For a PLAN task,
   `decideAwaitingHuman` (`decision.ts:889-908`, event `MergeRetryApproved`)
   patches `worker: { mergeRunName: null, mergeError: null }` → `awaiting-feature-merge`
   — **but does not clear `worker.prNumber`**.
5. Next cycle: `decideAwaitingFeatureMerge` (`decision.ts:1492-1497`) sees
   `!mergeRunName && prNumber` → calls `decidePrStateOutcome` again → polls the
   *same* closed PR #42 → back to `awaiting-human` with the same `mergeError`.

Infinite approve/bounce loop. There is no path that ever opens a fresh PR — the
only escape is `abandon`. `effects.ts:220-246` (`SchedulePrOpenRun`) already
handles deleting a terminal leftover pr-open run and recreating it, so a fresh
PR-open run *would* work once `prNumber` is cleared.

### Bug 2 — Failed feature-branch merge approval routes PLAN tasks to the BUILD merge path

`decideFailed` (`decision.ts:1806-1897`) handles human approval of a failed task:

```ts
if (worker?.mergeError || worker?.mergeRunName) {
  ...
  return {
    toPhase: 'awaiting-merge',                       // ← line 1825
    statusPatch: { worker: { mergeRunName: null, mergeError: null } },
    effects: [{ type: 'ClearTaskAnnotations', ... }],
    events: [makeEvent(..., 'MergeRetryApproved', ...)],
  };
}
```

Any task with `mergeError`/`mergeRunName` is routed to `awaiting-merge`, which
schedules a direct `buildMergeRun` (`decision.ts:997-1018`, effect
`ScheduleMergeRun`; `worker-builder.ts:312-397` resolves source = feature branch,
target = `main` and pushes directly). For a **PLAN task in PR mode** that
reaches `failed` (e.g. `FeatureBranchMergeStructuredFailure`,
`decision.ts:1617-1639`, or `FeatureMergeRunStale`, `decision.ts:1710-1734`),
this silently bypasses the configured `integration.mode: 'pr'` review gate —
the feature branch lands on `main` with no PR, and the task is marked `done`
via `MergeSucceeded` (`decision.ts:1051-1061`).

The equivalent approval from `awaiting-human` correctly goes to
`awaiting-feature-merge` for PLAN tasks (`decision.ts:889-908`), which in PR
mode schedules a PR-open run instead (`decision.ts:1502-1523`). `decideFailed`
must route PLAN merge retries the same way.

Note: the target phase `awaiting-feature-merge` is **not** currently in
`TRANSITION_TABLE.failed` (`packages/api/src/index.ts:913`:
`failed: ['pending', 'awaiting-human', 'awaiting-merge']`). `decide()`
(`decision.ts:179-193`) and `executeEffects` (`effects.ts:92-103`) both reject
illegal transitions, so the transition table must be extended or the fix will
be silently blocked (`InvalidTransitionBlocked`, toPhase cleared, effects
dropped).

### Bug 3 — Admin tools clear `worker.runName` with `undefined`, which JSON serialization drops

`packages/manager-controller/src/agent/tools.ts` patches task status via
`patchTaskStatus` (`packages/kube/src/index.ts:798-833`, JSON merge patch —
RFC 7386). `JSON.stringify` strips `undefined` object values, so a patch body
of `{ worker: { runName: undefined } }` serializes to `{}` — the field is never
removed (same pitfall documented in `AGENTS.md`).

Five call sites pass `runName: undefined` with the intent of clearing the run
ref:

- `tools.ts:1616` — `force_retry` with `createRun: false` (reset to `pending`)
- `tools.ts:1775` — `set_task_state` → `scheduled`/`running`
- `tools.ts:1797` — `set_task_state` → `done`
- `tools.ts:1810` — `set_task_state` → `pending`/`rework-requested`
- `tools.ts:1822` — `set_task_state` → `failed`

Consequence: after `set_task_state(..., cancelRunning: true)` deletes the run,
the stale `runName` survives in `Task.status.worker`. On the next reconcile the
task (now `running`/`scheduled`) has no observed run → `decideInitializing` /
`decideRunning` emit `WorkerRunMissing` and flip the task to `failed`
(`decision.ts:306-322`, `decision.ts:393-401`) — the opposite of the intended
recovery. The correct JSON merge-patch idiom (used throughout `decision.ts`,
e.g. `mergeRunName: null` at `decision.ts:896`) is `null`, which removes the
key from the target.

A ready-made helper already exists and is currently used only in tests:
`clearWorkerRunRefs()` (`agent/worker-status.ts:3-13`) returns
`{ runName: null, reviewRunName: null, mergeRunName: null,
buildTasksFacilitatorRun: null }`.

## Approach

Three surgical fixes, each with unit-test coverage.

### Fix 1 — clear the dead PR number so a fresh PR can be opened

Clear `worker.prNumber` at the **source** of the bounce and **defensively** at
the approval point:

- **Primary** (`decision.ts`, `decidePrStateOutcome`, closed-without-mergedAt
  branch ~line 1786-1788): add `prNumber: null` to the `statusPatch.worker`
  alongside `mergeError`. Once a PR is closed unmerged its number is dead;
  dropping it immediately stops `observations.ts:70-81` from polling a closed PR
  and guarantees any later approval cannot re-enter the polling loop.
- **Defensive** (`decision.ts`, `decideAwaitingHuman` PLAN merge-retry branch
  ~line 896): add `prNumber: null` to the `MergeRetryApproved` patch alongside
  the existing `mergeRunName: null, mergeError: null`, so any future path that
  lands in `awaiting-human` with a stale `prNumber` + `mergeError` still recovers.

After either patch, `decideAwaitingFeatureMerge` sees `!mergeRunName &&
!prNumber` in PR mode and schedules a fresh PR-open run
(`decision.ts:1502-1523`, effect `SchedulePrOpenRun`); `effects.ts:220-246`
deletes the terminal leftover pr-open run and recreates it, the new run opens a
new PR, and the new `prNumber` is stored on success (`decision.ts:1583-1600`).

### Fix 2 — route PLAN merge retries from `failed` through the feature-merge gate

In `decideFailed`'s `manualActions.approved` branch (`decision.ts:1812-1838`),
discriminate on task type:

- `task.spec.type === 'PLAN'` → `toPhase: 'awaiting-feature-merge'` with
  `statusPatch: { worker: { mergeRunName: null, mergeError: null, prNumber: null } }`
  and the existing `ClearTaskAnnotations` effect — mirroring the
  `awaiting-human` PLAN branch (`decision.ts:889-908`). In PR mode the next
  cycle schedules a PR-open run; in auto-merge/manual modes it schedules the
  feature-branch merge run / parks for a human, as before.
- BUILD tasks keep today's `awaiting-merge` route (their merge is the
  single-branch `buildMergeRun` regardless of `integration.mode`).

Mirror the `awaiting-human` PLAN branch by **not** applying the capacity gate
for the PLAN case (the `awaiting-feature-merge` phase is not an active/WIP
phase per `scheduler.ts:6-14`, and the `awaiting-human` branch has no gate);
keep the gate for BUILD tasks.

Extend `TRANSITION_TABLE.failed` in `packages/api/src/index.ts:913` with
`'awaiting-feature-merge'` (validated by both `decide()` at `decision.ts:179`
and `executeEffects` at `effects.ts:92-103`). This also unblocks the CLI
(`@percussionist/cli` validates against the same table via the re-export shim
`reconciler/transitions.ts`).

### Fix 3 — use `null`, not `undefined`, to clear `worker.runName` in admin tools

Replace `runName: undefined` with `runName: null` at the five call sites in
`agent/tools.ts` (1616, 1775, 1797, 1810, 1822). Optionally spread
`clearWorkerRunRefs()` (from `agent/worker-status.ts`) into the `set_task_state`
`pending`/`rework-requested`/`failed` and `force_retry(createRun:false)`
patches to also clear the other three run refs; the minimal change (only
`runName`) is sufficient to fix the reported `WorkerRunMissing` bounce and is
preferred to keep the diff scoped.

## Tasks

### Task 1 — Fix 1: clear `prNumber` on closed-unmerged PR and on merge-retry approval

1. `packages/manager-controller/src/reconciler/decision.ts`,
   `decidePrStateOutcome` closed-without-mergedAt branch (~line 1782-1799):
   change `statusPatch.worker` to
   `{ mergeError: 'PR #${prNumber} was closed without merging', prNumber: null }`.
2. `packages/manager-controller/src/reconciler/decision.ts`,
   `decideAwaitingHuman` PLAN merge-retry branch (~line 896): change
   `statusPatch.worker` to
   `{ mergeRunName: null, mergeError: null, prNumber: null }`.
3. Tests in `packages/manager-controller/src/reconciler/__tests__/decision.test.ts`:
   - Extend the existing `'prNumber set + prState closed without mergedAt →
     awaiting-human'` test (~line 1349) to assert `statusPatch.worker.prNumber
     === null`.
   - Extend the existing `'awaiting-human + PLAN merge-retry approval →
     awaiting-feature-merge'` test (~line 494) to set `worker.prNumber = 42`
     and assert `statusPatch.worker.prNumber === null`.
   - New loop-regression test: PLAN task in `awaiting-human` with
     `{ mergeError, mergeRunName, prNumber: 42 }` + approved → `toPhase
     'awaiting-feature-merge'`; then feed the resulting patch semantics back
     (prNumber now null) into a fresh `decide` with `awaiting-feature-merge`
     phase + PR-mode project + `observed: {}` → expects `SchedulePrOpenRun`
     effect, i.e. a fresh PR-open run, not a re-poll.

### Task 2 — Fix 2: route PLAN merge retries from `failed` through the feature-merge gate

4. `packages/manager-controller/src/reconciler/decision.ts`, `decideFailed`
   `manualActions.approved` branch (~line 1816-1838): after the
   `worker?.mergeError || worker?.mergeRunName` check, branch on
   `task.spec.type === 'PLAN'`:
   - PLAN → `toPhase: 'awaiting-feature-merge'`,
     `statusPatch.worker: { mergeRunName: null, mergeError: null,
     prNumber: null }`, event reason `MergeRetryApproved`, effects
     `[ClearTaskAnnotations(consumedKeys)]` (no capacity gate).
   - BUILD → unchanged `awaiting-merge` path (keep capacity gate).
5. `packages/api/src/index.ts` (~line 913): add `'awaiting-feature-merge'` to
   `TRANSITION_TABLE.failed`.
6. Tests:
   - `packages/manager-controller/src/reconciler/__tests__/transitions.test.ts`:
     assert `isValidTransition('failed', 'awaiting-feature-merge')` is true and
     add it to the valid-transitions list.
   - `decision.test.ts`: new tests in the `decide — failed` describe —
     (a) PLAN task, `worker = { mergeError: 'x', mergeRunName: 'm' }`, approved
     → `toPhase 'awaiting-feature-merge'`, patch nulls all three fields,
     `ClearTaskAnnotations` effect present; (b) BUILD task with the same worker
     state → `toPhase 'awaiting-merge'` (behavior preserved); (c) PLAN task in
     PR-mode project → after approval, a follow-up decide in
     `awaiting-feature-merge` schedules `SchedulePrOpenRun`, never
     `ScheduleMergeRun`.

### Task 3 — Fix 3: `null` (not `undefined`) to clear `worker.runName`

7. `packages/manager-controller/src/agent/tools.ts` — replace `runName:
   undefined` with `runName: null` at lines 1616, 1775, 1797, 1810, 1822.
   (Optional: spread `clearWorkerRunRefs()` at 1610/1809/1821 instead of the
   inline field — keep as a judgment call; minimal `runName: null` is
   acceptable.)
8. New test file `packages/manager-controller/src/agent/__tests__/tools-run-ref-clear.test.ts`
   following the `mock.module('@percussionist/kube', ...)` pattern of
   `tools-capability-gating.test.ts`: capture `patchTaskStatus` calls in state
   and assert that for `set_task_state` (targets `pending`, `done`, `failed`,
   `running`) and `force_retry` with `createRun: false`, the worker patch
   contains `runName: null` (and contains no `runName: undefined`), with the
   appropriate `getTask`/`getProject`/`listProjectTasks` mocks.

### Task 4 — Verification

9. Run `pnpm typecheck` from the repo root (gate before commit).
10. Run `pnpm test` (or at minimum
    `cd packages/manager-controller && bun test` for the touched suites, plus
    `cd packages/api && bun test` for the transition-table suite).
11. `pnpm lint`/`pnpm format` for Biome compliance.

## Acceptance criteria

1. A PLAN task whose PR is closed unmerged, after human approval, schedules a
   **fresh PR-open run** (new PR) — no infinite approve/bounce loop. The stale
   `prNumber` is never re-polled once the PR is known closed.
2. A PLAN task that fails its feature-branch merge and is approved from
   `failed` goes to `awaiting-feature-merge` and, in PR mode, opens a PR — it
   never schedules a direct `buildMergeRun` to the target. BUILD tasks keep
   today's `awaiting-merge` retry behavior.
3. `set_task_state`/`force_retry` patches actually remove `worker.runName`
   (JSON merge patch carries `null`); a task moved with `cancelRunning: true`
   no longer bounces to `failed` with `WorkerRunMissing` on the next reconcile.
4. All unit tests + typecheck pass; no lint regressions.

## Risks / open questions

- **Transition-table change is cross-package.** Adding
  `awaiting-feature-merge` to `TRANSITION_TABLE.failed` affects
  `@percussionist/cli` validation too — intentional and consistent, but the CLI
  package tests should still pass (it only widens the allowed set).
- **`prNumber: null` at the source drops the number from `worker`.** The
  `mergeError` message ("PR #42 was closed without merging") retains the number
  for human review; no other code reads `worker.prNumber` once cleared.
- **Fresh PR-open run is a *new* GitHub PR.** The recreated pr-open run pushes
  the same feature branch and opens a new PR against the target. If the branch
  protection requires CI on every PR, reviewers see a new PR — acceptable and
  intended (the old PR was closed unmerged).
- **One-cycle latency.** After approval, the `awaiting-feature-merge` cycle
  schedules the PR-open run on the *next* reconcile pass (no effect is emitted
  directly from `decideFailed`). This matches the existing `awaiting-human`
  recovery path and requires no change.
- **Capacity gate divergence.** The PLAN branch in `decideFailed` skips the
  capacity check to mirror `decideAwaitingHuman`; the BUILD branch keeps it. If
  reviewers prefer uniform gating, keep the check on both — functionally either
  is safe (the check only delays by one cycle).
- **`decidePrStateOutcome` `PrOpenRunMissingNumber` path** (pr-open run
  succeeded without a number, `decision.ts:1563-1581`) leaves `mergeRunName`
  set on the `awaiting-human` task; it is cleared on the next approval via the
  existing patch, so it needs no change here — out of scope.
- **No E2E for PR-mode.** A deterministic E2E exercising the closed-PR loop
  needs a live GitHub token and a real PR lifecycle; out of scope for this fix.
  Unit tests are the gate. (Candidate for a future `e2e:extended` scenario.)

## Proposed BUILD task breakdown

The two `decision.ts` fixes (Tasks 1–2) touch the same file plus `api` and
shared test files, so they belong in one BUILD task; the `tools.ts` fix (Task
3) is fully disjoint and can run in parallel.

1. **BUILD: `fix-merge-pr-recovery-decision`** (agent `builder`) — Fixes 1 and
   2: clear `prNumber` on closed-PR/approval, route PLAN merge retries from
   `failed` through `awaiting-feature-merge`, extend `TRANSITION_TABLE.failed`,
   add `decision.test.ts`/`transitions.test.ts` coverage. Files:
   `packages/manager-controller/src/reconciler/decision.ts`,
   `packages/api/src/index.ts`,
   `packages/manager-controller/src/reconciler/__tests__/decision.test.ts`,
   `packages/manager-controller/src/reconciler/__tests__/transitions.test.ts`.
2. **BUILD: `fix-admin-tool-runname-null`** (agent `builder`) — Fix 3:
   `runName: null` at the five `tools.ts` call sites + new
   `tools-run-ref-clear.test.ts`. Files:
   `packages/manager-controller/src/agent/tools.ts`,
   `packages/manager-controller/src/agent/__tests__/tools-run-ref-clear.test.ts`.

Both builds must pass `pnpm typecheck` and `pnpm test` before completion.
