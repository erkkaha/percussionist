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
import { DISPATCHER_MCP_PORT } from "@percussionist/api";
import { fetchMessages, type RawMessage, type ToolPart } from "./session.js";

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
// Git workflow validation

/**
 * Validates that the agent has completed the required git workflow steps
 * before allowing complete_run to succeed.
 * 
 * Returns array of error messages (empty if validation passes).
 */
async function validateGitWorkflow(sessionID: string): Promise<string[]> {
  const errors: string[] = [];

  // Skip validation for merge-only tasks that prohibit code changes.
  const taskDesc = process.env.RUN_TASK ?? "";
  if (/do not perform any code changes/i.test(taskDesc)) {
    return errors;
  }

  try {
    const messages: RawMessage[] = await fetchMessages(sessionID);
    
    // Extract all bash commands from the session
    const bashCommands: string[] = [];
    for (const msg of messages) {
      if (msg.info?.role === "assistant" && msg.parts) {
        for (const part of msg.parts) {
          const toolPart = part as ToolPart;
          if (toolPart.type === "tool" && toolPart.tool === "bash") {
            const cmd = toolPart.state?.input as { command?: string } | undefined;
            if (cmd?.command) {
              bashCommands.push(cmd.command);
            }
          }
        }
      }
    }
    
    // Check for required git operations
    const hasGitCommit = bashCommands.some(cmd => 
      cmd.includes("git commit") && !cmd.includes("git commit --amend")
    );
    const hasGitPush = bashCommands.some(cmd => 
      cmd.includes("git push")
    );
    const hasPRCreate = bashCommands.some(cmd => 
      cmd.includes("gh pr create")
    );
    const hasCheckoutBranch = bashCommands.some(cmd =>
      cmd.includes("git checkout -b")
    );
    
    // Validate workflow steps
    if (!hasCheckoutBranch) {
      errors.push("❌ No feature branch created (missing 'git checkout -b')");
    }
    
    if (!hasGitCommit) {
      errors.push("❌ No git commit detected (missing 'git commit')");
    }
    
    if (!hasGitPush) {
      errors.push("❌ Changes not pushed to remote (missing 'git push')");
    }
    
    if (!hasPRCreate) {
      errors.push("❌ No pull request created (missing 'gh pr create')");
    }
    
  } catch (e) {
    // If validation fails for technical reasons, log but allow completion
    // (don't block agents due to our own bugs)
    console.error(`[mcp-server] git workflow validation error:`, (e as Error).message);
  }
  
  return errors;
}

/**
 * Lightweight git workflow validation for PLAN tasks.
 * Only checks commit + push (no PR required).
 */
async function validateGitWorkflowPlan(sessionID: string): Promise<string[]> {
  const errors: string[] = [];

  const taskDesc = process.env.RUN_TASK ?? "";
  if (/do not perform any code changes/i.test(taskDesc)) {
    return errors;
  }

  try {
    const messages: RawMessage[] = await fetchMessages(sessionID);

    const bashCommands: string[] = [];
    for (const msg of messages) {
      if (msg.info?.role === "assistant" && msg.parts) {
        for (const part of msg.parts) {
          const toolPart = part as ToolPart;
          if (toolPart.type === "tool" && toolPart.tool === "bash") {
            const cmd = toolPart.state?.input as { command?: string } | undefined;
            if (cmd?.command) {
              bashCommands.push(cmd.command);
            }
          }
        }
      }
    }

    const hasGitCommit = bashCommands.some(cmd =>
      cmd.includes("git commit") && !cmd.includes("git commit --amend")
    );
    const hasGitPush = bashCommands.some(cmd =>
      cmd.includes("git push")
    );

    if (!hasGitCommit) {
      errors.push("❌ No git commit detected (missing 'git commit')");
    }

    if (!hasGitPush) {
      errors.push("❌ Changes not pushed to remote (missing 'git push')");
    }

  } catch (e) {
    console.error(`[mcp-server] git workflow validation error:`, (e as Error).message);
  }

  return errors;
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
  onCompleteRun: (summary: string) => void,
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
      return ok(req.id, { tools: [TOOL_FAIL_RUN, TOOL_COMPLETE_RUN, TOOL_COMPLETE_PLAN, TOOL_GET_STATUS] });

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

      if (toolName === "complete_run") {
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        const summary = typeof args["summary"] === "string"
          ? args["summary"]
          : "agent called complete_run without a summary";
        
        // Validate git workflow before allowing completion
        const status = getStatus();
        const sessionID = status?.session;
        
        if (sessionID) {
          // Async validation - return a promise
          return (async () => {
            const validationErrors = await validateGitWorkflow(sessionID);
            
            if (validationErrors.length > 0) {
              const errorMsg = [
                "⚠️  Cannot complete run - required git workflow steps are missing:",
                "",
                ...validationErrors,
                "",
                "Required workflow:",
                "1. Create feature branch: git checkout -b <branch-name>",
                "2. Commit changes: git add -A && git commit -m \"...\"",
                "3. Push to remote: git push -u origin <branch-name>",
                "4. Create pull request: gh pr create --title \"...\" --body \"...\"",
                "",
                "Please complete these steps, then call complete_run again.",
              ].join("\n");
              
              return ok(req.id, {
                content: [{ type: "text", text: errorMsg }],
                isError: true,
              });
            }
            
            // Validation passed - proceed with completion
            onCompleteRun(summary);
            return ok(req.id, {
              content: [{ type: "text", text: "Run marked as complete. The orchestrator will review the result." }],
            });
          })();
        }
        
        // No session ID available (shouldn't happen, but be safe)
        onCompleteRun(summary);
        return ok(req.id, {
          content: [{ type: "text", text: "Run marked as complete. The orchestrator will review the result." }],
        });
      }

      if (toolName === "complete_plan") {
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        const summary = typeof args["summary"] === "string"
          ? args["summary"]
          : "agent called complete_plan without a summary";

        const status = getStatus();
        const sessionID = status?.session;

        if (sessionID) {
          return (async () => {
            const validationErrors = await validateGitWorkflowPlan(sessionID);

            if (validationErrors.length > 0) {
              const errorMsg = [
                "⚠️  Cannot complete plan - required git workflow steps are missing:",
                "",
                ...validationErrors,
                "",
                "Required workflow for PLAN tasks:",
                "1. Commit changes: git add -A && git commit -m \"...\"",
                "2. Push to remote: git push -u origin <branch-name>",
                "",
                "Please complete these steps, then call complete_plan again.",
              ].join("\n");

              return ok(req.id, {
                content: [{ type: "text", text: errorMsg }],
                isError: true,
              });
            }

            onCompleteRun(summary);
            return ok(req.id, {
              content: [{ type: "text", text: "Plan marked as complete. The orchestrator will review the plan artifact." }],
            });
          })();
        }

        onCompleteRun(summary);
        return ok(req.id, {
          content: [{ type: "text", text: "Plan marked as complete. The orchestrator will review the plan artifact." }],
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
  onCompleteRun: (summary: string) => void,
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
            handleMcp(rpc, onFailRun, onCompleteRun, getStatus); // side-effects only (e.g. notifications/initialized)
            res.writeHead(202);
            res.end();
            return;
          }

          const response = await Promise.resolve(handleMcp(rpc, onFailRun, onCompleteRun, getStatus));
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
