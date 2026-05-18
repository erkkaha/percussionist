// agent/tools.ts — MCP server exposing K8s tools to the agent.
//
// Follows the same JSON-RPC 2.0 / MCP Streamable HTTP pattern as the
// dispatcher's mcp-server.ts. Runs on AGENT_MCP_PORT (default 4097).
//
// The opencode-web sidecar discovers these tools via the `mcp` stanza
// in its config (deployed as the agent-config ConfigMap).
// Note: uses `mcp` key (not `mcpServers` — that was a legacy format).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { MCP_PORT, MANAGER_NAMESPACE } from "./config.js";
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
  patchProjectStatus,
  listClusterAgents,
  listPodsByLabels,
  listTasks,
  getTask,
  patchTaskStatus,
} from "@percussionist/kube";
import { LABELS } from "@percussionist/api";
import { buildWorkerRun, workerRunName } from "../worker-builder.js";
import { setPaused, getPauseStatus } from "../reconciler.js";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "percussionist-manager-agent";
const SERVER_VERSION = "1.0";

// ---------------------------------------------------------------------------
// Tool definitions

const TOOLS = [
  {
    name: "inspect_cr",
    description:
      "Get full details of a Percussionist custom resource. Supports Run, Project, and ClusterAgent kinds.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description: "CR kind: Run, Project, or ClusterAgent",
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
      "List Percussionist custom resources of a given kind. Supports Run, Project, and ClusterAgent. Label selector uses comma-separated k=v pairs (e.g. 'percussionist.dev/project=my-project,percussionist.dev/task-id=BUILD-4'). Note: the correct task label key is 'percussionist.dev/task-id' (not 'task').",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description: "CR kind: Run, Project, or ClusterAgent",
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
      "Modify board state for a project. Uses Kubernetes merge-patch on the status.board subresource. At the top level of 'board', omitted keys are preserved, but nested objects (e.g. backlog columns) are fully replaced. Best practice: always include backlog, workers, activeWorkers, and lastEventAt in every patch to avoid losing state. For atomic task state changes, prefer set_task_state instead.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
        patch: {
          type: "object",
          description:
            "Status board patch. E.g. { backlog: { ready: [...], 'in-progress': [...] }, workers: [...] }. Omitted top-level board keys are preserved; nested objects are replaced.",
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
      "Create a new Run for a board task. The task must be in the 'ready' column. Moves the task to 'in-progress' and creates the run.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
        task: { type: "string", description: "Board task ID (e.g. 'BUILD-4')" },
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
    name: "force_retry",
    description:
      "Clean up all terminal-phase runs for a board task, reset the board state, and create a fresh run. Use when a task is stuck after infrastructure issues.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
        task: { type: "string", description: "Board task ID (e.g. 'BUILD-4')" },
        createRun: {
          type: "boolean",
          description: "Create a fresh run immediately (default: true)",
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
      "Atomically transition a board task to a target state. Cleans up terminal-phase runs, optionally cancels running runs, moves the task in the backlog, and updates the worker entry in a single patch. This avoids race conditions with the manager's reconciliation loop.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
        task: { type: "string", description: "Board task ID (e.g. 'BUILD-4')" },
        targetColumn: {
          type: "string",
          enum: ["ready", "in-progress", "review", "rework", "done"],
          description: "Target backlog column for the task",
        },
        cancelRunning: {
          type: "boolean",
          description: "Delete any active (Running/Pending) runs for this task (default: false)",
        },
        namespace: {
          type: "string",
          description: "Namespace (optional, defaults to percussionist)",
        },
      },
      required: ["project", "task", "targetColumn"],
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Tool implementations

const ns = MANAGER_NAMESPACE;

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
        default:
          throw new Error(`unknown kind: ${kind}. Supported: Run, Project, ClusterAgent`);
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

      const currentColumn = task.status?.column ?? "ready";
      if (currentColumn !== "ready") {
        throw new Error(`Task ${taskName} is in column "${currentColumn}", not "ready". Use force_retry to clean up first.`);
      }

      const existingWorker = task.status?.worker ?? null;
      const retryCount = args.retryCount !== undefined
        ? Number(args.retryCount)
        : (existingWorker?.retryCount ?? 0);

      const runName = workerRunName(projectName, taskName, retryCount);
      const workerRun = buildWorkerRun(project, task, runName, retryCount, reworkFeedback);
      if (agentOverride) workerRun.spec.agent = agentOverride;
      if (modelOverride) workerRun.spec.model = modelOverride;

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
          throw e;
        }
      }

      // Update task status atomically.
      await patchTaskStatus(taskName, {
        column: "in-progress",
        worker: {
          ...(existingWorker ?? {}),
          runName,
          status: "Running",
          branch: `feat/${taskName}`,
          retryCount,
          facilitated: false,
        },
      }, resourceNs);

      return { runName, project: projectName, task: taskName, phase: "Created", namespace: resourceNs };
    }

    case "force_retry": {
      const projectName = String(args.project ?? "");
      const taskName = String(args.task ?? "");
      const shouldCreate = args.createRun !== false;
      const resourceNs = String(args.namespace ?? ns);

      const allRuns = await listRuns(resourceNs);
      const taskRuns = allRuns.filter((r) => {
        const labels = r.metadata.labels ?? {};
        return labels[LABELS.projectName] === projectName && labels[LABELS.taskId] === taskName;
      });

      const terminalPhases = new Set(["Succeeded", "Failed", "Cancelled"]);
      const terminalRuns = taskRuns.filter((r) => r.status?.phase && terminalPhases.has(r.status.phase));
      const deletedNames: string[] = [];
      for (const run of terminalRuns) {
        const name = run.metadata.name!;
        await deleteRun(name, resourceNs);
        deletedNames.push(name);
      }

      const project = await getProject(projectName, resourceNs);
      const task = await getTask(taskName, resourceNs);

      let createdRunName: string | undefined;
      if (shouldCreate) {
        const runName = workerRunName(projectName, taskName, 0);
        const workerRun = buildWorkerRun(project, task, runName, 0);

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
            throw e;
          }
        }

        // Reset task to in-progress with fresh worker.
        await patchTaskStatus(taskName, {
          column: "in-progress",
          worker: {
            runName,
            status: "Running",
            branch: `feat/${taskName}`,
            retryCount: 0,
            facilitated: false,
          },
        }, resourceNs);

        createdRunName = runName;
      } else {
        // No run creation — reset to ready.
        await patchTaskStatus(taskName, { column: "ready" }, resourceNs);
      }

      return {
        project: projectName,
        task: taskName,
        deletedRuns: deletedNames,
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
      const targetColumn = String(args.targetColumn ?? "");
      const cancelRunning = args.cancelRunning === true;
      const resourceNs = String(args.namespace ?? ns);

      const validColumns = ["ready", "in-progress", "review", "rework", "done", "blocked"];
      if (!validColumns.includes(targetColumn)) {
        throw new Error(`Invalid targetColumn: ${targetColumn}. Must be one of: ${validColumns.join(", ")}`);
      }

      const task = await getTask(taskName, resourceNs);
      void projectName;

      const allRuns = await listRuns(resourceNs);
      const taskRuns = allRuns.filter((r) => {
        const labels = r.metadata.labels ?? {};
        return labels[LABELS.taskId] === taskName;
      });

      const deletedRuns: string[] = [];
      for (const run of taskRuns) {
        const name = run.metadata.name!;
        const phase = run.status?.phase;
        if (!phase || phase === "Succeeded" || phase === "Failed" || phase === "Cancelled") {
          await deleteRun(name, resourceNs);
          deletedRuns.push(name);
        } else if (cancelRunning && (phase === "Running" || phase === "Pending")) {
          await deleteRun(name, resourceNs);
          deletedRuns.push(name);
        }
      }

      const existingWorker = task.status?.worker;
      let workerCleared = true;
      if (targetColumn === "in-progress") {
        const retryCount = existingWorker?.retryCount ?? 0;
        await patchTaskStatus(taskName, {
          column: "in-progress",
          worker: {
            ...(existingWorker ?? {}),
            runName: undefined,
            status: "Running",
            branch: `feat/${taskName}`,
            retryCount,
            facilitated: false,
          },
        }, resourceNs);
        workerCleared = false;
      } else {
        await patchTaskStatus(taskName, { column: targetColumn as "ready" | "review" | "rework" | "done" | "blocked" }, resourceNs);
      }

      return {
        project: projectName,
        task: taskName,
        targetColumn,
        deletedRuns,
        workerCleared,
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
    server.listen(MCP_PORT, "127.0.0.1", () => {
      console.log(`[agent] MCP server listening on 127.0.0.1:${MCP_PORT}`);
      resolve({
        close() {
          server.close();
        },
      });
    });
  });
}
