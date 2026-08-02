# Plan: Fix board deadlock — `awaiting-children` waits for a `mergedAt` children can never get

Task: `percussionist-dev-plan-rev02`

## Context

`decideAwaitingChildren` (`packages/manager-controller/src/reconciler/decision.ts:1269-1271`)
gates PLAN-parent progress on:

```ts
childTasks.every((t) => t.status?.phase === 'done' && t.status?.worker?.mergedAt)
```

When that predicate is false and children exist, it returns a no-op
(`decision.ts:1292-1294`) — i.e. "wait".

**The wait can never resolve once a child is `done` without `mergedAt`.**
`worker.mergedAt` is only ever written in three places, and in every one of them
it is set in the *same* status patch that transitions the task to `done`:

- BUILD merge-run success: `decision.ts:1005-1007` (`toPhase: 'done'`, `mergedAt: now`)
- PLAN feature-branch merge-run success: `decision.ts:1480-1481`
- PLAN PR merged (PR polling): `decision.ts:1634-1648`

No code path adds `mergedAt` to a task that is already `done`. Therefore
`done && !mergedAt` is a **terminal** child state, and the no-op branch is a
permanent deadlock with no timeout or escalation.

Paths by which a BUILD child reaches `done` without `mergedAt`:

1. `BuildApprovedDone` (`decision.ts:903-915`): human approval when
   `flow.build.onApprove === 'done'` **or** `flow.merge.mode === 'disabled'`.
   This is the normal completion path of the shipped `plan-build` preset
   (`reconciler/flow.ts:94-114`: `merge.mode: 'disabled'`,
   `build.onApprove: 'done'`) and the `review` preset (`flow.ts:73-93`).
2. `BuildSucceededAutoDone` (`decision.ts:523-532`): `flow.build.onSuccess === 'done'`
   (the `simple` preset, `flow.ts:52-72`).
3. `TaskAbandoned` (`decision.ts:816-825`): a human abandons the child from
   `awaiting-human` — possible under **any** flow config, including
   `plan-build-review-merge` where merge is otherwise expected.

The same `done && mergedAt` predicate is duplicated in three more places:

- `flow-introspection.ts:466-468` (`explainAwaitingChildren`) — the "why is this
  stuck" explainer reports "wait for children" for the same unreachable state.
- `decision.ts:238` (`decidePending` predecessor gate) and `scheduler.ts:40`
  (`canSchedule`) — a successor BUILD task with `predecessorRef` blocks forever
  in `pending` when `featureBranchingEnabled` and the predecessor finished
  without `mergedAt` (abandoned, or a merge-less flow). This is the same
  deadlock class one level down: it also prevents the parent from ever reaching
  "all children done". Note `canSchedule` has no non-test callers — the live
  gate is `decidePending` — but both must stay consistent.

The test `"BUILD children done but missing mergedAt → no-op (wait for merge
cycle)"` (`__tests__/decision.test.ts:659-688`) codifies the deadlock; its
comment ("wait for merge cycle") describes a cycle that cannot occur.

Relevant types: `WorkerStatusSchema` (`packages/api/src/index.ts:900-926`)
currently has no way to distinguish "abandoned" from "completed"; both end as
`worker.status: 'Succeeded'`.

## Approach

Two principles drive the design:

1. **Never wait on a terminal state.** Once every child is `done`, waiting is
   provably futile; the only valid outcomes are *proceed* or *escalate to a
   human*.
2. **Require `mergedAt` only where the flow actually produces one.** Introduce
   a single shared predicate so the four duplicated gate sites cannot drift
   again.

### Key decisions

- **New shared predicate module** `packages/manager-controller/src/reconciler/child-completion.ts`:

  ```ts
  /** True when the configured flow routes BUILD children through a merge run,
   *  i.e. children are expected to end `done` WITH `mergedAt`. */
  export function childMergeExpected(project: Project, flow: ResolvedFlow): boolean {
    return (
      project.spec.featureBranchingEnabled === true &&
      flow.merge.mode !== 'disabled' &&
      flow.build.onSuccess !== 'done' &&
      flow.build.onApprove === 'merge'
    );
  }

  /** A done child satisfies its parent's gate when it merged, was abandoned,
   *  or the flow never merges children in the first place. */
  export function childSatisfiesGate(child: Task, mergeExpected: boolean): boolean {
    if (child.status?.phase !== 'done') return false;
    const w = child.status?.worker;
    return Boolean(w?.mergedAt) || w?.abandoned === true || !mergeExpected;
  }
  ```

  The conditions mirror the actual done-paths: `onSuccess === 'done'` short-circuits
  before review/approval (`decision.ts:523`), and `BuildApprovedDone` fires when
  `onApprove === 'done' || merge.mode === 'disabled'` (`decision.ts:904`).

- **Explicit `abandoned` marker.** Add `abandoned: z.boolean().optional()` to
  `WorkerStatusSchema` and set `abandoned: true` in the `TaskAbandoned` status
  patch (`decision.ts:822`). This is what lets an abandoned child (and an
  abandoned predecessor) unblock dependents even in merge-configured flows,
  while still letting us detect the genuinely-anomalous case (done without
  merge in a merge flow, *not* abandoned) and escalate it instead of silently
  auto-merging.

- **`decideAwaitingChildren` semantics** (replacing `decision.ts:1269-1294`):
  - Some child not `done` → no-op wait (unchanged — children genuinely in flight,
    including `awaiting-merge`).
  - All children `done` and every child satisfies `childSatisfiesGate` → proceed
    exactly as today (done / awaiting-human / PR / auto-merge per
    `integration.mode`, `decision.ts:1296-1379`). When any child completed
    without a merge, include that in the event message for visibility.
  - All children `done` but some non-abandoned child lacks `mergedAt` while
    `childMergeExpected` is true → transition to `awaiting-human` with a new
    `ChildrenDoneWithoutMerge` event naming the offending children. This state
    should be unreachable going forward (abandon now sets the marker); it
    covers legacy/stuck tasks that predate the marker and any future bug, and
    converts today's silent deadlock into a visible, actionable escalation.

- **Make escalation recoverable: extract the integration tail.** Pull
  `decision.ts:1296-1379` (the "all children complete → what next" logic) into
  a helper, e.g. `decideChildrenCompleteNext(input, fromPhase)`. In
  `decideAwaitingHuman`'s PLAN-approve branch (`decision.ts:856-901`), *after*
  the existing `mergeError` retry check but *before* the `onApprove` routing,
  detect "children already generated and all done"
  (`task.status?.worker?.buildTasksCreated` + every child `done`) and return
  the helper's decision (plus the `ClearTaskAnnotations` effect). Without this,
  approving a PLAN escalated by `ChildrenDoneWithoutMerge` would fall through
  to `generating-builds` (`decision.ts:894-900`) and re-run buildgen,
  duplicating child tasks. Abandoning the escalated parent already works
  (`decision.ts:816-825`).

- **Fix the predecessor gates with the same predicate.** In `decidePending`
  (`decision.ts:238`) and `canSchedule` (`scheduler.ts:40`), replace
  `project.spec.featureBranchingEnabled && !pred.status?.worker?.mergedAt` with
  `!childSatisfiesGate(pred, childMergeExpected(project, flow))` applied after
  the existing `phase === 'done'` check. `decidePending` already receives
  `input.flow`; `canSchedule(task, project, allTasks, activeCount)` does not —
  add a `flow: ResolvedFlow` parameter (it currently has no non-test callers,
  so the signature change is safe) or call `resolveFlow(project)` inside.
  Behavior: an abandoned predecessor, or any done predecessor under a
  merge-less flow, unblocks its successor; a done-unmerged-unabandoned
  predecessor under a merge flow keeps blocking (and the parent-level
  escalation above surfaces it once all children settle).

- **Mirror in the explainer.** Update `explainAwaitingChildren`
  (`flow-introspection.ts:450-499`) to use the shared predicate and to describe
  the new outcomes ("child X is done but was never merged; parent will escalate
  to awaiting-human") instead of "wait for children to finish" for terminal
  states.

### Why not alternatives

- *Pure "treat any done as satisfying"*: simplest, but under
  `plan-build-review-merge` + `integration.mode: 'auto-merge'` it would silently
  auto-merge a feature branch that is missing a child's work in an anomalous
  (non-abandoned) case. The `abandoned` marker keeps the intentional case
  frictionless and escalates only the anomaly.
- *Timeout on awaiting-children*: treats the symptom; the state is provably
  terminal, so deciding immediately is strictly better than a timer.

## Scope boundaries

**In scope**
- `packages/api/src/index.ts` — `WorkerStatusSchema.abandoned`.
- `packages/manager-controller/src/reconciler/decision.ts` —
  `decideAwaitingChildren`, `decideAwaitingHuman` (abandon marker + PLAN-approve
  resume), `decidePending` predecessor gate, extracted helper.
- `packages/manager-controller/src/reconciler/scheduler.ts` — `canSchedule` gate.
- `packages/manager-controller/src/reconciler/flow-introspection.ts` —
  `explainAwaitingChildren`.
- New `packages/manager-controller/src/reconciler/child-completion.ts` + tests.
- Test updates in `decision.test.ts`, `scheduler.test.ts`,
  `flow-introspection.test.ts`.

**Out of scope**
- Changing preset definitions in `flow.ts` (the `plan-build` preset's
  `merge: disabled` + `integration: auto-merge` combination is preserved as-is).
- CRD regeneration/migration beyond the additive optional `abandoned` field.
- Children stuck in `failed` blocking the parent (different lifecycle; `failed`
  is not terminal the way `done` is).
- Web UI changes (the new event reasons surface through existing event display).

## Tasks (proposed BUILD breakdown)

1. **API: add `abandoned` field.** Add `abandoned: z.boolean().optional()` to
   `WorkerStatusSchema` (`packages/api/src/index.ts:900-926`); regenerate any
   derived CRD schema if the codegen pipeline requires it (`codegen/`).
2. **Set the marker on abandon.** In `decideAwaitingHuman`
   (`decision.ts:816-825`), add `abandoned: true` to the `TaskAbandoned` status
   patch. Unit test: abandon patch carries the flag.
3. **Create `child-completion.ts`** with `childMergeExpected` and
   `childSatisfiesGate` as specified above, plus direct unit tests covering all
   four shipped presets and the abandon marker.
4. **Rework `decideAwaitingChildren`** (`decision.ts:1260-1294`): split the gate
   into "all done?" then "all satisfy?"; add the `ChildrenDoneWithoutMerge`
   escalation branch; keep the `ChildTasksMissing` branch unchanged.
5. **Extract `decideChildrenCompleteNext`** from `decision.ts:1296-1379` and use
   it from `decideAwaitingChildren` (pure refactor, no behavior change on its
   own).
6. **PLAN-approve resume path.** In `decideAwaitingHuman`'s PLAN branch
   (`decision.ts:856-901`), route to `decideChildrenCompleteNext` when
   `buildTasksCreated` is set and all children are `done`, clearing consumed
   annotations. Test: approve after `ChildrenDoneWithoutMerge` does NOT go to
   `generating-builds`.
7. **Predecessor gates.** Update `decidePending` (`decision.ts:233-241`) and
   `canSchedule` (`scheduler.ts:21-54`, new `flow` parameter) to use the shared
   predicate; update `scheduler.test.ts` and pending-phase tests.
8. **Explainer.** Update `explainAwaitingChildren`
   (`flow-introspection.ts:450-499`) to the shared predicate and new messaging;
   update `flow-introspection.test.ts`.
9. **Decision tests.** Replace `decision.test.ts:659-688` ("wait for merge
   cycle") with the new expectation (escalation to `awaiting-human` under the
   default merge flow), and add:
   - `plan-build` preset, `featureBranchingEnabled: false`: children done via
     `BuildApprovedDone` → parent `done` (`AllChildrenDoneNoIntegration`).
   - `plan-build` preset, `featureBranchingEnabled: true`: children done
     without `mergedAt` → parent proceeds per `integration.mode` (not stuck).
   - `plan-build-review-merge`: one child `done` with `abandoned: true`, rest
     merged → parent proceeds; event mentions the unmerged child.
   - `plan-build-review-merge`: one child done, unmerged, NOT abandoned →
     `awaiting-human` + `ChildrenDoneWithoutMerge`.
   - Children mixed (`done` + `awaiting-merge`) → still no-op wait.
   - Pending successor unblocks when predecessor is abandoned / done under a
     merge-less flow.
10. **Full verification.** `pnpm -r build && pnpm -r test` (or the repo's CI
    equivalents) across `api` and `manager-controller`.

Tasks 1–3 are independent of 4–8; 4 depends on 3 and 5; 6 depends on 5;
7–8 depend on 3.

## Acceptance criteria

- Under the `plan-build` preset (with and without `featureBranchingEnabled`),
  a PLAN parent whose BUILD children all complete via `BuildApprovedDone`
  leaves `awaiting-children` on the next reconcile (to `done` or the configured
  integration step) instead of waiting forever.
- Abandoning one BUILD child under any preset no longer wedges the parent: the
  parent proceeds once the remaining children finish, and the abandoned child
  carries `worker.abandoned: true`.
- A done-unmerged-unabandoned child under a merge-configured flow escalates the
  parent to `awaiting-human` with a `ChildrenDoneWithoutMerge` event —
  no silent no-op remains in `decideAwaitingChildren` once all children are done.
- Approving a PLAN escalated this way resumes at the integration step; it does
  not re-enter `generating-builds` or duplicate BUILD tasks.
- A pending successor BUILD task is not blocked by an abandoned or
  merge-not-expected predecessor.
- `explainAwaitingChildren` output matches the new decision logic.
- All existing tests pass; the rewritten `decision.test.ts:659` test asserts
  escalation rather than a permanent no-op.

## Risks / open questions

- **Auto-integration of partial work.** With the `abandoned` marker honored, a
  parent under `integration.mode: 'auto-merge'` will merge its feature branch
  to target even though an abandoned child's work is missing. This is judged
  correct (abandon = intentionally drop that work; the human made the call),
  but reviewers should confirm. If not, the alternative is to escalate whenever
  any child is unmerged and `integration.mode` is `auto-merge`/`pr`.
- **Legacy stuck tasks.** Parents already deadlocked will re-evaluate on the
  first reconcile after deploy. Children abandoned *before* this change lack
  the `abandoned` marker, so under merge flows those parents escalate to
  `awaiting-human` (one manual approve/abandon) rather than auto-proceeding —
  acceptable, arguably desirable.
- **Config smell, pre-existing:** `plan-build` combines `merge.mode: 'disabled'`
  with `integration.mode: 'auto-merge'`. With `featureBranchingEnabled: true`,
  children's work stays on `feature/{plan}--{build}` branches
  (`branch-resolver.ts:41-54`) and never lands on the parent feature branch, so
  the parent's integration merge can merge an effectively empty branch. This
  plan unblocks the board but does not resolve that config semantics question;
  flagged for a follow-up (preset validation or documentation).
- **`canSchedule` is currently dead in production** (only `decidePending`
  performs the live gate; no non-test imports of `scheduler.canSchedule`).
  Updating it anyway keeps the exported API truthful; deleting it is a separate
  cleanup decision.
- **Race safety.** No transient `done && !mergedAt` window exists — all three
  merge paths patch `mergedAt` in the same transition to `done` — so treating
  the state as terminal is safe. If a future path ever splits that patch, the
  `ChildrenDoneWithoutMerge` escalation (not a silent proceed) is the failure
  mode, which is visible and recoverable.
