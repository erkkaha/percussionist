// memory-client.ts — HTTP client for the per-project memory service.
//
// The manager controller calls the memory service directly via its cluster DNS
// name. Each project with spec.embedding.enabled has a memory-{project} Service
// running on port 4100.

import { MEMORY_SERVICE_PORT } from '@percussionist/api';

const NAMESPACE = process.env.PERCUSSIONIST_NAMESPACE ?? 'percussionist';

function memoryServiceUrl(project: string): string {
  return `http://memory-${project}.${NAMESPACE}.svc.cluster.local:${MEMORY_SERVICE_PORT}`;
}

// ---------------------------------------------------------------------------
// Store a memory

export async function storeMemory(
  project: string,
  content: string,
  metadata?: Record<string, unknown>,
  agentRun?: string,
): Promise<{ id: string }> {
  const url = `${memoryServiceUrl(project)}/memory`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, metadata, agentRun }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `memory service (${project}) store failed (${res.status}): ${body.slice(0, 200)}`,
    );
  }
  return (await res.json()) as { id: string };
}

// ---------------------------------------------------------------------------
// Semantic search

export interface MemorySearchResult {
  id: string;
  content: string;
  metadata: Record<string, unknown> | null;
  distance: number;
  createdAt: string | null;
}

export async function queryMemory(
  project: string,
  query: string,
  limit?: number,
): Promise<MemorySearchResult[]> {
  const url = `${memoryServiceUrl(project)}/search`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit: limit ?? 10 }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `memory service (${project}) search failed (${res.status}): ${body.slice(0, 200)}`,
    );
  }
  return (await res.json()) as MemorySearchResult[];
}

// ---------------------------------------------------------------------------
// Context retrieval

export async function getContext(
  project: string,
  query: string,
  task?: string,
): Promise<{ context: string }> {
  const url = `${memoryServiceUrl(project)}/context`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, task }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `memory service (${project}) context failed (${res.status}): ${body.slice(0, 200)}`,
    );
  }
  return (await res.json()) as { context: string };
}

// ---------------------------------------------------------------------------
// List memories

export interface MemoryListItem extends MemorySearchResult {}

export interface ListMemoriesResponse {
  memories: MemoryListItem[];
  total: number;
}

export async function listMemories(
  project: string,
  opts?: { task?: string; limit?: number; offset?: number },
): Promise<ListMemoriesResponse> {
  const url = new URL(`${memoryServiceUrl(project)}/memories`);
  if (opts?.task) url.searchParams.set('task', opts.task);
  if (opts?.limit) url.searchParams.set('limit', String(opts.limit));
  if (opts?.offset) url.searchParams.set('offset', String(opts.offset));

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `memory service (${project}) list failed (${res.status}): ${body.slice(0, 200)}`,
    );
  }
  return (await res.json()) as ListMemoriesResponse;
}

// ---------------------------------------------------------------------------
// Get memory by ID

export async function getMemory(project: string, id: string): Promise<MemorySearchResult> {
  const url = `${memoryServiceUrl(project)}/memory/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `memory service (${project}) get failed (${res.status}): ${body.slice(0, 200)}`,
    );
  }
  return (await res.json()) as MemorySearchResult;
}

// ---------------------------------------------------------------------------
// Update memory

export interface UpdateMemoryBody {
  content?: string;
  metadata?: Record<string, unknown>;
}

export async function updateMemory(
  project: string,
  id: string,
  body: UpdateMemoryBody,
): Promise<MemorySearchResult> {
  const url = `${memoryServiceUrl(project)}/memory/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(
      `memory service (${project}) update failed (${res.status}): ${bodyText.slice(0, 200)}`,
    );
  }
  return (await res.json()) as MemorySearchResult;
}

// ---------------------------------------------------------------------------
// Delete memory

export async function deleteMemory(project: string, id: string): Promise<{ deleted: true }> {
  const url = `${memoryServiceUrl(project)}/memory/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(
      `memory service (${project}) delete failed (${res.status}): ${bodyText.slice(0, 200)}`,
    );
  }
  return (await res.json()) as { deleted: true };
}
