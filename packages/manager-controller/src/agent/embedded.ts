// agent/embedded.ts — OpenCode 2 embedded in the manager process.
//
// Until v0.2.24 the manager talked to an `opencode-web` sidecar container over
// 127.0.0.1:4096. That sidecar is now the runner-opencode facade started here,
// in-process, bound to loopback on the same port — so agent/session.ts,
// stats-reporter.ts and the list_models tool keep speaking the v1 HTTP API
// they always did, and nothing in the pod races the manager at startup.
//
// Inputs are the ones the sidecar received, now on the manager container:
//   OPENCODE_CONFIG_CONTENT   agent-config ConfigMap (opencode.json)
//   OPENCODE_AUTH_CONTENT     agent-auth Secret (auth.json), optional
//   /root/.config/opencode/agents/*.md   agent-config's manager-decision.md
//
// Set AGENT_OPENCODE_EMBEDDED=0 to skip this and talk to an external server at
// AGENT_OPENCODE_URL instead (a dev box running `opencode serve`, or the old
// sidecar during a staged rollout).

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startFacade } from '@percussionist/runner-opencode';
import { OPENCODE_URL } from './config.js';

const log = (...args: unknown[]) => console.log(`[agent ${new Date().toISOString()}]`, ...args);
const err = (...args: unknown[]) => console.error(`[agent ${new Date().toISOString()}]`, ...args);

export const OPENCODE_EMBEDDED = process.env.AGENT_OPENCODE_EMBEDDED !== '0';

/** Sessions need a directory to live in; the manager has no repository checkout. */
const WORKSPACE = process.env.AGENT_OPENCODE_WORKSPACE ?? '/tmp/percussionist-manager';

const AGENTS_DIR =
  process.env.OPENCODE_AGENTS_DIR ??
  join(process.env.HOME ?? '/root', '.config', 'opencode', 'agents');

let closer: (() => Promise<void>) | undefined;

/**
 * Start the embedded host on the loopback address and port that
 * AGENT_OPENCODE_URL names. Throws when the URL is not loopback: binding an
 * embedded LLM runtime on a routable interface is never what a manager wants.
 */
export async function startEmbeddedOpencode(): Promise<void> {
  const url = new URL(OPENCODE_URL);
  const hostname = url.hostname;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname)) {
    throw new Error(
      `AGENT_OPENCODE_URL (${OPENCODE_URL}) must be a loopback address when AGENT_OPENCODE_EMBEDDED is on`,
    );
  }
  const port = Number(url.port || 4096);
  mkdirSync(WORKSPACE, { recursive: true });

  const facade = await startFacade({
    workspace: WORKSPACE,
    configContent: process.env.OPENCODE_CONFIG_CONTENT,
    authContent: process.env.OPENCODE_AUTH_CONTENT,
    agentsDir: AGENTS_DIR,
    port,
    hostname: hostname === 'localhost' ? '127.0.0.1' : hostname.replace(/^\[|\]$/g, ''),
    permissionMode: 'allow',
    logEvents: process.env.AGENT_OPENCODE_LOG_EVENTS === '1',
    version: `manager-embedded`,
    log: (m) => log(`[opencode] ${m}`),
    warn: (m) => err(`[opencode] ${m}`),
  });
  closer = facade.close;
  log(`embedded opencode ready on ${hostname}:${port} (sdk ${facade.sdkVersion})`);
}

export async function stopEmbeddedOpencode(): Promise<void> {
  const c = closer;
  closer = undefined;
  if (c) await c();
}
