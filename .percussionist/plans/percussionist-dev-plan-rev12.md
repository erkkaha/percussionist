# Plan: Manager approval/abandon annotations must be consumed AFTER the status patch

**Task ID:** `percussionist-dev-plan-rev12`
**Component:** `@percussionist/manager-controller` — reconciler effect executor
**Type:** Bug fix (data-loss / silent intent loss on conflict)
**Branch:** `feature/percussionist-dev-plan-rev12`

---

## Context

Human intent for a task is recorded **only** in annotations on the `Task` CR:

- `percussionist.dev/action-approved`
- `percussionist.dev/action-abandon`
- `percussionist.dev/action-request-changes` (+ `percussionist.dev/action-rework-feedback`)
- `percussionist.dev/action-answer`

These are produced by `getConsumedAnnotationKeys()` in
`packages/manager-controller/src/reconciler/observations.ts` (line 113) and consumed
by the decision layer:

- `decideAwaitingHuman` — `packages/manager-controller/src/reconciler/decision.ts:901`
- `decideWaitingForInput` — `~490` (the `Run` is `Running` branch at `:590`)
- `decideFailed` — `:1871`

Each of these returns a decision with **both** a `statusPatch` (the phase/worker
transition) **and** a `ClearTaskAnnotations` effect carrying the consumed keys.

### The bug

In `packages/manager-controller/src/reconciler/effects.ts`, `executeEffects()`
(current full file is 555 lines) runs the effects loop **first** (lines 109–428,
`ClearTaskAnnotations` handled at 267–298) and only **then** applies the guarded
status patch (lines 430–483):

1. Re-fetch task, check phase, validate transition.
2. **Apply all effects** — including deleting the action annotations via `patchTask`.
3. Re-read `latest` (line 443), guard `latestPhase === currentPhase` (line 455),
   then `patchTaskStatus(...)` with the conditional resource version (line 470).

If step 3 aborts — either the phase re-check trips (`applied:false`, line 456) or
`patchTaskStatus` 409s against a concurrent writer (MCP tools, stats reporter,
another controller replica — line 472) — the function returns early with
`applied:false`. **But the annotation was already deleted in step 2.**

Consequence: the task stays in `awaiting-human` (or `waiting-for-input`) with the
approval annotation gone. There is no other record of the human's intent, so the
task simply sits there; the human has to click "approve" again, with no signal
that anything went wrong. This is silent data loss of human intent on a conflict.

### Why the current comment is misleading

Lines 438–440 claim the re-read "picks up our own metadata writes from the effects
above (ClearTaskAnnotations), so those don't false-conflict." That reasoning is
about the *status* patch's resource-version precondition — it assumes the
annotation clear already happened so the re-read gets the newer resource version.
With the fix below, the annotation is intentionally **not** cleared before the
status write, so the re-read simply reflects external concurrent state, which is
what we want for the conflict guard.

---

## Approach

**Move annotation consumption to AFTER a successful status patch.**

The ordering in `executeEffects` becomes:

1. Re-fetch / phase guard / transition validation (unchanged).
2. Apply all effects **except** `ClearTaskAnnotations`. Collect the
   `ClearTaskAnnotations` effects into a deferred list and skip them in the loop.
3. Apply the guarded status patch (re-read, phase guard, conditional
   `patchTaskStatus` with the resource version read immediately before it). Capture
   the returned (updated) `Task` so we have its new `metadata.resourceVersion`.
4. **Only if the status patch succeeded** (no early `return`), run the deferred
   `ClearTaskAnnotations` effects, passing the post-status resource version so the
   annotation clear is conditional on the write we just made (no self-409).
5. Proceed to task-done worktree cleanup and return `applied:true` (unchanged).

Key invariant restored: **a failed status patch leaves the action annotation
intact on the Task**, so the next reconcile re-reads it and re-consumes it
idempotently. A leftover annotation after a *successful* patch is harmless (the
task has already transitioned out of the consuming phase and the annotation is
simply ignored thereafter).

### Why this is safe

- **Manager is single-replica** (`AGENTS.md`: "All deployments are single-replica
  with Recreate strategy"). Reconciles for a given `Task` are serialized by the
  in-memory work queue, so there is no second reconcile interleaving between the
  status write and the deferred annotation clear. The only concurrent writers are
  MCP tools / stats / dispatcher, which do not re-set the consumed action
  annotations during that micro-window in a way that matters.
- **No ordering dependency on effects.** None of the other effects
  (`ScheduleRun`, `ScheduleMergeRun`, `DeliverAnswer`, `CleanupWorktree`,
  `CreateTask`, `DeleteRun`, `SummarizeSession`) read or depend on the action
  annotations; deferring only `ClearTaskAnnotations` cannot change their
  correctness.
- **Resource version for the clear.** `patchTaskStatus` returns the updated `Task`
  (`packages/kube/src/index.ts:829`, returns `Task`). We pass its
  `metadata.resourceVersion` into the deferred clear so the annotation delete is a
  conditional merge-patch against the state we just wrote — avoiding a spurious
  409 against our own prior write. If an *external* concurrent write still 409s the
  clear, the existing non-fatal catch (lines 291–296) leaves the annotation as a
  harmless leftover rather than losing intent.

### Scope boundaries

- **In scope:** reordering annotation clearing relative to the status patch, plus
  a regression test.
- **Out of scope:** changing which annotations are "consumed", changing decision
  logic, changing `patchTaskStatus` retry behavior, touching `ClearProjectAnnotations`
  (that effect type is defined and tested but is **never produced** by any decision
  today, so it is unaffected; the same deferral naturally covers it if it ever is
  used).
- **Behavior preserved:** all non-annotation effects run in the same order and with
  the same failure semantics; the final status patch logic (phase guard, conditional
  write, conflict → `applied:false`) is untouched except for the comment update.

---

## Tasks

### BUILD task 1 — Defactor `executeEffects` to defer `ClearTaskAnnotations`

**File:** `packages/manager-controller/src/reconciler/effects.ts`

1. Extract the body of the existing `case 'ClearTaskAnnotations'` handler
   (lines 267–297) into a helper function, e.g.
   `applyClearTaskAnnotations(effect, taskName, project, namespace, resourceVersion?)`.
   - Keep the existing split: `percussionist.dev/action-*` keys → `patchTask`
     (metadata annotations set to `null`); everything else →
     `clearProjectAnnotations(...)`.
   - When `resourceVersion` is provided, include it in the `patchTask` metadata so
     the clear is conditional: `{ metadata: { name, resourceVersion, annotations } }`.
   - Preserve the existing internal try/catch + `console.warn` (non-fatal) so a
     failed annotation clear never throws out of the deferred section.
2. In the effects `for...of` loop (line 109), at the top of the switch, detect
   `ClearTaskAnnotations` and instead push it onto a `deferredClears: ReconcileEffect[]`
   array and `continue` (do **not** run it inline, do **not** push to
   `effectsApplied` yet). All other effect types run exactly as before.
3. After the status-patch block (after line 483, before the task-done worktree
   cleanup at line 489), add a deferred section:
   - It is only reached when the function has **not** early-returned, i.e. the
     status patch succeeded (or was skipped because there was no `toPhase`/
     `statusPatch`).
   - Capture `const patched = await patchTaskStatus(...)` from step 3 and pass
     `patched?.metadata?.resourceVersion` into each `applyClearTaskAnnotations`
     call. When the status patch was skipped, `resourceVersion` is `undefined` and
     the helper calls `patchTask` without it (unchanged behavior for that path).
   - For each deferred effect, after the helper completes, push
     `effect.type` (`'ClearTaskAnnotations'`) onto `effectsApplied` (mirrors the
     current loop's post-effect `push` at line 418).
4. Update the comment at lines 431–440: the re-read no longer needs to pick up
   annotation clears (they now happen later); state instead that the re-read guards
   the phase and supplies the resource version for the conditional status write,
   and that annotation consumption is deferred until after a successful status
   write so a failed/conflicted status patch never loses the human's intent.

**Acceptance for BUILD-1:** existing `effects.test.ts` ClearTaskAnnotations tests
(lines 515–589) still pass (they call with no status patch, so the clear runs in
the deferred section without a resource version, producing identical `patchTask`
args); the happy-path and concurrent-modification tests (lines 178–955) are
unaffected because they do not mix `ClearTaskAnnotations` with a status patch.

### BUILD task 2 — Add regression tests for the lost-intent race

**File:** `packages/manager-controller/src/reconciler/__tests__/effects.test.ts`

Add a dedicated `describe('executeEffects — annotation clear ordering')` block:

1. **Status patch 409 ⇒ annotation preserved.** Build a decision-shaped call with
   `toPhase: 'awaiting-merge'`, a `statusPatch`, and a
   `ClearTaskAnnotations` effect for `percussionist.dev/action-approved`. Mock
   `patchTaskStatus` to reject with a 409. Assert `result.applied === false` **and**
   that `patchTask` (the annotation clear) was **never** called — proving the
   approval annotation survives the conflict for the next reconcile to re-consume.
2. **Status patch succeeds ⇒ annotation cleared after.** Same shape but
   `patchTaskStatus` resolves with an updated task (resource version e.g. `'1001'`).
   Assert `result.applied === true`, `patchTask` was called with the
   `action-approved: null` annotation, **and** that `patchTask` was called
   *after* `patchTaskStatus` (use `mock.invocationCallOrder` or a sequence spy to
   verify ordering).
3. **Phase guard trip ⇒ annotation preserved.** Make the re-read (second
   `getTask` mock) return a task whose phase moved away from `currentPhase`. Assert
   `applied === false` and `patchTask` not called.
4. **No status patch ⇒ annotation still cleared (unchanged behavior).** Call with
   `toPhase`/`statusPatch` undefined + the clear effect; assert `patchTask` called
   and `applied === true` (guards the deferred section runs even when the status
   block is skipped).

**Acceptance for BUILD-2:** all new tests green; `pnpm test` and `pnpm typecheck`
pass for the package.

---

## Risks / open questions

- **Reverse race (negligible under current deployment).** After a *successful*
  status patch but before the deferred clear, there is a micro-window where the
  Task is in its new phase with the action annotation still present. Because the
  manager is single-replica and reconciles per-Task serially, no second reconcile
  of the same Task interleaves there. The one branch that could look odd is
  `decideFailed` "escalate to human" (`:1928`), which transitions a failed task to
  `awaiting-human` while clearing `action-approved`; in the deferred model the
  annotation is cleared *after* the move, so a concurrent reader would briefly see
  `awaiting-human` + `action-approved`. In practice (single replica) this cannot be
  observed mid-cycle, and even if it were, the next cycle would simply re-approve
  (idempotent, not a loop, because the annotation is then cleared). Acceptable.
- **Deferred clear 409.** If an external concurrent writer 409s the annotation
  clear after a successful status patch, the annotation is left as a harmless
  leftover (task already transitioned; intent not lost, merely not cleaned up).
  The existing non-fatal catch keeps the reconcile cycle healthy; a follow-up
  reconcile does not re-consume it (phase already changed). No action needed.
- **`patchTaskStatus` return value in tests.** The test mock currently returns
  `undefined as any` (line 68). The deferred section reads
  `patched?.metadata?.resourceVersion`, which is `undefined` in tests without a
  status patch — so the helper calls `patchTask` without a resource version,
  matching today's assertions. No mock change required for the no-status-patch
  path; BUILD-2 test 2 will set the mock to return a task with a resource version.

## Acceptance criteria (whole change)

1. When the guarded status patch fails (phase guard trip or 409 conflict), the
   consumed action annotation(s) remain on the `Task` CR — never deleted.
2. When the status patch succeeds, the consumed action annotation(s) are deleted
   **after** the status transition (verified by call ordering).
3. All existing unit tests in `effects.test.ts` and `decision.test.ts` continue to
   pass; `pnpm typecheck` and `pnpm test` are green for `@percussionist/manager-controller`.
4. No change to which annotations are consumed or to any decision logic.

## Proposed BUILD task breakdown (summary)

- **BUILD-1:** Refactor `executeEffects` (effects.ts) to defer
  `ClearTaskAnnotations` until after a successful status patch, using the
  post-status resource version for the clear. Update the explanatory comment.
- **BUILD-2:** Add regression tests in `effects.test.ts` covering the
  failed-status-patch-keeps-annotation, success-clears-after, phase-guard-keeps,
  and no-status-patch-still-clears cases.
