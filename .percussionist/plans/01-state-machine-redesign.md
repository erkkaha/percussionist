# 01 — Task State Machine Redesign

## Summary

Replace the current dual-purpose `status.column` field with an explicit `status.phase` 
(internal state). Board column is computed client-side from phase — never stored.
Add `ideas` as a board column for not-yet-actionable tasks.

## Current State

- `status.column`: `backlog | ready | in-progress | review | rework | done | blocked`
- `status.phase`: `Pending | Active | Done | Escalated` (barely used, redundant)
- Column drives both UI rendering AND reconciler logic (tight coupling)

## Target State

### Internal Phases (authoritative, stored in CRD)

```typescript
const TaskPhase = z.enum([
  // Pre-work
  "idea",              // Parking lot, not actionable
  "pending",           // Well-defined, waiting for scheduling
  // Active work
  "scheduled",         // Scheduler picked it, run being created
  "initializing",      // Pod starting, git checkout in progress
  "running",           // Agent actively working
  "waiting-for-input", // PLAN-only: agent asked a question
  // Post-work
  "succeeded",         // Run completed successfully
  "reviewing",         // AI reviewer evaluating (optional)
  "awaiting-human",    // Needs human decision (approve/reject/answer question)
  "awaiting-merge",    // Merge run in progress
  "rework-requested",  // Human gave feedback, waiting for scheduling slot
  "generating-builds", // PLAN-only: buildgen facilitator splitting into tasks
  // Terminal
  "done",              // Complete
  // Failure
  "failed",            // Run failed, needs human decision
]);
```

### Board Column (computed client-side, never stored)

| Phase | Board Column |
|-------|------|
| `idea` | **ideas** |
| `pending` | **backlog** |
| `scheduled`, `initializing`, `running`, `awaiting-merge`, `rework-requested`, `generating-builds` | **in-progress** |
| `waiting-for-input`, `succeeded`, `reviewing`, `awaiting-human`, `failed` | **review** |
| `done` | **done** |

### Column derivation function (exported from `@percussionist/api`)

```typescript
function computeBoardColumn(phase: TaskPhase): BoardColumn {
  if (phase === "idea") return "ideas";
  if (phase === "pending") return "backlog";
  if (phase === "done") return "done";
  if (["waiting-for-input", "succeeded", "reviewing", "awaiting-human", "failed"].includes(phase))
    return "review";
  return "in-progress";
}
```

No stored field. UI, CLI, and any consumer imports this function and derives 
the column from `status.phase` at render time.

### Blocked

`blocked` becomes a boolean flag `status.blocked: boolean` + `status.blockedReason: string`.
A blocked task retains its current phase but is excluded from scheduling.
On the board, blocked tasks show a visual indicator overlay regardless of column.

## Task Type Constraints

- `idea` phase: task type is always `PLAN` (ideas need planning before execution)
- `waiting-for-input`: only valid for `PLAN` tasks. BUILD tasks that cannot proceed should fail.
- `generating-builds`: only valid for `PLAN` tasks.

## State Transitions (valid moves)

```
idea → pending                          (human promotes idea to backlog)
pending → scheduled                     (scheduler picks task)
scheduled → initializing                (run pod created)
initializing → running                  (pod ready, agent started)
running → succeeded                     (run phase = Succeeded)
running → failed                        (run phase = Failed)
running → waiting-for-input             (PLAN only, agent asked question)
waiting-for-input → running             (human answered, agent resumed)
succeeded → reviewing                   (AI reviewer enabled)
succeeded → awaiting-human              (no AI reviewer, straight to human)
reviewing → awaiting-human              (AI approved, human gate)
reviewing → rework-requested            (AI requested changes, within ceiling)
reviewing → awaiting-human              (AI rework ceiling hit, escalate to human)
awaiting-human → awaiting-merge         (BUILD: human approved, merge started)
awaiting-human → generating-builds      (PLAN: human approved plan)
awaiting-human → rework-requested       (human requested changes)
awaiting-human → done                   (PLAN with no merge needed)
awaiting-merge → done                   (merge succeeded)
awaiting-merge → failed                 (merge failed)
rework-requested → scheduled            (slot available, re-dispatched)
generating-builds → done                (BUILD tasks created, PLAN complete)
failed → scheduled                      (human chose retry)
failed → rework-requested              (human chose rework with feedback)
failed → done                           (human chose abandon/skip)
```

## Deployment

No migration. Replace the schema, regenerate CRDs, deploy. Existing tasks get 
`status.phase` backfilled from the old `status.column` on first reconcile:

```typescript
function backfillPhase(column: string, worker?: WorkerStatus): TaskPhase {
  switch (column) {
    case "backlog": return "pending";
    case "ready": return "pending";
    case "in-progress":
      if (!worker?.runName) return "scheduled";
      return "running";
    case "review":
      if (worker?.status === "Failed") return "failed";
      return "awaiting-human";
    case "rework": return "rework-requested";
    case "done": return "done";
    case "blocked": return "pending"; // + set blocked flag
    default: return "pending";
  }
}
```

Runs once per task when `status.phase` is undefined. After that, phase is authoritative.

## Files to Change

| File | Change |
|------|--------|
| `packages/api/src/index.ts` | New `TaskPhase` enum, `BoardColumn` enum, `computeBoardColumn()`, replace old `TaskStatus` shape |
| `packages/api/codegen/` | Regenerate CRD YAML |
| `k8s/crds/` | Updated Task CRD |
| `packages/manager-controller/src/reconciler.ts` | Drive logic from `status.phase`, backfill on first reconcile (see plan 04) |
| `packages/operator/src/reconciler.ts` | No change (operates on Run CRs) |
| `packages/web/` | Import `computeBoardColumn()`, render board from phase |
| `packages/cli/` | Import `computeBoardColumn()` for display |
