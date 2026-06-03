// mcp-server.ts — minimal MCP (Model Context Protocol) HTTP server.
//
// Exposes three tools: fail_run(reason), complete_run(summary), get_status()
//
// fail_run — the agent calls this to signal that it cannot complete its task.
// The dispatcher detects the call and throws a "session error:" which causes
// the standard failure path: main().catch → patchStatus(Failed).
//
// complete_run — the agent calls this to explicitly signal successful completion
// with a human-readable summary. The orchestrator spawns a success-review
// facilitator that approves or redirects the result before closing the task.
//
// get_status — returns the current run state (phase, session ID, tokens, etc.)
// for agent self-awareness without cluster API access.
//
// Transport: MCP Streamable HTTP (POST /mcp), JSON-RPC 2.0.
// Port: DISPATCHER_MCP_PORT (4097) — adjacent to opencode's 4096, unlikely
// to conflict with common dev tooling.
//
// Opencode discovers this server via OPENCODE_CONFIG_CONTENT injected by the
// operator into the runner container's environment.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { DISPATCHER_MCP_PORT } from "@percussionist/api";
import { getProject, buildTask, createTask } from "@percussionist/kube";
import { recordToolEvent } from "./tool-events-reporter.js";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "percussionist-dispatcher";
const SERVER_VERSION = "1.0";

const TOOL_FAIL_RUN = {
  name: "fail_run",
  description:
    "Signal that this agent run has failed and cannot be completed. " +
    "The orchestrator will trigger facilitator analysis of the failure. " +
    "Call this instead of stopping silently when you determine the task is impossible.",
  inputSchema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "Human-readable explanation of why the task cannot be completed.",
      },
    },
    required: ["reason"],
  },
};

const TOOL_COMPLETE_RUN = {
  name: "complete_run",
  description:
    "Signal that this agent run has completed successfully. " +
    "The orchestrator will trigger a success review by a facilitator agent, " +
    "which may approve the result or redirect the task to another agent. " +
    "Call this when you have finished your work and want an explicit review gate " +
    "rather than relying on silent session completion.",
  inputSchema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "Human-readable summary of what was accomplished.",
      },
    },
    required: ["summary"],
  },
};

const TOOL_COMPLETE_PLAN = {
  name: "complete_plan",
  description:
    "Signal that this PLAN agent run has completed successfully. " +
    "Unlike complete_run, this does not require a pull request. " +
    "The orchestrator will evaluate the plan artifact and generate BUILD tasks. " +
    "Call this after committing and pushing the plan artifact.",
  inputSchema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "Human-readable summary of what the plan covers.",
      },
    },
    required: ["summary"],
  },
};

const TOOL_GET_STATUS = {
  name: "get_status",
  description:
    "Return the current status of this agent run (phase, session ID, token counts). " +
    "Useful for self-awareness without cluster API access.",
  inputSchema: { type: "object", properties: {} },
};

const TOOL_CREATE_TASK = {
  name: "create_task",
  description:
    "Create a new BUILD Task CR for the current project. " +
    "Starts in 'pending' phase (backlog column). " +
    "The agent name must be in the project's agent roster. " +
    "Returns the created task name via a 'taskName' field for use with predecessorRef.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short human-readable title for the BUILD task" },
      description: { type: "string", description: "Detailed implementation context and acceptance criteria (optional)" },
      agent: { type: "string", description: "Agent name (must be in project's agent roster)" },
      priority: { type: "string", enum: ["high", "medium", "low"], description: "Priority (default: medium)" },
      predecessorRef: { type: "string", description: "Name of the preceding BUILD task this task depends on (optional)" },
    },
    required: ["title", "agent"],
  },
};

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

// ---------------------------------------------------------------------------
// Request body reader

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// MCP handler

type RunStatus = {
  phase: string;
  session?: string;
  tokensIn?: number;
  tokensOut?: number;
};

async function handleCreateTask(
  id: JsonRpcRequest["id"],
  args: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  const projectName = process.env.RUN_PROJECT ?? "";
  const boardTask = process.env.RUN_BOARD_TASK ?? "";
  const ns = process.env.RUN_NAMESPACE ?? "percussionist";

  if (!projectName) {
    return rpcError(id, -32602, "RUN_PROJECT not set");
  }

  const title = String(args.title ?? "");
  const agent = String(args.agent ?? "");
  if (!title || !agent) {
    return rpcError(id, -32602, "title and agent are required");
  }
  const description = args.description ? String(args.description) : undefined;
  const priority = String(args.priority ?? "medium");
  const predecessorRef = args.predecessorRef ? String(args.predecessorRef) : undefined;

  try {
    const project = await getProject(projectName, ns);
    const roster = (project.spec.agents ?? []).map((a: { name: string }) => a.name);
    if (!roster.includes(agent)) {
      return rpcError(id, -32602, `agent "${agent}" not in project roster: ${roster.join(", ") || "(empty)"}`);
    }

    const suffix = randomBytes(3).toString("hex");
    const taskName = `${projectName}-build-${suffix}`;

    const task = buildTask({
      name: taskName,
      projectName,
      projectUid: project.metadata.uid ?? "",
      ns,
      spec: {
        projectRef: projectName,
        type: "BUILD",
        title,
        description,
        agent,
        priority: priority as "high" | "medium" | "low",
        parentTaskRef: boardTask || undefined,
        predecessorRef,
      },
    });

    await createTask(task, ns);

    return ok(id, {
      content: [{ type: "text", text: JSON.stringify({ taskName, project: projectName, type: "BUILD", phase: "pending" }) }],
    });
  } catch (e) {
    return rpcError(id, -32603, `failed to create task: ${(e as Error).message}`);
  }
}

function handleMcp(
  req: JsonRpcRequest,
  onFailRun: (reason: string) => void,
  onCompleteRun: (summary: string) => void,
  onCompletePlan: (summary: string) => void,
  getStatus: () => RunStatus | null,
): JsonRpcResponse | Promise<JsonRpcResponse> {
  switch (req.method) {
    case "initialize":
      return ok(req.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });

    case "notifications/initialized":
      // Fire-and-forget notification — no response needed, but respond anyway
      // with a no-op to keep some clients happy.
      return ok(req.id, {});

    case "tools/list":
      return ok(req.id, { tools: [TOOL_FAIL_RUN, TOOL_COMPLETE_RUN, TOOL_COMPLETE_PLAN, TOOL_GET_STATUS, TOOL_CREATE_TASK] });

    case "tools/call": {
      const toolName = (req.params?.name as string | undefined) ?? "";
      const calledAt = new Date().toISOString();
      const start = Date.now();

      const record = (success: boolean, error?: string): void => {
        recordToolEvent({
          toolName, isMcp: true, calledAt, success,
          durationMs: Date.now() - start,
          error,
        });
      };

      if (toolName === "fail_run") {
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        const reason = typeof args["reason"] === "string"
          ? args["reason"]
          : "agent called fail_run without a reason";
        onFailRun(reason);
        record(true);
        return ok(req.id, {
          content: [{ type: "text", text: "Run marked as failed. The orchestrator will investigate." }],
        });
      }

      if (toolName === "complete_run") {
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        const summary = typeof args["summary"] === "string"
          ? args["summary"]
          : "agent called complete_run without a summary";
        onCompleteRun(summary);
        record(true);
        return ok(req.id, {
          content: [{ type: "text", text: "Run marked as complete. The orchestrator will review the result." }],
        });
      }

      if (toolName === "complete_plan") {
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        const summary = typeof args["summary"] === "string"
          ? args["summary"]
          : "agent called complete_plan without a summary";
        onCompletePlan(summary);
        record(true);
        return ok(req.id, {
          content: [{ type: "text", text: "Plan marked as complete. The orchestrator will review the plan artifact." }],
        });
      }

      if (toolName === "get_status") {
        const status = getStatus();
        if (!status) {
          record(false, "status not available");
          return ok(req.id, {
            content: [{ type: "text", text: JSON.stringify({ phase: "unknown", error: "status not yet available" }) }],
          });
        }
        record(true);
        return ok(req.id, {
          content: [{ type: "text", text: JSON.stringify(status) }],
        });
      }

      if (toolName === "create_task") {
        const result = handleCreateTask(req.id, (req.params?.arguments ?? {}) as Record<string, unknown>);
        if (result instanceof Promise) {
          return result.then(
            (res) => { record(true); return res; },
            (err) => { record(false, (err as Error).message); throw err; },
          );
        }
        record(true);
        return result;
      }

      record(false, "unknown tool");
      return rpcError(req.id, -32602, `unknown tool: ${toolName}`);
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

export function startMcpServer(
  onFailRun: (reason: string) => void,
  onCompleteRun: (summary: string) => void,
  onCompletePlan: (summary: string) => void,
  getStatus: () => RunStatus | null,
): Promise<McpServer> {
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
            const errRes: JsonRpcResponse = rpcError(null, -32700, "parse error");
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify(errRes));
            return;
          }

          // Notifications have no id — return 202 with empty body.
          if (rpc.id === undefined || rpc.id === null) {
            handleMcp(rpc, onFailRun, onCompleteRun, onCompletePlan, getStatus); // side-effects only (e.g. notifications/initialized)
            res.writeHead(202);
            res.end();
            return;
          }

          const response = await Promise.resolve(handleMcp(rpc, onFailRun, onCompleteRun, onCompletePlan, getStatus));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(response));
        })
        .catch((e) => {
          const errRes: JsonRpcResponse = rpcError(null, -32603, String((e as Error).message));
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify(errRes));
        });
    });

    server.on("error", reject);
    server.listen(DISPATCHER_MCP_PORT, "127.0.0.1", () => {
      resolve({
        close() {
          server.close();
        },
      });
    });
  });
}
