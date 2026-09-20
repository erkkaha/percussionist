import { describe, expect, it } from 'bun:test';
import {
  INTERACTIVE_RUN_ANNOTATION,
  InteractiveRunRequestSchema,
  interactiveRunName,
} from '../index.js';

const DNS1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

describe('INTERACTIVE_RUN_ANNOTATION', () => {
  it('is the canonical task action annotation', () => {
    expect(INTERACTIVE_RUN_ANNOTATION).toBe('percussionist.dev/action-interactive');
  });
});

describe('InteractiveRunRequestSchema', () => {
  it('accepts a full valid payload', () => {
    const parsed = InteractiveRunRequestSchema.parse({
      id: 'abcd1234',
      agent: 'builder',
      model: 'opencode-go/deepseek-v4-flash',
      timeoutSeconds: 7200,
    });
    expect(parsed).toEqual({
      id: 'abcd1234',
      agent: 'builder',
      model: 'opencode-go/deepseek-v4-flash',
      timeoutSeconds: 7200,
    });
  });

  it('accepts an id-only payload', () => {
    expect(InteractiveRunRequestSchema.parse({ id: 'a1b2' })).toEqual({ id: 'a1b2' });
  });

  it.each([
    ['too short', 'abc'],
    ['too long', 'a'.repeat(17)],
    ['uppercase', 'ABCD1234'],
    ['non-alphanumeric', 'abcd-1234'],
    ['underscore', 'abcd_1234'],
    ['empty', ''],
  ])('rejects an invalid id (%s)', (_label, id) => {
    expect(InteractiveRunRequestSchema.safeParse({ id }).success).toBe(false);
  });

  it('rejects a missing id', () => {
    expect(InteractiveRunRequestSchema.safeParse({ agent: 'builder' }).success).toBe(false);
  });

  it.each([0, -1, 1.5, 86_401])('rejects an invalid timeoutSeconds (%p)', (timeoutSeconds) => {
    expect(InteractiveRunRequestSchema.safeParse({ id: 'abcd1234', timeoutSeconds }).success).toBe(
      false,
    );
  });

  it('accepts the maximum timeout', () => {
    expect(
      InteractiveRunRequestSchema.safeParse({ id: 'abcd1234', timeoutSeconds: 86_400 }).success,
    ).toBe(true);
  });

  it('rejects empty agent/model strings', () => {
    expect(InteractiveRunRequestSchema.safeParse({ id: 'abcd1234', agent: '' }).success).toBe(
      false,
    );
    expect(InteractiveRunRequestSchema.safeParse({ id: 'abcd1234', model: '' }).success).toBe(
      false,
    );
  });
});

describe('interactiveRunName', () => {
  it('builds {project}-interactive-{task}-{requestId}', () => {
    expect(interactiveRunName('proj-a', 'build-123', 'abcd1234')).toBe(
      'proj-a-interactive-build-123-abcd1234',
    );
  });

  it('strips a project-name prefix from the task segment', () => {
    expect(interactiveRunName('proj-a', 'proj-a-build-123', 'abcd1234')).toBe(
      'proj-a-interactive-build-123-abcd1234',
    );
  });

  it('lowercases and sanitizes non-DNS characters', () => {
    expect(interactiveRunName('Proj_A', 'Build_123', 'abcd1234')).toBe(
      'proj-a-interactive-build-123-abcd1234',
    );
  });

  it('always produces a valid DNS-1123 label of at most 63 characters', () => {
    const name = interactiveRunName('p'.repeat(40), 't'.repeat(80), 'abcdef12');
    expect(name.length).toBeLessThanOrEqual(63);
    expect(DNS1123.test(name)).toBe(true);
    expect(name.endsWith('-abcdef12')).toBe(true);
  });

  it('truncates the middle segment while preserving the request id', () => {
    const name = interactiveRunName(
      'proj-a',
      'task-segment-that-is-way-too-long-to-fit',
      'abcd1234',
    );
    expect(name.length).toBeLessThanOrEqual(63);
    expect(DNS1123.test(name)).toBe(true);
    expect(name.endsWith('-abcd1234')).toBe(true);
    expect(name.startsWith('proj-a-interactive-')).toBe(true);
  });

  it('shortens the project prefix when it alone leaves no room', () => {
    const project = 'p'.repeat(70);
    const name = interactiveRunName(project, 'build-123', 'abcdef12');
    expect(name.length).toBeLessThanOrEqual(63);
    expect(DNS1123.test(name)).toBe(true);
    expect(name.startsWith('p'.repeat(40))).toBe(true);
    expect(name.endsWith('-abcdef12')).toBe(true);
  });

  it('never ends a segment with a hyphen after truncation', () => {
    // Task names sanitize runs of non-alphanumerics into hyphens, so the slice
    // can land on a hyphen — the helper must trim it.
    const name = interactiveRunName('proj-a', 'ab--cd--ef--gh--ij--kl--mn--op--qr', 'abcd1234');
    expect(name.endsWith('--abcd1234')).toBe(false);
    expect(DNS1123.test(name)).toBe(true);
  });
});
