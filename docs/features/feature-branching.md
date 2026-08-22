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
- BUILD branch is cleaned up (worktree removed, mirror ref deleted) once the task reaches `done`; in `auto-merge` mode BUILD branches are never pushed to the remote at all — only the merge result lands there
- Next BUILD in sequence sees predecessor's changes

### 4. Predecessor Dependencies

- BUILD tasks with `predecessorRef` wait for predecessor to merge
- Reconciler blocks task from starting until predecessor is in `done` column AND has `mergedAt` timestamp

### 5. Feature Branch Merge

When all BUILD tasks under a PLAN are done, the PLAN's `feature/{plan-id}` branch
contains all merged BUILD changes. The `flow.integration.mode` setting controls
how it lands on the target branch (`project.spec.source.git.ref ?? "main"` by default):

```yaml
spec:
  featureBranchingEnabled: true
  flow:
    integration:
      mode: auto-merge   # auto-merge (default) | pr | manual | disabled
```

| Mode | Behavior |
|------|----------|
| `auto-merge` (default) | A merge run merges the feature branch directly to the target branch. No human in the loop. |
| `pr` | A short-lived run opens a GitHub PR from the feature branch to the target. The manager polls the PR state (15-minute cache interval) and auto-transitions the task to `done` when the PR is merged. If the PR is closed without merging, the task goes to `awaiting-human`. Requires `source.git.githubTokenSecret` to be configured so the manager can read the PR state via the GitHub API. Detection latency is up to 15 minutes after merge. |
| `manual` | The task parks in `awaiting-human`; a human merges the feature branch to the target entirely outside the system, then marks the task done in Percussionist. |
| `disabled` | No integration merge; the task goes to `done` once all BUILD children are done. |

Branch retention depends on the mode: branches pushed to the remote (e.g. the
feature branch in `pr` mode) are kept indefinitely, while in `auto-merge`/`manual`
mode the feature-branch ref lives only in the local bare mirror and is deleted
from it when the task reaches `done`. The merged result on the target branch is
unaffected either way.

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
