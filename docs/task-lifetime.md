# Board Task Lifetime

## Actors

| Actor | Role |
|---|---|
| **Human** | Creates PLAN tasks; approves, requests changes, or abandons in review |
| **Manager** | Single-threaded reconcile loop; the primary driver of phase transitions. MCP tools (`set_task_state`, `force_retry`, `create_run`) can also transition tasks as administrative actions, with validity checks against the transition table. |
| **Operator** | Watches Run CRs; provisions Pod + Service + PVC + ConfigMap; mirrors pod phase into Run status |
| **Dispatcher** | Sidecar inside every run pod; starts the agent session, exposes MCP tools to the agent, signals success/failure via exit code |
| **Agent (opencode)** | The LLM worker; calls `complete_run`/`complete_plan`/`fail_run` on the dispatcher |
| **Facilitator agents** | Separate agent runs spawned by the manager for AI review, BUILD-task generation, and branch merging |
| **TTL controller** | Inside the operator; cleans up expired Run CRs hourly |

---

## Columns vs. Phases

The board shows simplified columns. The real state machine uses 14 phases stored in `Task.status.phase`:

| Board column | Phases underneath |
|---|---|
| **ideas** | `idea` |
| **backlog** | `pending` |
| **in-progress** | `scheduled`, `initializing`, `running`, `waiting-for-input`, `awaiting-merge`, `generating-builds`, `rework-requested` |
| **review** | `succeeded`, `reviewing`, `awaiting-human`, `failed` |
| **done** | `done` |

`status.blocked: true` is orthogonal — it freezes the task regardless of phase.

---

## Phase-by-Phase Walk-through

### `idea`
Parking lot. The manager ignores it entirely. A human moves it to `pending` when ready to work on it.

### `pending`
The manager checks three gates on every reconcile cycle:
- WIP limit: active task count must be below `maxParallel` (default 2)
- Predecessor: if `spec.predecessorRef` is set, the referenced BUILD task must be `done` and (when feature branching is on) must have `worker.mergedAt` set
- Retry backoff: `status.retryAfter` must be in the past

All three pass → `scheduled`.

### `scheduled`
Manager's pure decision engine emits a `ScheduleRun` effect. The effect executor
resolves it by building a Run CR via `buildWorkerRun()` with a deterministic
run name (via `workerRunName(project, task, retryCount)`) and creating it in
Kubernetes. If feature branching is on, the run's `source.git.ref` is overridden
with the task's feature branch. Patches `worker.runName`, `worker.status = "Running"`,
`worker.startedAt`. Transitions to `initializing`.

### `initializing`
Manager waits for the operator. In parallel the operator:
1. Creates the data PVC (`{project}-data`, ReadWriteMany) if it doesn't exist
2. Creates a ClusterIP Service
3. Creates an agents ConfigMap with all ClusterAgent `.md` contents
4. Creates the Pod — init container (`workspace-init`) runs first, doing git mirror fetch + worktree setup, then the `opencode` runner and `dispatcher` sidecar start

When the pod enters Running → operator sets `Run.status.phase = Running` → manager transitions to `running`.

### `running`
Manager polls `Run.status.phase`:
- `Succeeded` → `succeeded`
- `Failed` → `failed`
- `WaitingForInput` → `waiting-for-input` (PLAN only; BUILD tasks go straight to `failed`)
- Running but no events beyond `flow.timeouts.runningStaleSeconds` (default 1800s/30min) → `failed` (staleness guard)

When the run completes (`Succeeded` or `Failed`), if `project.spec.embedding.enabled`
is true, the manager fires a fire-and-forget `SummarizeSession` effect that uses the
LLM to produce a 2-3 paragraph summary of the session and stores it in the
`{runName}-session` ConfigMap (`summary-{sessionID}`) and the project's vector
memory database.

The agent is working during this phase. It calls `complete_run` or `complete_plan` on the dispatcher when done. The dispatcher records the signal and exits 0. The pod reaches Succeeded, the operator mirrors it, and the manager picks it up on the next reconcile.

### `waiting-for-input` *(PLAN only)*
Manager polls for an answer annotation (`percussionist.dev/action-answer`) on the Task CR (with legacy fallback to Project CR annotations). When a human posts an answer via the web UI, the dispatcher injects it into the live session. Once the run resumes to `Running` the task goes back to `running`. The annotation is cleared.

### `succeeded`
Manager's decision engine checks flow configuration:
- `flow.build.onSuccess === "done"` (simple preset) → straight to `done`
- AI review disabled (`flow.review.aiReviewerEnabled === false` default) → `awaiting-human`
- AI review enabled → emits `ScheduleReviewRun` effect; executor builds the review Run
  via `buildReviewRun()` (no session data — the review agent reads context itself via
  MCP `read_session_live`). Transitions to `reviewing`.

### `reviewing`
Manager waits for the reviewer run. The reviewer agent reads the preceding worker
session via MCP `read_session_live` and writes a structured verdict annotation
(`percussionist.dev/review-verdict`) on the review Run CR before exiting.
The decision engine reads the annotation:
- `{"action":"approve"}` → `awaiting-human` (with `worker.reviewApproved = true`)
- `{"action":"request_changes","feedback":"..."}` and under `flow.review.maxAutoReworks`
  ceiling → auto-rework to `rework-requested`
- `request_changes` at ceiling → `awaiting-human`
- No verdict annotation → `awaiting-human` (fallback)
- Stale beyond `flow.timeouts.reviewStaleSeconds` (default 600s/10min) → `awaiting-human`

### `awaiting-human`
The task waits for a human action written as Task annotations by the web UI.
The decision engine reads Task annotations first, falling back to legacy
Project annotations for migration compatibility:

| Action | Task annotation | BUILD path | PLAN path |
|---|---|---|---|
| **Approve** | `percussionist.dev/action-approved` | → `awaiting-merge` (creates merge run) | → `generating-builds` |
| **Request changes** | `percussionist.dev/action-request-changes` + `percussionist.dev/action-rework-feedback` | → `rework-requested` (stores feedback) | same |
| **Abandon** | `percussionist.dev/action-abandon` | → `done` | same |

### `awaiting-merge` *(BUILD only)*
Manager creates a merge facilitator Run whose agent merges the BUILD's feature branch (`feature/{plan}--{build}`) into the parent PLAN branch (`feature/{plan}`). When the merge run succeeds → `done` and `worker.mergedAt` is recorded. This timestamp is what unlocks successor BUILD tasks in `canSchedule`. If the merge run fails or goes stale → `failed`.

### `generating-builds` *(PLAN only)*
Manager spawns a buildgen facilitator Run. The buildgen agent reads
`.percussionist/plans/{plan-task-id}.md` from the git worktree and creates BUILD
Task CRs directly via MCP tools (each with `spec.parentTaskRef` +
`spec.predecessorRef` for serial chaining). When `spec.embedding.enabled` is true,
the buildgen agent's prompt includes a `PLAN SESSION CONTEXT:` section populated
from the stored session summary of the preceding PLAN worker run (read from the
`{runName}-session` ConfigMap via `readStoredSessionSummary()`). The manager's
decision engine watches for child Tasks with `parentTaskRef === taskName` to
appear. When all child Tasks exist → PLAN task transitions to `done`.

### `rework-requested`
Waits for a scheduling slot (same `canSchedule` check as `pending`). When available → `scheduled`. The next run gets the stored `worker.reviewFeedback` injected into its prompt as rework context.

### `failed`
With auto-retry disabled (default): stays here until a human uses `force_retry` or `set_task_state`. With auto-retry enabled: the manager checks a poison-pill threshold (run died in < 30s → don't retry), checks the attempt ceiling, then sets `worker.retryCount + 1`, sets `status.retryAfter` (exponential backoff), and transitions back to `pending`.

### `done`
Terminal. Manager never touches it again. Task CR persists until the parent Project is deleted.

---

## PLAN vs BUILD — Key Differences

| | PLAN | BUILD |
|---|---|---|
| Created by | Human | Manager (buildgen) or human |
| Can enter `waiting-for-input` | Yes | No — goes to `failed` |
| Completion signal | `complete_plan` (plan artifact committed) | `complete_run` (work committed) |
| On human approval | → `generating-builds` | → `awaiting-merge` |
| Feature branch | `feature/{plan-id}` (from main) | `feature/{plan-id}--{build-id}` (from PLAN branch) |
| Merge target | None (manual to main) | Parent PLAN branch |
| `mergedAt` timestamp | Never | Set on `done`; required to unlock successor BUILDs |

---

## Feature Branching

When `Project.spec.featureBranchingEnabled: true`, every task gets its own branch. The workspace-init init container creates it from `parentRef` if it doesn't exist yet. A worktree is placed at `/data/worktrees/{run-name}/`. Retries reuse the branch — the agent picks up where it left off. When a BUILD task is approved, a merge run merges its branch into the parent PLAN branch, deletes the BUILD branch, and sets `worker.mergedAt`. The next BUILD in sequence only starts after `mergedAt` is set, so each BUILD sees its predecessor's committed code.

---

## Run Relationships

A task has up to three live Runs at once:

| Run type | Created in phase | Name scheme |
|---|---|---|
| Worker | `scheduled` | `workerRunName(project, task, retryCount)` — deterministic SHA-256 hash |
| Review | `succeeded` | `{project}-review-{task}-{retryCount+aiReworkCount}` (`auxiliaryRunName`) |
| Merge | `awaiting-human` (BUILD approval) | `{project}-merge-{task}-{retryCount}` (`auxiliaryRunName`) |
| Buildgen | `generating-builds` | `{project}-buildgen-{task}-0` (`auxiliaryRunName`) |

Old Runs are never deleted by state transitions — they persist as history until the TTL controller removes them after `runTTLDays` days (default 7).
