// index.ts — runner-claude: serves percussionist's runner API on 4096, backed
// by the Claude Agent SDK instead of `opencode serve`.
//
// The endpoint set below is not a design choice — it is exactly what
// packages/dispatcher already calls (see dispatcher/src/session.ts and the
// BASE_URL fetches in dispatcher/src/polling.ts):
//
//   GET  /global/health          → { healthy, version }
//   POST /session                → { id, title }        (dispatcher creates first)
//   GET  /session                → [{ id, title }]
//   GET  /session/:id/message    → transcript
//   POST /session/:id/message    → push a user turn
//   GET  /event                  → SSE: server.connected, message.updated, session.idle
//
// Match it and the dispatcher, the stats reporter and the web dashboard need no
// changes at all.

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { RunSession } from './session.js';

const PORT = Number(process.env.PORT ?? process.env.RUNNER_PORT ?? 4096);
const WORKSPACE = process.env.WORKSPACE_DIR ?? '/workspace';
const MODEL = process.env.CLAUDE_MODEL || undefined;
const DISPATCHER_MCP_URL = process.env.DISPATCHER_MCP_URL ?? 'http://127.0.0.1:4097/mcp';
const APPEND_SYSTEM_PROMPT = process.env.CLAUDE_APPEND_SYSTEM_PROMPT || undefined;
const VERSION = process.env.RUNNER_CLAUDE_VERSION ?? '0.2.0';
/** Set in the runner image to the `claude` the SDK should spawn. See SessionConfig. */
const CLAUDE_EXECUTABLE = process.env.CLAUDE_CODE_EXECUTABLE || undefined;

/**
 * Nothing in a run pod can answer a permission prompt, so a mode that blocks
 * would wedge the run until its timeout. The pod plus the cluster network
 * policy is the sandbox boundary here, which is what makes bypassing safe.
 * Override with CLAUDE_PERMISSION_MODE if a deployment wants it tighter.
 */
const PERMISSION_MODE = (process.env.CLAUDE_PERMISSION_MODE ??
  'bypassPermissions') as PermissionMode;

/**
 * Materialise operator-supplied settings at `~/.claude/settings.json`.
 *
 * The operator renders this from the run's agent definitions (see the operator's
 * adapters/claude-config.ts) and passes it as an env var, because a run pod has
 * no other writable channel into the CLI's config. `settingSources` includes
 * `'user'`, which is what makes the CLI read this path — drop either half and
 * agent-level tool denials are silently ignored.
 *
 * Failure here is logged and tolerated: a run that ignores a deny rule is worse
 * than one that never starts only in theory, but in practice refusing to boot
 * over unparseable settings turns a misconfiguration into an outage.
 */
function writeClaudeSettings(): void {
  const content = process.env.CLAUDE_SETTINGS_CONTENT;
  if (!content || content.trim() === '' || content.trim() === '{}') return;
  const dir = join(process.env.HOME ?? homedir(), '.claude');
  try {
    JSON.parse(content);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), content, { mode: 0o600 });
    console.log(`  settings.json: written to ${dir} (${content.length} bytes)`);
  } catch (e) {
    console.error(`  settings.json: NOT applied — ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * One run pod serves one run, but the API is keyed by session id because that
 * is the shape the dispatcher expects.
 */
const sessions = new Map<string, RunSession>();

/**
 * Event fan-out has to be session-independent: the dispatcher opens /event
 * concurrently with POST /session, so a handler that subscribed only to the
 * sessions present at connect time would silently miss the entire run.
 * Sessions publish here as they are created; SSE clients read from here.
 */
const bus = new Set<(payload: string) => void>();

function publish(payload: string): void {
  for (const fn of bus) fn(payload);
}

/** Wire a freshly created session's events onto the bus. */
function wire(session: RunSession): void {
  session.subscribe((event, data) => {
    if (event === 'message') {
      const info = session.latestInfo();
      if (info) publish(JSON.stringify({ type: 'message.updated', properties: { info } }));
      return;
    }
    if (event === 'idle') {
      publish(
        JSON.stringify({
          type: 'session.idle',
          properties: { sessionID: session.id, ...(data as object) },
        }),
      );
    }
  });
}

const app = new Hono();

app.get('/global/health', (c) => c.json({ healthy: true, version: VERSION }));

app.post('/session', async (c) => {
  const body = await c.req.json<{ title?: string }>().catch(() => ({}) as { title?: string });
  const id = crypto.randomUUID();
  const session = new RunSession(
    {
      cwd: WORKSPACE,
      model: MODEL,
      permissionMode: PERMISSION_MODE,
      appendSystemPrompt: APPEND_SYSTEM_PROMPT,
      pathToExecutable: CLAUDE_EXECUTABLE,
      // The dispatcher's own MCP server is how the agent reaches fail_run and
      // get_status without cluster API access.
      mcpServers: { dispatcher: { type: 'http', url: DISPATCHER_MCP_URL } },
    },
    id,
  );
  session.title = body.title ?? '';
  sessions.set(id, session);
  wire(session);
  return c.json({ id, title: session.title });
});

app.get('/session', (c) =>
  c.json([...sessions.values()].map((s) => ({ id: s.id, title: s.title }))),
);

/**
 * Not part of the OpenCode contract — a diagnostic the dispatcher ignores but
 * that makes a wedged or failed run answerable with one curl from the pod.
 */
app.get('/session/:id/status', (c) => {
  const session = sessions.get(c.req.param('id'));
  if (!session) return c.json({ error: 'no such session' }, 404);
  return c.json({
    id: session.id,
    phase: session.phase,
    error: session.error,
    sdkSessionId: session.sdkSessionId,
    messages: session.messages().length,
  });
});

app.get('/session/:id/message', (c) => {
  const session = sessions.get(c.req.param('id'));
  if (!session) return c.json({ error: 'no such session' }, 404);
  return c.json(session.messages());
});

app.post('/session/:id/message', async (c) => {
  const session = sessions.get(c.req.param('id'));
  if (!session) return c.json({ error: 'no such session' }, 404);

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

  // The dispatcher sends model as {providerID, modelID}; the SDK wants a bare id.
  if (body.model?.modelID) session.setModelId(body.model.modelID);
  if (body.agent) session.setAgent(body.agent);

  session.startOrSend(text);
  return c.json({ ok: true });
});

/**
 * SSE. The dispatcher only acts on three event types, and deliberately not on
 * `permission.updated` — that one means a human is needed, and in a
 * non-interactive pod nobody is. Emitting it would strand the run in
 * WaitingForInput.
 */
app.get('/event', (c) =>
  streamSSE(c, async (stream) => {
    await stream.writeSSE({ data: JSON.stringify({ type: 'server.connected' }) });

    const queue: string[] = [];
    let wake: (() => void) | undefined;
    const push = (payload: string): void => {
      queue.push(payload);
      wake?.();
    };
    bus.add(push);

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
      bus.delete(push);
    }
  }),
);

writeClaudeSettings();

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' });
console.log(`runner-claude ${VERSION} listening on 0.0.0.0:${PORT} (cwd=${WORKSPACE})`);
console.log(`  permission mode: ${PERMISSION_MODE}`);
console.log(`  dispatcher MCP:  ${DISPATCHER_MCP_URL}`);
console.log(`  system prompt append: ${APPEND_SYSTEM_PROMPT ? 'yes' : 'none'}`);
