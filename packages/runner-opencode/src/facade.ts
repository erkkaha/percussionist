// facade.ts — the v1 runner HTTP API served over an embedded OpenCode 2 host.
//
// Exported as a library so two processes can use it:
//   - the runner image (src/index.ts) on 0.0.0.0:4096 in run pods, and
//   - the manager controller on 127.0.0.1:4096 in its own process, replacing
//     the opencode-web sidecar it used to talk to over that same port.
//
// The endpoint set is exactly what packages/dispatcher and the manager's
// agent/session.ts already call; see index.ts for the list.

import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { type ServerType, serve } from '@hono/node-server';
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

const require = createRequire(import.meta.url);
/** The exact @opencode/sdk pin from this package's manifest (its own package.json is not exported). */
export const SDK_VERSION: string =
  (require('../package.json') as { dependencies?: Record<string, string> }).dependencies?.[
    '@opencode/sdk'
  ] ?? 'unknown';

export type FacadeOptions = {
  /** Directory sessions run in (the agent's cwd). */
  workspace: string;
  /** v1 opencode.json (OPENCODE_CONFIG_CONTENT). */
  configContent?: string;
  /** v1 auth.json (OPENCODE_AUTH_CONTENT). */
  authContent?: string;
  /** Directory of ClusterAgent-format *.md files to inline as agents. */
  agentsDir?: string;
  /** When set, guarantees an MCP entry pointing at the dispatcher. */
  dispatcherMcpUrl?: string;
  port: number;
  hostname: string;
  permissionMode?: PermissionMode;
  logEvents?: boolean;
  /** Reported by GET /global/health. */
  version?: string;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
};

export type Facade = {
  host: RunnerHost;
  server: ServerType;
  sdkVersion: string;
  /** Stop accepting connections and release the embedded host. */
  close: () => Promise<void>;
};

export function readAgentFiles(dir: string | undefined): AgentFile[] {
  if (!dir) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((f) => ({ name: f.replace(/\.md$/, ''), content: readFileSync(join(dir, f), 'utf8') }));
  } catch {
    return [];
  }
}

/**
 * Put env-method credentials (see config.ts OAUTH_ENV_CREDENTIALS) in place.
 * Must run before the SDK boots: it reads the environment when it builds the
 * provider registry.
 */
export function applyEnvCredentials(
  authContent: string | undefined,
  log: (m: string) => void,
  warn: (m: string) => void,
): void {
  for (const cred of envCredentials(authContent)) {
    if (process.env[cred.env] && process.env[cred.env] !== cred.value) {
      warn(
        `auth: ${cred.env} is already set in the environment; leaving it — ${cred.providerID} will use that token, not the one from auth.json`,
      );
      continue;
    }
    process.env[cred.env] = cred.value;
    log(`auth: ${cred.providerID} token exposed as ${cred.env}`);
  }
}

export async function startFacade(opts: FacadeOptions): Promise<Facade> {
  const log = opts.log ?? ((m: string) => console.log(`[runner-opencode] ${m}`));
  const warn = opts.warn ?? ((m: string) => console.error(`[runner-opencode] ${m}`));
  const permissionMode = opts.permissionMode ?? 'allow';
  const version = opts.version ?? `sdk-${SDK_VERSION}`;

  const agentFiles = readAgentFiles(opts.agentsDir);
  const built = buildConfigContent({
    configContent: opts.configContent,
    authContent: opts.authContent,
    agentFiles,
    dispatcherMcpUrl: opts.dispatcherMcpUrl,
  });
  for (const n of built.notes) log(n);
  for (const w of built.warnings) warn(w);
  const authPath = materializeAuthFile(opts.authContent);
  if (authPath) log(`auth: legacy auth.json materialized at ${authPath}`);
  applyEnvCredentials(opts.authContent, log, warn);

  const host = await RunnerHost.start({
    workspace: opts.workspace,
    configContent: built.content,
    credentials: apiCredentials(opts.authContent),
    permissionMode,
    logEvents: opts.logEvents ?? false,
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

  app.get('/global/health', (c) => c.json({ healthy: true, version, sdk: sdkVersion }));

  /** v1 `GET /provider` — what the manager's list_models tool reads. */
  app.get('/provider', async (c) => c.json(await host.providers()));

  app.post('/session', async (c) => {
    const body = await c.req
      .json<{ title?: string; agent?: string }>()
      .catch(() => ({}) as { title?: string; agent?: string });
    const s = await host.createSession(body.title ?? '', body.agent);
    log(
      `session ${s.id} created (${s.title || 'untitled'}${body.agent ? `, agent ${body.agent}` : ''})`,
    );
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
    // message. Answering immediately is what runner-claude does and both the
    // dispatcher and the manager tolerate it: they poll the transcript.
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
   * SSE. `permission.updated` is only emitted in permission mode `ask`; in the
   * default allow mode nothing ever needs a human, and emitting it would
   * strand a run in WaitingForInput.
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

  const server = serve({ fetch: app.fetch, port: opts.port, hostname: opts.hostname });
  log(
    `${version} listening on ${opts.hostname}:${opts.port} (cwd=${opts.workspace}, sdk=${sdkVersion})`,
  );
  log(`permission mode: ${permissionMode}`);
  if (opts.dispatcherMcpUrl) log(`dispatcher MCP:  ${opts.dispatcherMcpUrl}`);
  log(`agents dir:      ${opts.agentsDir ?? '(none)'} (${agentFiles.length} file(s))`);

  return {
    host,
    server,
    sdkVersion,
    close: async () => {
      server.close();
      await host.close();
    },
  };
}
