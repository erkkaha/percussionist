import { describe, expect, it } from 'bun:test';
import { getReviewVerdict } from '../observations.js';
import { makeRun } from './fixtures.js';

const context = {
  baseSha: 'base123',
  headSha: 'head456',
  forkSha: 'fork789',
  diffFingerprint: 'fpabc',
};

const baseFinding = {
  id: 'f1',
  source: 'reviewer' as const,
  severity: 'high' as const,
  title: 'Missing test',
  comment: 'Add coverage.',
  anchors: [{ path: 'src/index.ts', side: 'new' as const, line: 42 }],
  context,
  createdAt: '2026-06-13T00:00:00.000Z',
};

describe('getReviewVerdict', () => {
  it('returns undefined when run is undefined', () => {
    const result = getReviewVerdict(undefined);
    expect(result).toBeUndefined();
  });

  it('returns undefined when verdict annotation is missing', () => {
    const run = makeRun('review-1', { phase: 'Succeeded' });
    const result = getReviewVerdict(run);
    expect(result).toBeUndefined();
  });

  it('parses valid verdict JSON with action and feedback', () => {
    const run = makeRun('review-1', { phase: 'Succeeded' });
    (run.metadata as any).annotations = {
      'percussionist.dev/review-verdict': JSON.stringify({
        action: 'approve',
        feedback: 'looks good',
      }),
    };
    const result = getReviewVerdict(run);
    expect(result).toEqual({
      action: 'approve',
      feedback: 'looks good',
    });
  });

  it('parses valid verdict JSON and passes through diagnosis', () => {
    const run = makeRun('review-1', { phase: 'Succeeded' });
    (run.metadata as any).annotations = {
      'percussionist.dev/review-verdict': JSON.stringify({
        action: 'approve',
        diagnosis: 'code follows patterns',
        feedback: 'looks good',
      }),
    };
    const result = getReviewVerdict(run);
    expect(result).toEqual({
      action: 'approve',
      diagnosis: 'code follows patterns',
      feedback: 'looks good',
    });
  });

  it('handles verdict without diagnosis field', () => {
    const run = makeRun('review-1', { phase: 'Succeeded' });
    (run.metadata as any).annotations = {
      'percussionist.dev/review-verdict': JSON.stringify({
        action: 'request_changes',
        feedback: 'fix X',
      }),
    };
    const result = getReviewVerdict(run);
    expect(result).toEqual({
      action: 'request_changes',
      feedback: 'fix X',
    });
  });

  it('returns undefined for malformed JSON', () => {
    const run = makeRun('review-1', { phase: 'Succeeded' });
    (run.metadata as any).annotations = {
      'percussionist.dev/review-verdict': '{ invalid json }',
    };
    const result = getReviewVerdict(run);
    expect(result).toBeUndefined();
  });

  it('returns undefined for empty verdict string', () => {
    const run = makeRun('review-1', { phase: 'Succeeded' });
    (run.metadata as any).annotations = {
      'percussionist.dev/review-verdict': '',
    };
    const result = getReviewVerdict(run);
    expect(result).toBeUndefined();
  });

  it('returns undefined when verdict is a primitive (not an object)', () => {
    const run = makeRun('review-1', { phase: 'Succeeded' });
    (run.metadata as any).annotations = {
      'percussionist.dev/review-verdict': '"just a string"',
    };
    // JSON.parse('"just a string"') returns the string itself, which is truthy but has no action property
    const result = getReviewVerdict(run);
    expect(result?.action).toBeUndefined();
  });

  it('handles verdict with only action field', () => {
    const run = makeRun('review-1', { phase: 'Succeeded' });
    (run.metadata as any).annotations = {
      'percussionist.dev/review-verdict': JSON.stringify({ action: 'approve' }),
    };
    const result = getReviewVerdict(run);
    expect(result).toEqual({
      action: 'approve',
    });
  });

  it('handles verdict with diagnosis but no feedback', () => {
    const run = makeRun('review-1', { phase: 'Succeeded' });
    (run.metadata as any).annotations = {
      'percussionist.dev/review-verdict': JSON.stringify({
        action: 'request_changes',
        diagnosis: 'style issue',
      }),
    };
    const result = getReviewVerdict(run);
    expect(result).toEqual({
      action: 'request_changes',
      diagnosis: 'style issue',
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

  it("normalizes raw dispatcher findings array into diffFindings", () => {
    const run = makeRun("review-1", { phase: "Succeeded" });
    (run.metadata as any).annotations = {
      "percussionist.dev/review-verdict": JSON.stringify({
        action: "request_changes",
        diagnosis: "issues found",
        findings: [baseFinding],
      }),
    };
    const result = getReviewVerdict(run);
    expect(result?.action).toBe("request_changes");
    expect(result?.diffFindings).toBeDefined();
    expect(result?.diffFindings?.items.length).toBe(1);
    expect(result?.diffFindings?.sourceRunName).toBe("review-1");
  });

  it("truncates long title and clamps score", () => {
    const run = makeRun("review-1", { phase: "Succeeded" });
    const longTitle = "a".repeat(200);
    (run.metadata as any).annotations = {
      "percussionist.dev/review-verdict": JSON.stringify({
        action: "approve",
        findings: [
          {
            ...baseFinding,
            score: 150,
            title: longTitle,
          },
        ],
      }),
    };
    const result = getReviewVerdict(run);
    const item = result?.diffFindings?.items[0];
    expect(item?.title.length).toBeLessThanOrEqual(160);
    expect(item?.score).toBe(100);
  });

  it("drops duplicate finding ids", () => {
    const run = makeRun("review-1", { phase: "Succeeded" });
    (run.metadata as any).annotations = {
      "percussionist.dev/review-verdict": JSON.stringify({
        action: "approve",
        findings: [baseFinding, { ...baseFinding, title: "duplicate id" }],
      }),
    };
    const result = getReviewVerdict(run);
    expect(result?.diffFindings?.items.length).toBe(1);
    expect(result?.diffFindings?.items[0]?.title).toBe("Missing test");
  });

  it("drops findings whose context disagrees with the batch context", () => {
    const run = makeRun("review-1", { phase: "Succeeded" });
    (run.metadata as any).annotations = {
      "percussionist.dev/review-verdict": JSON.stringify({
        action: "request_changes",
        findings: [
          baseFinding,
          {
            ...baseFinding,
            id: "f2",
            context: { ...context, baseSha: "other-base" },
          },
        ],
      }),
    };
    const result = getReviewVerdict(run);
    expect(result?.diffFindings?.items.length).toBe(1);
    expect(result?.diffFindings?.items[0]?.id).toBe("f1");
  });

  it("preserves core verdict when all findings are invalid", () => {
    const run = makeRun("review-1", { phase: "Succeeded" });
    (run.metadata as any).annotations = {
      "percussionist.dev/review-verdict": JSON.stringify({
        action: "approve",
        diagnosis: "all good",
        findings: [{ id: "bad", severity: "nope" }],
      }),
    };
    const result = getReviewVerdict(run);
    expect(result?.action).toBe("approve");
    expect(result?.diffFindings).toBeUndefined();
  });
});
