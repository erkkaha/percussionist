import { randomUUID } from 'node:crypto';
import { and, count, desc, eq, type SQL, sql } from 'drizzle-orm';
import {
  getDb,
  getEmbeddingDimensions,
  getProject,
  inTransaction,
  pingDatabase,
  toEmbeddingVector,
} from './db.js';
import { getEmbedding } from './embed.js';
import { normalizeModelName } from './model-warmup.js';
import { ollamaFetch } from './ollama.js';
import { memories } from './schema.js';

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
  limit?: unknown;
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
  limit?: unknown;
  offset?: unknown;
}

interface ListMemoriesResponse {
  memories: SearchResult[];
  total: number;
}

// ---------------------------------------------------------------------------
// Validation

/**
 * Client input error — surfaced as a 400 by the HTTP entry points instead of a
 * 500. The limit/offset parsers throw it so a JSON `"abc"` or `?limit=abc` is
 * rejected here rather than reaching the database as NaN.
 */
export class ValidationError extends Error {}

/**
 * Coerce and validate a `limit` value: undefined/null/empty falls back to
 * `fallback`, anything that is not an integer >= 1 is rejected, and values
 * above `max` are capped. The entry points pass raw (string or number) values
 * through, so a JSON `"abc"` or `?limit=abc` is rejected here.
 */
export function parseLimit(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError(`limit must be an integer >= 1, got ${JSON.stringify(value)}`);
  }
  return Math.min(n, max);
}

/**
 * Coerce and validate an `offset` value: undefined/null/empty becomes 0,
 * anything that is not an integer >= 0 is rejected.
 */
export function parseOffset(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new ValidationError(`offset must be an integer >= 0, got ${JSON.stringify(value)}`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Memory operations

export async function handleStoreMemory(body: StoreMemoryRequest): Promise<StoreMemoryResponse> {
  const id = randomUUID();
  const embedding = toEmbeddingVector(await getEmbedding(body.content));
  const project = getProject();

  await inTransaction(async (tx) => {
    await tx.insert(memories).values({
      project,
      id,
      content: body.content,
      metadata: body.metadata ?? {},
      agentRun: body.agentRun ?? null,
      embedding,
      dims: getEmbeddingDimensions(),
    });
  });

  return { id };
}

function toVectorLiteral(embedding: number[]): SQL {
  return sql`${`[${embedding.join(',')}]`}::vector`;
}

export async function handleSearch(body: SearchRequest): Promise<SearchResult[]> {
  // Validate limit before the embedding round-trip: a client sending garbage
  // gets a 400 without us hitting Ollama first.
  const limit = parseLimit(body.limit, 10, 100);
  const dims = getEmbeddingDimensions();
  const queryEmbedding = toEmbeddingVector(await getEmbedding(body.query));
  const project = getProject();
  const vector = toVectorLiteral(queryEmbedding);
  // Written exactly as the ANN index in db.ts#ensureVectorIndex is defined: the
  // same `embedding::vector(n)` cast and the same `dims = n` filter in WHERE.
  // Dropping either still returns correct rows, but the planner falls back to
  // a sequential scan. The width is inlined rather than bound because a
  // PostgreSQL type modifier must be a constant, and getEmbeddingDimensions()
  // has already rejected anything that is not a positive integer.
  const width = sql.raw(String(dims));
  const distance = sql<number>`(${memories.embedding}::vector(${width})) <=> ${vector}`;

  const rows = await getDb()
    .select({
      id: memories.id,
      content: memories.content,
      metadata: memories.metadata,
      createdAt: memories.createdAt,
      distance,
    })
    .from(memories)
    .where(
      and(
        eq(memories.project, project),
        eq(memories.dims, dims),
        body.task ? sql`${memories.metadata}->>'task' = ${body.task}` : sql`true`,
      ),
    )
    .orderBy(distance)
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    content: row.content,
    metadata: row.metadata,
    distance: Number(row.distance),
    createdAt: row.createdAt.toISOString(),
  }));
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
  const limit = parseLimit(body.limit, 50, 200);
  const offset = parseOffset(body.offset);
  const project = getProject();
  const scope = body.task
    ? and(eq(memories.project, project), sql`${memories.metadata}->>'task' = ${body.task}`)
    : eq(memories.project, project);

  const [rows, totals] = await Promise.all([
    getDb()
      .select({
        id: memories.id,
        content: memories.content,
        metadata: memories.metadata,
        createdAt: memories.createdAt,
      })
      .from(memories)
      .where(scope)
      .orderBy(desc(memories.createdAt))
      .limit(limit)
      .offset(offset),
    getDb().select({ value: count() }).from(memories).where(scope),
  ]);

  return {
    memories: rows.map((row) => ({
      id: row.id,
      content: row.content,
      metadata: row.metadata,
      distance: 0, // list does not return distances
      createdAt: row.createdAt.toISOString(),
    })),
    total: Number(totals[0]?.value ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Get memory by ID

export async function handleGetMemory(id: string): Promise<SearchResult> {
  const row = await getDb()
    .select({
      id: memories.id,
      content: memories.content,
      metadata: memories.metadata,
      createdAt: memories.createdAt,
    })
    .from(memories)
    .where(and(eq(memories.project, getProject()), eq(memories.id, id)))
    .limit(1);

  const found = row[0];
  if (!found) {
    throw new Error(`Memory not found: ${id}`);
  }

  return {
    id: found.id,
    content: found.content,
    metadata: found.metadata,
    distance: 0,
    createdAt: found.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Update memory (content + metadata), refresh embedding if content changed

export async function handleUpdateMemory(
  id: string,
  body: UpdateMemoryRequest,
): Promise<UpdateMemoryResponse> {
  const project = getProject();

  const existing = await getDb()
    .select({
      id: memories.id,
      content: memories.content,
      metadata: memories.metadata,
      agentRun: memories.agentRun,
      createdAt: memories.createdAt,
    })
    .from(memories)
    .where(and(eq(memories.project, project), eq(memories.id, id)))
    .limit(1);

  const current = existing[0];
  if (!current) {
    throw new Error(`Memory not found: ${id}`);
  }

  const contentChanged = body.content !== undefined && body.content !== current.content;

  const embedding = contentChanged
    ? toEmbeddingVector(await getEmbedding(body.content as string))
    : null;

  const patch: Partial<typeof memories.$inferInsert> = {};
  if (body.content !== undefined) patch.content = body.content;
  if (body.metadata !== undefined) patch.metadata = body.metadata;
  if (embedding) {
    patch.embedding = embedding;
    // CHECK (dims = vector_dims(embedding)) rejects the update unless both move.
    patch.dims = getEmbeddingDimensions();
  }

  return inTransaction(async (tx) => {
    if (Object.keys(patch).length > 0) {
      await tx
        .update(memories)
        .set(patch)
        .where(and(eq(memories.project, project), eq(memories.id, id)));
    }
    const updated = await tx
      .select({
        id: memories.id,
        content: memories.content,
        metadata: memories.metadata,
        agentRun: memories.agentRun,
        createdAt: memories.createdAt,
      })
      .from(memories)
      .where(and(eq(memories.project, project), eq(memories.id, id)))
      .limit(1);

    const row = updated[0];
    if (!row) {
      throw new Error(`Memory not found: ${id}`);
    }
    return {
      id: row.id,
      content: row.content,
      metadata: row.metadata,
      agentRun: row.agentRun,
      createdAt: row.createdAt.toISOString(),
    };
  });
}

// ---------------------------------------------------------------------------
// Delete memory

export async function handleDeleteMemory(id: string): Promise<DeleteMemoryResponse> {
  const project = getProject();
  const scope = and(eq(memories.project, project), eq(memories.id, id));

  return inTransaction(async (tx) => {
    const deleted = await tx.delete(memories).where(scope).returning({ id: memories.id });
    if (deleted.length === 0) {
      throw new Error(`Memory not found: ${id}`);
    }
    return { deleted: true as const };
  });
}

const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'nomic-embed-text';

export async function handleHealth(): Promise<{ ok: boolean }> {
  try {
    await pingDatabase();
  } catch (e) {
    console.error(`[memory] health: database unreachable: ${(e as Error).message}`);
    return { ok: false };
  }

  try {
    const res = await ollamaFetch('/api/tags', {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return { ok: false };
    }
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    // Match on the normalized tag: /api/tags reports "model:latest" while the
    // configured name is usually untagged, and exact equality never matched.
    const wanted = normalizeModelName(EMBEDDING_MODEL);
    const modelFound = (data.models ?? []).some((m) => normalizeModelName(m.name) === wanted);
    if (!modelFound) {
      return { ok: false };
    }
  } catch {
    return { ok: false };
  }

  return { ok: true };
}
