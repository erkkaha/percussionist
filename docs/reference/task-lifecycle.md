# Task Lifecycle

Tasks in Percussionist follow a defined state machine with 16 phases.

## Phases

| Phase | Board Column | Description |
|-------|-------------|-------------|
| `idea` | ideas | Parking lot, not actionable |
| `pending` | backlog | Well-defined, waiting for scheduling |
| `scheduled` | in-progress | Scheduler picked it, run being created |
| `initializing` | in-progress | Pod starting, git checkout in progress |
| `running` | in-progress | Agent actively working |
| `waiting-for-input` | review | Agent asked a question (parked for human input) |
| `succeeded` | review | Run completed successfully |
| `reviewing` | review | AI reviewer evaluating |
| `awaiting-human` | review | Needs human decision |
| `awaiting-merge` | in-progress | Merge run in progress |
| `rework-requested` | in-progress | Human gave feedback, waiting for scheduling slot |
| `generating-builds` | in-progress | PLAN-only: buildgen facilitator splitting into tasks |
| `awaiting-children` | blocked | Waiting for all child tasks to complete |
| `awaiting-feature-merge` | in-progress | Feature branch merge run in progress |
| `done` | done | Complete |
| `failed` | review | Run failed, needs human decision |

## Transitions

| From | To |
|------|-----|
| `idea` | `pending` |
| `pending` | `scheduled` |
| `scheduled` | `initializing`, `failed` |
| `initializing` | `running`, `succeeded`, `failed` |
| `running` | `waiting-for-input`, `succeeded`, `failed` |
| `waiting-for-input` | `running`, `succeeded`, `failed`, `done`, `rework-requested` |
| `succeeded` | `reviewing`, `awaiting-human`, `done` |
| `reviewing` | `awaiting-human`, `rework-requested` |
| `awaiting-human` | `awaiting-merge`, `generating-builds`, `awaiting-feature-merge`, `rework-requested`, `done`, `failed` |
| `awaiting-merge` | `done`, `awaiting-human`, `failed` |
| `rework-requested` | `scheduled` |
| `generating-builds` | `awaiting-children`, `awaiting-human`, `failed` |
| `awaiting-children` | `awaiting-feature-merge`, `awaiting-human`, `done`, `failed` |
| `awaiting-feature-merge` | `awaiting-children`, `done`, `awaiting-human`, `failed` |
| `failed` | `pending`, `awaiting-human`, `awaiting-merge`, `awaiting-feature-merge` |
| `done` | — |

`done` is a terminal phase with no outgoing transitions.

## Flow Presets

Projects configure their task lifecycle via `spec.flow.preset`:

| Preset | Behavior |
|--------|----------|
| `simple` | Minimal: pending → scheduled → running → succeeded → done |
| `review` | Adds a human review step between succeeded and done — no AI review |
| `plan-build` | PLAN creates BUILD tasks; no AI review |
| `plan-build-review-merge` | Full pipeline with review + merge (default) |

## PLAN vs BUILD

PLAN and BUILD tasks follow the same state machine but differ in terminal paths:

- **PLAN**: On approval, enters `generating-builds` → creates BUILD tasks, then `awaiting-children`
- **BUILD**: On approval, enters `awaiting-merge` → automated merge run, then `done`

## Capability-Gated Assignment and Completion

Percussionist enforces a strict capability model for both assignment and completion tools.

- Agent assignment to PLAN/BUILD tasks is validated against `ClusterAgent.spec.capabilities`.
- BUILD assignment requires `task.build.execute`; PLAN assignment requires `task.plan.execute`.
- Missing capabilities are hard failures (fail-closed), not warnings.

Completion tools are also run-context gated:

- PLAN worker runs can only use `complete_plan` (`run.complete.plan` required)
- BUILD/merge/buildgen/failure runs can only use `complete_run` (`run.complete.build` required)
- Review facilitator runs can only use `complete_review` (`run.complete.review` required)

The dispatcher enforces this in both MCP tool discovery (`tools/list`) and execution (`tools/call`).
Cross-context completion calls are rejected with deterministic `-32602` errors.

### Rollout preflight for custom agents

If you run custom `ClusterAgent` resources, add capabilities before enabling/deploying strict enforcement.
Otherwise task creation and run overrides may be rejected. Error messages name the missing capability
to make remediation explicit.

## Feature Branching States

When `featureBranchingEnabled: true`, additional states manage the merge workflow:

- `awaiting-feature-merge` replaces `awaiting-merge` for feature branch merges
- On completion, transitions to `done` (success) or `awaiting-human` (requires intervention)
- In `pr` integration mode the task does not merge directly. A PR-open run opens a
  GitHub PR and the manager polls it: merged → `done`; closed without merging →
  `awaiting-human`; new human PR comments spawn a PR-feedback evaluation run.

### Request Changes in the PR stage

When a PLAN task is parked in `awaiting-feature-merge` with an open PR
(`worker.prNumber` set and no `worker.mergeRunName`), the **Request Changes** action is
available from the board detail panel and from
`beatctl board task request-changes --task-name <plan> --feedback <text>`. It writes
`percussionist.dev/action-request-changes` +
`percussionist.dev/action-rework-feedback` on the Task.

On the next reconcile cycle the manager creates exactly one follow-up BUILD child
(`spec.parentTaskRef` pointing at the PLAN, agent `flow.build.defaultAgent`, the human
feedback in `spec.description`), appends it to `worker.createdBuildTaskRefs`, clears the
annotations, and moves the PLAN to `awaiting-children`. Once that child merges into the
PLAN's feature branch, the PR-open run is re-scheduled in update mode and pushes the
revised head to the *same* PR. This is the Percussionist-native alternative to leaving
review comments on the GitHub PR; both paths feed the same follow-up-child mechanism.

The action is rejected for tasks that cannot consume it, e.g. `done`, `running`, or
`awaiting-feature-merge` without an open PR (`worker.prNumber` unset). Merge still
happens on GitHub — a PR-stage task cannot be approved from Percussionist.

## Troubleshooting Phase Ambiguity

If you are unsure what a task's current phase means or which transition is appropriate, call the manager MCP tool `inspect_task_flow` before using `set_task_state` or `force_retry`. It returns the current phase, all legal target phases, the project's resolved flow, worker status context, and a flow-aware prediction of the expected next step. This is especially useful for high-risk phases such as `awaiting-human`, `reviewing`, `awaiting-merge`, `awaiting-feature-merge`, `awaiting-children`, and `failed`, where the correct action depends on task type (PLAN vs BUILD) and project flow configuration.

See [`inspect_task_flow`](mcp-tools.md#inspect_task_flow) for inputs, outputs, and an example response.

## Backward Compatibility

A legacy `column` field used to map phases to board columns. It has been removed
from the Task schema entirely and is never written — columns are derived from each
task's phase, and all state is driven by the phase enum.
