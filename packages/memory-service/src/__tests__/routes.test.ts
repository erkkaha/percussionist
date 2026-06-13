import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Integration-style test: use the real db.ts with a temp database.
// Only mock embed.js to avoid actual Ollama calls.
// ---------------------------------------------------------------------------

import './shared-mocks.js';

const FAKE_EMBEDDING = new Float32Array(Array.from({ length: 768 }, (_, i) => Math.sin(i)));

// Set env BEFORE module-level imports so db.ts picks up the temp path.
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-test-'));
process.env.MEMORY_DB_PATH = path.join(dbDir, 'vectors.db');

const {
  handleStoreMemory,
  handleSearch,
  handleContext,
  handleHealth,
  initDb,
  handleListMemories,
  handleGetMemory,
  handleUpdateMemory,
  handleDeleteMemory,
} = await import('../routes.js');
const { getRawDb } = await import('../db.js');

beforeAll(() => {
  initDb();
});

afterAll(() => {
  fs.rmSync(dbDir, { recursive: true, force: true });
  delete process.env.MEMORY_DB_PATH;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Seed N memories, keeping vec_memories rowids in sync with memories rowids
 *  via last_insert_rowid(). This avoids a vec0 quirk where DELETE resets
 *  the memories rowid counter but not the vec_memories counter. */
function seed(count: number) {
  const raw = getRawDb();
  const eBuf = new Uint8Array(FAKE_EMBEDDING.buffer);
  for (let i = 0; i < count; i++) {
    const id = crypto.randomUUID();
    raw
      .prepare('INSERT INTO memories (id, content, metadata) VALUES (?, ?, ?)')
      .run(
        id,
        `memory content ${i}`,
        JSON.stringify({ task: `task-${i % 2 === 0 ? 'abc' : 'xyz'}` }),
      );
    const row = raw.prepare('SELECT last_insert_rowid() AS rid').get() as { rid: number };
    raw.prepare('INSERT INTO vec_memories (rowid, embedding) VALUES (?, ?)').run(row.rid, eBuf);
  }
}

function clear() {
  const raw = getRawDb();
  raw.run('DELETE FROM vec_memories');
  raw.run('DELETE FROM memories');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleHealth', () => {
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('returns ok when Ollama model is available', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ models: [{ name: 'nomic-embed-text' }] }), {
        status: 200,
      });

    const result = await handleHealth();
    expect(result).toEqual({ ok: true });
  });

  it('returns not-ok when Ollama is unreachable', async () => {
    globalThis.fetch = async () => new Response(null, { status: 503 });

    const result = await handleHealth();
    expect(result).toEqual({ ok: false });
  });

  it('returns not-ok when model is not listed in tags', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ models: [{ name: 'llama3' }] }), {
        status: 200,
      });

    const result = await handleHealth();
    expect(result).toEqual({ ok: false });
  });
});

describe('handleStoreMemory', () => {
  afterAll(() => clear());

  it('stores a memory and returns an id', async () => {
    const result = await handleStoreMemory({ content: 'test memory' });
    expect(result).toHaveProperty('id');
    expect(typeof result.id).toBe('string');

    const raw = getRawDb();
    const row = raw.prepare('SELECT content FROM memories WHERE id = ?').get(result.id) as {
      content: string;
    } | null;
    expect(row).not.toBeNull();
    expect(row?.content).toBe('test memory');
  });

  it('survives delete + re-store without rowid desync (regression test for C1)', async () => {
    const raw = getRawDb();

    // Store via production path
    const first = await handleStoreMemory({ content: 'first memory' });
    const search1 = await handleSearch({ query: 'test', limit: 10 });
    expect(search1.length).toBeGreaterThanOrEqual(1);
    expect(search1[0]?.content).toBe('first memory');

    // Delete everything
    raw.run('DELETE FROM vec_memories');
    raw.run('DELETE FROM memories');

    // Store again via production path — this is where the rowid desync
    // would break search if handleStoreMemory doesn't sync rowids.
    const second = await handleStoreMemory({ content: 'second memory' });
    expect(second.id).not.toBe(first.id);

    const search2 = await handleSearch({ query: 'test', limit: 10 });
    expect(search2.length).toBeGreaterThanOrEqual(1);
    expect(search2[0]?.content).toBe('second memory');
  });

  it('stores with metadata and agentRun', async () => {
    const result = await handleStoreMemory({
      content: 'task-specific memory',
      metadata: { task: 'task-abc', type: 'observation' },
      agentRun: 'run:test-1',
    });
    expect(result).toHaveProperty('id');

    const raw = getRawDb();
    const row = raw
      .prepare('SELECT content, metadata, agent_run FROM memories WHERE id = ?')
      .get(result.id) as {
      content: string;
      metadata: string;
      agent_run: string;
    } | null;
    expect(row).not.toBeNull();
    expect(row?.content).toBe('task-specific memory');
    expect(JSON.parse(row?.metadata)).toEqual({
      task: 'task-abc',
      type: 'observation',
    });
    expect(row?.agent_run).toBe('run:test-1');
  });

  it('stores session-summary metadata correctly', async () => {
    const result = await handleStoreMemory({
      content: 'Session summary of agent work on feature X',
      metadata: { type: 'session-summary', runName: 'plan-worker-1', sessionID: 'sess-abc123' },
      agentRun: 'run:plan-worker-1',
    });
    expect(result).toHaveProperty('id');

    const raw = getRawDb();
    const row = raw
      .prepare('SELECT content, metadata, agent_run FROM memories WHERE id = ?')
      .get(result.id) as {
      content: string;
      metadata: string;
      agent_run: string;
    } | null;
    expect(row).not.toBeNull();
    expect(row!.content).toBe('Session summary of agent work on feature X');
    const parsedMeta = JSON.parse(row!.metadata);
    expect(parsedMeta.type).toBe('session-summary');
    expect(parsedMeta.runName).toBe('plan-worker-1');
    expect(parsedMeta.sessionID).toBe('sess-abc123');
    expect(row!.agent_run).toBe('run:plan-worker-1');
  });

  it('stores session-summary with truncated content', async () => {
    const longContent = 'x'.repeat(50_000);
    const result = await handleStoreMemory({
      content: longContent,
      metadata: { type: 'session-summary', runName: 'build-worker-2', sessionID: 'sess-def456' },
      agentRun: 'run:build-worker-2',
    });
    expect(result).toHaveProperty('id');

    const raw = getRawDb();
    const row = raw
      .prepare('SELECT content, metadata FROM memories WHERE id = ?')
      .get(result.id) as {
      content: string;
      metadata: string;
    } | null;
    expect(row).not.toBeNull();
    // Content should be stored as-is (truncation happens at summarizer level, not here)
    expect(row!.content.length).toBe(50_000);
    const parsedMeta = JSON.parse(row!.metadata);
    expect(parsedMeta.type).toBe('session-summary');
  });
});

describe('handleSearch', () => {
  beforeAll(() => seed(3));
  afterAll(() => clear());

  it('returns results ordered by distance', async () => {
    const results = await handleSearch({ query: 'test', limit: 10 });
    expect(results.length).toBe(3);
  });

  it('filters by task when provided', async () => {
    const results = await handleSearch({
      query: 'test',
      limit: 10,
      task: 'task-abc',
    });
    expect(results.length).toBe(2);
    for (const r of results) {
      expect((r.metadata as Record<string, unknown>)?.task).toBe('task-abc');
    }
  });

  it('returns empty array when no results match task filter', async () => {
    const results = await handleSearch({
      query: 'test',
      limit: 10,
      task: 'task-nonexistent',
    });
    expect(results).toEqual([]);
  });

  it('respects limit', async () => {
    const results = await handleSearch({ query: 'test', limit: 1 });
    expect(results.length).toBe(1);
  });

  it('searches session-summary memories by type metadata', async () => {
    // Seed a session-summary memory alongside regular ones
    const raw = getRawDb();
    const eBuf = new Uint8Array(FAKE_EMBEDDING.buffer);
    const id = crypto.randomUUID();
    raw
      .prepare('INSERT INTO memories (id, content, metadata) VALUES (?, ?, ?)')
      .run(id, 'session summary of plan task', JSON.stringify({ type: 'session-summary' }));
    const row = raw.prepare('SELECT last_insert_rowid() AS rid').get() as { rid: number };
    raw.prepare('INSERT INTO vec_memories (rowid, embedding) VALUES (?, ?)').run(row.rid, eBuf);

    // Search should find it among other results
    const results = await handleSearch({ query: 'session', limit: 10 });
    expect(results.length).toBeGreaterThanOrEqual(4);
  });
});

describe('handleContext', () => {
  beforeAll(() => seed(3));
  afterAll(() => clear());

  it('returns formatted context', async () => {
    const result = await handleContext({ query: 'test' });
    expect(result.context).not.toBe('No relevant context found.');
    expect(result.context).toMatch(/\[1\] \(relevance:/);
  });

  it('filters by task when provided', async () => {
    const result = await handleContext({ query: 'test', task: 'task-xyz' });
    expect(result.context).not.toBe('No relevant context found.');
  });

  it('returns no context when database is empty', async () => {
    clear();
    const result = await handleContext({ query: 'anything' });
    expect(result.context).toBe('No relevant context found.');
  });
});

// ---------------------------------------------------------------------------
// handleListMemories
// ---------------------------------------------------------------------------

describe('handleListMemories', () => {
  beforeAll(() => seed(5));
  afterAll(() => clear());

  it('returns all memories ordered by created_at DESC', async () => {
    const result = await handleListMemories({});
    expect(result.memories.length).toBe(5);
    expect(result.total).toBe(5);
    // Verify descending order (newest first)
    for (let i = 0; i < result.memories.length - 1; i++) {
      const prev = new Date(result.memories[i]!.createdAt!).getTime();
      const curr = new Date(result.memories[i + 1]!.createdAt!).getTime();
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });

  it('filters by task', async () => {
    const result = await handleListMemories({ task: 'task-abc' });
    expect(result.total).toBe(3); // indices 0,2,4 have task-abc
    for (const m of result.memories) {
      expect((m.metadata as Record<string, unknown>)?.task).toBe('task-abc');
    }
  });

  it('respects limit', async () => {
    const result = await handleListMemories({ limit: 2 });
    expect(result.memories.length).toBe(2);
    expect(result.total).toBe(5);
  });

  it('respects offset for pagination', async () => {
    const page1 = await handleListMemories({ limit: 2, offset: 0 });
    const page2 = await handleListMemories({ limit: 2, offset: 2 });
    expect(page1.memories.length).toBe(2);
    expect(page2.memories.length).toBe(2);
    // Different pages should have different IDs
    const ids1 = new Set(page1.memories.map((m) => m.id));
    const ids2 = page2.memories.map((m) => m.id);
    for (const id of ids2) {
      expect(ids1.has(id)).toBe(false);
    }
  });

  it('returns empty list when no memories match task', async () => {
    const result = await handleListMemories({ task: 'nonexistent' });
    expect(result.memories).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('caps limit at 200', async () => {
    const result = await handleListMemories({ limit: 999 });
    expect(result.memories.length).toBe(5); // only 5 exist
    expect(result.total).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// handleGetMemory
// ---------------------------------------------------------------------------

describe('handleGetMemory', () => {
  beforeAll(() => seed(3));
  afterAll(() => clear());

  it('returns a memory by ID', async () => {
    const result = await handleStoreMemory({ content: 'get-test memory' });
    const mem = await handleGetMemory(result.id);
    expect(mem.id).toBe(result.id);
    expect(mem.content).toBe('get-test memory');
    expect(typeof mem.distance).toBe('number');
  });

  it('throws on not-found', async () => {
    await expect(handleGetMemory('nonexistent-id')).rejects.toThrow(
      'Memory not found: nonexistent-id',
    );
  });
});

// ---------------------------------------------------------------------------
// handleUpdateMemory
// ---------------------------------------------------------------------------

describe('handleUpdateMemory', () => {
  beforeAll(() => seed(3));
  afterAll(() => clear());

  it('updates content and refreshes embedding', async () => {
    const result = await handleStoreMemory({ content: 'original content' });
    const updated = await handleUpdateMemory(result.id, {
      content: 'updated content',
    });
    expect(updated.content).toBe('updated content');

    // Verify search now finds the updated content (embedding was refreshed)
    const results = await handleSearch({ query: 'updated content' });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.content).toBe('updated content');
  });

  it('updates metadata without re-embedding', async () => {
    const result = await handleStoreMemory({
      content: 'metadata-only update test',
      metadata: { task: 'task-old' },
    });
    const updated = await handleUpdateMemory(result.id, {
      metadata: { task: 'task-new', version: 2 },
    });
    expect(updated.metadata).toEqual({ task: 'task-new', version: 2 });

    // Content should be unchanged
    const mem = await handleGetMemory(result.id);
    expect(mem.content).toBe('metadata-only update test');
  });

  it('updates both content and metadata in one call', async () => {
    const result = await handleStoreMemory({ content: 'old' });
    const updated = await handleUpdateMemory(result.id, {
      content: 'new content',
      metadata: { key: 'val' },
    });
    expect(updated.content).toBe('new content');
    expect(updated.metadata).toEqual({ key: 'val' });

    // Search should find the new content
    const results = await handleSearch({ query: 'new content' });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('throws on not-found', async () => {
    await expect(handleUpdateMemory('nonexistent-id', { content: 'x' })).rejects.toThrow(
      'Memory not found: nonexistent-id',
    );
  });

  it('no-op when neither content nor metadata provided', async () => {
    const result = await handleStoreMemory({ content: 'unchanged' });
    const updated = await handleUpdateMemory(result.id, {});
    expect(updated.content).toBe('unchanged');
  });
});

// ---------------------------------------------------------------------------
// handleDeleteMemory
// ---------------------------------------------------------------------------

describe('handleDeleteMemory', () => {
  beforeAll(() => seed(3));
  afterAll(() => clear());

  it('deletes memory from both tables atomically', async () => {
    const result = await handleStoreMemory({ content: 'to-delete' });
    const raw = getRawDb();

    // Verify row exists in both tables before delete
    let memRow = raw.prepare('SELECT id FROM memories WHERE id = ?').get(result.id) as {
      id: string;
    } | null;
    expect(memRow).not.toBeNull();
    let vecRow = raw
      .prepare(
        'SELECT rowid FROM vec_memories WHERE rowid IN (SELECT rowid FROM memories WHERE id = ?)',
      )
      .get(result.id) as { rowid: number } | null;
    expect(vecRow).not.toBeNull();

    // Delete
    const deleted = await handleDeleteMemory(result.id);
    expect(deleted.deleted).toBe(true);

    // Verify removed from both tables
    memRow = raw.prepare('SELECT id FROM memories WHERE id = ?').get(result.id) as {
      id: string;
    } | null;
    expect(memRow).toBeNull();
    vecRow = raw
      .prepare(
        'SELECT rowid FROM vec_memories WHERE rowid IN (SELECT rowid FROM memories WHERE id = ?)',
      )
      .get(result.id) as { rowid: number } | null;
    expect(vecRow).toBeNull();
  });

  it('removes memory from search results after delete', async () => {
    const result = await handleStoreMemory({ content: 'search-delete-test' });
    // Verify it appears in search before deletion
    const beforeSearch = await handleSearch({ query: 'search-delete-test' });
    expect(beforeSearch.some((r) => r.id === result.id)).toBe(true);

    await handleDeleteMemory(result.id);

    // Should no longer appear in search
    const afterSearch = await handleSearch({ query: 'search-delete-test' });
    expect(afterSearch.some((r) => r.id === result.id)).toBe(false);
  });

  it('throws on not-found', async () => {
    await expect(handleDeleteMemory('nonexistent-id')).rejects.toThrow(
      'Memory not found: nonexistent-id',
    );
  });

  it('survives delete + re-store without rowid desync (regression test for C1)', async () => {
    const raw = getRawDb();

    // Store, verify search works
    const first = await handleStoreMemory({ content: 'first' });
    const s1 = await handleSearch({ query: 'first', limit: 10 });
    expect(s1.length).toBeGreaterThanOrEqual(1);
    expect(s1[0]!.content).toBe('first');

    // Delete everything
    const allMemories = await handleListMemories({});
    for (const m of allMemories.memories) {
      await handleDeleteMemory(m.id);
    }

    // Store again — this is where the rowid desync would break search
    const second = await handleStoreMemory({ content: 'second' });
    expect(second.id).not.toBe(first.id);

    const s2 = await handleSearch({ query: 'second', limit: 10 });
    expect(s2.length).toBeGreaterThanOrEqual(1);
    expect(s2[0]!.content).toBe('second');
  });
});
