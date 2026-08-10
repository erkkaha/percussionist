// spec-validation.test.ts — unit tests for the reconcile-entry Zod re-validation
// module. The schemas are permissive (all fields optional, defaults applied), so
// the only specs that fail are the ones violating a .refine() invariant — the
// exact gap the generated CRDs cannot express.

import { describe, expect, it } from 'bun:test';
import { validateProjectSpec, validateRunSpec } from './spec-validation.js';

const TASK_MESSAGE = 'task: spec.task is required unless spec.interactive is true';
const SOURCE_MESSAGE = 'source: source.git and source.local are mutually exclusive';

describe('validateRunSpec', () => {
  it('fails with the exact task message when neither task nor interactive is set', () => {
    expect(validateRunSpec({ project: 'p' })).toEqual({
      ok: false,
      error: TASK_MESSAGE,
    });
  });

  it('fails with the exact task message when interactive is explicitly false and task is absent', () => {
    expect(validateRunSpec({ project: 'p', interactive: false })).toEqual({
      ok: false,
      error: TASK_MESSAGE,
    });
  });

  it('passes when interactive is true', () => {
    expect(validateRunSpec({ project: 'p', interactive: true })).toEqual({ ok: true });
  });

  it('passes when task is set (defaults absent)', () => {
    expect(validateRunSpec({ project: 'p', task: 'do the thing' })).toEqual({ ok: true });
  });

  it('fails with both messages when source contradicts AND task is absent', () => {
    expect(
      validateRunSpec({
        project: 'p',
        source: { git: { url: 'https://example.com/repo.git' }, local: true },
      }),
    ).toEqual({
      ok: false,
      error: `${SOURCE_MESSAGE}; ${TASK_MESSAGE}`,
    });
  });

  it('passes for a spec with task and a contradictory source — source refine is reported only via the source check', () => {
    // Run also embeds SourceSchema, so the source refine fires here too when
    // both sides are set — with a valid task the error is the source one alone.
    expect(
      validateRunSpec({
        project: 'p',
        task: 't',
        source: { git: { url: 'https://example.com/repo.git' }, local: true },
      }),
    ).toEqual({ ok: false, error: SOURCE_MESSAGE });
  });

  it('rejects non-object input', () => {
    expect(validateRunSpec(undefined).ok).toBe(false);
    expect(validateRunSpec(null).ok).toBe(false);
    expect(validateRunSpec('nope').ok).toBe(false);
  });
});

describe('validateProjectSpec', () => {
  it('fails with the exact source message when both source.git and source.local are set', () => {
    expect(
      validateProjectSpec({
        source: { git: { url: 'https://example.com/repo.git' }, local: true },
      }),
    ).toEqual({ ok: false, error: SOURCE_MESSAGE });
  });

  it('passes with source.git alone', () => {
    expect(
      validateProjectSpec({ source: { git: { url: 'https://example.com/repo.git' } } }),
    ).toEqual({ ok: true });
  });

  it('passes with source.local alone', () => {
    expect(validateProjectSpec({ source: { local: true } })).toEqual({ ok: true });
  });

  it('passes with no source at all (NAND, not XOR)', () => {
    expect(validateProjectSpec({})).toEqual({ ok: true });
  });

  it('passes for safeParse-tolerant shapes with defaults absent', () => {
    // Real Project CRs carry a default-stamped spec; a minimal hand-written one
    // (only displayName) must still validate.
    expect(validateProjectSpec({ displayName: 'My Project' })).toEqual({ ok: true });
  });

  it('rejects non-object input', () => {
    expect(validateProjectSpec(undefined).ok).toBe(false);
    expect(validateProjectSpec(null).ok).toBe(false);
  });
});
