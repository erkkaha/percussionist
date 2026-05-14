// mcp-server.ts — minimal MCP (Model Context Protocol) HTTP server.
//
// Exposes two tools: fail_run(reason), get_status()
//
// fail_run — the agent calls this to signal that it cannot complete its task.
// The dispatcher detects the call and throws a "session error:" which causes
// the standard failure path: main().catch → patchStatus(Failed).
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
import { DISPATCHER_MCP_PORT } from "@percussionist/api";

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

const TOOL_GET_STATUS = {
  name: "get_status",
  description:
    "Return the current status of this agent run (phase, session ID, token counts). " +
    "Useful for self-awareness without cluster API access.",
  inputSchema: { type: "object", properties: {} },
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

function handleMcp(
  req: JsonRpcRequest,
  onFailRun: (reason: string) => void,
  getStatus: () => RunStatus | null,
): JsonRpcResponse {
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
      return ok(req.id, { tools: [TOOL_FAIL_RUN, TOOL_GET_STATUS] });

    case "tools/call": {
      const toolName = (req.params?.name as string | undefined) ?? "";
      if (toolName === "fail_run") {
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        const reason = typeof args["reason"] === "string"
          ? args["reason"]
          : "agent called fail_run without a reason";
        onFailRun(reason);
        return ok(req.id, {
          content: [{ type: "text", text: "Run marked as failed. The orchestrator will investigate." }],
        });
      }

      if (toolName === "get_status") {
        const status = getStatus();
        if (!status) {
          return ok(req.id, {
            content: [{ type: "text", text: JSON.stringify({ phase: "unknown", error: "status not yet available" }) }],
          });
        }
        return ok(req.id, {
          content: [{ type: "text", text: JSON.stringify(status) }],
        });
      }

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
        .then((body) => {
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
            handleMcp(rpc, onFailRun, getStatus); // side-effects only (e.g. notifications/initialized)
            res.writeHead(202);
            res.end();
            return;
          }

          const response = handleMcp(rpc, onFailRun, getStatus);
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
