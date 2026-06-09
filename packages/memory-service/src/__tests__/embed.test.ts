import { describe, it, expect } from "bun:test";

// Ensures the embed.js mock is installed before we import the module.
import "./shared-mocks.js";

const { getEmbedding, getEmbeddings } = await import("../embed.js");

describe("getEmbedding", () => {
  it("returns a Float32Array of the expected length", async () => {
    const result = await getEmbedding("test text");
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(768);
  });
});

describe("getEmbeddings", () => {
  it("returns an array of Float32Arrays", async () => {
    const results = await getEmbeddings(["one", "two", "three"]);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r).toBeInstanceOf(Float32Array);
      expect(r.length).toBe(768);
    }
  });

  it("returns empty array for empty input", async () => {
    const results = await getEmbeddings([]);
    expect(results).toEqual([]);
  });
});
