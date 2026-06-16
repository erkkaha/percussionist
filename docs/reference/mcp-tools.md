# MCP Tools

Percussionist exposes two sets of MCP (Model Context Protocol) tools: Manager tools for orchestration, and Dispatcher tools for in-run agent actions.

## Manager MCP Tools

The manager runs an in-process MCP server on port 4097. OpenCode agents connect to it at `http://127.0.0.1:4097/mcp`.

### Orchestration

| Tool | Description |
|------|-------------|
| `inspect_cr` | Get full details of a CR (Run, Project, Task, ClusterAgent) |
| `list_crs` | List CRs of a given kind with optional labelSelector |
| `create_run` | Create a new run for a ready task |
| `create_task` | Create a new Task CR |
| `delete_run` | Delete a Run by name |
| `force_retry` | Restart a stuck task at an incremented retry count |
| `set_task_state` | Move a task to a target column |
| `manager_approve` | Approve a BUILD task in `awaiting-human` for merge by writing the canonical approval annotation |
| `inspect_task_flow` | Explain current task lifecycle state, allowed transitions, and expected next action |

### `inspect_task_flow`

Explain the current lifecycle state of a task in the context of its project flow. Returns the task's current phase, valid transitions, fully resolved flow configuration, worker status context, manual action flags, and a natural-language "expected next" block. Use this before calling `set_task_state`, `force_retry`, or other lifecycle-changing tools when you are unsure what a phase means or where the task will go next.

**Inputs**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | yes | Project name |
| `task` | string | yes | Task CR name (e.g. `BUILD-4`) |
| `namespace` | string | no | Namespace (defaults to `percussionist`) |
| `verbose` | boolean | no | Include observed run details (worker, review, merge, buildgen) in the response |

**Outputs**

| Field | Description |
|-------|-------------|
| `project` | Project name |
| `task` | Task CR name |
| `taskType` | `PLAN` or `BUILD` |
| `currentPhase` | Current `Task.status.phase` |
| `validTargetPhases` | Array of phases that are legal transitions from `currentPhase` |
| `resolvedFlow` | Full resolved flow object for the project (preset, review, merge, integration, retry, timeouts) |
| `statusSummary.worker` | Worker status fields: `runName`, `reviewRunName`, `mergeRunName`, `buildTasksFacilitatorRun`, `reviewApproved`, `reviewFeedback`, `mergeError`, `mergedAt`, `retryCount`, `aiReworkCount` |
| `statusSummary.manualActionFlagsPresent` | Action annotations currently set on the task (`approved`, `requestChanges`, `reworkFeedback`, `abandon`, `answer`) |
| `statusSummary.blocked` / `blockedReason` / `retryAfter` | Scheduling freeze and backoff metadata |
| `expectedNext.primary` | Short human-readable prediction of the next step |
| `expectedNext.reason` | Why that prediction was made |
| `expectedNext.blockingConditions` | Conditions preventing progress |
| `expectedNext.suggestedActions` | Concrete actions to consider |

**Example response**

```json
{
  "project": "percussionist-dev",
  "task": "BUILD-4",
  "taskType": "BUILD",
  "currentPhase": "awaiting-human",
  "validTargetPhases": [
    "awaiting-merge",
    "generating-builds",
    "awaiting-feature-merge",
    "rework-requested",
    "done",
    "failed"
  ],
  "resolvedFlow": {
    "preset": "plan-build-review-merge",
    "build": { "onApprove": "merge" },
    "merge": { "mode": "auto" },
    "plan": { "onApprove": "generate-builds" },
    "integration": { "mode": "auto-merge" },
    "review": { "aiReviewerEnabled": true, "maxAutoReworks": 2 },
    "retry": { "enabled": true, "maxAttempts": 3 },
    "timeouts": { "runningStaleSeconds": 1800, "reviewStaleSeconds": 600, "mergeStaleSeconds": 600, "buildgenStaleSeconds": 600 }
  },
  "statusSummary": {
    "worker": {
      "runName": "percussionist-dev-worker-BUILD-4-0-abc123",
      "reviewApproved": true,
      "mergeRunName": null,
      "retryCount": 0,
      "aiReworkCount": 0
    },
    "manualActionFlagsPresent": ["approved"],
    "blocked": false,
    "retryAfter": null
  },
  "expectedNext": {
    "primary": "Build will move to awaiting-merge",
    "reason": "BUILD task + approval annotation is set + build.onApprove=merge",
    "blockingConditions": [],
    "suggestedActions": [
      "Remove action-approved annotation to cancel",
      "If changes are needed, set action-request-changes + action-rework-feedback"
    ]
  }
}
```

### Session

| Tool | Description |
|------|-------------|
| `read_session` | Read session messages from a completed run's ConfigMap snapshot |
| `read_session_live` | Incremental session messages with polling support |
| `read_logs` | Read pod logs for a run |
| `read_manager_logs` | Read logs from the manager controller pod |

### Plans

| Tool | Description |
|------|-------------|
| `read_plan` | Read a plan artifact from the project's plans ConfigMap |
| `write_plan` | Write a plan artifact to the project's plans ConfigMap |

### Board

| Tool | Description |
|------|-------------|
| `patch_board` | Merge-patch `Project.status.board` |
| `pause_reconciliation` | Pause the manager reconcile loop |
| `resume_reconciliation` | Resume a paused reconcile loop |
| `get_reconcile_status` | Check reconcile loop state |

### Memory

| Tool | Description |
|------|-------------|
| `store_memory` | Store a memory with semantic embedding |
| `query_memory` | Semantic search across stored memories |
| `get_context` | Retrieve relevant context for prompt injection |

### Administration

| Tool | Description |
|------|-------------|
| `exec_in_workspace` | Run commands in the project's data PVC workspace |
| `list_available_packages` | List Alpine packages declared for a project |
| `install_packages` | Install ad-hoc Alpine packages |
| `check_for_updates` | Check the latest Percussionist release version |
| `apply_upgrade` | Upgrade Percussionist deployments |
| `list_models` | List available LLM providers and models |
| `list_task_events` | List task lifecycle audit events |

## Dispatcher MCP Tools

The dispatcher sidecar runs an in-process MCP server on port 4097 within each run pod.

| Tool | Description |
|------|-------------|
| `complete_run` | Signal successful BUILD task completion |
| `complete_plan` | Signal successful PLAN task completion |
| `fail_run` | Signal task failure with reason |
| `get_status` | Return current run state (phase, session ID, token usage) |
| `create_task` | Create a new BUILD Task CR |
| `search_code` | Search the workspace with ripgrep/grep |
| `write_plan` | Persist a plan artifact |
| `read_plan` | Read a plan artifact |
| `read_session` | Read session messages from another run's ConfigMap snapshot |
| `report_finding` | Report an off-task issue (bug, security, performance, debt) for manager triage |

### `report_finding`

Report an off-task issue discovered while working — a bug, security problem, performance trap, or tech debt that is **outside** the agent's assigned task. The manager triages it, de-duplicates against existing findings, and may auto-create a Task CR.

**Inputs**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | yes | One-line summary (≤256 chars) |
| `description` | string | yes | What is wrong, why it matters, suggested fix |
| `severity` | string | yes | One of: `low`, `medium`, `high`, `critical` |
| `category` | string | yes | One of: `bug`, `security`, `performance`, `debt`, `docs`, `other` |
| `filePath` | string | no | Repo-relative path of the issue |
| `snippet` | string | no | Short code excerpt (≤2048 chars) |

**Returns** `{ id, status: "accepted" }` synchronously. Deduplication and triage happen asynchronously on the next manager reconcile cycle (within ≤60s).

## Capability Enforcement (Strict, Fail-Closed)

All agent/task/tool authorization is enforced by explicit `ClusterAgent.spec.capabilities`.
Missing capability means denied — there is no legacy permissive fallback.

### Capability matrix

| Agent role | Required task capability | Required completion capability |
|---|---|---|
| planner | `task.plan.execute` | `run.complete.plan` |
| builder | `task.build.execute` | `run.complete.build` |
| reviewer | `task.review.evaluate` | `run.complete.review` |
| failure-analyst | `task.failure.analyze` | `run.complete.build` |
| buildgen | `task.build.generate` | `run.complete.build` |
| integrator | `task.merge.execute` | `run.complete.build` |

### Run-context completion-tool mapping

The dispatcher gates completion tools in both `tools/list` and `tools/call`:

| Run context | Advertised completion tool | Capability required |
|---|---|---|
| PLAN worker | `complete_plan` | `run.complete.plan` |
| BUILD worker / merge / buildgen / failure | `complete_run` | `run.complete.build` |
| Review facilitator | `complete_review` | `run.complete.review` |

Disallowed completion calls are rejected with deterministic JSON-RPC `-32602` errors.

### Assignment validation entry points

Task/run assignment capability checks are enforced consistently in:

- Manager MCP: `create_task`, `create_run` (agent override), `force_retry` (agent override)
- Dispatcher MCP: `create_task` (BUILD task creation from worker runs)
- Web board API: `POST /api/projects/:project/board/tasks`

If assignment is invalid, the error message explicitly names the missing capability.

## Rollout Notes

Before deploying strict enforcement to an existing cluster:

1. Preflight all custom `ClusterAgent` resources and ensure required capabilities are set.
2. Update custom agents before (or in the same deployment as) manager/dispatcher/web upgrades.
3. Confirm errors mention the exact missing capability (for example: `task.build.execute`).

This prevents broken task creation/run overrides after upgrade.
