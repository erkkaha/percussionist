# Board Task Lifetime

## Actors

| Actor | Role |
|---|---|
| **Human** | Creates PLAN tasks; approves, requests changes, or abandons in review |
| **Manager** | Single-threaded reconcile loop; the only thing that drives phase transitions |
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
Manager creates the worker Run CR. The run name is a deterministic SHA-256 hash of `project:task:retryCount` — same inputs always produce the same name, so a double-reconcile never creates a duplicate. If feature branching is on, the run's `source.git.ref` is overridden with the task's feature branch. Patches `worker.runName`, `worker.status = "Running"`, `worker.startedAt`. Transitions to `initializing`.

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
- Running but no events for 5+ minutes → `failed` (staleness guard)

The agent is working during this phase. It calls `complete_run` or `complete_plan` on the dispatcher when done. The dispatcher validates the git workflow (for BUILD: checks that a commit, push, and `gh pr create` happened; for PLAN: just commit + push), then exits 0. The pod reaches Succeeded, the operator mirrors it, and the manager picks it up on the next reconcile.

### `waiting-for-input` *(PLAN only)*
Manager polls for an answer annotation (`percussionist.dev/answer-{taskName}`) on the Project CR. When a human posts an answer via the web UI, the dispatcher injects it into the live session. Once the run resumes to `Running` the task goes back to `running`. The annotation is cleared.

### `succeeded`
Manager decides whether to run AI review:
- AI review disabled (default) → straight to `awaiting-human`
- AI review enabled → creates a success-review facilitator Run → `reviewing`

### `reviewing`
Manager waits for the reviewer run. The reviewer agent reads the session snapshot and outputs JSON with a `recommendedAction`:
- `approve` → `awaiting-human` (with `worker.reviewApproved = true`)
- `request_changes` and under `maxAutoReworks` ceiling → auto-rework to `rework-requested` (fully automated loop)
- `request_changes` at ceiling, or any other action → `awaiting-human`

If the review run fails or goes stale (5 min no events) → `awaiting-human` as fallback.

### `awaiting-human`
The task sits in the Review column waiting for a human annotation on the Project CR, set by the web UI:

| Annotation | BUILD path | PLAN path |
|---|---|---|
| `approved-{taskName}` | → `awaiting-merge` (creates merge run) | → `generating-builds` |
| `request-changes-{taskName}` | → `rework-requested` (stores feedback) | same |
| `abandon-{taskName}` | → `done` | same |

### `awaiting-merge` *(BUILD only)*
Manager creates a merge facilitator Run whose agent merges the BUILD's feature branch (`feature/{plan}--{build}`) into the parent PLAN branch (`feature/{plan}`). When the merge run succeeds → `done` and `worker.mergedAt` is recorded. This timestamp is what unlocks successor BUILD tasks in `canSchedule`. If the merge run fails or goes stale → `failed`.

### `generating-builds` *(PLAN only)*
Manager spawns a buildgen facilitator Run. The buildgen agent reads the plan session context and outputs a JSON array of `{title, description, agent, priority, predecessorIndex}` objects — nothing else, no code, no file writes. The manager parses this, validates it, and creates the BUILD Task CRs (each with `spec.parentTaskRef` + `spec.predecessorRef` for serial chaining). PLAN task transitions to `done`.

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
| Completion signal | `complete_plan` (commit + push, no PR needed) | `complete_run` (commit + push + `gh pr create`) |
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
| Worker | `scheduled` | SHA-256 of `project:task:retryCount` |
| Review | `succeeded` | `{project}-review-{task}-{retryCount+aiReworkCount}` |
| Merge | `awaiting-human` (BUILD approval) | `{project}-merge-{task}-{retryCount}` |
| Buildgen | `generating-builds` | `{project}-buildgen-{task}-0` |

Old Runs are never deleted by state transitions — they persist as history until the TTL controller removes them after `runTTLDays` days (default 7).
