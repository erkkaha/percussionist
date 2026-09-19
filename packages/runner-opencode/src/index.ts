// index.ts — runner-opencode: serves percussionist's runner API on 4096,
// backed by OpenCode 2 embedded in-process (`@opencode/sdk`) instead of the
// `opencode serve` binary.
//
// The endpoint set is exactly what packages/dispatcher already calls (see
// dispatcher/src/session.ts, the BASE_URL fetches in dispatcher/src/polling.ts
// and dispatcher/src/stats-reporter.ts); packages/runner-claude serves the same
// set over the Claude Agent SDK, and the manager controller embeds this same
// facade in-process (see facade.ts):
//
//   GET  /global/health          → { healthy, version }
//   GET  /provider               → { all, default, connected }  (manager list_models)
//   POST /session                → { id, title }        (dispatcher creates first)
//   GET  /session                → [{ id, title }]
//   GET  /session/:id/message    → transcript, oldest first
//   POST /session/:id/message    → push a user turn ({ parts, agent?, model? })
//   GET  /event                  → SSE: server.connected, message.updated, session.idle
//
// Match it and the dispatcher, the stats reporter, the web dashboard and the
// deterministic e2e fixtures need no changes at all. The image that ships this
// also installs an `opencode` shim that accepts `serve --hostname … --port …`,
// so it is a drop-in `spec.image` for the default engine.

import { join } from 'node:path';
import { startFacade } from './facade.js';
import type { PermissionMode } from './plugin.js';

const PORT = Number(
  process.env.PORT ?? process.env.RUNNER_PORT ?? process.env.OPENCODE_PORT ?? 4096,
);
const WORKSPACE = process.env.WORKSPACE_DIR ?? '/workspace';
const DISPATCHER_MCP_URL = process.env.DISPATCHER_MCP_URL ?? 'http://127.0.0.1:4097/mcp';
/** Where the operator mounts the agents ConfigMap (RunnerImageSpec.configMountPath/agentsDirRelative). */
const AGENTS_DIR =
  process.env.OPENCODE_AGENTS_DIR ??
  join(process.env.HOME ?? '/root', '.config', 'opencode', 'agents');
const PERMISSION_MODE: PermissionMode =
  process.env.RUNNER_PERMISSION_MODE === 'ask' ? 'ask' : 'allow';
const LOG_EVENTS = process.env.RUNNER_LOG_EVENTS === '1';

const log = (msg: string): void => console.log(`[runner-opencode] ${msg}`);
const warn = (msg: string): void => console.error(`[runner-opencode] ${msg}`);

async function main(): Promise<void> {
  const facade = await startFacade({
    workspace: WORKSPACE,
    configContent: process.env.OPENCODE_CONFIG_CONTENT,
    authContent: process.env.OPENCODE_AUTH_CONTENT,
    agentsDir: AGENTS_DIR,
    dispatcherMcpUrl: DISPATCHER_MCP_URL,
    port: PORT,
    hostname: '0.0.0.0',
    permissionMode: PERMISSION_MODE,
    logEvents: LOG_EVENTS,
    version: process.env.RUNNER_OPENCODE_VERSION,
    log,
    warn,
  });

  const shutdown = async (signal: string): Promise<void> => {
    log(`${signal} received; closing host`);
    await facade
      .close()
      .catch((e) => warn(`close failed: ${e instanceof Error ? e.message : String(e)}`));
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => {
  warn(`fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(1);
});
