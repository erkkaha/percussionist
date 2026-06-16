# Dashboard

The Percussionist web dashboard provides observability and control over your agents, projects, and cluster.

## Project Board

The kanban board shows the task lifecycle — from idea to done. Tasks flow through configurable columns (Ideas, Backlog, Blocked, In-Progress, Review, Done) with phase-coded color badges. Each task card displays its type (PLAN/BUILD), priority, assigned agent, and current status. Filter by type, priority, or column, or use search to find specific tasks. Click any task to open its detail panel with Overview, Runs, Events, Plan, and Diff views.

![Project board with task detail and manager chat panel](/images/board.png)

## Manager Chat

A chat panel connects you directly to the manager agent — the same agent that orchestrates your project board. Ask about task status, request changes, or inspect runs without leaving the dashboard. The manager agent can also use its [MCP tools](/reference/mcp-tools) to act on your behalf.

![Manager agent chat panel](/images/chat.png)

## Stats & Analytics

Session analytics, tool usage metrics, and cost breakdowns help you understand agent behavior across runs. Track tokens in/out per session, tool invocation counts, estimated cost per agent, and success/failure rates. Filter by time range (last 7/30/90 days) or drill down by agent name. The tool metrics table ranks which tools agents use most frequently and their estimated token cost.

![Stats dashboard showing session and tool analytics](/images/stats.png)

## Findings

The findings panel shows agent-reported off-task issues — bugs, security problems, performance traps, and tech debt — surfaced via the `report_finding` MCP tool. Each finding displays severity (color-coded), category, title, source task/run, file path, status, and occurrence count. Expand a finding to see the full description and code snippet. Action buttons allow creating a Task from a finding, dismissing it, or marking it as a duplicate. The findings data comes from `board.status.findings[]` and the `{project}-findings` ConfigMap.

## Cluster Metrics

Real-time pod CPU and memory usage across the Percussionist cluster. Monitor resource consumption per pod (operator, manager, runner, memory service, Ollama), track aggregate utilization trends, and identify resource pressure before it impacts agent runs. Metrics auto-refresh and support configurable time windows.

![Cluster metrics showing pod CPU and memory usage](/images/metrics.png)

## Run Detail

Every run shows its phase, session history, logs, and exit status in a single-page view. The header displays the run name, phase badge, timing, and links to the web UI and git source. Below, session messages replay the agent conversation with tool calls and responses. Logs from the pod containers are available alongside the session view.

![Individual run detail with phase, session, and logs](/images/run-detail.png)
