import { describe, expect, it } from 'bun:test';
import type { Task } from '@percussionist/api';
import { prOpenPromptLines } from '../worker-builder.js';

// Prompt contract for the PR-open run: the agent composes the PR body from the
// plan document and the build tasks' review records, then opens the PR with
// `gh pr create --body-file`. The body is LLM-authored but must be grounded in
// the supplied materials — the assertions here pin the sections, the grounding
// rules, and that the materials actually reach the prompt.
const SOURCE = 'feature/plan-efd08d';
const TARGET = 'main';

function makeBuildTask(name: string): Task {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Task',
    metadata: { name },
    spec: {
      title: `Build ${name}`,
      projectRef: 'test-project',
      type: 'BUILD',
      agent: 'builder',
    },
    status: {
      phase: 'done',
      worker: { retryCount: 1 } as never,
      reviews: [
        {
          action: 'request_changes',
          diagnosis: 'first-round diagnosis',
          feedback: 'fix the rollup cutoff',
          reviewedAt: '2026-08-01T00:00:00.000Z',
          attempt: 0,
        },
        {
          action: 'approve',
          diagnosis: 'verified rollup values against seed data',
          reviewedAt: '2026-08-02T00:00:00.000Z',
          attempt: 1,
        },
      ],
      diffFindings: {
        version: 1,
        context: { baseSha: 'a', headSha: 'b', forkSha: 'c', diffFingerprint: 'd' },
        items: [
          {
            id: 'f1',
            source: 'reviewer',
            severity: 'high',
            title: 'cutoff not inclusive',
            comment: 'the hour bucket excludes the boundary sample',
            anchors: [{ path: 'db/spec/tp.sql', side: 'new', line: 42 }],
            context: { baseSha: 'a', headSha: 'b', forkSha: 'c', diffFingerprint: 'd' },
            createdAt: '2026-08-02T00:00:00.000Z',
          },
        ],
        updatedAt: '2026-08-02T00:00:00.000Z',
        sourceRunName: 'review-run-1',
      },
    },
  } as Task;
}

const PLAN_DOC = [
  '# Plan: fix latest values',
  '## Context',
  'values stopped updating',
  '## Risks / open questions',
  '- rollup semantics drift',
].join('\n');

const prompt = prOpenPromptLines(
  'plan-efd08d',
  'latest sensor values are not updating',
  'due to refactoring of sensor calculations',
  SOURCE,
  TARGET,
  PLAN_DOC,
  [makeBuildTask('build-1')],
).join('\n');

describe('prOpenPromptLines — composed body, grounded in materials', () => {
  it('opens the PR with a body file, never an inline hardcoded body', () => {
    expect(prompt).toContain('--body-file /tmp/pr-body.md');
    expect(prompt).not.toContain('--body "');
  });

  it('requires every synthesized section', () => {
    for (const section of [
      '`## Deliverable`',
      '`## Context`',
      '`## How it was delivered`',
      '`## Verification`',
      '`## What the reviewer should look at`',
      '`## Risks`',
      '`## Acceptance criteria`',
    ]) {
      expect(prompt).toContain(section);
    }
    expect(prompt).toContain('Audit appendix');
  });

  it('states the grounding rules', () => {
    expect(prompt).toContain('the diff wins');
    expect(prompt).toContain('Never soften "unverified"');
    expect(prompt).toContain('never invent');
  });

  it('embeds the plan document verbatim', () => {
    expect(prompt).toContain('## Risks / open questions');
    expect(prompt).toContain('rollup semantics drift');
  });

  it('embeds the full review history including superseded rounds', () => {
    expect(prompt).toContain('first-round diagnosis');
    expect(prompt).toContain('fix the rollup cutoff');
    expect(prompt).toContain('verified rollup values against seed data');
  });

  it('embeds the latest findings with severity and anchor', () => {
    expect(prompt).toContain('[high] cutoff not inclusive (db/spec/tp.sql:42)');
  });

  it('keeps the body file outside the worktree and forbids repo writes', () => {
    expect(prompt).toContain('do not create or');
    expect(prompt).toContain('Writing /tmp/pr-body.md is fine; nothing under the worktree is.');
  });

  it('keeps the completion contract (pr-opened + prNumber via complete_merge)', () => {
    expect(prompt).toContain('percussionist_dispatcher_complete_merge');
    expect(prompt).toContain('outcome=`pr-opened`');
    expect(prompt).toContain('gh pr edit <number> --body-file /tmp/pr-body.md');
  });

  it('degrades gracefully when materials are missing', () => {
    const bare = prOpenPromptLines(
      'plan-x',
      'title',
      undefined,
      SOURCE,
      TARGET,
      null,
      [],
    ).join('\n');
    expect(bare).toContain('(No plan document was found for this task.)');
    expect(bare).toContain('(No build task review records were found for this task.)');
    expect(bare).toContain('Description: (none)');
    expect(bare).toContain('skip the');
  });
});
