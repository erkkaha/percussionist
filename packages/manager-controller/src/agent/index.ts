// agent/index.ts — agent module entry point.
//
// The MCP server is started directly by index.ts before the informer so the
// agent runtime can discover it at startup. This module handles the rest:
//   1. Starts the embedded OpenCode host (or waits for an external one when
//      AGENT_OPENCODE_EMBEDDED=0) and confirms it is healthy.
//   2. Starts the chat handler for interactive conversations.
//   3. Reports readiness.

import { startChatServer } from './chat-handler.js';
import { OPENCODE_EMBEDDED, startEmbeddedOpencode } from './embedded.js';
import { waitForOpencodeWeb } from './session.js';

const log = (...args: unknown[]) => console.log(`[agent ${new Date().toISOString()}]`, ...args);
const err = (...args: unknown[]) => console.error(`[agent ${new Date().toISOString()}]`, ...args);

let started = false;

export async function startAgent(): Promise<void> {
  if (started) return;

  log('starting agent module...');

  // 1. Bring up the agent runtime. Embedded by default; the health check is
  //    kept for both modes so a misconfigured embedded host is reported the
  //    same way an unreachable sidecar used to be.
  try {
    if (OPENCODE_EMBEDDED) {
      log('starting embedded opencode host...');
      await startEmbeddedOpencode();
    } else {
      log('AGENT_OPENCODE_EMBEDDED=0 — waiting for external opencode server...');
    }
    await waitForOpencodeWeb(120_000);
    log('opencode host is healthy');
  } catch (e) {
    err('opencode host not available:', (e as Error).message);
    err('agent will retry in background; decision engine will be degraded');
    // Don't crash the manager — continue without the agent
  }

  // 3. Start chat handler (interactive conversations).
  try {
    startChatServer();
  } catch (e) {
    err('failed to start chat handler:', (e as Error).message);
  }

  started = true;
  log('agent module started');
}
