import { describe, expect, it } from 'bun:test';
import { mergeProjectPatch } from '../src/server/routes/projects.js';

// Mirrors the agents merge in the PUT /api/projects/:name handler: incoming
// roster entries are deep-merged against existing entries by name.
function mergeAgents(
  existing: Array<Record<string, unknown>>,
  incoming: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return incoming.map((agent) => {
    const current = existing.find((e) => e.name === agent.name);
    return current ? mergeProjectPatch(current, agent) : agent;
  });
}

describe('mergeProjectPatch roster agent models', () => {
  it('replaces the stored model when the incoming roster entry sets a new one', () => {
    expect(
      mergeProjectPatch({ name: 'builder', model: 'c/d' }, { name: 'builder', model: 'a/b' }),
    ).toEqual({ name: 'builder', model: 'a/b' });
  });

  it("overwrites the stored model with '' so no stale value survives", () => {
    expect(
      mergeProjectPatch({ name: 'builder', model: 'c/d' }, { name: 'builder', model: '' }),
    ).toEqual({ name: 'builder', model: '' });
  });

  it('preserves existing roster-entry fields the UI does not send', () => {
    expect(
      mergeProjectPatch(
        { name: 'builder', model: 'c/d', labels: { team: 'core' } },
        { name: 'builder', model: 'a/b' },
      ),
    ).toEqual({ name: 'builder', model: 'a/b', labels: { team: 'core' } });
  });

  it('keeps the existing roster entry untouched when the incoming one has no model', () => {
    expect(mergeProjectPatch({ name: 'builder', model: 'c/d' }, { name: 'builder' })).toEqual({
      name: 'builder',
      model: 'c/d',
    });
  });

  it('replaces models per roster entry at the spec level (PUT handler merge)', () => {
    const existing = [
      { name: 'builder', model: 'c/d' },
      { name: 'reviewer', model: 'x/y' },
    ];
    const incoming = [
      { name: 'builder', model: 'a/b' },
      { name: 'reviewer', model: '' },
    ];

    expect(mergeAgents(existing, incoming)).toEqual([
      { name: 'builder', model: 'a/b' },
      { name: 'reviewer', model: '' },
    ]);
  });
});
