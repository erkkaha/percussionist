// Memory service — per-project vector embedding server.
//
// Stores memories with semantic embeddings in a local bun:sqlite database
// backed by sqlite-vec for vector search. Exposes a REST API used by the
// manager controller's MCP tools.
//
// Environment:
//   MEMORY_SERVICE_PORT  — HTTP port (default 4100, from @percussionist/api)
//   MEMORY_DB_PATH       — SQLite database path (default /data/memory/vectors.db)
//   OLLAMA_BASE_URL      — Ollama service URL (default http://ollama:11434)
//   EMBEDDING_MODEL      — Ollama embedding model (default nomic-embed-text)
//   WARMUP_ENABLED       — Auto-warm embedding model on startup (default "true")
//   WARMUP_TIMEOUT_MS    — Max warmup time in ms (default 300000 = 5 min)
//   WARMUP_MAX_RETRIES   — Retry count for transient failures (default 6)

import { timingSafeEqual } from 'node:crypto';
import { isModelReady, warmupModel } from './model-warmup.js';
import {
  handleContext,
  handleDeleteMemory,
  handleGetMemory,
  handleHealth,
  handleListMemories,
  handleSearch,
  handleStoreMemory,
  handleUpdateMemory,
  initDb,
  ValidationError,
} from './routes.js';

const PORT = parseInt(process.env.MEMORY_SERVICE_PORT ?? '4100', 10);
// Shared control-plane token (manager-mcp-token Secret). Empty = dev mode.
const MCP_TOKEN = process.env.MCP_TOKEN ?? '';

process.on('unhandledRejection', (reason) => {
  console.error(`[memory] unhandledRejection:`, reason);
  process.exit(1);
});

// Initialise database and vector tables on startup
initDb();

// ---------------------------------------------------------------------------
// Model warmup — must complete before the service becomes ready.
// If warmup fails, the process stays alive so K8s can restart it via probe
// failures; /health will report not-ready until the model is available.

await warmupModel();

if (!isModelReady()) {
  console.error(`[memory] warmup failed — service will remain unready`);
}

// ---------------------------------------------------------------------------
// HTTP router

function parseBody(req: Request): Promise<Record<string, unknown>> {
  return req.json().catch(() => {
    throw new Error('invalid JSON body');
  });
}

/**
 * Bearer check for every route except /health.
 *
 * The service used to be completely unauthenticated on a flat pod network, so
 * anything that could reach :4100 could read, poison or wipe a project's
 * memories — and stored memories are injected verbatim into worker prompts as
 * "RELEVANT PROJECT CONTEXT", making a write here prompt injection into the
 * orchestration loop.
 *
 * MCP_TOKEN is the shared control-plane token (manager-mcp-token Secret). The
 * manager is the only legitimate caller, and that Secret is deliberately not
 * projected into run pods, so an agent cannot authenticate even if it reaches
 * the port. When no token is configured the check is skipped, matching the
 * dev-mode behaviour of the manager MCP server and the web dashboard.
 */
function isAuthorized(req: Request): boolean {
  if (!MCP_TOKEN) return true;
  const header = req.headers.get('authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(provided);
  const b = Buffer.from(MCP_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // /health stays open so kubelet probes work without wiring the token in.
  if (path !== '/health' && !isAuthorized(req)) {
    return json({ error: 'unauthorized' }, 401);
  }

  try {
    // GET /health
    if (method === 'GET' && path === '/health') {
      const result = await handleHealth();
      // handleHealth already reports ok:false when the embedding backend is
      // unreachable or the model is absent, but returning 200 regardless meant
      // the readiness probe — which only reads the status code — passed anyway.
      // A service that cannot embed anything sat Ready while every /context and
      // /memory call failed, so the feature contributed nothing and nothing
      // said so. Fail the probe instead.
      return json(result, result.ok ? 200 : 503);
    }

    // POST /memory — store memory
    if (method === 'POST' && path === '/memory') {
      const body = await parseBody(req);
      const result = await handleStoreMemory({
        content: String(body.content ?? ''),
        metadata: body.metadata as Record<string, unknown> | undefined,
        agentRun: body.agentRun as string | undefined,
      });
      return json(result, 201);
    }

    // POST /search — semantic search
    if (method === 'POST' && path === '/search') {
      const body = await parseBody(req);
      // Raw limit passes through — handleSearch coerces and validates it
      // (integer >= 1, max 100), so "abc"/NaN/negative never reach the bind.
      const result = await handleSearch({
        query: String(body.query ?? ''),
        limit: body.limit,
      });
      return json(result);
    }

    // POST /context — formatted context retrieval
    if (method === 'POST' && path === '/context') {
      const body = await parseBody(req);
      const result = await handleContext({
        query: String(body.query ?? ''),
        task: body.task as string | undefined,
      });
      return json(result);
    }

    // GET /memories — list memories (query params: task, limit, offset)
    if (method === 'GET' && path === '/memories') {
      // Raw query params pass through — handleListMemories coerces and
      // validates limit (integer >= 1, max 200) and offset (integer >= 0).
      const result = await handleListMemories({
        task: url.searchParams.get('task') ?? undefined,
        limit: url.searchParams.get('limit') ?? undefined,
        offset: url.searchParams.get('offset') ?? undefined,
      });
      return json(result);
    }

    // GET /memory/:id — get single memory by ID
    if (method === 'GET' && path.startsWith('/memory/')) {
      const id = path.split('/')[2];
      if (!id) throw new Error('missing memory id');
      const result = await handleGetMemory(id);
      return json(result);
    }

    // PATCH /memory/:id — update memory (content + metadata, refresh embedding if content changed)
    if (method === 'PATCH' && path.startsWith('/memory/')) {
      const id = path.split('/')[2];
      if (!id) throw new Error('missing memory id');
      const body = await parseBody(req);
      const result = await handleUpdateMemory(id, {
        content: body.content as string | undefined,
        metadata: body.metadata as Record<string, unknown> | undefined,
      });
      return json(result);
    }

    // DELETE /memory/:id — delete memory (both tables atomically)
    if (method === 'DELETE' && path.startsWith('/memory/')) {
      const id = path.split('/')[2];
      if (!id) throw new Error('missing memory id');
      const result = await handleDeleteMemory(id);
      return json(result, 200);
    }

    return new Response('Not Found', { status: 404 });
  } catch (e) {
    if (e instanceof ValidationError) {
      // Invalid client input (bad limit/offset) is a 400, not a 500.
      console.warn(`[memory] ${method} ${path}: ${(e as Error).message}`);
      return json({ error: (e as Error).message }, 400);
    }
    const msg = (e as Error).message;
    console.error(`[memory] ${method} ${path}:`, msg);
    return json({ error: msg }, 500);
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Start

Bun.serve({ fetch: handler, port: PORT });
console.log(`[memory] listening on :${PORT}`);
