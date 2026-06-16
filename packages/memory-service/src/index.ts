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
} from './routes.js';

const PORT = parseInt(process.env.MEMORY_SERVICE_PORT ?? '4100', 10);

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

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  try {
    // GET /health
    if (method === 'GET' && path === '/health') {
      const result = await handleHealth();
      return json(result);
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
      const result = await handleSearch({
        query: String(body.query ?? ''),
        limit: body.limit ? Number(body.limit) : undefined,
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
      const result = await handleListMemories({
        task: url.searchParams.get('task') ?? undefined,
        limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
        offset: url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : undefined,
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
