// agent/index.ts — agent module entry point.
//
// Initialises the agent subsystem:
//   1. Waits for the opencode-web sidecar to be healthy.
//   2. Starts the MCP server for K8s tools.
//   3. Starts the chat handler for interactive conversations.
//   4. Reports readiness.

import { waitForOpencodeWeb } from "./session.js";
import { startMcpServer } from "./tools.js";
import { startChatServer } from "./chat-handler.js";
import type { McpServer } from "./tools.js";

const log = (...args: unknown[]) =>
  console.log(`[agent ${new Date().toISOString()}]`, ...args);
const err = (...args: unknown[]) =>
  console.error(`[agent ${new Date().toISOString()}]`, ...args);

let mcp: McpServer | null = null;
let started = false;

export function isAgentReady(): boolean {
  return started;
}

export async function startAgent(): Promise<void> {
  if (started) return;

  log("starting agent module...");

  // 1. Wait for opencode-web sidecar.
  try {
    log("waiting for opencode-web sidecar...");
    await waitForOpencodeWeb(120_000);
    log("opencode-web sidecar is healthy");
  } catch (e) {
    err("opencode-web sidecar not available:", (e as Error).message);
    err("agent will retry in background; decision engine will be degraded");
    // Don't crash the manager — continue without the agent
  }

  // 2. Start MCP server (K8s tools for the agent).
  try {
    mcp = await startMcpServer();
  } catch (e) {
    err("failed to start MCP server:", (e as Error).message);
  }

  // 3. Start chat handler (interactive conversations).
  try {
    startChatServer();
  } catch (e) {
    err("failed to start chat handler:", (e as Error).message);
  }

  started = true;
  log("agent module started");
}

export function stopAgent(): void {
  if (mcp) {
    mcp.close();
    mcp = null;
  }
  started = false;
  log("agent module stopped");
}
