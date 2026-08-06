import { describe, expect, it } from 'bun:test';
import { byPriority, isActivePhase } from '../scheduler.js';
import { makeTask } from './fixtures.js';

describe('isActivePhase', () => {
  const activePhases = [
    'scheduled',
    'initializing',
    'running',
    'reviewing',
    'waiting-for-input',
    'awaiting-merge',
    'generating-builds',
  ] as const;

  const inactivePhases = [
    'idea',
    'pending',
    'succeeded',
    'awaiting-human',
    'rework-requested',
    'done',
    'failed',
  ] as const;

  it.each(activePhases)('returns true for %s', (phase) => {
    expect(isActivePhase(phase)).toBe(true);
  });

  it.each(inactivePhases)('returns false for %s', (phase) => {
    expect(isActivePhase(phase)).toBe(false);
  });
});

describe('byPriority', () => {
  const project = 'test-project';

  it('sorts high before medium before low', () => {
    const tasks = [
      makeTask('low', project, { priority: 'low' }),
      makeTask('high', project, { priority: 'high' }),
      makeTask('medium', project, { priority: 'medium' }),
    ];
    tasks.sort(byPriority);
    expect(tasks.map((t) => t.metadata.name)).toEqual(['high', 'medium', 'low']);
  });

  it('defaults to medium when priority is unset', () => {
    const a = makeTask('a', project);
    const b = makeTask('b', project, { priority: 'high' });
    // byPriority(a, b) returns bP - aP: high(3) - medium(2) = 1 → b sorts first
    expect(byPriority(a, b)).toBe(1);
    expect(byPriority(b, a)).toBe(-1);
  });
});
