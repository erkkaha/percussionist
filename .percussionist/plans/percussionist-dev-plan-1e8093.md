# Plan: Guard `decideAwaitingChildren` against empty child set

## Context

- In `packages/manager-controller/src/reconciler/decision.ts`, `decideAwaitingChildren()` computes:
  - `childTasks` as all `BUILD` tasks with `spec.parentTaskRef === <planTaskName>`
  - `allDone` as `childTasks.every((t) => t.status?.phase === "done")`
- `Array.prototype.every()` returns `true` for an empty array, so if all child tasks are deleted after the PLAN task already entered `awaiting-children`, the reconcile loop will interpret “no children” as “all done”.
- That can incorrectly advance the PLAN task to:
  - `done` (integration disabled), or
  - `awaiting-human` (manual integration), or
  - `awaiting-feature-merge` with `ScheduleMergeRun` (auto-merge),
  even though there are no BUILD results to integrate.
- Existing tests in `packages/manager-controller/src/reconciler/__tests__/decision.test.ts` cover:
  - generating-builds success with children → `awaiting-children`
  - generating-builds success with zero children → `awaiting-human`
  but do **not** cover the edge case where children later disappear while already in `awaiting-children`.

## Scope boundaries

In scope:
- Reconcile decision behavior in `awaiting-children` for zero-current-child condition.
- Unit tests in reconciler decision tests.

Out of scope:
- Board route delete permissions/constraints (`packages/web/src/server/routes/board.ts`).
- Broader task lifecycle redesign or adding hard referential integrity for parent/child Task CRs.
- Changes to transition table or unrelated flow presets.

## Approach

Add an explicit non-empty guard before treating children as complete:

- Replace vacuous `every()` success with explicit logic equivalent to:
  - `hasChildren = childTasks.length > 0`
  - `allDone = hasChildren && childTasks.every(done)`
- When `hasChildren` is false in `awaiting-children`, do **not** proceed to done/merge. Escalate to a safe state (`awaiting-human`) with a specific event reason/message indicating child tasks are missing after previously being generated.

Why `awaiting-human` for zero-current-child:
- It prevents silent auto-merge scheduling with no merged BUILD work.
- It is consistent with existing `generating-builds` behavior, which escalates to `awaiting-human` when no children are present.
- It creates a visible recovery point for operators instead of a false “complete” state.

## Tasks

1. Update `decideAwaitingChildren()` in `packages/manager-controller/src/reconciler/decision.ts`:
   - Introduce `hasChildren` derived from `childTasks.length > 0`.
   - Gate completion logic with `hasChildren && ...every(...)`.
   - Add an early branch for `!hasChildren` that returns:
     - `toPhase: "awaiting-human"`
     - deterministic event reason (e.g. `ChildTasksMissing`) and explanatory message.
2. Keep integration-mode branching (`disabled` / `manual` / `auto-merge`) unchanged for the valid `hasChildren && allDone` path.
3. Add unit tests in `packages/manager-controller/src/reconciler/__tests__/decision.test.ts` for `awaiting-children`:
   - **New test A:** zero children now → transitions to `awaiting-human` (regression test for vacuous truth).
   - **New test B:** one child not done → stays in-place (no-op) to confirm waiting behavior unaffected.
   - **New test C:** all children done + feature branching enabled/integration auto-merge → still transitions to `awaiting-feature-merge` (guard didn’t break happy path).
4. Verify test naming/messages are explicit about “children deleted/missing after entering awaiting-children” to document intent.
5. Run targeted tests (and, if standard in branch workflow, full manager-controller test suite) to confirm no regressions.

## Acceptance criteria

- A PLAN task in `awaiting-children` with zero matching `BUILD` children no longer transitions as if all children were done.
- In that zero-child state, reconcile moves to `awaiting-human` with a clear event reason/message.
- Existing done/merge transitions still occur when at least one child exists and all are `done`.
- Unit tests explicitly cover zero-child, partial-child, and all-done-child cases for `awaiting-children`.

## Proposed BUILD task breakdown

1. **Decision logic fix (manager-controller)**
   - Implement non-empty guard + zero-child escalation in `decision.ts`.
2. **Reconciler unit test coverage**
   - Add/adjust tests in `decision.test.ts` for the new edge-case behavior and unchanged happy paths.
3. **Validation run**
   - Execute relevant tests and capture results in BUILD output.

## Risks / open questions

- **Event reason naming:** confirm preferred naming convention for new reason (`ChildTasksMissing` vs `NoChildTasksInAwaitingChildren`) to keep task event taxonomy consistent.
- **Operational recovery policy:** after escalation to `awaiting-human`, human/operator action flow (recreate children vs approve to done) remains policy-driven and is not enforced by this fix.
- **Data race tolerance:** transient list inconsistencies are unlikely but possible; escalation is intentionally conservative to avoid false completion.

## Assumptions

- Child task deletion can occur externally (e.g., board delete/admin action), so reconciler must be resilient.
- Conservative behavior (`awaiting-human`) is preferable to silent completion/merge when integrity is uncertain.
