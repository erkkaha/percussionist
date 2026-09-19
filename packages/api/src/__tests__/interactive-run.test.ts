// interactive-run.test.ts — shared contract for auxiliary interactive runs.
//
// The annotation payload is written by the CLI / MCP tool / web route and
// consumed by the manager reconciler, which derives the Run name from the
// writer-generated `id`. The name must stay a valid DNS-1123 label, so these
// tests pin the truncation behaviour for long project/task names.

import { describe, expect, it } from 'bun:test';
import {
  INTERACTIVE_RUN_ANNOTATION,
  InteractiveRunRequestSchema,
  interactiveRunName,
} from '../index.js';

const DNS_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

describe('INTERACTIVE_RUN_ANNOTATION', () => {
  it('is the canonical task annotation key', () => {
    expect(INTERACTIVE_RUN_ANNOTATION).toBe('percussionist.dev/action-interactive');
  });
});

describe('InteractiveRunRequestSchema', () => {
  it('accepts a minimal id-only payload', () => {
    expect(InteractiveRunRequestSchema.parse({ id: 'deadbeef' })).toEqual({ id: 'deadbeef' });
  });

  it('accepts optional agent, model, and timeoutSeconds overrides', () => {
    const parsed = InteractiveRunRequestSchema.parse({
      id: 'a1b2',
      agent: 'builder',
      model: 'openai/gpt-5',
      timeoutSeconds: 7200,
    });
    expect(parsed.agent).toBe('builder');
    expect(parsed.model).toBe('openai/gpt-5');
    expect(parsed.timeoutSeconds).toBe(7200);
  });

  it('rejects an id shorter than 4 chars or with non-alphanumerics', () => {
    expect(InteractiveRunRequestSchema.safeParse({ id: 'abc' }).success).toBe(false);
    expect(InteractiveRunRequestSchema.safeParse({ id: 'NOT-hex!' }).success).toBe(false);
  });

  it('rejects non-positive and over-long timeoutSeconds', () => {
    expect(InteractiveRunRequestSchema.safeParse({ id: 'a1b2', timeoutSeconds: 0 }).success).toBe(
      false,
    );
    expect(InteractiveRunRequestSchema.safeParse({ id: 'a1b2', timeoutSeconds: -1 }).success).toBe(
      false,
    );
    expect(
      InteractiveRunRequestSchema.safeParse({ id: 'a1b2', timeoutSeconds: 86_401 }).success,
    ).toBe(false);
  });
});

describe('interactiveRunName', () => {
  it('composes {project}-interactive-{task}-{requestId}', () => {
    expect(interactiveRunName('my-proj', 'my-proj-build-abc', 'deadbeef')).toBe(
      'my-proj-interactive-my-proj-build-abc-deadbeef',
    );
  });

  it('sanitizes segments and produces a DNS-1123 label', () => {
    const name = interactiveRunName('My_Proj', 'Task One!', 'a1b2');
    expect(name).toBe('my-proj-interactive-task-one-a1b2');
    expect(name).toMatch(DNS_LABEL);
  });

  it('truncates long project/task names to stay within 63 chars', () => {
    const project = 'p'.repeat(60);
    const task = 't'.repeat(60);
    const name = interactiveRunName(project, task, 'deadbeef');
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(DNS_LABEL);
    expect(name.endsWith('-deadbeef')).toBe(true);
  });

  it('keeps the requestId even when everything else is long', () => {
    const name = interactiveRunName('a'.repeat(63), 'b'.repeat(63), 'c0ffee12');
    expect(name.endsWith('-c0ffee12')).toBe(true);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(DNS_LABEL);
  });
});
