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

// Git exports repo-local variables to hooks. For a linked worktree (which is
// how every agent checkout is mounted) GIT_DIR and GIT_INDEX_FILE are set to
// absolute paths inside the real repository. The husky pre-commit hook runs
// `pnpm test`, so this suite would inherit them and every spawned `git` would
// ignore its explicit `cwd`, letting the fixture's `git add`/`git commit` land
// on the developer's live branch and sweep in whatever was staged.
// Scrub these for the duration of each test and hand every spawned command an
// environment without them.
const GIT_REPO_ENV_VARS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_DIR',
  'GIT_GRAFT_FILE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_REPLACE_REF_BASE',
  'GIT_SHALLOW_FILE',
  'GIT_WORK_TREE',
] as const;

/** A copy of the environment with every repo-targeting git variable removed. */
function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of GIT_REPO_ENV_VARS) delete env[key];
  return env;
}

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
  const originalGitEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    // publishWorkerBranch reads the ambient process.env and its child git
    // processes inherit it, so scrub the hook-injected repo vars before each
    // test rather than only on the direct execFileSync calls below.
    for (const key of GIT_REPO_ENV_VARS) {
      originalGitEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    tempRoot = mkdtempSync(join(tmpdir(), 'git-publish-'));
    emptyDir = join(tempRoot, 'empty');
    mkdirSync(emptyDir);
  });

  afterEach(() => {
    delete process.env.RUN_GIT_BRANCH;
    if (originalWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = originalWorkspaceDir;
    for (const key of GIT_REPO_ENV_VARS) {
      const value = originalGitEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    originalGitEnv.clear();
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
    const env = cleanGitEnv();
    execFileSync('git', ['init', '--bare', bareDir], { cwd: tempRoot, env });
    execFileSync('git', ['init', workDir], { cwd: tempRoot, env });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workDir, env });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: workDir, env });
    writeFileSync(join(workDir, 'file.txt'), 'hello\n');
    execFileSync('git', ['add', 'file.txt'], { cwd: workDir, env });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: workDir, env });
    execFileSync('git', ['remote', 'add', 'origin', bareDir], { cwd: workDir, env });

    process.env.RUN_GIT_BRANCH = 'feature/unit';
    const result = await gitPublish.publishWorkerBranch({ cwd: workDir });
    expect(result.ok).toBe(true);

    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workDir, env })
      .toString()
      .trim();
    const ref = execFileSync(
      'git',
      ['--git-dir', bareDir, 'rev-parse', 'refs/percussionist/feature/unit'],
      { cwd: tempRoot, env },
    )
      .toString()
      .trim();
    expect(ref).toBe(head);
  });
});
