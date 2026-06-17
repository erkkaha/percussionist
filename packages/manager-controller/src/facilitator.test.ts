import { describe, expect, it } from 'bun:test';
import { resolveSummarySource } from './facilitator.js';

describe('resolveSummarySource — source selection', () => {
  it('prefers explicit arg over stored summary', () => {
    const result = resolveSummarySource('explicit summary content', 'stored summary content');
    expect(result.source).toBe('arg');
    expect(result.summary).toBe('explicit summary content');
  });

  it('falls back to stored ConfigMap summary when arg is empty', () => {
    const result = resolveSummarySource('', 'stored summary content');
    expect(result.source).toBe('configmap');
    expect(result.summary).toBe('stored summary content');
  });

  it('returns none source and empty string when both are absent', () => {
    const result = resolveSummarySource('', undefined);
    expect(result.source).toBe('none');
    expect(result.summary).toBe('');
  });

  it('treats whitespace-only arg as truthy (non-empty)', () => {
    // A string with only spaces is non-empty, so it counts as "arg" source.
    const result = resolveSummarySource('   ', undefined);
    expect(result.source).toBe('arg');
    expect(result.summary).toBe('   ');
  });

  it('returns correct summary length in chars for arg source', () => {
    const content = 'a'.repeat(42);
    const result = resolveSummarySource(content, undefined);
    expect(result.source).toBe('arg');
    expect(result.summary.length).toBe(42);
  });

  it('returns correct summary length in chars for configmap source', () => {
    const content = 'b'.repeat(100);
    const result = resolveSummarySource('', content);
    expect(result.source).toBe('configmap');
    expect(result.summary.length).toBe(100);
  });

  it('returns correct summary length in chars for none source', () => {
    const result = resolveSummarySource('', undefined);
    expect(result.source).toBe('none');
    expect(result.summary.length).toBe(0);
  });

  it('preserves stored summary content exactly (no truncation)', () => {
    const longSummary = 'Line 1\nLine 2\nLine 3\n'.repeat(50);
    const result = resolveSummarySource('', longSummary);
    expect(result.source).toBe('configmap');
    expect(result.summary).toBe(longSummary);
  });

  it('returns summary from arg even when stored is longer', () => {
    const shortArg = 'short';
    const longStored = 'a'.repeat(1000);
    const result = resolveSummarySource(shortArg, longStored);
    expect(result.source).toBe('arg');
    expect(result.summary).toBe(shortArg);
  });
});
