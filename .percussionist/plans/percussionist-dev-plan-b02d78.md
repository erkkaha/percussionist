# Plan: unblock PLAN merge retry from awaiting-human

## Context

- Task phase transitions are centrally enforced by `TRANSITION_TABLE` in `packages/manager-controller/src/reconciler/transitions.ts`.
- `decide()` in `packages/manager-controller/src/reconciler/decision.ts` validates every proposed transition with `isValidTransition(...)` before returning.
  - If illegal, it emits an `InvalidTransitionBlocked` audit event, sets `toPhase` to `undefined`, and clears all effects (`decision.effects = []`, lines ~141-155).
- In `decideAwaitingHuman(...)` (same file, lines ~663-700), approving a PLAN with `task.status.worker.mergeError` proposes:
  - `toPhase: "awaiting-feature-merge"`
  - `statusPatch` clearing stale merge metadata (`mergeRunName: null`, `mergeError: null`)
  - `ClearTaskAnnotations` to consume the human approval annotation
- Current transition table for `"awaiting-human"` does **not** include `"awaiting-feature-merge"` (line ~14), so that branch is always blocked as illegal.
- Resulting behavior matches the report:
  - transition is rejected,
  - `ClearTaskAnnotations` is dropped,
  - approval annotation remains,
  - reconcile loop repeats `InvalidTransitionBlocked` without progressing to merge retry.

## Scope boundaries

### In scope
- Make PLAN merge-retry from `awaiting-human` legal by aligning transition table with existing decision logic.
- Add/adjust unit tests that assert the newly legal transition path.
- Preserve existing behavior for other `awaiting-human` actions (approve→buildgen/done, request changes, abandon).

### Out of scope
- Redesign of the decision engine’s illegal-transition fallback behavior (clearing effects).
- Changes to merge-run scheduling mechanics in `decideAwaitingFeatureMerge(...)`.
- New CRD phases or broad workflow refactors.

## Approach

1. **Single-source-of-truth fix first:** update `TRANSITION_TABLE["awaiting-human"]` to include `"awaiting-feature-merge"`.
2. **Test the contract at two levels:**
   - transition table validity (`isValidTransition("awaiting-human", "awaiting-feature-merge") === true`),
   - decision behavior for merge-retry approval (toPhase + annotation-clearing effect retained).
3. **Keep change minimal:** no modification to runtime branching logic unless tests reveal adjacent gaps.

## Acceptance criteria

1. `isValidTransition("awaiting-human", "awaiting-feature-merge")` returns `true`.
2. For a PLAN task in `awaiting-human` with `worker.mergeError` and `manualActions.approved = true`, `decide(...)` returns:
   - `toPhase: "awaiting-feature-merge"`,
   - `statusPatch.worker.mergeRunName = null` and `statusPatch.worker.mergeError = null`,
   - `effects` including `ClearTaskAnnotations`.
3. No existing transition tests regress.
4. No `InvalidTransitionBlocked` is produced for this specific approval path.

## Tasks

1. **Update legal transition table**
   - File: `packages/manager-controller/src/reconciler/transitions.ts`
   - Add `"awaiting-feature-merge"` to the `"awaiting-human"` allowed-target list.

2. **Expand transition unit test coverage**
   - File: `packages/manager-controller/src/reconciler/__tests__/transitions.test.ts`
   - Add explicit expectation that `isValidTransition("awaiting-human", "awaiting-feature-merge")` is `true`.

3. **Add decision test for merge-retry approval path**
   - File: `packages/manager-controller/src/reconciler/__tests__/decision.test.ts`
   - Add a case under `describe("decide — awaiting-human", ...)` with:
     - PLAN task phase `awaiting-human`,
     - preloaded `task.status.worker.mergeError` and optional `mergeRunName`,
     - `manualActions.approved = true`.
   - Assert `toPhase === "awaiting-feature-merge"`, merge metadata is cleared in `statusPatch`, and `ClearTaskAnnotations` effect exists.

4. **Regression safety check for illegal-transition guard**
   - Keep existing invalid transition guard tests untouched, but ensure newly legal route no longer depends on that fallback path.

5. **Verification**
   - Run targeted tests for reconciler decision/transition suites first.
   - Run project standard checks as appropriate for changed package (`pnpm typecheck`, relevant tests).

## Proposed BUILD task breakdown

1. **BUILD 1 — Transition table + transition tests**
   - Implement transition-table change and update `transitions.test.ts` assertions.

2. **BUILD 2 — Decision-path regression test**
   - Add `decision.test.ts` case for PLAN merge-retry approval path from `awaiting-human`.

3. **BUILD 3 — Verification and hardening**
   - Execute tests/typecheck, confirm no regressions, and validate that the retry path no longer emits `InvalidTransitionBlocked` in unit-level behavior.

## Risks / open questions

1. **Potential workflow coupling risk**
   - Enabling `awaiting-human -> awaiting-feature-merge` makes this path broadly legal. Current decision logic only uses it for PLAN merge retries, but future logic changes could also route here; tests should keep intent explicit.

2. **Annotation consumption still tied to decision legality**
   - This fix unblocks the known path, but any future illegal transition proposals will still drop `ClearTaskAnnotations` due to current guard behavior. Consider a separate hardening task if recurring loops appear elsewhere.

3. **Manual vs auto merge semantics**
   - This plan assumes retry approval should always resume feature-merge automation for PLAN tasks with `mergeError`, consistent with current `decideAwaitingHuman` implementation.
