import { describe, it, expect, mock, beforeAll, afterAll } from "bun:test";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

// ---------------------------------------------------------------------------
// Integration-style test: use the real db.ts with a temp database.
// Only mock embed.js to avoid actual Ollama calls.
// ---------------------------------------------------------------------------

const FAKE_EMBEDDING = new Float32Array(
  Array.from({ length: 768 }, (_, i) => Math.sin(i)),
);

// Set env BEFORE module-level imports so db.ts picks up the temp path.
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-test-"));
process.env.MEMORY_DB_PATH = path.join(dbDir, "vectors.db");

mock.module("../embed.js", () => ({
  getEmbedding: async (_text: string) => FAKE_EMBEDDING,
}));

mock.module("../model-warmup.js", () => ({
  isModelReady: () => true,
  getModelError: () => null,
}));

const { handleStoreMemory, handleSearch, handleContext, handleHealth, initDb } =
  await import("../routes.js");
const { getRawDb } = await import("../db.js");

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
      .prepare(
        "INSERT INTO memories (id, content, metadata) VALUES (?, ?, ?)",
      )
      .run(
        id,
        `memory content ${i}`,
        JSON.stringify({ task: `task-${i % 2 === 0 ? "abc" : "xyz"}` }),
      );
    const row = raw
      .prepare("SELECT last_insert_rowid() AS rid")
      .get() as { rid: number };
    raw
      .prepare("INSERT INTO vec_memories (rowid, embedding) VALUES (?, ?)")
      .run(row.rid, eBuf);
  }
}

function clear() {
  const raw = getRawDb();
  raw.run("DELETE FROM vec_memories");
  raw.run("DELETE FROM memories");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleHealth", () => {
  it("returns ok with embedding readiness info", async () => {
    const result = await handleHealth();
    expect(result.ok).toBe(true);
    expect(result.db).toBe("ready");
    expect(result.embedding.ready).toBe(true);
    expect(typeof result.embedding.model).toBe("string");
  });
});

describe("handleStoreMemory", () => {
  afterAll(() => clear());

  it("stores a memory and returns an id", async () => {
    const result = await handleStoreMemory({ content: "test memory" });
    expect(result).toHaveProperty("id");
    expect(typeof result.id).toBe("string");

    const raw = getRawDb();
    const row = raw
      .prepare("SELECT content FROM memories WHERE id = ?")
      .get(result.id) as { content: string } | null;
    expect(row).not.toBeNull();
    expect(row!.content).toBe("test memory");
  });

  it("stores with metadata and agentRun", async () => {
    const result = await handleStoreMemory({
      content: "task-specific memory",
      metadata: { task: "task-abc", type: "observation" },
      agentRun: "run:test-1",
    });
    expect(result).toHaveProperty("id");

    const raw = getRawDb();
    const row = raw
      .prepare(
        "SELECT content, metadata, agent_run FROM memories WHERE id = ?",
      )
      .get(result.id) as {
      content: string;
      metadata: string;
      agent_run: string;
    } | null;
    expect(row).not.toBeNull();
    expect(row!.content).toBe("task-specific memory");
    expect(JSON.parse(row!.metadata)).toEqual({
      task: "task-abc",
      type: "observation",
    });
    expect(row!.agent_run).toBe("run:test-1");
  });
});

describe("handleSearch", () => {
  beforeAll(() => seed(3));
  afterAll(() => clear());

  it("returns results ordered by distance", async () => {
    const results = await handleSearch({ query: "test", limit: 10 });
    expect(results.length).toBe(3);
  });

  it("filters by task when provided", async () => {
    const results = await handleSearch({
      query: "test",
      limit: 10,
      task: "task-abc",
    });
    expect(results.length).toBe(2);
    for (const r of results) {
      expect((r.metadata as Record<string, unknown>)?.task).toBe("task-abc");
    }
  });

  it("returns empty array when no results match task filter", async () => {
    const results = await handleSearch({
      query: "test",
      limit: 10,
      task: "task-nonexistent",
    });
    expect(results).toEqual([]);
  });

  it("respects limit", async () => {
    const results = await handleSearch({ query: "test", limit: 1 });
    expect(results.length).toBe(1);
  });
});

describe("handleContext", () => {
  beforeAll(() => seed(3));
  afterAll(() => clear());

  it("returns formatted context", async () => {
    const result = await handleContext({ query: "test" });
    expect(result.context).not.toBe("No relevant context found.");
    expect(result.context).toMatch(/\[1\] \(relevance:/);
  });

  it("filters by task when provided", async () => {
    const result = await handleContext({ query: "test", task: "task-xyz" });
    expect(result.context).not.toBe("No relevant context found.");
  });

  it("returns no context when database is empty", async () => {
    clear();
    const result = await handleContext({ query: "anything" });
    expect(result.context).toBe("No relevant context found.");
  });
});
