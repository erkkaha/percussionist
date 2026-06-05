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

import { initDb, handleStoreMemory, handleSearch, handleContext, handleHealth } from "./routes.js";

const PORT = parseInt(process.env.MEMORY_SERVICE_PORT ?? "4100", 10);

// Initialise database and vector tables on startup
initDb();

// ---------------------------------------------------------------------------
// HTTP router

function parseBody(req: Request): Promise<Record<string, unknown>> {
  return req.json().catch(() => {
    throw new Error("invalid JSON body");
  });
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  try {
    if (method === "GET" && path === "/health") {
      const result = await handleHealth();
      return json(result);
    }

    if (method === "POST") {
      if (path === "/memory") {
        const body = await parseBody(req);
        const result = await handleStoreMemory({
          content: String(body.content ?? ""),
          metadata: body.metadata as Record<string, unknown> | undefined,
          agentRun: body.agentRun as string | undefined,
        });
        return json(result, 201);
      }

      if (path === "/search") {
        const body = await parseBody(req);
        const result = await handleSearch({
          query: String(body.query ?? ""),
          limit: body.limit ? Number(body.limit) : undefined,
        });
        return json(result);
      }

      if (path === "/context") {
        const body = await parseBody(req);
        const result = await handleContext({
          query: String(body.query ?? ""),
          task: body.task as string | undefined,
        });
        return json(result);
      }
    }

    return new Response("Not Found", { status: 404 });
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`[memory] ${method} ${path}:`, msg);
    return json({ error: msg }, 500);
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Start

Bun.serve({ fetch: handler, port: PORT });
console.log(`[memory] listening on :${PORT}`);
