// reconciler.test.ts — Tests for the pure pieces of safeReconcileProject:
// the 4xx-vs-transient error classifier and the status-unchanged skip check.

import { describe, expect, it } from 'bun:test';
import type { Project } from '@percussionist/api';
import {
  classifyProjectReconcileError,
  hasReconcileStatusChanged,
  projectKey,
} from './reconciler.js';

describe('classifyProjectReconcileError', () => {
  it('classifies statusCode 422 (invalid spec) as permanent', () => {
    expect(classifyProjectReconcileError({ statusCode: 422 })).toBe('permanent');
  });

  it('classifies statusCode 400 as permanent', () => {
    expect(classifyProjectReconcileError({ statusCode: 400 })).toBe('permanent');
  });

  it('classifies statusCode 499 as permanent (upper 4xx boundary)', () => {
    expect(classifyProjectReconcileError({ statusCode: 499 })).toBe('permanent');
  });

  it('classifies statusCode 500 as transient', () => {
    expect(classifyProjectReconcileError({ statusCode: 500 })).toBe('transient');
  });

  it('classifies statusCode 399 as transient (below 4xx boundary)', () => {
    expect(classifyProjectReconcileError({ statusCode: 399 })).toBe('transient');
  });

  it('falls back to the `code` field when statusCode is absent', () => {
    expect(classifyProjectReconcileError({ code: 404 })).toBe('permanent');
  });

  it('prefers statusCode over code when both are present', () => {
    expect(classifyProjectReconcileError({ statusCode: 503, code: 404 })).toBe('transient');
  });

  it('defaults to transient when no numeric code is present (e.g. a network error)', () => {
    expect(classifyProjectReconcileError(new Error('ECONNREFUSED'))).toBe('transient');
  });

  it('defaults to transient for a plain non-error value', () => {
    expect(classifyProjectReconcileError('boom')).toBe('transient');
  });

  it('defaults to transient for null/undefined', () => {
    expect(classifyProjectReconcileError(undefined)).toBe('transient');
    expect(classifyProjectReconcileError(null)).toBe('transient');
  });
});

describe('hasReconcileStatusChanged', () => {
  it('returns true when current is undefined and next is Ready', () => {
    expect(hasReconcileStatusChanged(undefined, { state: 'Ready', observedGeneration: 1 })).toBe(
      true,
    );
  });

  it('returns false when state, message, and observedGeneration are all identical', () => {
    const current = { state: 'Error' as const, message: 'boom', observedGeneration: 3 };
    const next = { state: 'Error' as const, message: 'boom', observedGeneration: 3 };
    expect(hasReconcileStatusChanged(current, next)).toBe(false);
  });

  it('returns true when state differs', () => {
    const current = { state: 'Error' as const, message: 'boom', observedGeneration: 3 };
    const next = { state: 'Ready' as const, observedGeneration: 3 };
    expect(hasReconcileStatusChanged(current, next)).toBe(true);
  });

  it('returns true when message differs', () => {
    const current = { state: 'Error' as const, message: 'boom', observedGeneration: 3 };
    const next = { state: 'Error' as const, message: 'different failure', observedGeneration: 3 };
    expect(hasReconcileStatusChanged(current, next)).toBe(true);
  });

  it('returns true when observedGeneration differs', () => {
    const current = { state: 'Ready' as const, observedGeneration: 3 };
    const next = { state: 'Ready' as const, observedGeneration: 4 };
    expect(hasReconcileStatusChanged(current, next)).toBe(true);
  });

  it('returns false when both are Ready with the same generation and no message', () => {
    const current = { state: 'Ready' as const, observedGeneration: 5 };
    const next = { state: 'Ready' as const, observedGeneration: 5 };
    expect(hasReconcileStatusChanged(current, next)).toBe(false);
  });

  it('returns true when a successful reconcile must clear a stale error message', () => {
    // Same state and generation, only the stale `message` from a prior Error
    // needs clearing — this is the case that must trigger a patch, since a
    // JSON merge patch only clears a key if it's actually sent.
    const current = {
      state: 'Ready' as const,
      message: 'old 422 from a prior bad spec',
      observedGeneration: 5,
    };
    const next = { state: 'Ready' as const, observedGeneration: 5 };
    expect(hasReconcileStatusChanged(current, next)).toBe(true);
  });

  it('treats a null message the same as an absent one (post-clear apiserver echo)', () => {
    const current = {
      state: 'Ready' as const,
      message: null as unknown as string,
      observedGeneration: 5,
    };
    const next = { state: 'Ready' as const, observedGeneration: 5 };
    expect(hasReconcileStatusChanged(current, next)).toBe(false);
  });
});

describe('projectKey', () => {
  const project = (namespace: string | undefined, name: string) =>
    ({ metadata: { namespace, name } }) as Project;

  it('joins namespace and name', () => {
    expect(projectKey(project('team-a', 'my-project'))).toBe('team-a/my-project');
  });

  it('falls back to an empty namespace segment when namespace is missing', () => {
    expect(projectKey(project(undefined, 'my-project'))).toBe('/my-project');
  });
});
