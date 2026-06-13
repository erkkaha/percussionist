import { describe, expect, it } from 'bun:test';
import { getReviewVerdict } from '../observations.js';
import { makeRun } from './fixtures.js';

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
});
