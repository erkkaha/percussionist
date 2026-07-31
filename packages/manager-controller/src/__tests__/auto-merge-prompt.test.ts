import { describe, expect, it } from 'bun:test';
import { autoMergePromptLines } from '../worker-builder.js';

// Regression cover for percussionist-dev-build-15fc5e: the merge failed because
// every git step in this prompt was written against origin/<source>, and in
// auto-merge mode nothing ever publishes the source branch. The task's work sat
// in the git mirror while the board wedged, and the merges that did land only
// landed because the agent improvised a push of the source branch — which is the
// other thing we do not want, one remote branch per BUILD task.
const SOURCE = 'feature/plan-580f71--build-15fc5e';
const TARGET = 'feature/plan-580f71';
const prompt = autoMergePromptLines(
  'build-15fc5e',
  'Render project color chip',
  SOURCE,
  TARGET,
).join('\n');

describe('autoMergePromptLines — never depends on a published source branch', () => {
  it('states the source branch is normally absent from origin and must not be pushed', () => {
    expect(prompt).toContain('only in the local git mirror');
    expect(prompt).toContain('Do not push the source branch under any name');
  });

  it('tests fast-forward against the local tip, not origin/<source>', () => {
    expect(prompt).toContain(`git merge-base --is-ancestor "origin/${TARGET}" HEAD`);
    expect(prompt).not.toContain(`--is-ancestor origin/${TARGET} origin/${SOURCE}`);
  });

  it('verifies with the recorded SHA, since origin/<source> may not exist', () => {
    expect(prompt).toContain('SOURCE_SHA=$(git rev-parse HEAD)');
    expect(prompt).toContain(`git merge-base --is-ancestor "$SOURCE_SHA" "origin/${TARGET}"`);
    expect(prompt).not.toContain(`--is-ancestor origin/${SOURCE} origin/${TARGET}`);
  });

  // Publishing the source under any ref name is the remote-pollution failure.
  it('only ever pushes HEAD to the target ref', () => {
    const pushes = prompt.match(/git push [^\n]*/g) ?? [];
    expect(pushes.length).toBeGreaterThan(0);
    for (const push of pushes) {
      expect(push).toContain(`HEAD:refs/heads/${TARGET}`);
      expect(push).not.toContain(`refs/heads/${SOURCE}`);
    }
  });

  it('only fetches the target branch', () => {
    expect(prompt).toContain(`git fetch origin ${TARGET}`);
    expect(prompt).not.toContain(`git fetch origin ${SOURCE}`);
  });

  // Every ${...} must already be interpolated by the template literal: three of
  // these lines were single-quoted JS strings, so the shell received a literal
  // ${sourceBranch} and expanded it to nothing — `git reset --hard "origin/"`.
  it('leaves no un-interpolated placeholder for the shell to expand to nothing', () => {
    expect(prompt).not.toContain('${sourceBranch}');
    expect(prompt).not.toContain('${targetBranch}');
  });

  it('substitutes the real branch names', () => {
    expect(prompt).toContain(`Source branch: ${SOURCE}`);
    expect(prompt).toContain(`Target branch: ${TARGET}`);
  });
});
