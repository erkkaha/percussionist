import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_WORKSPACE,
  gitHardeningFlags,
  gitPublish,
  resolveWorkspaceRoot,
} from './git-publish.js';

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

describe('resolveWorkspaceRoot', () => {
  const originalWorkspaceDir = process.env.WORKSPACE_DIR;

  afterEach(() => {
    if (originalWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = originalWorkspaceDir;
  });

  it('defaults to /workspace', () => {
    delete process.env.WORKSPACE_DIR;
    expect(resolveWorkspaceRoot()).toBe(DEFAULT_WORKSPACE);
    expect(resolveWorkspaceRoot()).toBe('/workspace');
  });

  it('honors WORKSPACE_DIR', () => {
    process.env.WORKSPACE_DIR = '/tmp/workspace-dir';
    expect(resolveWorkspaceRoot()).toBe('/tmp/workspace-dir');
  });

  it('prefers an explicit cwd override over WORKSPACE_DIR', () => {
    process.env.WORKSPACE_DIR = '/tmp/workspace-dir';
    expect(resolveWorkspaceRoot('/tmp/explicit')).toBe('/tmp/explicit');
  });
});

describe('gitPublish.publishWorkerBranch', () => {
  let tempRoot: string;
  let emptyDir: string;
  const originalWorkspaceDir = process.env.WORKSPACE_DIR;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'git-publish-'));
    emptyDir = join(tempRoot, 'empty');
    mkdirSync(emptyDir);
  });

  afterEach(() => {
    delete process.env.RUN_GIT_BRANCH;
    if (originalWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = originalWorkspaceDir;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('no-ops ok when RUN_GIT_BRANCH is unset', async () => {
    delete process.env.RUN_GIT_BRANCH;
    const result = await gitPublish.publishWorkerBranch();
    expect(result.ok).toBe(true);
    expect((result as { skipped?: string }).skipped).toContain('RUN_GIT_BRANCH');
  });

  it('no-ops ok when the workspace is not a git worktree', async () => {
    process.env.RUN_GIT_BRANCH = 'feature/some-task';
    const result = await gitPublish.publishWorkerBranch({ cwd: emptyDir });
    expect(result.ok).toBe(true);
    expect((result as { skipped?: string }).skipped).toContain('not a git worktree');
  });

  it('pushes HEAD to refs/percussionist/<branch> in the supplied cwd', async () => {
    const bareDir = join(tempRoot, 'bare.git');
    const workDir = join(tempRoot, 'work');
    execFileSync('git', ['init', '--bare', bareDir]);
    execFileSync('git', ['init', workDir]);
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: workDir });
    writeFileSync(join(workDir, 'file.txt'), 'hello\n');
    execFileSync('git', ['add', 'file.txt'], { cwd: workDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: workDir });
    execFileSync('git', ['remote', 'add', 'origin', bareDir], { cwd: workDir });

    process.env.RUN_GIT_BRANCH = 'feature/unit';
    const result = await gitPublish.publishWorkerBranch({ cwd: workDir });
    expect(result.ok).toBe(true);

    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workDir }).toString().trim();
    const ref = execFileSync('git', [
      '--git-dir',
      bareDir,
      'rev-parse',
      'refs/percussionist/feature/unit',
    ])
      .toString()
      .trim();
    expect(ref).toBe(head);
  });
});
