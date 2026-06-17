import { describe, expect, it } from 'bun:test';
import { __test } from '../mcp-server.js';

const { normalizeFindingText, computeDedupKey } = __test;

describe('normalizeFindingText', () => {
  it('lowercases text', () => {
    expect(normalizeFindingText('Hello WORLD')).toBe('hello world');
  });

  it('collapses whitespace to single spaces', () => {
    expect(normalizeFindingText('foo   bar\t\nbaz')).toBe('foo bar baz');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizeFindingText('  hello  ')).toBe('hello');
  });

  it('handles empty string', () => {
    expect(normalizeFindingText('')).toBe('');
  });

  it('handles already-normalized text', () => {
    expect(normalizeFindingText('normal text')).toBe('normal text');
  });
});

describe('computeDedupKey', () => {
  it('produces a deterministic 16-char hex hash', () => {
    const key = computeDedupKey('bug', undefined, 'Memory leak');
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic for same inputs', () => {
    const a = computeDedupKey('bug', 'src/worker.ts', 'Memory leak');
    const b = computeDedupKey('bug', 'src/worker.ts', 'Memory leak');
    expect(a).toBe(b);
  });

  it('differs when category differs', () => {
    const a = computeDedupKey('bug', undefined, 'Memory leak');
    const b = computeDedupKey('security', undefined, 'Memory leak');
    expect(a).not.toBe(b);
  });

  it('differs when title differs', () => {
    const a = computeDedupKey('bug', undefined, 'Memory leak');
    const b = computeDedupKey('bug', undefined, 'CPU spike');
    expect(a).not.toBe(b);
  });

  it('differs when filePath is provided vs undefined', () => {
    const a = computeDedupKey('bug', undefined, 'Memory leak');
    const b = computeDedupKey('bug', 'src/foo.ts', 'Memory leak');
    expect(a).not.toBe(b);
  });

  it('normalizes title case and whitespace', () => {
    const a = computeDedupKey('bug', undefined, 'Memory Leak');
    const b = computeDedupKey('bug', undefined, 'memory leak');
    expect(a).toBe(b);
  });

  it('normalizes filePath case and whitespace', () => {
    const a = computeDedupKey('bug', 'Src/Foo.Ts', 'Memory leak');
    const b = computeDedupKey('bug', 'src/foo.ts', 'Memory leak');
    expect(a).toBe(b);
  });

  it('treats empty filePath the same as undefined (both produce empty string)', () => {
    const keyWithUndefined = computeDedupKey('bug', undefined, 'title');
    const keyWithEmpty = computeDedupKey('bug', '', 'title');
    expect(keyWithUndefined).toBe(keyWithEmpty);
  });
});
