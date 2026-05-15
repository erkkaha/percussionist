// agent/tools.ts — MCP server exposing K8s tools to the agent.
//
// Follows the same JSON-RPC 2.0 / MCP Streamable HTTP pattern as the
// dispatcher's mcp-server.ts. Runs on AGENT_MCP_PORT (default 4097).
//
// The agent module uses these tools internally via direct HTTP calls.
// opencode-web does NOT support mcpServers config, so tools are not
// discovered by the sidecar — the module provides context inline.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { MCP_PORT, MANAGER_NAMESPACE } from "./config.js";
import {
  getRun,
  getProject,
  listRuns,
  readPodLog,
  readSessionConfigMap,
} from "@percussionist/kube";

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
      const result = await readSessionConfigMap(runName, sessionID ?? "", ns);
      if (!result) return { runName, messages: [], note: "no session snapshot found" };
      return { runName, messages: result.messages, truncated: result.truncated };
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
      const { deleteRun } = await import("@percussionist/kube");
      await deleteRun(name, resourceNs);
      return { name, deleted: true };
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
