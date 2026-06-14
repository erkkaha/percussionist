import { describe, expect, it } from 'bun:test';
import { MERGE_VERDICT_ANNOTATION, normalizeMergeVerdict } from '../index.js';

describe('normalizeMergeVerdict', () => {
  it('returns undefined for non-objects', () => {
    expect(normalizeMergeVerdict(null)).toBeUndefined();
    expect(normalizeMergeVerdict('string')).toBeUndefined();
    expect(normalizeMergeVerdict(123)).toBeUndefined();
  });

  it('returns undefined when outcome is missing or invalid', () => {
    expect(normalizeMergeVerdict({})).toBeUndefined();
    expect(normalizeMergeVerdict({ diagnosis: 'looks fine' })).toBeUndefined();
    expect(normalizeMergeVerdict({ outcome: 'unknown' })).toBeUndefined();
    expect(normalizeMergeVerdict({ outcome: '' })).toBeUndefined();
  });

  it('normalizes a complete merged verdict', () => {
    const result = normalizeMergeVerdict({
      outcome: 'merged',
      diagnosis: 'Merged and pushed',
      details: 'Fast-forward merge completed',
      sourceBranch: 'feature/plan-abc--build-123',
      targetBranch: 'feature/plan-abc',
      mergeCommitSha: 'abc123def456',
      requiresHuman: false,
    });

    expect(result).toEqual({
      outcome: 'merged',
      diagnosis: 'Merged and pushed',
      details: 'Fast-forward merge completed',
      sourceBranch: 'feature/plan-abc--build-123',
      targetBranch: 'feature/plan-abc',
      mergeCommitSha: 'abc123def456',
      requiresHuman: false,
    });
  });

  it('normalizes already-merged verdict with optional fields omitted', () => {
    const result = normalizeMergeVerdict({
      outcome: 'already-merged',
      diagnosis: 'Nothing to merge',
    });

    expect(result).toEqual({
      outcome: 'already-merged',
      diagnosis: 'Nothing to merge',
      requiresHuman: false,
    });
  });

  it('defaults requiresHuman by outcome', () => {
    expect(normalizeMergeVerdict({ outcome: 'merged' })?.requiresHuman).toBe(false);
    expect(normalizeMergeVerdict({ outcome: 'already-merged' })?.requiresHuman).toBe(false);
    expect(normalizeMergeVerdict({ outcome: 'conflict' })?.requiresHuman).toBe(true);
    expect(normalizeMergeVerdict({ outcome: 'push-failed' })?.requiresHuman).toBe(true);
    expect(normalizeMergeVerdict({ outcome: 'transient-failure' })?.requiresHuman).toBe(false);
  });

  it('respects explicit requiresHuman overrides', () => {
    expect(
      normalizeMergeVerdict({ outcome: 'conflict', requiresHuman: false })?.requiresHuman,
    ).toBe(false);
    expect(normalizeMergeVerdict({ outcome: 'merged', requiresHuman: true })?.requiresHuman).toBe(
      true,
    );
    expect(
      normalizeMergeVerdict({ outcome: 'push-failed', requiresHuman: 'false' })?.requiresHuman,
    ).toBe(false);
    expect(
      normalizeMergeVerdict({ outcome: 'transient-failure', requiresHuman: 'true' })?.requiresHuman,
    ).toBe(true);
  });

  it('coerces legacy outcome aliases', () => {
    expect(normalizeMergeVerdict({ outcome: 'already_merged' })?.outcome).toBe('already-merged');
    expect(normalizeMergeVerdict({ outcome: 'push_failed' })?.outcome).toBe('push-failed');
    expect(normalizeMergeVerdict({ outcome: 'transient_failure' })?.outcome).toBe(
      'transient-failure',
    );
    expect(normalizeMergeVerdict({ outcome: 'merge-failed' })?.outcome).toBe('transient-failure');
    expect(normalizeMergeVerdict({ outcome: 'failed' })?.outcome).toBe('transient-failure');
  });

  it('truncates string fields to safe lengths', () => {
    const result = normalizeMergeVerdict({
      outcome: 'push-failed',
      diagnosis: 'a'.repeat(2000),
      details: 'b'.repeat(5000),
      sourceBranch: 'c'.repeat(300),
      targetBranch: 'd'.repeat(300),
      mergeCommitSha: 'e'.repeat(100),
    });

    expect(result?.diagnosis?.length).toBe(1024);
    expect(result?.details?.length).toBe(4096);
    expect(result?.sourceBranch?.length).toBe(255);
    expect(result?.targetBranch?.length).toBe(255);
    expect(result?.mergeCommitSha?.length).toBe(64);
  });

  it('drops invalid optional fields safely', () => {
    const result = normalizeMergeVerdict({
      outcome: 'merged',
      diagnosis: '',
      details: '   ',
      sourceBranch: 123,
      targetBranch: null,
      mergeCommitSha: {},
    });

    expect(result).toEqual({
      outcome: 'merged',
      requiresHuman: false,
    });
  });
});

describe('MERGE_VERDICT_ANNOTATION', () => {
  it('has the expected well-known key', () => {
    expect(MERGE_VERDICT_ANNOTATION).toBe('percussionist.dev/merge-verdict');
  });
});
