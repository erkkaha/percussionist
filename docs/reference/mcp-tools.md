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

::: tip PLAN vs BUILD
- PLAN agents call `complete_plan` after committing their plan to `.percussionist/plans/{task-id}.md`
- BUILD agents call `complete_run` after implementation is committed
:::
