import { describe, expect, it } from 'bun:test';
import { resolveSummarySource, reviewOutputPromptLines } from './facilitator.js';

describe('reviewOutputPromptLines — where a reviewer sends its output', () => {
  const prompt = reviewOutputPromptLines('main', 'feature/task-abc').join('\n');

  it('tells the reviewer that complete_review takes findings, and what each one needs', () => {
    expect(prompt).toContain('findings array');
    expect(prompt).toContain('anchors');
    expect(prompt).toContain('side: "new" | "old"');
    for (const field of ['id', 'severity', 'title', 'comment', 'context']) {
      expect(prompt).toContain(field);
    }
  });

  // The prompt used to name only `approved`/`diagnosis`, so a reviewer that
  // approved put its line-level caveats in unanchored prose instead.
  it('asks for findings on approval too, not only on request_changes', () => {
    expect(prompt).toContain('whether you approve or request changes');
  });

  // A reviewer cannot invent the context object; without the recipe every
  // finding is dropped or stale.
  it('gives the diffFingerprint recipe with the resolved branches substituted', () => {
    expect(prompt).toContain('git merge-base main feature/task-abc');
    expect(prompt).toContain('git rev-parse main^{commit}');
    expect(prompt).toContain('git rev-parse feature/task-abc^{commit}');
    expect(prompt).toContain(
      'git diff --no-color --find-renames --binary $FORK_SHA..feature/task-abc --',
    );
    expect(prompt).toContain('$FORK_SHA\\n$HEAD_SHA\\n');
  });

  it('says an unmatched fingerprint is stale rather than lost, so findings are never withheld', () => {
    expect(prompt).toContain('stale');
    expect(prompt).toContain('never drop a finding');
  });

  it('routes off-diff issues to report_unrelated_issue under its current name', () => {
    expect(prompt).toContain('percussionist_dispatcher_report_unrelated_issue');
    expect(prompt).not.toContain('report_finding');
  });
});

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
