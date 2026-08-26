import { afterEach, describe, expect, it } from 'bun:test';
import { gitHardeningFlags, gitPublish } from './git-publish.js';

describe('gitHardeningFlags', () => {
  afterEach(() => {
    delete process.env.GITHUB_TOKEN;
  });

  it('disables config-driven code execution and credential helpers', () => {
    const flags = gitHardeningFlags();
    expect(flags).toContain('core.fsmonitor=false');
    expect(flags).toContain('core.hooksPath=/dev/null');
    expect(flags).toContain('credential.helper=');
  });

  it('adds a token credential helper only when GITHUB_TOKEN is set', () => {
    expect(gitHardeningFlags().some((f) => f.includes('x-access-token'))).toBe(false);
    process.env.GITHUB_TOKEN = 'tok';
    expect(gitHardeningFlags().some((f) => f.includes('x-access-token'))).toBe(true);
  });
});

describe('gitPublish.publishWorkerBranch', () => {
  afterEach(() => {
    delete process.env.RUN_GIT_BRANCH;
  });

  it('no-ops ok when RUN_GIT_BRANCH is unset', async () => {
    delete process.env.RUN_GIT_BRANCH;
    const result = await gitPublish.publishWorkerBranch();
    expect(result.ok).toBe(true);
    expect((result as { skipped?: string }).skipped).toContain('RUN_GIT_BRANCH');
  });

  it('no-ops ok when /workspace is not a git worktree', async () => {
    process.env.RUN_GIT_BRANCH = 'feature/some-task';
    // In the test environment /workspace does not exist, so the repo probe
    // fails and the publish must degrade to a skip, not an error.
    const result = await gitPublish.publishWorkerBranch();
    expect(result.ok).toBe(true);
    expect((result as { skipped?: string }).skipped).toContain('not a git worktree');
  });
});
