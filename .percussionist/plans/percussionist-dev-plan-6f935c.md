# Plan: Prevent review run-name collisions across retry/rework boundaries

## Context

The reconcile logic for BUILD tasks in `packages/manager-controller/src/reconciler/decision.ts` schedules an AI review run when a task moves from `succeeded` to `reviewing` (`decideSucceeded`).

- Current code computes review sequence as:
  - `retryCount = task.status?.worker?.retryCount ?? 0`
  - `aiReworkCount = task.status?.worker?.aiReworkCount ?? 0`
  - `reviewSeq = String(retryCount + aiReworkCount)`
  - `reviewRunName = auxiliaryRunName(project, "review", taskName, reviewSeq)`
- This is non-injective: different pairs can map to the same sum (e.g. `0+1` and `1+0`).
- In `packages/manager-controller/src/reconciler/effects.ts`, `ScheduleReviewRun` calls `createRun(reviewRun)` and intentionally swallows `already exists` errors.
- In `decideReviewing`, the manager reads the run referenced by `task.status.worker.reviewRunName` and applies its verdict annotation (`getReviewVerdict(reviewRun)` in `packages/manager-controller/src/reconciler/observations.ts`).

Result: if a new review cycle reuses an old run name, the old run can be treated as the current review and its stale verdict can be applied to new work.

## Scope boundaries

### In scope
- Fixing review run-name generation so `(retryCount, aiReworkCount)` pairs map to unique review run names.
- Updating/adding unit tests around reconcile decisions for AI review naming behavior.
- Keeping run names K8s-safe and deterministic.

### Out of scope
- Changing overall review policy semantics (approve/request_changes/escalate behavior).
- Changing `createRun` AlreadyExists handling globally for all effect types.
- Data migration for historical runs/tasks.

## Approach

Use a **pair-aware, collision-resistant review suffix** derived from both counters (not their sum), aligned with existing deterministic naming patterns already used for worker and merge runs.

Preferred implementation shape:

1. In `decideSucceeded`, replace `String(retryCount + aiReworkCount)` with a suffix derived from both counters, e.g.:
   - canonical key: ``${projectName}:${taskName}:review:${retryCount}:${aiReworkCount}``
   - suffix: `sha256(key).slice(0, 8|10)`
2. Pass this suffix into `auxiliaryRunName(..., "review", ..., suffix)`.

Why this shape:
- Injective with respect to practical inputs (different counter pairs produce different keys, and hash truncation risk is negligible at this scale).
- Deterministic across reconcile loops for the same pair (preserves idempotent scheduling behavior).
- Consistent with existing merge/worker naming strategy (`createHash("sha256")` usage in `decision.ts` and `worker-builder.ts`).

Alternative acceptable shape:
- Plain separated key suffix (e.g. `${retryCount}-${aiReworkCount}`) if length constraints are validated against `auxiliaryRunName` truncation logic.

## Acceptance criteria

1. Review run name generation in `decideSucceeded` no longer uses `retryCount + aiReworkCount`.
2. Two states with equal sums but different pairs (e.g. `(0,1)` vs `(1,0)`) produce different `reviewRunName` values.
3. Reconcile remains idempotent for identical `(retryCount, aiReworkCount)` inputs (same `reviewRunName` across repeated cycles).
4. Existing review flow behavior is preserved:
   - transition to `reviewing` still occurs,
   - `ScheduleReviewRun` effect is still emitted,
   - verdict handling in `decideReviewing` remains unchanged.
5. Unit tests in `packages/manager-controller/src/reconciler/__tests__/decision.test.ts` cover the collision regression scenario.

## Tasks

1. **Locate and isolate the naming logic**
   - Edit `decideSucceeded` in `packages/manager-controller/src/reconciler/decision.ts` where `reviewSeq` is computed and passed to `auxiliaryRunName`.

2. **Implement pair-aware review suffix generation**
   - Replace sum-based `reviewSeq` with a value that encodes both `retryCount` and `aiReworkCount` (prefer deterministic hash key as above).
   - Keep output compatible with K8s naming constraints through existing `auxiliaryRunName` path.

3. **Add regression-focused decision tests**
   - In `packages/manager-controller/src/reconciler/__tests__/decision.test.ts`, add/extend tests under “succeeded with AI review” to assert:
     - `(retryCount=0, aiReworkCount=1)` and `(retryCount=1, aiReworkCount=0)` yield different `statusPatch.worker.reviewRunName`.
     - Re-running `decide(...)` with the same counters yields the same `reviewRunName`.

4. **Keep existing behavior assertions intact**
   - Ensure existing test (`succeeded + AI review enabled → reviewing + ScheduleReviewRun effect`) still passes and continues asserting phase/effect behavior.

5. **Run targeted verification**
   - Execute manager-controller unit tests (or full `pnpm test` if preferred by maintainer workflow).
   - If practical, run typecheck to ensure no typing regressions in reconcile logic.

6. **Document rationale in code comments (minimal)**
   - Add a short inline comment near suffix generation clarifying why both counters must be encoded to avoid retry/rework collisions.

## Proposed BUILD task breakdown

1. **BUILD A — Decision logic fix**
   - Implement deterministic collision-free review suffix in `decideSucceeded`.
   - Deliverable: code change with concise inline rationale comment.

2. **BUILD B — Regression tests**
   - Add tests proving distinct names for `(0,1)` vs `(1,0)` and deterministic stability for identical inputs.
   - Deliverable: updated `decision.test.ts` coverage for this bug class.

3. **BUILD C — Validation pass**
   - Run test/typecheck commands and capture results for reviewer confidence.
   - Deliverable: green checks or clearly documented failures unrelated to this fix.

## Risks / open questions

1. **Hash truncation theoretical collision risk**
   - Very low but non-zero when truncating. Using 10 hex chars (as used elsewhere) keeps consistency and practical safety.

2. **Plain separated suffix length/format tradeoff**
   - `${retryCount}-${aiReworkCount}` is human-readable but may interact with truncation if task names are very long; hashed suffix avoids this concern.

3. **Existing stale `reviewRunName` values on in-flight tasks**
   - Fix prevents new collisions but does not retroactively repair tasks already stuck with old colliding names. Manual retry/rework may still be needed for already-affected tasks.
