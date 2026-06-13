import { randomUUID } from 'node:crypto';
import { getDb, getRawDb } from './db.js';
import { getEmbedding } from './embed.js';

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
  const dims = parseInt(process.env.EMBEDDING_DIMENSIONS ?? '768', 10);
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
  raw.run('CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at)');
  raw.run('CREATE INDEX IF NOT EXISTS idx_memories_run ON memories(agent_run)');
}

interface UpdateMemoryRequest {
  content?: string;
  metadata?: Record<string, unknown>;
}

interface UpdateMemoryResponse {
  id: string;
  content: string;
  metadata: Record<string, unknown> | null;
  agentRun: string | null;
  createdAt: string | null;
}

interface DeleteMemoryResponse {
  deleted: true;
}

interface ListMemoriesRequest {
  task?: string;
  limit?: number;
  offset?: number;
}

interface ListMemoriesResponse {
  memories: SearchResult[];
  total: number;
}

// ---------------------------------------------------------------------------
// Memory operations

export async function handleStoreMemory(body: StoreMemoryRequest): Promise<StoreMemoryResponse> {
  const id = randomUUID();
  const embedding = await getEmbedding(body.content);
  const raw = getRawDb();

  // Use a transaction with last_insert_rowid() so the vec_memories rowid
  // stays aligned with the memories rowid.  Without this, a DELETE (which
  // resets the memories rowid counter but not the vec_memories counter)
  // causes the two sequences to desync and search to silently return wrong
  // content.
  raw.run('BEGIN TRANSACTION');
  raw
    .prepare('INSERT INTO memories (id, content, metadata, agent_run) VALUES (?, ?, ?, ?)')
    .run(id, body.content, JSON.stringify(body.metadata ?? {}), body.agentRun ?? null);
  const rid = (raw.prepare('SELECT last_insert_rowid() AS rid').get() as { rid: number }).rid;
  raw
    .prepare('INSERT INTO vec_memories (rowid, embedding) VALUES (?, ?)')
    .run(rid, new Uint8Array(embedding.buffer));
  raw.run('COMMIT');

  return { id };
}

export async function handleSearch(body: SearchRequest): Promise<SearchResult[]> {
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
  const placeholders = ids.map(() => '?').join(',');
  const params: (string | number)[] = [...ids];
  let memSql = `SELECT rowid, id, content, metadata, created_at FROM memories WHERE rowid IN (${placeholders})`;
  if (body.task) {
    memSql += ` AND json_extract(metadata, '$.task') = ?`;
    params.push(body.task);
  }
  const memRows = raw.prepare(memSql).all(...params) as {
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
      const mem = memMap.get(r.rowid);
      if (!mem) return null;
      return {
        id: mem.id,
        content: mem.content,
        metadata: mem.metadata ? safeParseJson(mem.metadata) : null,
        distance: r.distance,
        createdAt: mem.created_at,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

export async function handleContext(body: ContextRequest): Promise<ContextResponse> {
  const results = await handleSearch({ query: body.query, limit: 5, task: body.task });
  if (results.length === 0) {
    return { context: 'No relevant context found.' };
  }

  const context = results
    .map((r, i) => `[${i + 1}] (relevance: ${(1 - r.distance).toFixed(3)})\n${r.content}`)
    .join('\n\n');

  return { context };
}

// ---------------------------------------------------------------------------
// List memories

export async function handleListMemories(body: ListMemoriesRequest): Promise<ListMemoriesResponse> {
  const limit = Math.min(body.limit ?? 50, 200);
  const offset = body.offset ?? 0;
  const raw = getRawDb();

  // Count total matching rows (without limit/offset)
  let countSql = 'SELECT COUNT(*) AS cnt FROM memories';
  const countParams: (string | number)[] = [];
  if (body.task) {
    countSql += ` WHERE json_extract(metadata, '$.task') = ?`;
    countParams.push(body.task);
  }
  const total = (raw.prepare(countSql).get(...countParams) as { cnt: number }).cnt;

  // Fetch page of rows ordered by created_at DESC
  let memSql = `SELECT rowid, id, content, metadata, agent_run, created_at FROM memories`;
  const params: (string | number)[] = [];
  if (body.task) {
    memSql += ` WHERE json_extract(metadata, '$.task') = ?`;
    params.push(body.task);
  }
  memSql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const rows = raw.prepare(memSql).all(...params) as {
    rowid: number;
    id: string;
    content: string;
    metadata: string | null;
    agent_run: string | null;
    created_at: string | null;
  }[];

  const memories = rows.map((m) => ({
    id: m.id,
    content: m.content,
    metadata: m.metadata ? safeParseJson(m.metadata) : null,
    distance: 0, // list does not return distances
    createdAt: m.created_at,
  }));

  return { memories, total };
}

// ---------------------------------------------------------------------------
// Get memory by ID

export async function handleGetMemory(id: string): Promise<SearchResult> {
  const raw = getRawDb();
  const row = raw
    .prepare('SELECT rowid, id, content, metadata, created_at FROM memories WHERE id = ?')
    .get(id) as {
    rowid: number;
    id: string;
    content: string;
    metadata: string | null;
    created_at: string | null;
  } | null;

  if (!row) {
    throw new Error(`Memory not found: ${id}`);
  }

  return {
    id: row.id,
    content: row.content,
    metadata: row.metadata ? safeParseJson(row.metadata) : null,
    distance: 0,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Update memory (content + metadata), refresh embedding if content changed

export async function handleUpdateMemory(
  id: string,
  body: UpdateMemoryRequest,
): Promise<UpdateMemoryResponse> {
  const raw = getRawDb();

  // Fetch existing row to compare content and get rowid
  const existing = raw
    .prepare(
      'SELECT rowid, id, content, metadata, agent_run, created_at FROM memories WHERE id = ?',
    )
    .get(id) as {
    rowid: number;
    id: string;
    content: string;
    metadata: string | null;
    agent_run: string | null;
    created_at: string | null;
  } | null;

  if (!existing) {
    throw new Error(`Memory not found: ${id}`);
  }

  const needsEmbeddingUpdate = body.content !== undefined && body.content !== existing.content;

  raw.run('BEGIN TRANSACTION');

  // Update memories row
  const updates: string[] = [];
  const params: (string | number)[] = [];

  if (body.content !== undefined) {
    updates.push('content = ?');
    params.push(body.content);
  }
  if (body.metadata !== undefined) {
    updates.push('metadata = ?');
    params.push(JSON.stringify(body.metadata));
  }

  if (updates.length > 0) {
    params.push(id);
    raw.prepare(`UPDATE memories SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  // If content changed, update the embedding vector row by matched rowid
  if (needsEmbeddingUpdate) {
    const newEmbedding = await getEmbedding(body.content as string);
    raw
      .prepare('UPDATE vec_memories SET embedding = ? WHERE rowid = ?')
      .run(new Uint8Array(newEmbedding.buffer), existing.rowid);
  }

  raw.run('COMMIT');

  // Re-read the updated row to return it
  const updatedRow = raw
    .prepare('SELECT id, content, metadata, agent_run, created_at FROM memories WHERE id = ?')
    .get(id) as {
    id: string;
    content: string;
    metadata: string | null;
    agent_run: string | null;
    created_at: string | null;
  };

  return {
    id: updatedRow.id,
    content: updatedRow.content,
    metadata: updatedRow.metadata ? safeParseJson(updatedRow.metadata) : null,
    agentRun: updatedRow.agent_run,
    createdAt: updatedRow.created_at,
  };
}

// ---------------------------------------------------------------------------
// Delete memory (both tables atomically via rowid)

export async function handleDeleteMemory(id: string): Promise<DeleteMemoryResponse> {
  const raw = getRawDb();

  // Resolve rowid from memories table first
  const existing = raw.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as {
    rowid: number;
  } | null;

  if (!existing) {
    throw new Error(`Memory not found: ${id}`);
  }

  // Delete from both tables atomically using the resolved rowid
  raw.run('BEGIN TRANSACTION');
  raw.prepare('DELETE FROM vec_memories WHERE rowid = ?').run(existing.rowid);
  raw.prepare('DELETE FROM memories WHERE id = ?').run(id);
  raw.run('COMMIT');

  return { deleted: true };
}

const OLLAMA_BASE_URL =
  process.env.OLLAMA_BASE_URL ?? 'http://ollama.percussionist.svc.cluster.local:11434';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'nomic-embed-text';

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
