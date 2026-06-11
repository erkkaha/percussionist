// agent/tools.ts — MCP server exposing K8s tools to the agent.
//
// Follows the same JSON-RPC 2.0 / MCP Streamable HTTP pattern as the
// dispatcher's mcp-server.ts. Runs on AGENT_MCP_PORT (default 4097).
//
// The opencode-web sidecar discovers these tools via the `mcp` stanza
// in its config (deployed as the agent-config ConfigMap).
// Note: uses `mcp` key (not `mcpServers` — that was a legacy format).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { MCP_PORT, MANAGER_NAMESPACE, OPENCODE_URL } from "./config.js";
import { setHeaderOptions } from "@kubernetes/client-node";
import {
  getRun,
  getProject,
  listRuns,
  readPodLog,
  readSessionConfigMap,
  readAllSessionsFromConfigMap,
  createRun,
  deleteRun,
  fetchSessionMessages,
  fetchAllSessionMessages,
  listClusterAgents,
  listPodsByLabels,
  listTasks,
  getTask,
  patchTaskStatus,
  execInWorkspace,
  writePlanToConfigMap,
  readPlanFromConfigMap,
  getDeploymentImages,
  getDispatcherImageFromOperatorDeployment,
  buildTask,
  createTask,
  apps,
  gitUrlHash,
} from "@percussionist/kube";
import { LABELS, type Project, type Task, type TaskPhase } from "@percussionist/api";
import { storeMemory, queryMemory, getContext } from "./memory-client.js";
import { isValidPackageName, sanitizeCommand, logSecurityEvent } from "./security.js";
import { buildWorkerRun, workerRunName } from "../worker-builder.js";
import { setPaused, getPauseStatus } from "../reconciler-bridge.js";
import { resolveTaskBranch, resolveParentBranch, resolveMergeBranch } from "../branch-resolver.js";
import { isValidTransition, TRANSITION_TABLE } from "../reconciler/transitions.js";
import { resolveFlow } from "../reconciler/flow.js";
import { clearWorkerRunRefs } from "./worker-status.js";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "percussionist-manager-agent";
const SERVER_VERSION = "1.0";

// ---------------------------------------------------------------------------
// Phase-aware agent resolution

function resolvePhaseAgent(
  task: Task,
  project: Project,
  currentPhase: TaskPhase,
): string | undefined {
  if (currentPhase !== "generating-builds") return undefined;

  const flow = resolveFlow(project);
  const agent = flow.plan.buildGenerationAgent;

  const roster = (project.spec.agents ?? []).map((a: { name: string }) => a.name);
  if (!roster.includes(agent)) {
    console.log(
      `[resolvePhaseAgent] ${task.metadata.name}: ` +
      `buildGenerationAgent "${agent}" not in project roster, ` +
      `defaulting to "${task.spec.agent}"`,
    );
    return undefined;
  }

  return agent;
}

// ---------------------------------------------------------------------------
// Tool definitions

const TOOLS = [
  {
    name: "inspect_cr",
    description:
      "Get full details of a Percussionist custom resource. Supports Run, Project, Task, and ClusterAgent kinds.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description: "CR kind: Run, Project, Task, or ClusterAgent",
        },
        name: { type: "string", description: "Resource name" },
        namespace: {
          type: "string",
          description: "Namespace (optional, defaults to percussionist)",
        },
      },
      required: ["kind", "name"],
    },
  },
  {
    name: "list_crs",
    description:
      "List Percussionist custom resources of a given kind. Supports Run, Project, Task, and ClusterAgent. Label selector uses comma-separated k=v pairs (e.g. 'percussionist.dev/project=my-project,percussionist.dev/task-id=BUILD-4'). Note: the correct task label key is 'percussionist.dev/task-id' (not 'task').",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description: "CR kind: Run, Project, Task, or ClusterAgent",
        },
        namespace: {
          type: "string",
          description: "Namespace (optional, defaults to percussionist). Ignored for ClusterAgent.",
        },
        labelSelector: {
          type: "string",
          description: "Label selector filter (comma-separated k=v, e.g. 'percussionist.dev/project=my-project')",
        },
      },
      required: ["kind"],
    },
  },
  {
    name: "read_logs",
    description:
      "Read pod logs for a run. Returns recent log lines from the specified container.",
    inputSchema: {
      type: "object",
      properties: {
        runName: { type: "string", description: "Name of the Run" },
        container: {
          type: "string",
          description:
            "Container name: opencode, dispatcher, workspace-init, or bootstrap (default: opencode)",
        },
        tailLines: {
          type: "number",
          description: "Number of recent lines to fetch (default: 100)",
        },
        namespace: {
          type: "string",
          description: "Namespace (optional, defaults to percussionist)",
        },
      },
      required: ["runName"],
    },
  },
  {
    name: "read_session",
    description:
      "Read session messages from a completed run's ConfigMap snapshot. If sessionID is omitted, returns messages from all sessions. Returns the conversation history.",
    inputSchema: {
      type: "object",
      properties: {
        runName: { type: "string", description: "Name of the Run" },
        sessionID: { type: "string", description: "Session ID (optional; if omitted returns all sessions)" },
      },
      required: ["runName"],
    },
  },
  {
    name: "patch_board",
    description:
      "Modify project board metadata. Uses Kubernetes merge-patch on the status.board subresource. Supports updating activeWorkers, escalations, pendingQuestions, managerMetrics, and lastEventAt. At the top level of 'board', omitted keys are preserved, but nested objects are fully replaced. For atomic task state changes, prefer set_task_state instead.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
        patch: {
          type: "object",
          description:
            "Status board patch. E.g. { activeWorkers: 2, escalations: [...], pendingQuestions: [...] }. Omitted top-level board keys are preserved; nested objects are replaced.",
        },
      },
      required: ["project", "patch"],
    },
  },
  {
    name: "delete_run",
    description:
      "Delete an Run by name. Useful for cleaning up stale/failed runs before recreating them.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Run name to delete" },
        namespace: {
          type: "string",
          description: "Namespace (optional, defaults to percussionist)",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "create_run",
    description:
      "Create a new Run for a task. The task must be in the 'pending' phase. Moves the task to 'running' and creates the run.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
        task: { type: "string", description: "Task CR name (e.g. 'BUILD-4')" },
        agent: {
          type: "string",
          description: "Override the task's default agent",
        },
        model: {
          type: "string",
          description: "Override the default model",
        },
        retryCount: {
          type: "number",
          description: "Retry count (default: inferred from existing worker or 0)",
        },
        reworkFeedback: {
          type: "string",
          description: "Feedback to include in the task prompt",
        },
        namespace: {
          type: "string",
          description: "Namespace (optional, defaults to percussionist)",
        },
      },
      required: ["project", "task"],
    },
  },
  {
    name: "create_task",
    description:
      "Create a new Task CR and add it to a project's board. The task starts in 'pending' phase (backlog column). Validates that the agent is in the project's agent roster.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
        type: { type: "string", enum: ["PLAN", "BUILD"], description: "Task type" },
        title: { type: "string", description: "Short human-readable title" },
        agent: { type: "string", description: "Agent name (must be in project's agent roster)" },
        description: { type: "string", description: "Detailed context and acceptance criteria (optional)" },
        priority: { type: "string", enum: ["high", "medium", "low"], description: "Priority (default: medium)" },
        parentTaskRef: { type: "string", description: "BUILD only: CR name of the parent PLAN task" },
        predecessorRef: { type: "string", description: "BUILD only: CR name of preceding BUILD task" },
        successorRef: { type: "string", description: "BUILD only: CR name of following BUILD task" },
        namespace: { type: "string", description: "Namespace (optional, defaults to percussionist)" },
      },
      required: ["project", "type", "title", "agent"],
    },
  },
  {
    name: "force_retry",
    description:
      "Clean up all terminal-phase runs for a task CR, reset the task state, and create a fresh run. Use when a task is stuck after infrastructure issues. Supports agent/model overrides to retry with a different agent without a multi-step workaround.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
        task: { type: "string", description: "Task CR name (e.g. 'BUILD-4')" },
        createRun: {
          type: "boolean",
          description: "Create a fresh run immediately (default: true)",
        },
        agent: {
          type: "string",
          description: "Override the agent for the new run (e.g. 'meta-reviewer')",
        },
        model: {
          type: "string",
          description: "Override the model for the new run",
        },
        namespace: {
          type: "string",
          description: "Namespace (optional, defaults to percussionist)",
        },
      },
      required: ["project", "task"],
    },
  },
  {
    name: "read_session_live",
    description:
      "Read session messages from a running or completed run in real-time. If sessionID is omitted, returns messages from all sessions on the pod. Returns incremental messages since the given index. Use with 'since' parameter for polling.",
    inputSchema: {
      type: "object",
      properties: {
        runName: { type: "string", description: "Name of the Run" },
        sessionID: {
          type: "string",
          description: "Session ID (optional; if omitted returns all sessions from the pod)",
        },
        since: {
          type: "number",
          description: "Message index to start from (default: 0)",
        },
        namespace: {
          type: "string",
          description: "Namespace (optional, defaults to percussionist)",
        },
      },
      required: ["runName"],
    },
  },
  {
    name: "set_task_state",
    description:
      "Atomically transition a task to a target phase. Cleans up terminal-phase runs (unless preserveRuns is true), optionally cancels running runs, and updates task status in a single operation. This avoids race conditions with the manager's reconciliation loop.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
        task: { type: "string", description: "Task CR name" },
        targetPhase: {
          type: "string",
          enum: ["idea", "pending", "scheduled", "failed", "awaiting-human", "rework-requested", "done"],
          description: "Target phase for the task. Most common: pending (reset to backlog), awaiting-human (needs review), rework-requested (AI/human requested changes), done (complete).",
        },
        cancelRunning: {
          type: "boolean",
          description: "Delete any active (Running/Pending) runs for this task (default: false)",
        },
        preserveRuns: {
          type: "boolean",
          description: "Skip run deletion entirely — only update the task phase. Useful when you need to preserve completed run data (default: false)",
        },
        namespace: {
          type: "string",
          description: "Namespace (optional, defaults to percussionist)",
        },
      },
      required: ["project", "task", "targetPhase"],
    },
  },
  {
    name: "read_manager_logs",
    description:
      "Read logs from the manager controller pod. Useful for debugging reconciliation decisions and seeing what the manager is doing.",
    inputSchema: {
      type: "object",
      properties: {
        tailLines: {
          type: "number",
          description: "Number of recent lines to fetch (default: 100)",
        },
        namespace: {
          type: "string",
          description: "Namespace (optional, defaults to percussionist)",
        },
      },
    },
  },
  {
    name: "pause_reconciliation",
    description:
      "Pause the manager's reconciliation loop for a project. Prevents the manager from overriding your board patches during manual board surgery. Auto-resumes after the specified duration (default: 5 minutes).",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
        durationSeconds: {
          type: "number",
          description: "How long to pause for in seconds (default: 300 = 5 minutes)",
        },
        namespace: {
          type: "string",
          description: "Namespace (optional, defaults to percussionist)",
        },
      },
      required: ["project"],
    },
  },
  {
    name: "resume_reconciliation",
    description:
      "Resume the manager's reconciliation loop after a pause. The manager will pick up any pending changes on the next cycle.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
        namespace: {
          type: "string",
          description: "Namespace (optional, defaults to percussionist)",
        },
      },
      required: ["project"],
    },
  },
  {
    name: "get_reconcile_status",
    description:
      "Check whether the manager's reconciliation loop is paused or active, and when it was last paused.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "exec_in_workspace",
    description:
      "Run a shell command inside a project's data volume by spawning a short-lived maintenance pod. Useful for git mirror cleanup, worktree pruning, disk inspection, or any workspace maintenance. The pod mounts the project's data PVC at the given mountPath (default: /data) and runs the command via /bin/sh -c. Returns stdout and the exit code. The pod is deleted after the command completes.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name (used to find the data PVC: {project}-data)" },
        command: { type: "string", description: "Shell command to run, e.g. 'git -C /data/git-mirrors/abc123 worktree prune && rm -rf /data/worktrees/stale-run'" },
        mountPath: {
          type: "string",
          description: "Mount path for the data PVC inside the pod (default: /data)",
        },
        timeoutSeconds: {
          type: "number",
          description: "Maximum seconds to wait for the pod to complete (default: 120)",
        },
        namespace: {
          type: "string",
          description: "Namespace (optional, defaults to percussionist)",
        },
      },
      required: ["project", "command"],
    },
  },
  {
    name: "read_plan",
    description:
      "Read a plan artifact from the project's plans ConfigMap. Plans are persisted by planner agents via write_plan and referenced by BUILD tasks during implementation. Use this to review plan content before implementing or reviewing BUILD tasks.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
        task: { type: "string", description: "Plan task ID (e.g. 'PLAN-1')" },
        namespace: {
          type: "string",
          description: "Namespace (optional, defaults to percussionist)",
        },
      },
      required: ["project", "task"],
    },
  },
  {
    name: "write_plan",
    description:
      "Persist a plan artifact to the project's plans ConfigMap. Planner agents MUST call this after creating their plan markdown file, so the plan is queryable via read_plan even after worktrees are cleaned up.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
        task: { type: "string", description: "Plan task ID (e.g. 'PLAN-1')" },
        content: { type: "string", description: "Full markdown content of the plan" },
        namespace: {
          type: "string",
          description: "Namespace (optional, defaults to percussionist)",
        },
      },
      required: ["project", "task", "content"],
    },
  },
  {
    name: "check_for_updates",
    description:
      "Check the currently running Percussionist component versions against the latest available release on GHCR. " +
      "Reads image tags from the live deployments (operator, manager, web) and queries the container registry " +
      "to find the newest semver tag. Returns current versions, the latest available tag, and whether an update is available.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "apply_upgrade",
    description:
      "Upgrade Percussionist deployments (operator, manager, web) to a specified target image tag. " +
      "Uses the currently running image registry prefix to construct the new image references and patches " +
      "each deployment in-place (rolling update). Requires 'patch' permission on deployments.",
    inputSchema: {
      type: "object",
      properties: {
        targetTag: {
          type: "string",
          description: "Target image tag to upgrade to (e.g. v0.1.9)",
        },
      },
      required: ["targetTag"],
    },
  },
  {
    name: "list_models",
    description:
      "List available LLM providers and their models from the opencode sidecar. " +
      "Returns all providers, which ones are connected, and current defaults. " +
      "Optionally filter to a single provider by ID.",
    inputSchema: {
      type: "object",
      properties: {
        providerID: {
          type: "string",
          description: "Optional provider ID to filter results (e.g. 'anthropic', 'openai')",
        },
      },
    },
  },
  {
    name: "list_task_events",
    description:
      "List task lifecycle events from the audit log. Events include phase transitions, " +
      "review verdicts, failures, and manual actions. Events are recorded by the reconciler " +
      "and persisted to the web server's SQLite database.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name (required)" },
        task: { type: "string", description: "Optional task CR name to filter events (e.g. 'BUILD-4')" },
        limit: { type: "number", description: "Max events to return (default: 50, max: 500)" },
      },
      required: ["project"],
    },
  },
  {
    name: "store_memory",
    description:
      "Store a memory with semantic embedding for future context retrieval. " +
      "The content is embedded via Ollama and stored in the project's vector database. " +
      "Requires the project to have spec.embedding.enabled.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name (required)" },
        content: { type: "string", description: "Text content to store as memory" },
        metadata: { type: "object", description: "Optional metadata JSON (task, run, etc.)" },
      },
      required: ["project", "content"],
    },
  },
  {
    name: "query_memory",
    description:
      "Semantic search across stored memories. Returns the most relevant memories " +
      "ranked by cosine distance. Requires the project to have spec.embedding.enabled.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name (required)" },
        query: { type: "string", description: "Natural language query text" },
        limit: { type: "number", description: "Max results (default: 10, max: 100)" },
      },
      required: ["project", "query"],
    },
  },
  {
    name: "get_context",
    description:
      "Retrieve relevant context from past runs and memories, formatted for prompt " +
      "injection. Uses semantic search to find the most relevant memories for a given " +
      "query. Requires the project to have spec.embedding.enabled.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name (required)" },
        query: { type: "string", description: "Natural language query for context retrieval" },
        task: { type: "string", description: "Optional task identifier for filtering context" },
      },
      required: ["project", "query"],
    },
  },
  {
    name: "list_available_packages",
    description:
      "List the system packages installed in the runner environment for a project. " +
      "Returns the packages declared in spec.runner.packages on the Project CR.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name (required)" },
      },
      required: ["project"],
    },
  },
  {
    name: "install_packages",
    description:
      "Install additional system packages in the project's runner environment. " +
      "Shells out to the maintenance pod to run apk add. Changes are not persistent " +
      "across pod restarts — add packages to spec.runner.packages for permanence.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name (required)" },
        packages: {
          type: "array",
          items: { type: "string" },
          description: "Package names to install (e.g. [\"ripgrep\", \"jq\"])",
        },
      },
      required: ["project", "packages"],
    },
  },
];

// ---------------------------------------------------------------------------
// JSON-RPC helpers

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

function ok(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

const MAX_BODY_SIZE = 1_048_576; // 1 MB

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on("data", (c: Buffer) => {
      totalSize += c.length;
      if (totalSize > MAX_BODY_SIZE) {
        reject(new Error(`Request body exceeds ${MAX_BODY_SIZE} byte limit`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Tool implementations

const ns = MANAGER_NAMESPACE;

async function listProjectTasks(projectName: string, resourceNs: string): Promise<Task[]> {
  return listTasks(projectName, resourceNs);
}

function workerBranchPatch(project: Project, task: Task, allTasks: Task[]) {
  const gitBranch = resolveTaskBranch(task, project, allTasks);
  const parentBranch = resolveParentBranch(task, project, allTasks);
  const mergeIntoBranch = resolveMergeBranch(task, project, allTasks);
  return {
    branch: gitBranch ?? `feat/${task.metadata.name}`,
    gitBranch,
    parentBranch,
    mergeIntoBranch,
  };
}

async function cleanupRunWorktree(projectName: string, runName: string, resourceNs: string): Promise<void> {
  const project = await getProject(projectName, resourceNs);
  const gitUrl = project.spec.source?.git?.url;
  if (!gitUrl) return;
  const mountPath = project.spec.data?.mountPath ?? "/data";
  const hash = gitUrlHash(gitUrl);
  const quotedRun = runName.replace(/'/g, "'\\''");
  await execInWorkspace(
    projectName,
    `rm -rf '${mountPath}/worktrees/${quotedRun}'; if command -v git >/dev/null 2>&1 && [ -d '${mountPath}/git-mirrors/${hash}' ]; then git -C '${mountPath}/git-mirrors/${hash}' worktree prune --expire=now || true; fi`,
    mountPath,
    120_000,
    resourceNs,
  ).catch(() => { /* best effort */ });
}

async function deleteRunsForTask(
  projectName: string,
  taskName: string,
  resourceNs: string,
  opts: { includeActive?: boolean; includeUnknown?: boolean } = {},
): Promise<string[]> {
  const allRuns = await listRuns(resourceNs);
  const taskRuns = allRuns.filter((r) => {
    const labels = r.metadata.labels ?? {};
    return labels[LABELS.projectName] === projectName && labels[LABELS.taskId] === taskName;
  });
  const deletedNames: string[] = [];
  for (const run of taskRuns) {
    const name = run.metadata.name!;
    const phase = run.status?.phase;
    const terminal = phase === "Succeeded" || phase === "Failed" || phase === "Cancelled";
    const active = phase === "Pending" || phase === "Initializing" || phase === "Running" || phase === "WaitingForInput";
    if (terminal || (opts.includeUnknown && !phase) || (opts.includeActive && active)) {
      await deleteRun(name, resourceNs);
      await cleanupRunWorktree(projectName, name, resourceNs);
      deletedNames.push(name);
    }
  }
  return deletedNames;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "inspect_cr": {
      const kind = String(args.kind ?? "");
      const resourceName = String(args.name ?? "");
      const resourceNs = String(args.namespace ?? ns);
      switch (kind) {
        case "Run": {
          const run = await getRun(resourceName, resourceNs);
          return { kind, name: resourceName, spec: run.spec, status: run.status };
        }
        case "Project": {
          const proj = await getProject(resourceName, resourceNs);
          return { kind, name: resourceName, spec: proj.spec, status: proj.status };
        }
        case "ClusterAgent": {
          const { getClusterAgent } = await import("@percussionist/kube");
          const agent = await getClusterAgent(resourceName);
          return { kind, name: resourceName, spec: agent.spec };
        }
        case "Task": {
          const task = await getTask(resourceName, resourceNs);
          return { kind, name: resourceName, spec: task.spec, status: task.status };
        }
        default:
          throw new Error(`unknown kind: ${kind}`);
      }
    }

    case "list_crs": {
      const kind = String(args.kind ?? "");
      const resourceNs = String(args.namespace ?? ns);
      const labelSelector = String(args.labelSelector ?? "");

      switch (kind) {
        case "Run": {
          const runs = await listRuns(resourceNs);
          let filtered = runs;
          if (labelSelector) {
            filtered = runs.filter((r) => {
              const labels = r.metadata.labels ?? {};
              for (const part of labelSelector.split(",")) {
                const trimmed = part.trim();
                const eqIdx = trimmed.indexOf("=");
                if (eqIdx < 0) continue;
                const k = trimmed.slice(0, eqIdx).trim();
                const v = trimmed.slice(eqIdx + 1).trim();
                if (k && labels[k] !== v) return false;
              }
              return true;
            });
          }
          return filtered.map((r) => ({
            name: r.metadata.name,
            phase: r.status?.phase,
            project: r.spec.project,
            task: r.spec.boardTask,
            startedAt: r.status?.startedAt,
            completedAt: r.status?.completedAt,
            labels: r.metadata.labels,
          }));
        }
        case "Project": {
          const { listProjects } = await import("@percussionist/kube");
          let projects = await listProjects(resourceNs);
          if (labelSelector) {
            projects = projects.filter((p) => {
              const labels = p.metadata.labels ?? {};
              for (const part of labelSelector.split(",")) {
                const trimmed = part.trim();
                const eqIdx = trimmed.indexOf("=");
                if (eqIdx < 0) continue;
                const k = trimmed.slice(0, eqIdx).trim();
                const v = trimmed.slice(eqIdx + 1).trim();
                if (k && labels[k] !== v) return false;
              }
              return true;
            });
          }
          return projects.map((p) => ({
            name: p.metadata.name,
            phase: p.spec.phase,
            maxParallel: p.spec.maxParallel,
            labels: p.metadata.labels,
          }));
        }
        case "ClusterAgent": {
          const agents = await listClusterAgents();
          return agents.map((a) => ({
            name: a.metadata.name,
            contentPreview: a.spec.content.slice(0, 200) + (a.spec.content.length > 200 ? "..." : ""),
            contentLength: a.spec.content.length,
            createdAt: a.metadata.creationTimestamp,
            labels: a.metadata.labels,
          }));
        }
        case "Task": {
          const projectFilter = args.project ? String(args.project) : undefined;
          let tasks = await listTasks(projectFilter, resourceNs);
          if (labelSelector) {
            tasks = tasks.filter((t) => {
              const labels = t.metadata.labels ?? {};
              for (const part of labelSelector.split(",")) {
                const trimmed = part.trim();
                const eqIdx = trimmed.indexOf("=");
                if (eqIdx < 0) continue;
                const k = trimmed.slice(0, eqIdx).trim();
                const v = trimmed.slice(eqIdx + 1).trim();
                if (k && labels[k] !== v) return false;
              }
              return true;
            });
          }
          return tasks.map((t) => ({
            name: t.metadata.name,
            projectRef: t.spec.projectRef,
            type: t.spec.type,
            title: t.spec.title,
            phase: t.status?.phase,
            column: t.status?.column,
            labels: t.metadata.labels,
          }));
        }
        default:
          throw new Error(`unknown kind: ${kind}. Supported: Run, Project, ClusterAgent, Task`);
      }
    }

    case "read_logs": {
      const runName = String(args.runName ?? "");
      const container = String(args.container ?? "opencode");
      const tail = args.tailLines ? Number(args.tailLines) : 100;
      const resourceNs = String(args.namespace ?? ns);
      const logs = await readPodLog(runName, container, tail, resourceNs);
      return { runName, container, tailLines: tail, logs };
    }

    case "read_session": {
      const runName = String(args.runName ?? "");
      const sessionID = args.sessionID ? String(args.sessionID) : undefined;
      const resourceNs = String(args.namespace ?? ns);

      const run = await getRun(runName, resourceNs);
      const serviceName = run.status?.serviceName;
      const runSessionID = sessionID ?? run.status?.sessionID;

      // If sessionID is specified, try to fetch that specific session
      if (runSessionID && serviceName) {
        try {
          const data = await fetchSessionMessages(serviceName, runSessionID, resourceNs) as { messages?: unknown[] };
          return { runName, messages: data.messages ?? [], source: "live", runPhase: run.status?.phase };
        } catch {
          // Service unreachable — fall through to ConfigMap
        }
      }

      // If sessionID is specified, try ConfigMap for that session
      if (runSessionID) {
        const result = await readSessionConfigMap(runName, runSessionID, resourceNs);
        if (result) {
          return { runName, messages: result.messages, truncated: result.truncated, source: "configmap", sessionID: runSessionID };
        }
      }

      // No sessionID specified or specific session not found — fetch all sessions
      if (serviceName) {
        try {
          const allData = await fetchAllSessionMessages(serviceName, resourceNs);
          return {
            runName,
            sessions: allData.sessions,
            messages: allData.allMessages,
            source: "live",
            runPhase: run.status?.phase,
            note: sessionID ? `Specific session ${sessionID} not found; returning all sessions` : undefined,
          };
        } catch {
          // Fall through to ConfigMap
        }
      }

      // Fallback: all sessions from ConfigMap
      const allResult = await readAllSessionsFromConfigMap(runName, resourceNs);
      if (allResult) {
        return {
          runName,
          sessions: allResult.sessions,
          messages: allResult.allMessages,
          source: "configmap",
          note: sessionID ? `Specific session ${sessionID} not found; returning all sessions` : undefined,
        };
      }

      return { runName, messages: [], note: "no session snapshot found" };
    }

    case "patch_board": {
      const project = String(args.project ?? "");
      const patch = args.patch as Record<string, unknown>;
      const { patchProjectStatus } = await import("@percussionist/kube");
      await patchProjectStatus(project, { board: patch as never }, ns);
      return { project, patched: true };
    }

    case "delete_run": {
      const name = String(args.name ?? "");
      const resourceNs = String(args.namespace ?? ns);
      await deleteRun(name, resourceNs);
      return { name, deleted: true };
    }

    case "create_run": {
      const projectName = String(args.project ?? "");
      const taskName = String(args.task ?? "");
      const agentOverride = args.agent ? String(args.agent) : undefined;
      const modelOverride = args.model ? String(args.model) : undefined;
      const reworkFeedback = args.reworkFeedback ? String(args.reworkFeedback) : undefined;
      const resourceNs = String(args.namespace ?? ns);

      const project = await getProject(projectName, resourceNs);
      const task = await getTask(taskName, resourceNs);
      const projectTasks = await listProjectTasks(projectName, resourceNs);

      const currentPhase = (task.status?.phase ?? "pending") as TaskPhase;
      // Validate pending → running transition (create_run is an admin shortcut).
      if (!isValidTransition(currentPhase, "running")) {
        const allowed = TRANSITION_TABLE[currentPhase] ?? [];
        throw new Error(
          `Task ${taskName} has phase "${currentPhase}", cannot create run. Allowed transitions: ${allowed.join(", ") || "(none, terminal)"}. Use force_retry to clean up first.`,
        );
      }

      const existingWorker = task.status?.worker ?? null;
      const retryCount = args.retryCount !== undefined
        ? Number(args.retryCount)
        : (existingWorker?.retryCount ?? 0);

      const runName = workerRunName(projectName, taskName, retryCount);
      const workerRun = await buildWorkerRun(project, task, runName, retryCount, reworkFeedback, projectTasks);
      const phaseAgent = resolvePhaseAgent(task, project, currentPhase);
      if (agentOverride ?? phaseAgent) workerRun.spec.agent = agentOverride ?? phaseAgent;
      if (modelOverride) workerRun.spec.model = modelOverride;

      await patchTaskStatus(taskName, {
        phase: "running",
        worker: {
          ...(existingWorker ?? {}),
          runName,
          status: "Running",
          ...workerBranchPatch(project, task, projectTasks),
          retryCount,
          aiReworkCount: existingWorker?.aiReworkCount ?? 0,
        },
      }, resourceNs);

      try {
        await createRun(workerRun, resourceNs);
      } catch (e) {
        const msg = (e as Error).message;
        if (/AlreadyExists/i.test(msg)) {
          const existing = await getRun(runName, resourceNs);
          const phase = existing.status?.phase;
          if (phase === "Failed" || phase === "Cancelled") {
            await deleteRun(runName, resourceNs);
            await cleanupRunWorktree(projectName, runName, resourceNs);
            await createRun(workerRun, resourceNs);
          } else {
            throw new Error(`Run ${runName} already exists (phase: ${phase})`);
          }
        } else {
          await patchTaskStatus(taskName, { phase: "pending" }, resourceNs).catch(() => { /* best effort */ });
          throw e;
        }
      }

      return { runName, project: projectName, task: taskName, phase: "Created", namespace: resourceNs };
    }

    case "create_task": {
      const projectName = String(args.project ?? "");
      const taskType = String(args.type ?? "");
      const title = String(args.title ?? "");
      const agent = String(args.agent ?? "");
      const description = args.description ? String(args.description) : undefined;
      const priority = String(args.priority ?? "medium");
      const parentTaskRef = args.parentTaskRef ? String(args.parentTaskRef) : undefined;
      const predecessorRef = args.predecessorRef ? String(args.predecessorRef) : undefined;
      const successorRef = args.successorRef ? String(args.successorRef) : undefined;
      const resourceNs = String(args.namespace ?? ns);

      if (taskType !== "PLAN" && taskType !== "BUILD") {
        throw new Error("type must be PLAN or BUILD");
      }

      const project = await getProject(projectName, resourceNs);
      const roster = (project.spec.agents ?? []).map((a: { name: string }) => a.name);
      if (!roster.includes(agent)) {
        throw new Error(`agent "${agent}" not in project roster: ${roster.join(", ") || "(empty)"}`);
      }

      const suffix = randomBytes(3).toString("hex");
      const taskName = `${projectName}-${taskType.toLowerCase()}-${suffix}`;

      const task = buildTask({
        name: taskName,
        projectName,
        projectUid: project.metadata.uid ?? "",
        ns: resourceNs,
        spec: {
          projectRef: projectName,
          type: taskType as "PLAN" | "BUILD",
          title,
          description,
          agent,
          priority: priority as "high" | "medium" | "low",
          parentTaskRef,
          predecessorRef,
          successorRef,
        },
      });

      const created = await createTask(task, resourceNs);

      return {
        taskName: created.metadata.name,
        project: projectName,
        type: taskType,
        phase: "pending",
        namespace: resourceNs,
      };
    }

    case "force_retry": {
      const projectName = String(args.project ?? "");
      const taskName = String(args.task ?? "");
      const shouldCreate = args.createRun !== false;
      const agentOverride = args.agent ? String(args.agent) : undefined;
      const modelOverride = args.model ? String(args.model) : undefined;
      const resourceNs = String(args.namespace ?? ns);

      const project = await getProject(projectName, resourceNs);
      const task = await getTask(taskName, resourceNs);
      const projectTasks = await listProjectTasks(projectName, resourceNs);

      const currentPhase = (task.status?.phase ?? "pending") as TaskPhase;
      // force_retry is an admin tool — validates but allows any phase → running.
      if (!isValidTransition(currentPhase, "running")) {
        console.log(
          `[force_retry] ${taskName} admin override: ${currentPhase} → running (not a standard transition)`,
        );
      }

      let createdRunName: string | undefined;
      const existingRetryCount = task.status?.worker?.retryCount ?? 0;
      const retryCount = existingRetryCount + 1;
      if (shouldCreate) {
        const runName = workerRunName(projectName, taskName, retryCount);
        const workerRun = await buildWorkerRun(project, task, runName, retryCount, undefined, projectTasks);
        const phaseAgent = resolvePhaseAgent(task, project, currentPhase);
        if (agentOverride ?? phaseAgent) workerRun.spec.agent = agentOverride ?? phaseAgent;
        if (modelOverride) workerRun.spec.model = modelOverride;

        await patchTaskStatus(taskName, {
          phase: "running",
          worker: {
            runName,
            status: "Running",
            ...workerBranchPatch(project, task, projectTasks),
            retryCount,
            aiReworkCount: 0,
          },
        }, resourceNs);

        try {
          await createRun(workerRun, resourceNs);
        } catch (e) {
          const msg = (e as Error).message;
          if (/AlreadyExists/i.test(msg)) {
            const existing = await getRun(runName, resourceNs);
            const phase = existing.status?.phase;
            if (phase === "Failed" || phase === "Cancelled") {
              await deleteRun(runName, resourceNs);
              await createRun(workerRun, resourceNs);
            } else {
              throw new Error(`Run ${runName} already exists (phase: ${phase})`);
            }
          } else {
            await patchTaskStatus(taskName, { phase: "pending" }, resourceNs).catch(() => { /* best effort */ });
            throw e;
          }
        }

        createdRunName = runName;
      } else {
        // No run creation — reset to pending.
        const existingWorker = task.status?.worker;
        await patchTaskStatus(taskName, {
          phase: "pending",
          worker: existingWorker
            ? {
                ...existingWorker,
                ...clearWorkerRunRefs(),
                status: "Failed",
                retryCount,
                aiReworkCount: existingWorker.aiReworkCount ?? 0,
              }
            : {
                ...clearWorkerRunRefs(),
                status: "Failed" as const,
                retryCount,
                aiReworkCount: 0,
              },
        }, resourceNs);
      }

      return {
        project: projectName,
        task: taskName,
        createdRun: createdRunName,
        namespace: resourceNs,
      };
    }

    case "read_session_live": {
      const runName = String(args.runName ?? "");
      const sessionID = args.sessionID ? String(args.sessionID) : undefined;
      const since = args.since ? Number(args.since) : 0;
      const resourceNs = String(args.namespace ?? ns);

      const run = await getRun(runName, resourceNs);
      const runPhase = run.status?.phase ?? "Unknown";
      const serviceName = run.status?.serviceName;
      const runSessionID = sessionID ?? run.status?.sessionID;

      // If sessionID is specified, try to fetch that specific session
      if (runSessionID && serviceName) {
        try {
          const data = await fetchSessionMessages(serviceName, runSessionID, resourceNs) as { messages?: unknown[] };
          const messages = data.messages ?? [];
          return {
            messages: messages.slice(since),
            total: messages.length,
            nextSince: messages.length,
            runPhase,
            sessionID: runSessionID,
            source: "live",
          };
        } catch {
          // Service unreachable — fall through
        }
      }

      // No sessionID specified or specific session not found — fetch all sessions
      if (serviceName) {
        try {
          const allData = await fetchAllSessionMessages(serviceName, resourceNs);
          const messages = allData.allMessages;
          return {
            sessions: allData.sessions,
            messages: messages.slice(since),
            total: messages.length,
            nextSince: messages.length,
            runPhase,
            source: "live",
            note: sessionID ? `Specific session ${sessionID} not found; returning all sessions` : undefined,
          };
        } catch {
          // Fall through to ConfigMap
        }
      }

      // Fallback: try specific session from ConfigMap if sessionID was provided
      if (runSessionID) {
        const cmData = await readSessionConfigMap(runName, runSessionID, resourceNs);
        if (cmData) {
          return {
            messages: cmData.messages.slice(since),
            total: cmData.messages.length,
            nextSince: cmData.messages.length,
            runPhase,
            sessionID: runSessionID,
            source: "configmap",
            truncated: cmData.truncated,
          };
        }
      }

      // Fallback: all sessions from ConfigMap
      const allResult = await readAllSessionsFromConfigMap(runName, resourceNs);
      if (allResult) {
        return {
          sessions: allResult.sessions,
          messages: allResult.allMessages.slice(since),
          total: allResult.allMessages.length,
          nextSince: allResult.allMessages.length,
          runPhase,
          source: "configmap",
          note: sessionID ? `Specific session ${sessionID} not found; returning all sessions` : undefined,
        };
      }

      return {
        messages: [],
        total: 0,
        nextSince: 0,
        runPhase,
        note: "no session data available yet — run may still be initializing",
      };
    }

    case "set_task_state": {
      const projectName = String(args.project ?? "");
      const taskName = String(args.task ?? "");
      const targetPhase = String(args.targetPhase ?? "");
      const cancelRunning = args.cancelRunning === true;
      const preserveRuns = args.preserveRuns !== false;
      const adminOverride = args.admin === true;
      const resourceNs = String(args.namespace ?? ns);

      // Validate target phase is a known TaskPhase.
      const allPhases = Object.keys(TRANSITION_TABLE) as TaskPhase[];
      if (!allPhases.includes(targetPhase as TaskPhase)) {
        throw new Error(`Invalid targetPhase: ${targetPhase}. Must be one of: ${allPhases.join(", ")}`);
      }

      const task = await getTask(taskName, resourceNs);
      const project = await getProject(projectName, resourceNs);
      const projectTasks = await listProjectTasks(projectName, resourceNs);

      const currentPhase = (task.status?.phase ?? "pending") as TaskPhase;

      // Validate transition unless admin override is set.
      if (!adminOverride && !isValidTransition(currentPhase, targetPhase as TaskPhase)) {
        const allowed = TRANSITION_TABLE[currentPhase] ?? [];
        throw new Error(
          `Invalid transition: ${currentPhase} → ${targetPhase}. Allowed: ${allowed.join(", ") || "(none, terminal)"}. Use admin: true to override.`,
        );
      }

      // Cannot transition directly to "running" — no Run would exist, so the
      // next reconcile immediately flips the task to "failed". Use force_retry
      // or create_run instead.
      if (targetPhase === "running") {
        throw new Error(
          'Cannot transition directly to "running". Use force_retry to retry a task or create_run to start a new run.',
        );
      }

      const deletedRuns = preserveRuns
        ? []
        : await deleteRunsForTask(projectName, taskName, resourceNs, { includeActive: cancelRunning, includeUnknown: true });

      const existingWorker = task.status?.worker;
      let workerCleared = true;
      
      // Phase-specific worker state updates
      if (targetPhase === "scheduled") {
        const retryCount = existingWorker?.retryCount ?? 0;
        await patchTaskStatus(taskName, {
          phase: "scheduled",
          worker: {
            ...(existingWorker ?? {}),
            ...clearWorkerRunRefs(),
            status: "Running",
            ...workerBranchPatch(project, task, projectTasks),
            retryCount,
            aiReworkCount: existingWorker?.aiReworkCount ?? 0,
          },
        }, resourceNs);
        workerCleared = false;
      } else if (targetPhase === "done") {
        await patchTaskStatus(taskName, {
          phase: "done",
          worker: {
            ...(existingWorker ?? {}),
            ...clearWorkerRunRefs(),
            status: "Succeeded",
            retryCount: existingWorker?.retryCount ?? 0,
            aiReworkCount: existingWorker?.aiReworkCount ?? 0,
            completedAt: new Date().toISOString(),
          },
        }, resourceNs);
        workerCleared = false;
      } else if (targetPhase === "pending" || targetPhase === "rework-requested") {
        await patchTaskStatus(taskName, {
          phase: targetPhase as "pending" | "rework-requested",
          worker: existingWorker
            ? {
                ...existingWorker,
                ...clearWorkerRunRefs(),
                status: "Failed",
                retryCount: existingWorker.retryCount ?? 0,
                aiReworkCount: existingWorker.aiReworkCount ?? 0,
              }
            : undefined,
        }, resourceNs);
        workerCleared = !existingWorker;
      } else if (targetPhase === "failed") {
        await patchTaskStatus(taskName, {
          phase: "failed",
          worker: existingWorker
            ? {
                ...existingWorker,
                ...clearWorkerRunRefs(),
                status: "Failed",
                retryCount: existingWorker.retryCount ?? 0,
                aiReworkCount: existingWorker.aiReworkCount ?? 0,
              }
            : { ...clearWorkerRunRefs(), status: "Failed" as const, retryCount: 0, aiReworkCount: 0 },
        }, resourceNs);
        workerCleared = false;
      } else {
        // Other phases (idea, awaiting-human) - just update phase
        await patchTaskStatus(taskName, { phase: targetPhase as never }, resourceNs);
      }

      return {
        project: projectName,
        task: taskName,
        targetPhase,
        deletedRuns,
        workerCleared,
        preserveRuns,
      };
    }

    case "read_manager_logs": {
      const tailLines = args.tailLines ? Number(args.tailLines) : 100;
      const resourceNs = String(args.namespace ?? ns);

      const pods = await listPodsByLabels(
        { "app.kubernetes.io/component": "manager" },
        resourceNs,
      );
      if (pods.length === 0) throw new Error("No manager pods found");

      const podName = pods[0]!.metadata!.name!;
      const logs = await readPodLog(podName, "manager", tailLines, resourceNs);
      return { podName, container: "manager", tailLines, logs };
    }

    case "pause_reconciliation": {
      const projectName = String(args.project ?? "");
      const durationSeconds = args.durationSeconds ? Number(args.durationSeconds) : 300;
      const resourceNs = String(args.namespace ?? ns);

      setPaused(true, durationSeconds * 1000);

      try {
        const { patchProject } = await import("@percussionist/kube");
        await patchProject(projectName, {
          metadata: {
            annotations: {
              "percussionist.dev/reconcile-paused": "true",
              "percussionist.dev/reconcile-paused-at": new Date().toISOString(),
              "percussionist.dev/reconcile-paused-duration": String(durationSeconds),
            },
          },
        }, resourceNs);
      } catch {
        // Annotation failed but in-memory pause still works
      }

      return {
        project: projectName,
        paused: true,
        durationSeconds,
        autoResumeAt: new Date(Date.now() + durationSeconds * 1000).toISOString(),
      };
    }

    case "resume_reconciliation": {
      const projectName = String(args.project ?? "");
      const resourceNs = String(args.namespace ?? ns);

      setPaused(false);

      try {
        const { patchProject } = await import("@percussionist/kube");
        await patchProject(projectName, {
          metadata: {
            annotations: {
              "percussionist.dev/reconcile-paused": null as unknown as string,
              "percussionist.dev/reconcile-paused-at": null as unknown as string,
              "percussionist.dev/reconcile-paused-duration": null as unknown as string,
            },
          },
        }, resourceNs);
      } catch {
        // Annotation failed but in-memory resume still works
      }

      return {
        project: projectName,
        paused: false,
      };
    }

    case "get_reconcile_status": {
      const pauseInfo = getPauseStatus();
      return {
        paused: pauseInfo.paused,
        elapsedMs: pauseInfo.elapsedMs,
        lastReconcile: new Date().toISOString(),
      };
    }

    case "exec_in_workspace": {
      const projectName = String(args.project ?? "");
      const command = String(args.command ?? "");
      const mountPath = args.mountPath ? String(args.mountPath) : "/data";
      const timeoutMs = args.timeoutSeconds ? Number(args.timeoutSeconds) * 1000 : 120_000;
      const resourceNs = String(args.namespace ?? ns);

      if (!command) throw new Error("command is required");

      // Security: sanitize command before execution to prevent shell injection.
      const sanitizationError = sanitizeCommand(command);
      if (sanitizationError) {
        logSecurityEvent("exec_in_workspace.rejected", { project: projectName, reason: sanitizationError });
        throw new Error(sanitizationError);
      }

      console.log(`[exec_in_workspace] project=${projectName} command="${command.slice(0, 200)}"`);

      const result = await execInWorkspace(projectName, command, mountPath, timeoutMs, resourceNs);
      return {
        project: projectName,
        podName: result.podName,
        exitCode: result.exitCode,
        stdout: result.stdout,
        succeeded: result.exitCode === 0,
      };
    }

    case "read_plan": {
      const projectName = String(args.project ?? "");
      const taskName = String(args.task ?? "");
      const resourceNs = String(args.namespace ?? ns);

      if (!projectName) throw new Error("project is required");
      if (!taskName) throw new Error("task is required");

      // Try ConfigMap first (fast, no pod spawning)
      const planContent = await readPlanFromConfigMap(projectName, taskName, resourceNs);
      if (planContent !== null) {
        return {
          project: projectName,
          task: taskName,
          exists: true,
          content: planContent,
          source: "configmap",
        };
      }

      // Fallback: read from workspace via execInWorkspace (backward compat for existing plans)
      const mountPath = "/data";
      const project = await getProject(projectName, resourceNs);
      const isLocal = project.spec.source?.local === true;
      const gitUrl = project.spec.source?.git?.url;
      const planPath = `.percussionist/plans/${taskName}.md`;
      const escaped = planPath.replace(/'/g, "'\\''");

      if (!isLocal && gitUrl) {
        const task = await getTask(taskName, resourceNs);
        const gitBranch = task.status?.worker?.gitBranch || `feature/${taskName}`;
        const urlHash = gitUrlHash(gitUrl);
        const mirrorPath = `${mountPath}/git-mirrors/${urlHash}`;

        const gitShowCmd = `apk add --no-cache git > /dev/null 2>&1 && cd '${mirrorPath}' && git show '${gitBranch}:${planPath}' 2>/dev/null`;
        const result = await execInWorkspace(projectName, gitShowCmd, mountPath, 30_000, resourceNs);

        if (result.exitCode === 0 && result.stdout) {
          return { project: projectName, task: taskName, exists: true, content: result.stdout, source: "git", branch: gitBranch };
        }

        const mainBranchCmd = `apk add --no-cache git > /dev/null 2>&1 && cd '${mirrorPath}' && git show 'main:${planPath}' 2>/dev/null`;
        const mainResult = await execInWorkspace(projectName, mainBranchCmd, mountPath, 30_000, resourceNs);

        if (mainResult.exitCode === 0 && mainResult.stdout) {
          return { project: projectName, task: taskName, exists: true, content: mainResult.stdout, source: "git", branch: "main" };
        }
      } else {
        const result = await execInWorkspace(projectName, `cat '${escaped}'`, mountPath, 30_000, resourceNs);
        if (result.exitCode === 0 && result.stdout) {
          return { project: projectName, task: taskName, exists: true, content: result.stdout, source: "workspace" };
        }
      }

      return {
        project: projectName,
        task: taskName,
        planPath,
        exists: false,
        content: null,
        note: `Plan not found for ${taskName}. The planner may not have called write_plan yet.`,
      };
    }

    case "write_plan": {
      const projectName = String(args.project ?? "");
      const taskName = String(args.task ?? "");
      const content = args.content ? String(args.content) : "";
      const resourceNs = String(args.namespace ?? ns);

      if (!projectName) throw new Error("project is required");
      if (!taskName) throw new Error("task is required");
      if (!content) throw new Error("content is required");

      const result = await writePlanToConfigMap(projectName, taskName, content, resourceNs);
      return {
        project: projectName,
        task: taskName,
        written: true,
        sizeBytes: result.sizeBytes,
        warning: result.warning,
      };
    }

    case "check_for_updates": {
      const DEPLOYMENT_NAMES = [
        "percussionist-operator",
        "percussionist-manager",
        "percussionist-web",
      ];

      // 1. Read current image tags from live deployments
      const images = await getDeploymentImages(ns, DEPLOYMENT_NAMES);

      // 2. Read dispatcher image from the operator Deployment's DISPATCHER_IMAGE env var
      const dispatcherInfo = await getDispatcherImageFromOperatorDeployment(ns);

      // 3. Derive registry prefix and repo path from the operator image (or whichever is found first)
      const foundImage = Object.values(images)[0];
      if (!foundImage) {
        return {
          current: { operator: null, manager: null, web: null, dispatcher: dispatcherInfo?.tag ?? null },
          latest: null,
          updateAvailable: false,
          error: "Could not read deployment images — are the deployments running?",
        };
      }

      // e.g. "ghcr.io/erkkaha/percussionist/operator:v0.1.4"
      // imageWithoutTag = "ghcr.io/erkkaha/percussionist/operator"
      // repo = "erkkaha/percussionist/operator"
      const imageWithoutTag = foundImage.image.includes(":")
        ? foundImage.image.slice(0, foundImage.image.lastIndexOf(":"))
        : foundImage.image;
      const repo = imageWithoutTag.replace(/^[^/]+\//, ""); // strip registry host

      // 4. Get GHCR anonymous bearer token for this repo
      let latestTag: string | null = null;
      let registryError: string | undefined;
      try {
        const tokenRes = await fetch(
          `https://ghcr.io/token?scope=repository:${repo}:pull`,
          { signal: AbortSignal.timeout(10_000) },
        );
        if (!tokenRes.ok) throw new Error(`GHCR token endpoint returned ${tokenRes.status}`);
        const { token } = (await tokenRes.json()) as { token: string };

        // 5. Fetch tag list
        const tagsRes = await fetch(
          `https://ghcr.io/v2/${repo}/tags/list?n=1000`,
          {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!tagsRes.ok) throw new Error(`GHCR tags endpoint returned ${tagsRes.status}`);
        const { tags } = (await tagsRes.json()) as { tags: string[] };

        // 6. Find latest semver tag (vMAJOR.MINOR.PATCH) via inline sort
        const semverTags = (tags ?? [])
          .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
          .sort((a, b) => {
            const parse = (s: string) => s.slice(1).split(".").map(Number) as [number, number, number];
            const [aMaj, aMin, aPatch] = parse(a);
            const [bMaj, bMin, bPatch] = parse(b);
            return (bMaj - aMaj) || (bMin - aMin) || (bPatch - aPatch);
          });
        latestTag = semverTags[0] ?? null;
      } catch (e) {
        registryError = (e as Error).message;
      }

      const current = {
        operator: images["percussionist-operator"]?.tag ?? null,
        manager: images["percussionist-manager"]?.tag ?? null,
        web: images["percussionist-web"]?.tag ?? null,
        dispatcher: dispatcherInfo?.tag ?? null,
      };

      const updateAvailable =
        latestTag !== null &&
        !registryError &&
        Object.values(current).some((tag) => tag !== null && tag !== latestTag);

      return {
        current,
        latest: latestTag,
        updateAvailable,
        registryPrefix: foundImage.registryPrefix,
        ...(registryError ? { error: registryError } : {}),
      };
    }

    case "apply_upgrade": {
      const targetTag = String(args.targetTag ?? "");
      if (!targetTag) throw new Error("targetTag is required");

      const DEPLOYMENT_NAMES = [
        "percussionist-operator",
        "percussionist-manager",
        "percussionist-web",
      ];

      // Container names within each deployment (must match k8s/deploy/*.yaml)
      const CONTAINER_NAMES: Record<string, string> = {
        "percussionist-operator": "operator",
        "percussionist-manager": "manager",
        "percussionist-web": "web",
      };

      // Read current images to derive registry prefix and component names
      const images = await getDeploymentImages(ns, DEPLOYMENT_NAMES);
      const foundImage = Object.values(images)[0];
      if (!foundImage) {
        return {
          patched: [],
          errors: ["Could not read deployment images — are the deployments running?"],
        };
      }

      const registryPrefix = foundImage.registryPrefix;
      const patched: string[] = [];
      const errors: string[] = [];

      for (const depName of DEPLOYMENT_NAMES) {
        const info = images[depName];
        if (!info) {
          errors.push(`${depName}: deployment not found`);
          continue;
        }

        // Derive component name from the full image path
        // e.g. "ghcr.io/erkkaha/percussionist/operator:v0.1.5" → "operator"
        const imageWithoutTag = info.image.includes(":")
          ? info.image.slice(0, info.image.lastIndexOf(":"))
          : info.image;
        const component = imageWithoutTag.split("/").pop() ?? depName;
        const newImage = `${registryPrefix}/${component}:${targetTag}`;
        const containerName = CONTAINER_NAMES[depName] ?? component;

        // Build the patch body — for the operator deployment, also update
        // the DISPATCHER_IMAGE env var to match the target tag
        const containers: Array<Record<string, unknown>> = [{
          name: containerName,
          image: newImage,
        }];

        if (depName === "percussionist-operator") {
          const dispatcherNewImage = `${registryPrefix}/dispatcher:${targetTag}`;
          containers[0]!.env = [{ name: "DISPATCHER_IMAGE", value: dispatcherNewImage }];
        }

        const patchBody = {
          spec: {
            template: {
              spec: {
                containers,
              },
            },
          },
        };

        try {
          await apps().patchNamespacedDeployment(
            {
              name: depName,
              namespace: ns,
              body: patchBody,
            },
            setHeaderOptions("Content-Type", "application/strategic-merge-patch+json"),
          );
          patched.push(depName);
        } catch (e) {
          errors.push(`${depName}: ${(e as Error).message}`);
        }
      }

      return { patched, errors, targetTag };
    }

    case "list_models": {
      const res = await fetch(`${OPENCODE_URL}/provider`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`opencode /provider returned ${res.status}`);
      const data = (await res.json()) as {
        all: Array<{ id: string; name?: string; models?: unknown }>;
        default: Record<string, string>;
        connected: string[];
      };
      // Normalize each provider's models to an array (opencode may return a
      // record/object keyed by model ID rather than an array).
      const normalizeModels = (raw: unknown): Array<{ id: string; name?: string }> => {
        if (Array.isArray(raw)) return raw as Array<{ id: string; name?: string }>;
        if (raw && typeof raw === "object") {
          return Object.values(raw as Record<string, { id: string; name?: string }>);
        }
        return [];
      };
      const connectedSet = new Set(data.connected ?? []);
      const normalized = {
        ...data,
        all: (data.all ?? [])
          .filter((p) => connectedSet.has(p.id))
          .map((p) => ({
            id: p.id,
            name: p.name ?? p.id,
            models: normalizeModels(p.models).map((m) => ({
              id: m.id,
              name: (m as { name?: string }).name ?? m.id,
            })),
          })),
      };
      const providerID = args.providerID as string | undefined;
      if (providerID) {
        const match = normalized.all.find((p) => p.id === providerID);
        if (!match) return { error: `Provider '${providerID}' not found` };
        return match;
      }
      return normalized;
    }

    case "list_task_events": {
      const project = String(args.project ?? "");
      const taskFilter = args.task ? String(args.task) : undefined;
      const limit = Math.min(parseInt(String(args.limit ?? "50"), 10), 500);
      const webUrl =
        process.env.WEB_SERVICE_URL ??
        `http://percussionist-web.${MANAGER_NAMESPACE}.svc.cluster.local:8080`;
      const webAuthToken = process.env.WEB_AUTH_TOKEN ?? "";
      const authHeaders: Record<string, string> = webAuthToken ? { Authorization: `Bearer ${webAuthToken}` } : {};
      let path = `/api/board/${encodeURIComponent(project)}/events?limit=${limit}`;
      if (taskFilter) {
        path = `/api/board/${encodeURIComponent(project)}/tasks/${encodeURIComponent(taskFilter)}/events?limit=${limit}`;
      }
      const res = await fetch(`${webUrl}${path}`, { headers: { ...authHeaders } });
      if (!res.ok) {
        throw new Error(`web server returned ${res.status}: ${res.statusText}`);
      }
      const body = (await res.json()) as { events: unknown };
      return body.events ?? [];
    }

    case "store_memory": {
      const project = String(args.project ?? "");
      const content = String(args.content ?? "");
      const metadata = args.metadata as Record<string, unknown> | undefined;
      if (!project || !content) {
        throw new Error("project and content are required");
      }
      return await storeMemory(project, content, metadata);
    }

    case "query_memory": {
      const project = String(args.project ?? "");
      const query = String(args.query ?? "");
      const limit = args.limit ? parseInt(String(args.limit), 10) : undefined;
      if (!project || !query) {
        throw new Error("project and query are required");
      }
      return await queryMemory(project, query, limit);
    }

    case "get_context": {
      const project = String(args.project ?? "");
      const query = String(args.query ?? "");
      const task = args.task ? String(args.task) : undefined;
      if (!project || !query) {
        throw new Error("project and query are required");
      }
      return await getContext(project, query, task);
    }

    case "list_available_packages": {
      const project = String(args.project ?? "");
      if (!project) throw new Error("project is required");
      const p = await getProject(project, MANAGER_NAMESPACE);
      return { packages: p.spec.runner?.packages ?? [] };
    }

    case "install_packages": {
      const project = String(args.project ?? "");
      const pkgs = (args.packages ?? []) as string[];
      if (!project || !pkgs.length) throw new Error("project and packages are required");

      // Security: validate each package name against Alpine package naming rules.
      // Rejects shell metacharacters that could enable command injection via execInWorkspace.
      for (const pkg of pkgs) {
        if (!isValidPackageName(pkg)) {
          logSecurityEvent("install_packages.rejected", { project, package: pkg });
          throw new Error(
            `Invalid package name "${pkg}": only alphanumeric characters, hyphens, dots, and plus signs are allowed.`,
          );
        }
      }

      const cmd = `apk update --quiet && apk add --no-cache ${pkgs.join(" ")}`;
      console.log(`[install_packages] project=${project} packages=[${pkgs.join(", ")}]`);

      const result = await execInWorkspace(project, cmd, undefined, undefined, MANAGER_NAMESPACE);
      return { installed: pkgs, output: result.stdout ?? "", exitCode: result.exitCode };
    }

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// MCP handler

function handleMcp(req: JsonRpcRequest): JsonRpcResponse | Promise<JsonRpcResponse> {
  switch (req.method) {
    case "initialize":
      return ok(req.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });

    case "notifications/initialized":
      return ok(req.id, {});

    case "tools/list":
      return ok(req.id, { tools: TOOLS });

    case "tools/call": {
      const toolName = (req.params?.name as string | undefined) ?? "";
      const toolArgs = (req.params?.arguments ?? {}) as Record<string, unknown>;
      return (async () => {
        try {
          const result = await callTool(toolName, toolArgs);
          return ok(req.id, {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          });
        } catch (e) {
          return ok(req.id, {
            content: [
              {
                type: "text",
                text: `Error calling ${toolName}: ${(e as Error).message}`,
              },
            ],
            isError: true,
          });
        }
      })();
    }

    default:
      return rpcError(req.id, -32601, `method not found: ${req.method}`);
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle

export interface McpServer {
  close(): void;
}

export function startMcpServer(): Promise<McpServer> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "POST" || req.url !== "/mcp") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }

      readBody(req)
        .then(async (body) => {
          let rpc: JsonRpcRequest;
          try {
            rpc = JSON.parse(body) as JsonRpcRequest;
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify(rpcError(null, -32700, "parse error")));
            return;
          }

          if (rpc.id === undefined || rpc.id === null) {
            handleMcp(rpc);
            res.writeHead(202);
            res.end();
            return;
          }

          const response = await Promise.resolve(handleMcp(rpc));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(response));
        })
        .catch((e) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify(rpcError(null, -32603, String((e as Error).message))));
        });
    });

    server.on("error", reject);
    server.listen(MCP_PORT, "0.0.0.0", () => {
      console.log(`[agent] MCP server listening on 0.0.0.0:${MCP_PORT}`);
      resolve({
        close() {
          server.close();
        },
      });
    });
  });
}
