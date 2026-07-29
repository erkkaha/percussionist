import { describe, expect, it } from 'bun:test';
import { ProjectSpecSchema, SourceSchema, withDefaultLocalSource } from '../index.js';

describe('withDefaultLocalSource', () => {
  it('fills in a local source when the spec names none', () => {
    expect(withDefaultLocalSource({}).source).toEqual({ local: true });
  });

  it('fills in a local source when source is present but empty', () => {
    expect(withDefaultLocalSource({ source: {} }).source).toEqual({ local: true });
  });

  it('leaves a git source alone', () => {
    const source = { git: { url: 'https://github.com/octocat/Hello-World.git' } };
    expect(withDefaultLocalSource({ source }).source).toBe(source);
  });

  it('leaves an explicit local source alone', () => {
    const spec = { source: { local: true } };
    expect(withDefaultLocalSource(spec)).toBe(spec);
  });

  it('does not mutate the spec it is given', () => {
    const spec: { source?: { local?: boolean } } = {};
    withDefaultLocalSource(spec);
    expect(spec.source).toBeUndefined();
  });

  it('preserves every other field', () => {
    const result = withDefaultLocalSource({ model: 'claude-code/claude-opus-5', maxParallel: 2 });
    expect(result.model).toBe('claude-code/claude-opus-5');
    expect(result.maxParallel).toBe(2);
  });

  it('produces a source the schema accepts', () => {
    const { source } = withDefaultLocalSource({});
    expect(SourceSchema.safeParse(source).success).toBe(true);
  });

  it('keeps a parsed project spec valid', () => {
    const parsed = ProjectSpecSchema.parse({ model: 'claude-code/claude-opus-5' });
    const spec = withDefaultLocalSource(parsed);
    expect(ProjectSpecSchema.safeParse(spec).success).toBe(true);
    expect(spec.source).toEqual({ local: true });
  });
});
