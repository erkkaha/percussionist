import { describe, expect, it } from 'bun:test';
import { DiffFindingSeveritySchema, normalizeReviewVerdict } from '../index.js';

const baseFinding = {
  id: 'f1',
  source: 'reviewer' as const,
  severity: 'high' as const,
  title: 'Missing test',
  comment: 'Add coverage for the edge case.',
  anchors: [
    {
      path: 'src/index.ts',
      side: 'new' as const,
      line: 42,
      hunkHeader: '@@ -10,5 +10,7 @@',
    },
  ],
  context: {
    baseSha: 'base123',
    headSha: 'head456',
    forkSha: 'fork789',
    diffFingerprint: 'fpabc',
  },
  createdAt: '2026-06-13T00:00:00.000Z',
};

const context = {
  baseSha: 'base123',
  headSha: 'head456',
  forkSha: 'fork789',
  diffFingerprint: 'fpabc',
};

describe('normalizeReviewVerdict', () => {
  it('returns undefined for non-objects', () => {
    expect(normalizeReviewVerdict(null)).toBeUndefined();
    expect(normalizeReviewVerdict('string')).toBeUndefined();
    expect(normalizeReviewVerdict(123)).toBeUndefined();
  });

  it('returns undefined when action is missing or invalid', () => {
    expect(normalizeReviewVerdict({})).toBeUndefined();
    expect(normalizeReviewVerdict({ action: 'merge' })).toBeUndefined();
    expect(normalizeReviewVerdict({ action: 'approve', diagnosis: '' })).toEqual({
      action: 'approve',
    });
  });

  it('normalizes a basic approve verdict without findings', () => {
    const result = normalizeReviewVerdict({
      action: 'approve',
      diagnosis: 'Looks good',
      feedback: 'Nice work',
    });
    expect(result).toEqual({
      action: 'approve',
      diagnosis: 'Looks good',
      feedback: 'Nice work',
    });
  });

  it('normalizes request-charges alias to request_changes', () => {
    const result = normalizeReviewVerdict({
      action: 'request-changes',
      diagnosis: 'Needs fixes',
    });
    expect(result).toEqual({
      action: 'request_changes',
      diagnosis: 'Needs fixes',
    });
  });

  it('builds diffFindings from raw findings array', () => {
    const result = normalizeReviewVerdict(
      {
        action: 'request_changes',
        diagnosis: 'Issues found',
        findings: [baseFinding],
      },
      { sourceRunName: 'review-1', updatedAt: '2026-06-13T01:00:00.000Z' },
    );

    expect(result?.diffFindings).toBeDefined();
    expect(result?.diffFindings?.version).toBe(1);
    expect(result?.diffFindings?.sourceRunName).toBe('review-1');
    expect(result?.diffFindings?.updatedAt).toBe('2026-06-13T01:00:00.000Z');
    expect(result?.diffFindings?.context).toEqual(context);
    expect(result?.diffFindings?.items.length).toBe(1);
    expect(result?.diffFindings?.items[0]).toEqual(baseFinding);
  });

  it('validates and normalizes an already-normalized diffFindings object', () => {
    const normalized = normalizeReviewVerdict(
      {
        action: 'request_changes',
        diagnosis: 'Issues found',
        findings: [baseFinding],
      },
      { sourceRunName: 'review-1', updatedAt: '2026-06-13T01:00:00.000Z' },
    );

    const result = normalizeReviewVerdict({
      action: 'request_changes',
      diagnosis: 'Still issues',
      diffFindings: normalized?.diffFindings,
    });

    expect(result?.diffFindings?.items.length).toBe(1);
    expect(result?.diffFindings?.items[0]?.id).toBe('f1');
  });

  it('drops invalid findings but keeps valid ones and core verdict', () => {
    const result = normalizeReviewVerdict(
      {
        action: 'request_changes',
        diagnosis: 'Some issues',
        findings: [
          baseFinding,
          { id: '', severity: 'high', title: 'Bad id' }, // missing required fields
          {
            id: 'f3',
            severity: 'not-a-severity',
            title: 'Bad severity',
            comment: 'x',
            anchors: baseFinding.anchors,
            context,
            createdAt: 'now',
          },
          {
            id: 'f4',
            severity: 'low',
            title: 'No comment',
            anchors: baseFinding.anchors,
            context,
            createdAt: 'now',
          },
        ],
      },
      { sourceRunName: 'review-1', updatedAt: '2026-06-13T01:00:00.000Z' },
    );

    expect(result?.action).toBe('request_changes');
    expect(result?.diagnosis).toBe('Some issues');
    expect(result?.diffFindings?.items.length).toBe(1);
    expect(result?.diffFindings?.items[0]?.id).toBe('f1');
  });

  it('caps findings at 25 items', () => {
    const findings = Array.from({ length: 30 }, (_, i) => ({
      ...baseFinding,
      id: `f${i}`,
    }));

    const result = normalizeReviewVerdict(
      { action: 'request_changes', diagnosis: 'Many issues', findings },
      { sourceRunName: 'review-1', updatedAt: '2026-06-13T01:00:00.000Z' },
    );

    expect(result?.diffFindings?.items.length).toBe(25);
  });

  it('deduplicates findings by id keeping the first', () => {
    const result = normalizeReviewVerdict(
      {
        action: 'request_changes',
        diagnosis: 'Dupes',
        findings: [
          { ...baseFinding, id: 'f1', severity: 'high' as const },
          { ...baseFinding, id: 'f1', severity: 'low' as const },
        ],
      },
      { sourceRunName: 'review-1', updatedAt: '2026-06-13T01:00:00.000Z' },
    );

    expect(result?.diffFindings?.items.length).toBe(1);
    expect(result?.diffFindings?.items[0]?.severity).toBe('high');
  });

  it('truncates title, comment, category and hunkHeader to caps', () => {
    const result = normalizeReviewVerdict(
      {
        action: 'request_changes',
        diagnosis: 'Truncation',
        findings: [
          {
            ...baseFinding,
            id: 'f1',
            title: 'a'.repeat(200),
            comment: 'b'.repeat(2500),
            category: 'c'.repeat(100),
            anchors: [
              {
                path: 'src/index.ts',
                side: 'new' as const,
                line: 1,
                hunkHeader: 'd'.repeat(300),
              },
            ],
          },
        ],
      },
      { sourceRunName: 'review-1', updatedAt: '2026-06-13T01:00:00.000Z' },
    );

    const finding = result?.diffFindings?.items[0];
    expect(finding?.title.length).toBe(160);
    expect(finding?.comment.length).toBe(2000);
    expect(finding?.category?.length).toBe(64);
    expect(finding?.anchors[0]?.hunkHeader?.length).toBe(256);
  });

  it('clamps score between 0 and 100', () => {
    const result = normalizeReviewVerdict(
      {
        action: 'request_changes',
        diagnosis: 'Scores',
        findings: [
          { ...baseFinding, id: 'f1', score: 150 },
          { ...baseFinding, id: 'f2', score: -10 },
          { ...baseFinding, id: 'f3', score: 42 },
        ],
      },
      { sourceRunName: 'review-1', updatedAt: '2026-06-13T01:00:00.000Z' },
    );

    expect(result?.diffFindings?.items[0]?.score).toBe(100);
    expect(result?.diffFindings?.items[1]?.score).toBe(0);
    expect(result?.diffFindings?.items[2]?.score).toBe(42);
  });

  it('caps anchors at 3 and drops invalid anchors', () => {
    const result = normalizeReviewVerdict(
      {
        action: 'request_changes',
        diagnosis: 'Anchors',
        findings: [
          {
            ...baseFinding,
            id: 'f1',
            anchors: [
              { path: 'a.ts', side: 'new' as const, line: 1 },
              { path: 'b.ts', side: 'old' as const, line: 2 },
              { path: 'c.ts', side: 'new' as const, line: 3 },
              { path: 'd.ts', side: 'old' as const, line: 4 },
              { path: '', side: 'new' as const, line: 5 }, // invalid
            ],
          },
        ],
      },
      { sourceRunName: 'review-1', updatedAt: '2026-06-13T01:00:00.000Z' },
    );

    expect(result?.diffFindings?.items[0]?.anchors.length).toBe(3);
    expect(result?.diffFindings?.items[0]?.anchors.map((a) => a.path)).toEqual([
      'a.ts',
      'b.ts',
      'c.ts',
    ]);
  });

  it('requires sourceRunName and updatedAt to build diffFindings from raw array', () => {
    const result = normalizeReviewVerdict({
      action: 'request_changes',
      diagnosis: 'No options',
      findings: [baseFinding],
    });

    expect(result?.action).toBe('request_changes');
    expect(result?.diffFindings).toBeUndefined();
  });

  it('drops findings with mismatched context', () => {
    const result = normalizeReviewVerdict(
      {
        action: 'request_changes',
        diagnosis: 'Mixed context',
        findings: [
          baseFinding,
          {
            ...baseFinding,
            id: 'f2',
            context: {
              baseSha: 'other',
              headSha: 'other',
              forkSha: 'other',
              diffFingerprint: 'other',
            },
          },
        ],
      },
      { sourceRunName: 'review-1', updatedAt: '2026-06-13T01:00:00.000Z' },
    );

    expect(result?.diffFindings?.items.length).toBe(1);
    expect(result?.diffFindings?.items[0]?.id).toBe('f1');
    expect(result?.diffFindings?.context).toEqual(context);
  });

  it('returns core verdict without diffFindings when all findings are invalid', () => {
    const result = normalizeReviewVerdict(
      {
        action: 'approve',
        diagnosis: 'All invalid',
        findings: [{ id: 'bad' }],
      },
      { sourceRunName: 'review-1', updatedAt: '2026-06-13T01:00:00.000Z' },
    );

    expect(result?.action).toBe('approve');
    expect(result?.diffFindings).toBeUndefined();
  });
});

describe('DiffFindingSeveritySchema', () => {
  it('accepts valid severities', () => {
    for (const s of ['critical', 'high', 'medium', 'low', 'info']) {
      expect(DiffFindingSeveritySchema.safeParse(s).success).toBe(true);
    }
  });

  it('rejects invalid severities', () => {
    expect(DiffFindingSeveritySchema.safeParse('urgent').success).toBe(false);
    expect(DiffFindingSeveritySchema.safeParse('').success).toBe(false);
  });
});
