import { describe, it, expect, mock } from "bun:test";

const FAKE_EMBEDDING = Array.from({ length: 768 }, (_, i) => Math.sin(i));

function mockOllamaOk() {
  mock.module("../embed.js", () => ({
    getEmbedding: async (_text: string) => new Float32Array(FAKE_EMBEDDING),
    getEmbeddings: async (texts: string[]) =>
      texts.map(() => new Float32Array(FAKE_EMBEDDING)),
  }));
}

function mockOllamaError() {
  mock.module("../embed.js", () => ({
    getEmbedding: async () => {
      throw new Error("Ollama embedding failed (500): server error");
    },
    getEmbeddings: async () => {
      throw new Error("Ollama batch embedding failed (500): server error");
    },
  }));
}

describe("getEmbedding", () => {
  it("returns a Float32Array of the expected length", async () => {
    mockOllamaOk();
    const { getEmbedding } = await import("../embed.js");
    const result = await getEmbedding("test text");
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(768);
  });

  it("throws on Ollama error", async () => {
    mockOllamaError();
    const { getEmbedding } = await import("../embed.js");
    expect(getEmbedding("fail")).rejects.toThrow("Ollama embedding failed");
  });
});

describe("getEmbeddings", () => {
  it("returns an array of Float32Arrays", async () => {
    mockOllamaOk();
    const { getEmbeddings } = await import("../embed.js");
    const results = await getEmbeddings(["one", "two", "three"]);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r).toBeInstanceOf(Float32Array);
      expect(r.length).toBe(768);
    }
  });

  it("returns empty array for empty input", async () => {
    mockOllamaOk();
    const { getEmbeddings } = await import("../embed.js");
    const results = await getEmbeddings([]);
    expect(results).toEqual([]);
  });

  it("throws on Ollama error", async () => {
    mockOllamaError();
    const { getEmbeddings } = await import("../embed.js");
    expect(getEmbeddings(["x"])).rejects.toThrow(
      "Ollama batch embedding failed",
    );
  });
});
