# Feature Branch Workflow

Projects can enable isolated feature branch development with `featureBranchingEnabled: true`. This creates per-task feature branches that prevent worktree conflicts and enable incremental feature development.

## Branch Structure

When enabled, tasks work on dedicated feature branches instead of `main`:

| Task Type | Branch |
|-----------|--------|
| PLAN | `feature/{plan-task-id}` |
| BUILD (with parent PLAN) | `feature/{plan-task-id}--{build-task-id}` |
| Standalone BUILD | `feature/{build-task-id}` |

Each run gets its own worktree at `/data/worktrees/{run-name}/` checking out the task's branch.

## Workflow

### 1. PLAN Task Creation

- Task assigned branch `feature/plan-abc`
- First run creates branch from `main`
- Planner produces `.percussionist/plans/{plan-task-id}.md`
- Subsequent runs (retries) continue on same branch
- PLAN branch persists after completion

### 2. BUILD Task Generation

- When PLAN is approved, BUILD tasks are created
- Build generator reads the plan artifact first
- Each BUILD branches from parent: `feature/plan-abc--build-123`

### 3. BUILD Review & Merge

- Agent works on BUILD branch, commits and pushes
- On approval, merge run merges BUILD branch → parent PLAN branch
- BUILD branch deleted after successful merge
- Next BUILD in sequence sees predecessor's changes

### 4. Predecessor Dependencies

- BUILD tasks with `predecessorRef` wait for predecessor to merge
- Reconciler blocks task from starting until predecessor is in `done` column AND has `mergedAt` timestamp

## Enable

```yaml
spec:
  featureBranchingEnabled: true
```

## Backward Compatibility

- Default: `false` (work on `main`)
- Existing tasks continue on `main` when flag is enabled
- Only new tasks use feature branches
- Projects can migrate gradually
