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
  createRun,
  deleteRun,
  fetchSessionMessages,
  patchProjectStatus,
} from "@percussionist/kube";
import { LABELS } from "@percussionist/api";
import { buildWorkerRun, workerRunName } from "../worker-builder.js";
import { moveTask, upsertWorker } from "../task-scheduler.js";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "percussionist-manager-agent";
const SERVER_VERSION = "1.0";

// ---------------------------------------------------------------------------
// Tool definitions

const TOOLS = [
  {
    name: "inspect_cr",
    description:
      "Get full details of a Percussionist custom resource. Supports OpenCodeRun, OpenCodeProject, and ClusterAgent kinds.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description: "CR kind: OpenCodeRun, OpenCodeProject, or ClusterAgent",
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
      "List Percussionist custom resources of a given kind. Returns summary of matching resources.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description: "CR kind: OpenCodeRun or OpenCodeProject",
        },
        namespace: {
          type: "string",
          description: "Namespace (optional, defaults to percussionist)",
        },
        labelSelector: {
          type: "string",
          description: "Label selector filter (e.g. 'percussionist.dev/project=my-project')",
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
        runName: { type: "string", description: "Name of the OpenCodeRun" },
        container: {
          type: "string",
          description:
            "Container name: opencode, dispatcher, git-clone, or bootstrap (default: opencode)",
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
      "Read session messages from a completed run's ConfigMap snapshot. Returns the conversation history.",
    inputSchema: {
      type: "object",
      properties: {
        runName: { type: "string", description: "Name of the OpenCodeRun" },
        sessionID: { type: "string", description: "Session ID (optional if only one session)" },
      },
      required: ["runName"],
    },
  },
  {
    name: "patch_board",
    description:
      "Modify board state for a project. Patches the project status subresource.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
        patch: {
          type: "object",
          description:
            "Status board patch. E.g. { backlog: { ready: [...], 'in-progress': [...] }, workers: [...] }",
        },
      },
      required: ["project", "patch"],
    },
  },
  {
    name: "delete_run",
    description:
      "Delete an OpenCodeRun by name. Useful for cleaning up stale/failed runs before recreating them.",
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
      "Create a new OpenCodeRun for a board task. The task must be in the 'ready' column. Moves the task to 'in-progress' and creates the run.",
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
      "Read session messages from a running or completed run in real-time. Returns incremental messages since the given index. Use with 'since' parameter for polling.",
    inputSchema: {
      type: "object",
      properties: {
        runName: { type: "string", description: "Name of the OpenCodeRun" },
        sessionID: {
          type: "string",
          description: "Session ID (auto-discovered from run if not provided)",
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
        case "OpenCodeRun": {
          const run = await getRun(resourceName, resourceNs);
          return { kind, name: resourceName, spec: run.spec, status: run.status };
        }
        case "OpenCodeProject": {
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
      const runs = await listRuns(resourceNs);
      switch (kind) {
        case "OpenCodeRun": {
          let filtered = runs;
          if (labelSelector) {
            filtered = runs.filter((r) => {
              const labels = r.metadata.labels ?? {};
              for (const part of labelSelector.split(",")) {
                const [k, v] = part.split("=");
                if (k && v && labels[k] !== v) return false;
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
          }));
        }
        case "OpenCodeProject": {
          const { listProjects } = await import("@percussionist/kube");
          const projects = await listProjects(resourceNs);
          return projects.map((p) => ({
            name: p.metadata.name,
            tasks: p.spec.board?.tasks?.length ?? 0,
            boardPhase: p.spec.board?.phase,
          }));
        }
        default:
          throw new Error(`unknown kind: ${kind}`);
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

      if (serviceName && runSessionID) {
        try {
          const data = await fetchSessionMessages(serviceName, runSessionID, resourceNs) as { messages?: unknown[] };
          return { runName, messages: data.messages ?? [], source: "live", runPhase: run.status?.phase };
        } catch {
          // Service unreachable — fall through to ConfigMap
        }
      }

      const result = await readSessionConfigMap(runName, runSessionID ?? "", resourceNs);
      if (!result) return { runName, messages: [], note: "no session snapshot found" };
      return { runName, messages: result.messages, truncated: result.truncated, source: "configmap" };
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
      const taskId = String(args.task ?? "");
      const agentOverride = args.agent ? String(args.agent) : undefined;
      const modelOverride = args.model ? String(args.model) : undefined;
      const reworkFeedback = args.reworkFeedback ? String(args.reworkFeedback) : undefined;
      const resourceNs = String(args.namespace ?? ns);

      const project = await getProject(projectName, resourceNs);
      const board = project.spec.board;
      if (!board) throw new Error(`Project ${projectName} has no board configured`);

      const taskDef = (board.tasks ?? []).find((t) => t.id === taskId);
      if (!taskDef) throw new Error(`Task ${taskId} not found in project ${projectName} board`);

      const boardStatus = project.status?.board;
      const backlog = boardStatus?.backlog ?? { ready: [] };
      const readyColumn = (backlog["ready"] ?? []) as string[];
      if (!readyColumn.includes(taskId)) {
        const currentCol = Object.entries(backlog).find(([, ids]) =>
          (ids as string[]).includes(taskId),
        )?.[0] ?? "unknown";
        throw new Error(`Task ${taskId} is in column "${currentCol}", not "ready". Use force_retry to clean up first.`);
      }

      const existingWorker = (boardStatus?.workers ?? []).find((w) => w.taskId === taskId);
      const retryCount = args.retryCount !== undefined
        ? Number(args.retryCount)
        : (existingWorker?.retryCount ?? 0);

      const runName = workerRunName(projectName, taskId, retryCount);
      const workerRun = buildWorkerRun(project, taskDef, runName, retryCount, reworkFeedback);
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

      const newBacklog = moveTask(backlog, taskId, "in-progress");
      const workers = [...(boardStatus?.workers ?? [])];
      const newWorkers = upsertWorker(workers, {
        taskId,
        runName,
        status: "Running",
        branch: `feat/${taskId}`,
        startedAt: new Date().toISOString(),
        retryCount,
        facilitated: false,
      });

      await patchProjectStatus(projectName, {
        board: {
          backlog: newBacklog,
          workers: newWorkers,
          activeWorkers: newWorkers.filter((w) => w.status === "Running" && !!w.runName).length,
          lastEventAt: new Date().toISOString(),
        },
      }, resourceNs);

      return { runName, project: projectName, task: taskId, phase: "Created", namespace: resourceNs };
    }

    case "force_retry": {
      const projectName = String(args.project ?? "");
      const taskId = String(args.task ?? "");
      const shouldCreate = args.createRun !== false;
      const resourceNs = String(args.namespace ?? ns);

      const allRuns = await listRuns(resourceNs);
      const taskRuns = allRuns.filter((r) => {
        const labels = r.metadata.labels ?? {};
        return labels[LABELS.projectName] === projectName && labels[LABELS.taskId] === taskId;
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
      const boardStatus = project.status?.board ?? { backlog: { ready: [] }, workers: [] };
      const currentWorkers = (boardStatus.workers ?? []).filter((w) => w.taskId !== taskId);
      const newBacklog = moveTask(boardStatus.backlog ?? { ready: [] }, taskId, "ready");

      await patchProjectStatus(projectName, {
        board: {
          backlog: newBacklog,
          workers: currentWorkers,
          activeWorkers: currentWorkers.filter((w) => w.status === "Running" && !!w.runName).length,
          lastEventAt: new Date().toISOString(),
        },
      }, resourceNs);

      let createdRunName: string | undefined;
      if (shouldCreate) {
        const board = project.spec.board;
        if (!board) throw new Error(`Project ${projectName} has no board configured`);
        const taskDef = (board.tasks ?? []).find((t) => t.id === taskId);
        if (!taskDef) throw new Error(`Task ${taskId} not found in project ${projectName} board`);

        const runName = workerRunName(projectName, taskId, 0);
        const workerRun = buildWorkerRun(project, taskDef, runName, 0);

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

        const newWorkers = upsertWorker(currentWorkers, {
          taskId,
          runName,
          status: "Running",
          branch: `feat/${taskId}`,
          startedAt: new Date().toISOString(),
          retryCount: 0,
          facilitated: false,
        });

        await patchProjectStatus(projectName, {
          board: {
            backlog: moveTask(newBacklog, taskId, "in-progress"),
            workers: newWorkers,
            activeWorkers: newWorkers.filter((w) => w.status === "Running" && !!w.runName).length,
            lastEventAt: new Date().toISOString(),
          },
        }, resourceNs);

        createdRunName = runName;
      }

      return {
        project: projectName,
        task: taskId,
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

      if (serviceName && runSessionID) {
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
        } catch (e) {
          // Service unreachable — fall through to ConfigMap
        }
      }

      // Fallback: ConfigMap snapshot (completed run)
      const fallbackSessionID = runSessionID ?? "";
      const cmData = await readSessionConfigMap(runName, fallbackSessionID, resourceNs);
      if (cmData) {
        return {
          messages: cmData.messages.slice(since),
          total: cmData.messages.length,
          nextSince: cmData.messages.length,
          runPhase,
          sessionID: fallbackSessionID,
          source: "configmap",
          truncated: cmData.truncated,
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
