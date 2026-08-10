// board-move.test.ts — `beatctl board task move` validates against the
// sanctioned transition table and patches status.phase only.
//
// The old implementation patched the legacy `status.column` field, which the
// controllers stopped writing, so the command printed success and changed
// nothing observable. The repointed command resolves the move through the same
// transition table the manager's reconciler uses (hoisted to
// @percussionist/api) and never touches `status.column`.

import { describe, expect, it } from 'bun:test';
import { resolveTaskMove } from '../src/board.ts';

describe('resolveTaskMove', () => {
  it('accepts a transition the table sanctions', () => {
    const result = resolveTaskMove('pending', 'scheduled');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch).toEqual({ phase: 'scheduled' });
  });

  it('accepts the retry-style failed -> pending transition', () => {
    const result = resolveTaskMove('failed', 'pending');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch).toEqual({ phase: 'pending' });
  });

  it('rejects an illegal transition and lists the allowed targets', () => {
    const result = resolveTaskMove('pending', 'done');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Invalid transition/);
    expect(result.error).toMatch(/pending.*done/);
    // The only phase pending may move to.
    expect(result.error).toMatch(/scheduled/);
  });

  it('rejects a move from a task with no recorded phase', () => {
    const result = resolveTaskMove(undefined, 'pending');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/no recorded phase/);
  });
});

describe('resolveTaskMove patch payload', () => {
  it('patches only phase, never the legacy column field', () => {
    const cases: Array<
      [Parameters<typeof resolveTaskMove>[0], Parameters<typeof resolveTaskMove>[1]]
    > = [
      ['pending', 'scheduled'],
      ['failed', 'pending'],
      ['awaiting-human', 'awaiting-merge'],
      ['succeeded', 'reviewing'],
    ];
    for (const [from, to] of cases) {
      const result = resolveTaskMove(from, to);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(Object.keys(result.patch)).toEqual(['phase']);
      expect('column' in result.patch).toBe(false);
      expect('taskName' in result.patch).toBe(false);
    }
  });
});
