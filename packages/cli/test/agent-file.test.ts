// agent-file.test.ts — `--agent-name` must bind to the immediately preceding
// `--agent-file` in argv order, not pair with it by array index.
//
// Regression: submit.ts index-paired the two parallel arrays, so any ordering
// other than strict alternating file/name pairs silently misassigned names.
// The fix uses a shared accumulator (createAgentFileAccumulator) that the
// `submit` command's option processors mutate in argv order, and the consuming
// loop in buildRunFromFlags reads { path, name? } entries directly. A
// --agent-name with no preceding unnamed --agent-file is a hard usage error.

import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { buildRunFromFlags, createAgentFileAccumulator } from '../src/submit.ts';

/**
 * Parse a submit-like argv against the same option wiring index.ts uses, and
 * return the shared accumulator's entries. Uses exitOverride() so commander's
 * own usage errors throw instead of process.exit() killing the test runner.
 */
function parseSubmit(args: string[]): ReturnType<typeof createAgentFileAccumulator>['entries'] {
  const acc = createAgentFileAccumulator();
  const cmd = new Command('submit');
  cmd
    .exitOverride()
    .option('--agent-file <path>', '', acc.pushFile)
    .option('--agent-name <name>', '', acc.bindName);
  cmd.parse(['node', 'beatctl', ...args]);
  return acc.entries;
}

function tempAgentFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'beatctl-agent-'));
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

describe('--agent-file / --agent-name pairing (argv order)', () => {
  it('binds a name to the immediately preceding file', () => {
    const entries = parseSubmit(['--agent-file', 'a.md', '--agent-name', 'A']);
    expect(entries).toEqual([{ path: 'a.md', name: 'A' }]);
  });

  it('binds a name to the preceding file even after earlier pairs', () => {
    const entries = parseSubmit([
      '--agent-file',
      'a.md',
      '--agent-name',
      'A',
      '--agent-file',
      'b.md',
      '--agent-name',
      'B',
    ]);
    expect(entries).toEqual([
      { path: 'a.md', name: 'A' },
      { path: 'b.md', name: 'B' },
    ]);
  });

  it('binds a name to the last file, leaving earlier files unnamed', () => {
    const entries = parseSubmit([
      '--agent-file',
      'a.md',
      '--agent-file',
      'b.md',
      '--agent-name',
      'B',
    ]);
    expect(entries).toEqual([{ path: 'a.md' }, { path: 'b.md', name: 'B' }]);
  });

  it('errors on a --agent-name with no preceding --agent-file', () => {
    expect(() => parseSubmit(['--agent-name', 'X'])).toThrow(/preceding --agent-file/);
  });

  it('errors when --agent-name precedes its file', () => {
    // Behavior change: this used to silently pair with the later file by
    // index. It never matched the documented "preceding file" contract.
    expect(() => parseSubmit(['--agent-name', 'X', '--agent-file', 'a.md'])).toThrow(
      /preceding --agent-file/,
    );
  });

  it('errors on a second name for the same file', () => {
    expect(() =>
      parseSubmit(['--agent-file', 'a.md', '--agent-name', 'A', '--agent-name', 'B']),
    ).toThrow(/preceding --agent-file/);
  });
});

describe('buildRunFromFlags consumption', () => {
  it('derives names from the file basename when no --agent-name was given', () => {
    const aPath = tempAgentFile('a.md', 'agent a');
    const bPath = tempAgentFile('b.md', 'agent b');
    const entries = parseSubmit([
      '--agent-file',
      aPath,
      '--agent-file',
      bPath,
      '--agent-name',
      'B',
    ]);
    const run = buildRunFromFlags({
      project: 'my-project',
      task: 'say hi',
      namespace: 'percussionist',
      name: 'r-agents',
      agentFile: entries,
    } as Parameters<typeof buildRunFromFlags>[0]);
    // a.md gets its name from the basename (not the explicit B), b.md keeps
    // the explicit --agent-name.
    expect(run.spec.inlineAgents).toEqual([
      { name: 'a', content: 'agent a' },
      { name: 'B', content: 'agent b' },
    ]);
  });
});

describe('real CLI usage error', () => {
  it('exits non-zero with a clear message for a dangling --agent-name', () => {
    const res = spawnSync('bun', ['src/index.ts', 'submit', '--agent-name', 'X'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('preceding --agent-file');
  });
});
