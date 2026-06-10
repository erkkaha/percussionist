import { describe, it, expect } from "bun:test";
import { gitUrlHash } from "../index.js";

describe("gitUrlHash", () => {
  it("produces a deterministic 8-char hex hash", () => {
    const url = "https://github.com/example/repo.git";
    expect(gitUrlHash(url)).toBe("cd46a4d2");
  });

  it("is deterministic — same URL always produces same hash", () => {
    const url = "https://github.com/example/repo.git";
    expect(gitUrlHash(url)).toBe(gitUrlHash(url));
  });

  it("handles empty string", () => {
    expect(gitUrlHash("")).toBe("00001505");
  });

  it("handles short strings", () => {
    expect(gitUrlHash("a")).toBe("0002b606");
  });

  it("produces different hashes for different URLs", () => {
    const a = gitUrlHash("https://github.com/one.git");
    const b = gitUrlHash("https://github.com/two.git");
    expect(a).not.toBe(b);
  });

  it("matches the format used by pod-builder (8 lower-hex chars)", () => {
    expect(gitUrlHash("https://github.com/percussionist/percussionist.git")).toMatch(/^[0-9a-f]{8}$/);
  });
});
