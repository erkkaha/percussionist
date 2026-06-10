// agent/index.ts — agent module entry point.
//
// The MCP server is started directly by index.ts before the informer so the
// sidecar can discover it at startup. This module handles the rest:
//   1. Waits for the opencode-web sidecar to be healthy.
//   2. Starts the chat handler for interactive conversations.
//   3. Reports readiness.

import { waitForOpencodeWeb } from "./session.js";
import { startChatServer } from "./chat-handler.js";

const log = (...args: unknown[]) =>
  console.log(`[agent ${new Date().toISOString()}]`, ...args);
const err = (...args: unknown[]) =>
  console.error(`[agent ${new Date().toISOString()}]`, ...args);

let started = false;

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

  // 3. Start chat handler (interactive conversations).
  try {
    startChatServer();
  } catch (e) {
    err("failed to start chat handler:", (e as Error).message);
  }

  started = true;
  log("agent module started");
}
