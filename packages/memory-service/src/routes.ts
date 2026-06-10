import { randomUUID } from "node:crypto";
import { getDb, getRawDb } from "./db.js";
import { getEmbedding } from "./embed.js";

// ---------------------------------------------------------------------------
// Request / Response types

interface StoreMemoryRequest {
  content: string;
  metadata?: Record<string, unknown>;
  agentRun?: string;
}

interface StoreMemoryResponse {
  id: string;
}

interface SearchRequest {
  query: string;
  limit?: number;
  task?: string;
}

interface SearchResult {
  id: string;
  content: string;
  metadata: Record<string, unknown> | null;
  distance: number;
  createdAt: string | null;
}

interface ContextRequest {
  query: string;
  task?: string;
}

interface ContextResponse {
  context: string;
}

// ---------------------------------------------------------------------------
// Initialise vector tables

export function initDb(): void {
  const dims = parseInt(process.env.EMBEDDING_DIMENSIONS ?? "768", 10);
  const raw = getRawDb();
  raw.run(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      agent_run TEXT,
      content TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  raw.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
      embedding float[${dims}]
    )
  `);
  raw.run(
    "CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at)",
  );
  raw.run("CREATE INDEX IF NOT EXISTS idx_memories_run ON memories(agent_run)");
}

// ---------------------------------------------------------------------------
// Memory operations

export async function handleStoreMemory(
  body: StoreMemoryRequest,
): Promise<StoreMemoryResponse> {
  const id = randomUUID();
  const embedding = await getEmbedding(body.content);
  const raw = getRawDb();

  // Use a transaction with last_insert_rowid() so the vec_memories rowid
  // stays aligned with the memories rowid.  Without this, a DELETE (which
  // resets the memories rowid counter but not the vec_memories counter)
  // causes the two sequences to desync and search to silently return wrong
  // content.
  raw.run("BEGIN TRANSACTION");
  raw
    .prepare(
      "INSERT INTO memories (id, content, metadata, agent_run) VALUES (?, ?, ?, ?)",
    )
    .run(id, body.content, JSON.stringify(body.metadata ?? {}), body.agentRun);
  const rid = (raw
    .prepare("SELECT last_insert_rowid() AS rid")
    .get() as { rid: number }).rid;
  raw
    .prepare("INSERT INTO vec_memories (rowid, embedding) VALUES (?, ?)")
    .run(rid, new Uint8Array(embedding.buffer));
  raw.run("COMMIT");

  return { id };
}

export async function handleSearch(
  body: SearchRequest,
): Promise<SearchResult[]> {
  const queryEmbedding = await getEmbedding(body.query);
  const limit = Math.min(body.limit ?? 10, 100);
  const buf = new Uint8Array(queryEmbedding.buffer);

  const raw = getRawDb();
  const rows = raw
    .prepare(
      `SELECT rowid, distance FROM vec_memories WHERE embedding MATCH ?1 ORDER BY distance LIMIT ?2`,
    )
    .all(buf, limit) as { rowid: number; distance: number }[];

  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.rowid);
  const placeholders = ids.map(() => "?").join(",");
  const params: (string | number)[] = [...ids];
  let memSql = `SELECT rowid, id, content, metadata, created_at FROM memories WHERE rowid IN (${placeholders})`;
  if (body.task) {
    memSql += ` AND json_extract(metadata, '$.task') = ?`;
    params.push(body.task);
  }
  const memRows = raw
    .prepare(memSql)
    .all(...params) as {
    rowid: number;
    id: string;
    content: string;
    metadata: string | null;
    created_at: string | null;
  }[];

  const memMap = new Map(memRows.map((m) => [m.rowid, m]));

  return rows
    .filter((r) => memMap.has(r.rowid))
    .map((r) => {
      const mem = memMap.get(r.rowid)!;
      return {
        id: mem.id,
        content: mem.content,
        metadata: mem.metadata ? safeParseJson(mem.metadata) : null,
        distance: r.distance,
        createdAt: mem.created_at,
      };
    });
}

export async function handleContext(
  body: ContextRequest,
): Promise<ContextResponse> {
  const results = await handleSearch({ query: body.query, limit: 5, task: body.task });
  if (results.length === 0) {
    return { context: "No relevant context found." };
  }

  const context = results
    .map(
      (r, i) =>
        `[${i + 1}] (relevance: ${(1 - r.distance).toFixed(3)})\n${r.content}`,
    )
    .join("\n\n");

  return { context };
}

const OLLAMA_BASE_URL =
  process.env.OLLAMA_BASE_URL ?? "http://ollama.percussionist.svc.cluster.local:11434";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "nomic-embed-text";

export async function handleHealth(): Promise<{ ok: boolean }> {
  getDb(); // ensure DB is initialised

  try {
    const tagsUrl = `${OLLAMA_BASE_URL}/api/tags`;
    const res = await fetch(tagsUrl, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return { ok: false };
    }
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    const modelFound = (data.models ?? []).some((m) => m.name === EMBEDDING_MODEL);
    if (!modelFound) {
      return { ok: false };
    }
  } catch {
    return { ok: false };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Helpers

function safeParseJson(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}
