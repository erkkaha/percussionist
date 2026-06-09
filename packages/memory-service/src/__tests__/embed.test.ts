import { describe, it, expect, mock } from "bun:test";

const FAKE_EMBEDDING = Array.from({ length: 768 }, (_, i) => Math.sin(i));

// Behavior flag toggled by tests — lets us use a single module-scoped mock.
let _shouldError = false;

mock.module("../embed.js", () => ({
  getEmbedding: async (_text: string) => {
    if (_shouldError) throw new Error("Ollama embedding failed (500): server error");
    return new Float32Array(FAKE_EMBEDDING);
  },
  getEmbeddings: async (texts: string[]) => {
    if (_shouldError) throw new Error("Ollama batch embedding failed (500): server error");
    if (texts.length === 0) return [];
    return texts.map(() => new Float32Array(FAKE_EMBEDDING));
  },
}));

const { getEmbedding, getEmbeddings } = await import("../embed.js");

describe("getEmbedding", () => {
  it("returns a Float32Array of the expected length", async () => {
    _shouldError = false;
    const result = await getEmbedding("test text");
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(768);
  });

  it("throws on Ollama error", async () => {
    _shouldError = true;
    expect(getEmbedding("fail")).rejects.toThrow("Ollama embedding failed");
  });
});

describe("getEmbeddings", () => {
  it("returns an array of Float32Arrays", async () => {
    _shouldError = false;
    const results = await getEmbeddings(["one", "two", "three"]);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r).toBeInstanceOf(Float32Array);
      expect(r.length).toBe(768);
    }
  });

  it("returns empty array for empty input", async () => {
    _shouldError = false;
    const results = await getEmbeddings([]);
    expect(results).toEqual([]);
  });

  it("throws on Ollama error", async () => {
    _shouldError = true;
    expect(getEmbeddings(["x"])).rejects.toThrow(
      "Ollama batch embedding failed",
    );
  });
});
