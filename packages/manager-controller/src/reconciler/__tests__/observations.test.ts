import { describe, it, expect } from "bun:test";
import { getReviewVerdict } from "../observations.js";
import { makeRun } from "./fixtures.js";

const context = {
  baseSha: "base123",
  headSha: "head456",
  forkSha: "fork789",
  diffFingerprint: "fpabc",
};

const baseFinding = {
  id: "f1",
  source: "reviewer" as const,
  severity: "high" as const,
  title: "Missing test",
  comment: "Add coverage.",
  anchors: [{ path: "src/index.ts", side: "new" as const, line: 42 }],
  context,
  createdAt: "2026-06-13T00:00:00.000Z",
};

describe("getReviewVerdict", () => {
  it("returns undefined when run is undefined", () => {
    const result = getReviewVerdict(undefined);
    expect(result).toBeUndefined();
  });

  it("returns undefined when verdict annotation is missing", () => {
    const run = makeRun("review-1", { phase: "Succeeded" });
    const result = getReviewVerdict(run);
    expect(result).toBeUndefined();
  });

  it("parses valid verdict JSON with action and feedback", () => {
    const run = makeRun("review-1", { phase: "Succeeded" });
    (run.metadata as any).annotations = {
      "percussionist.dev/review-verdict": JSON.stringify({ action: "approve", feedback: "looks good" }),
    };
    const result = getReviewVerdict(run);
    expect(result).toEqual({
      action: "approve",
      feedback: "looks good",
    });
  });

  it("parses valid verdict JSON and passes through diagnosis", () => {
    const run = makeRun("review-1", { phase: "Succeeded" });
    (run.metadata as any).annotations = {
      "percussionist.dev/review-verdict": JSON.stringify({
        action: "approve",
        diagnosis: "code follows patterns",
        feedback: "looks good",
      }),
    };
    const result = getReviewVerdict(run);
    expect(result).toEqual({
      action: "approve",
      diagnosis: "code follows patterns",
      feedback: "looks good",
    });
  });

  it("handles verdict without diagnosis field", () => {
    const run = makeRun("review-1", { phase: "Succeeded" });
    (run.metadata as any).annotations = {
      "percussionist.dev/review-verdict": JSON.stringify({ action: "request_changes", feedback: "fix X" }),
    };
    const result = getReviewVerdict(run);
    expect(result).toEqual({
      action: "request_changes",
      feedback: "fix X",
    });
  });

  it("handles verdict with only action field", () => {
    const run = makeRun("review-1", { phase: "Succeeded" });
    (run.metadata as any).annotations = {
      "percussionist.dev/review-verdict": JSON.stringify({ action: "approve" }),
    };
    const result = getReviewVerdict(run);
    expect(result).toEqual({
      action: "approve",
    });
  });

  it("handles verdict with diagnosis but no feedback", () => {
    const run = makeRun("review-1", { phase: "Succeeded" });
    (run.metadata as any).annotations = {
      "percussionist.dev/review-verdict": JSON.stringify({ action: "request_changes", diagnosis: "style issue" }),
    };
    const result = getReviewVerdict(run);
    expect(result).toEqual({
      action: "request_changes",
      diagnosis: "style issue",
    });
  });

  it("normalizes diffFindings from annotation", () => {
    const run = makeRun("review-1", { phase: "Succeeded" });
    (run.metadata as any).annotations = {
      "percussionist.dev/review-verdict": JSON.stringify({
        action: "request_changes",
        diagnosis: "issues found",
        diffFindings: {
          version: 1,
          context,
          items: [baseFinding],
          updatedAt: "2026-06-13T01:00:00.000Z",
          sourceRunName: "review-1",
        },
      }),
    };
    const result = getReviewVerdict(run);
    expect(result?.action).toBe("request_changes");
    expect(result?.diffFindings?.items.length).toBe(1);
    expect(result?.diffFindings?.items[0]?.id).toBe("f1");
  });

  it("drops invalid diffFindings items but preserves core verdict", () => {
    const run = makeRun("review-1", { phase: "Succeeded" });
    (run.metadata as any).annotations = {
      "percussionist.dev/review-verdict": JSON.stringify({
        action: "approve",
        diagnosis: "mostly good",
        diffFindings: {
          version: 1,
          context,
          items: [
            baseFinding,
            { id: "bad", severity: "nope" },
          ],
          updatedAt: "2026-06-13T01:00:00.000Z",
          sourceRunName: "review-1",
        },
      }),
    };
    const result = getReviewVerdict(run);
    expect(result?.action).toBe("approve");
    expect(result?.diffFindings?.items.length).toBe(1);
  });

  it("returns undefined for malformed JSON", () => {
    const run = makeRun("review-1", { phase: "Succeeded" });
    (run.metadata as any).annotations = {
      "percussionist.dev/review-verdict": "{ invalid json }",
    };
    const result = getReviewVerdict(run);
    expect(result).toBeUndefined();
  });

  it("returns undefined for primitive verdict", () => {
    const run = makeRun("review-1", { phase: "Succeeded" });
    (run.metadata as any).annotations = {
      "percussionist.dev/review-verdict": '"just a string"',
    };
    const result = getReviewVerdict(run);
    expect(result).toBeUndefined();
  });
});
