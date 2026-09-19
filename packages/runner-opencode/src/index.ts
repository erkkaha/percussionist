// index.ts — runner-opencode: serves percussionist's runner API on 4096,
// backed by OpenCode 2 embedded in-process (`@opencode/sdk`) instead of the
// `opencode serve` binary.
//
// The endpoint set is exactly what packages/dispatcher already calls (see
// dispatcher/src/session.ts, the BASE_URL fetches in dispatcher/src/polling.ts
// and dispatcher/src/stats-reporter.ts); packages/runner-claude serves the same
// set over the Claude Agent SDK:
//
//   GET  /global/health          → { healthy, version }
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

import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  type AgentFile,
  apiCredentials,
  buildConfigContent,
  envCredentials,
  materializeAuthFile,
} from './config.js';
import { RunnerHost, type V1Event } from './host.js';
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

const require = createRequire(import.meta.url);
/** The exact @opencode/sdk pin from this package's manifest (its own package.json is not exported). */
const SDK_VERSION: string =
  (require('../package.json') as { dependencies?: Record<string, string> }).dependencies?.[
    '@opencode/sdk'
  ] ?? 'unknown';
const VERSION = process.env.RUNNER_OPENCODE_VERSION ?? `sdk-${SDK_VERSION}`;

const log = (msg: string): void => console.log(`[runner-opencode] ${msg}`);
const warn = (msg: string): void => console.error(`[runner-opencode] ${msg}`);

function readAgentFiles(dir: string): AgentFile[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((f) => ({ name: f.replace(/\.md$/, ''), content: readFileSync(join(dir, f), 'utf8') }));
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const authContent = process.env.OPENCODE_AUTH_CONTENT;
  const agentFiles = readAgentFiles(AGENTS_DIR);
  const built = buildConfigContent({
    configContent: process.env.OPENCODE_CONFIG_CONTENT,
    authContent,
    agentFiles,
    dispatcherMcpUrl: DISPATCHER_MCP_URL,
  });
  for (const n of built.notes) log(n);
  for (const w of built.warnings) warn(w);
  const authPath = materializeAuthFile(authContent);
  if (authPath) log(`auth: legacy auth.json materialized at ${authPath}`);
  // Env-method credentials must be in place before the SDK boots; it reads the
  // environment when it builds the provider registry.
  for (const cred of envCredentials(authContent)) {
    if (process.env[cred.env] && process.env[cred.env] !== cred.value) {
      warn(
        `auth: ${cred.env} is already set in the pod (githubTokenSecret?); leaving it — ${cred.providerID} will use that token, not the one from auth.json`,
      );
      continue;
    }
    process.env[cred.env] = cred.value;
    log(`auth: ${cred.providerID} token exposed as ${cred.env}`);
  }

  const host = await RunnerHost.start({
    workspace: WORKSPACE,
    configContent: built.content,
    credentials: apiCredentials(authContent),
    permissionMode: PERMISSION_MODE,
    logEvents: LOG_EVENTS,
    log,
    warn,
  });
  const sdkVersion = await host.version();

  const app = new Hono();
  app.onError((e, c) => {
    // SDK errors are Effect failures, not always Error instances; inspect()
    // renders them without risking a second throw inside the handler.
    const detail = inspect(e, { depth: 4, breakLength: Infinity }).slice(0, 2000);
    warn(`${c.req.method} ${c.req.path} failed: ${detail}`);
    return c.json({ error: e instanceof Error ? e.message : detail.slice(0, 300) }, 500);
  });

  app.get('/global/health', (c) => c.json({ healthy: true, version: VERSION, sdk: sdkVersion }));

  app.post('/session', async (c) => {
    const body = await c.req.json<{ title?: string }>().catch(() => ({}) as { title?: string });
    const s = await host.createSession(body.title ?? '');
    log(`session ${s.id} created (${s.title || 'untitled'})`);
    return c.json(s);
  });

  app.get('/session', (c) => c.json(host.listSessions()));

  app.get('/session/:id/message', async (c) => {
    const id = c.req.param('id');
    if (!host.has(id)) return c.json({ error: 'no such session' }, 404);
    return c.json(await host.messages(id));
  });

  app.post('/session/:id/message', async (c) => {
    const id = c.req.param('id');
    if (!host.has(id)) return c.json({ error: 'no such session' }, 404);

    const body = await c.req.json<{
      parts?: Array<{ type?: string; text?: string }>;
      agent?: string;
      model?: { providerID?: string; modelID?: string };
    }>();
    const text = (body.parts ?? [])
      .filter((p) => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('\n');
    if (!text) return c.json({ error: 'no text parts in request' }, 400);

    await host.prompt(id, { text, agent: body.agent, model: body.model });
    // v1 `opencode serve` answered this call with the finished assistant
    // message. Answering immediately is what runner-claude does and the
    // dispatcher tolerates it: usage arrives through message.updated instead.
    return c.json({ ok: true });
  });

  /** Not part of the contract — a one-curl diagnostic from inside the pod. */
  app.post('/session/:id/interrupt', async (c) => {
    const id = c.req.param('id');
    if (!host.has(id)) return c.json({ error: 'no such session' }, 404);
    await host.interrupt(id);
    return c.json({ ok: true });
  });

  /**
   * SSE. `permission.updated` is only emitted in RUNNER_PERMISSION_MODE=ask;
   * in the default allow mode nothing ever needs a human, and emitting it
   * would strand the run in WaitingForInput.
   */
  app.get('/event', (c) =>
    streamSSE(c, async (stream) => {
      await stream.writeSSE({
        data: JSON.stringify({ type: 'server.connected' } satisfies V1Event),
      });

      const queue: string[] = [];
      let wake: (() => void) | undefined;
      const unsubscribe = host.subscribe((ev) => {
        queue.push(JSON.stringify(ev));
        wake?.();
      });
      try {
        while (!stream.closed) {
          const next = queue.shift();
          if (next === undefined) {
            await new Promise<void>((resolve) => {
              wake = resolve;
              setTimeout(resolve, 15_000);
            });
            wake = undefined;
            // Keep-alive so an idle connection is not dropped mid-run.
            if (queue.length === 0) await stream.writeSSE({ data: '', event: 'ping' });
            continue;
          }
          await stream.writeSSE({ data: next });
        }
      } finally {
        unsubscribe();
      }
    }),
  );

  const server = serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' });
  log(`${VERSION} listening on 0.0.0.0:${PORT} (cwd=${WORKSPACE}, sdk=${sdkVersion})`);
  log(`permission mode: ${PERMISSION_MODE}`);
  log(`dispatcher MCP:  ${DISPATCHER_MCP_URL}`);
  log(`agents dir:      ${AGENTS_DIR} (${agentFiles.length} file(s))`);

  const shutdown = async (signal: string): Promise<void> => {
    log(`${signal} received; closing host`);
    server.close();
    await host
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
