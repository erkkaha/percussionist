import { describe, expect, it } from 'bun:test';
import { childMergeExpected, childSatisfiesGate } from '../child-completion.js';
import { resolveFlow } from '../flow.js';
import { makeProject, makeTask } from './fixtures.js';

const PRESETS = ['simple', 'review', 'plan-build', 'plan-build-review-merge'] as const;

describe('childMergeExpected', () => {
  for (const preset of PRESETS) {
    for (const featureBranchingEnabled of [true, false]) {
      const expected = preset === 'plan-build-review-merge' && featureBranchingEnabled;

      it(`${preset} preset, featureBranchingEnabled=${featureBranchingEnabled} → ${expected}`, () => {
        const project = makeProject('test-project', { featureBranchingEnabled });
        project.spec.flow = { preset };
        const flow = resolveFlow(project);

        expect(childMergeExpected(project, flow)).toBe(expected);
      });
    }
  }
});

describe('childSatisfiesGate', () => {
  it('not done → false regardless of mergeExpected', () => {
    const child = makeTask('build-a', 'test-project', { phase: 'running' });
    expect(childSatisfiesGate(child, true)).toBe(false);
    expect(childSatisfiesGate(child, false)).toBe(false);
  });

  it('done with mergedAt → true when merge is expected', () => {
    const child = makeTask('build-a', 'test-project', {
      phase: 'done',
      mergedAt: '2026-05-29T00:00:00.000Z',
    });
    expect(childSatisfiesGate(child, true)).toBe(true);
  });

  it('done without mergedAt and merge expected → false', () => {
    const child = makeTask('build-a', 'test-project', { phase: 'done' });
    expect(childSatisfiesGate(child, true)).toBe(false);
  });

  it('done without mergedAt and merge NOT expected → true', () => {
    const child = makeTask('build-a', 'test-project', { phase: 'done' });
    expect(childSatisfiesGate(child, false)).toBe(true);
  });

  it('done and abandoned satisfies the gate even when merge is otherwise expected', () => {
    const child = makeTask('build-a', 'test-project', { phase: 'done', abandoned: true });
    expect(childSatisfiesGate(child, true)).toBe(true);
  });

  it('done and abandoned with no mergedAt still satisfies when merge is not expected', () => {
    const child = makeTask('build-a', 'test-project', { phase: 'done', abandoned: true });
    expect(childSatisfiesGate(child, false)).toBe(true);
  });
});
