# Plan: Fix AI auto-rework so it creates a fresh worker run

## Context

- Worker run naming is currently deterministic only by `project`, `task`, and `retryCount` in `packages/manager-controller/src/worker-builder.ts` (`workerRunName()` around lines 371-388).
- In reconcile flow, `decideScheduled()` computes worker run names with `workerRunName(project, task, retryCount)` and emits `ScheduleRun` (`packages/manager-controller/src/reconciler/decision.ts` around lines 224-260).
- Human-requested rework increments `retryCount` in `decideAwaitingHuman()` (around lines 645-660), which produces a new worker run name and therefore a new Run CR.
- AI-requested rework (`decideReviewing()` when verdict is `request_changes`) increments only `aiReworkCount` (around lines 584-614) and moves task to `rework-requested`, then `scheduled`.
- Because `retryCount` is unchanged on AI rework, `decideScheduled()` recomputes the same worker run name. `executeEffects()` handles `createRun` `already exists` as a no-op for `ScheduleRun` (around lines 92-112 in `effects.ts`), so no new pod is created. The old succeeded run is observed and the task loops through review again unchanged.
- AI review is opt-in (`review.aiReviewerEnabled` defaults false in all presets in `packages/manager-controller/src/reconciler/flow.ts`), but this is still a correctness issue when enabled.

## Scope boundaries

### In scope

- Ensure AI auto-rework (`request_changes`) always schedules a **new** worker run instance.
- Preserve deterministic/idempotent behavior per reconcile cycle.
- Keep existing human rework and retry semantics intact.
- Add/update unit tests under `packages/manager-controller/src/reconciler/__tests__/` and any naming tests needed.

### Out of scope

- Changing default flow presets or enabling AI review by default.
- Refactoring overall reconciliation state machine.
- Altering merge/buildgen naming semantics unless required by the worker naming signature change.

## Approach

Use `aiReworkCount` as part of worker run identity so AI-requested rework gets a distinct deterministic run name without deleting historical runs.

### Key decision

- Prefer **including `aiReworkCount` in worker run naming input** over deleting old runs.
  - Pros: keeps run history, avoids destructive behavior, preserves existing reconcile idempotency pattern (same state => same name), and directly models “attempt identity” for AI-driven rework loops.
  - Deleting old runs is riskier (race conditions, audit/history loss, extra effects), and unnecessary once naming encodes all attempt counters.

### Design details

1. Extend `workerRunName()` signature in `worker-builder.ts` to accept `aiReworkCount` (default `0` for backwards compatibility in callsites/tools).
2. Update the deterministic hash input from `${project}:${task}:${retryCount}` to include AI rework count (e.g., `${project}:${task}:${retryCount}:${aiReworkCount}`).
3. In `decideScheduled()`, pass both counters from task status (`retryCount`, `aiReworkCount`) when computing `runName`.
4. Keep `retryCount` semantics unchanged:
   - Human rework still increments `retryCount` and resets `aiReworkCount`.
   - AI rework increments `aiReworkCount` only.
   - Combined values now uniquely identify each worker attempt.
5. Evaluate non-reconciler callsites (`agent/tools.ts`):
   - Keep admin/manual run creation behavior stable by passing explicit `aiReworkCount` from existing worker status where available, otherwise default `0`.
   - Ensure no accidental run-name collisions when using `create_run`/`force_retry` after AI rework cycles.

## Implementation tasks

1. **Update worker run naming API**
   - File: `packages/manager-controller/src/worker-builder.ts`
   - Change `workerRunName(projectName, taskName, retryCount = 0)` to include `aiReworkCount = 0`.
   - Update function comment to document both counters are part of deterministic identity.

2. **Wire AI rework counter into scheduler naming**
   - File: `packages/manager-controller/src/reconciler/decision.ts`
   - In `decideScheduled()`, read `aiReworkCount` and call `workerRunName(..., retryCount, aiReworkCount)`.
   - Keep status patch and `ScheduleRun` effect payload behavior unchanged except resulting `runName` value.

3. **Align operational/admin tooling callsites**
   - File: `packages/manager-controller/src/agent/tools.ts`
   - Update `create_run` and `force_retry` callsites to pass the most appropriate AI rework value:
     - `create_run`: existing worker `aiReworkCount` if present.
     - `force_retry`: explicit `0` on retry bump (consistent with existing reset semantics).

4. **Add/adjust decision tests for regression coverage**
   - File: `packages/manager-controller/src/reconciler/__tests__/decision.test.ts`
   - Add test(s) verifying scheduled run names differ when only `aiReworkCount` changes.
   - Add an end-to-end state-machine style test for AI `request_changes` path:
     - reviewing (`request_changes`) -> rework-requested -> scheduled -> initializing
     - assert newly computed worker `runName` differs from prior succeeded run name.

5. **Add focused naming unit test (if missing) for `workerRunName`**
   - Prefer new test file near worker builder tests (or extend existing manager-controller tests) to assert:
     - same inputs => same output;
     - changed `aiReworkCount` => different output;
     - unchanged K8s name constraints (<=63 chars).

6. **Verification**
   - Run targeted tests first (decision + any new naming test).
   - Run package test sweep for manager-controller.
   - Run repo-level typecheck/tests per project norms before merge.

## Acceptance criteria

- With AI reviewer enabled, when a review verdict is `request_changes`, the subsequent scheduled worker run name differs from the previously succeeded worker run name even when `retryCount` is unchanged.
- Reconcile no longer loops by reusing the old succeeded worker run; a new Run CR is created for each AI auto-rework attempt.
- Human rework behavior remains unchanged (still driven by `retryCount` bump/reset semantics).
- Existing flows without AI reviewer enabled continue unchanged.
- Unit tests explicitly cover this regression and pass.

## Risks / open questions

1. **Run-name compatibility across in-flight tasks**
   - Changing naming input could alter names for tasks currently in `scheduled`/`initializing` if they rely on old deterministic mapping.
   - Mitigation: default `aiReworkCount` to `0`; existing tasks without AI rework continue to generate equivalent logical attempt names, though hash values may still change after deployment. Validate reconcile behavior for already-running tasks.

2. **Admin tool parity (`create_run`)**
   - If `create_run` does not pass `aiReworkCount`, it may compute an unexpected run name relative to reconciler.
   - Mitigation: explicitly pass/derive counter in tools callsite and cover via tests where practical.

3. **Test fixture fidelity**
   - Current fixtures often override `worker` blobs directly; ensure new tests avoid false positives by setting both `runName` and counters consistently.

## Proposed BUILD task breakdown

1. **BUILD A — Worker run naming update**
   - Update `workerRunName` signature/hash input and all compile-time callsites.

2. **BUILD B — Reconciler AI rework scheduling fix**
   - Ensure `decideScheduled` uses both counters and preserves existing phase/effect semantics.

3. **BUILD C — Regression tests**
   - Add decision-flow and naming tests proving AI auto-rework creates a fresh worker run and prevents no-op loops.
