import { describe, expect, it } from 'bun:test';
import {
  deriveLatestActivity,
  deriveRunPurpose,
  deriveRunSummary,
  type RunSummaryRelatedTask,
  type RunSummaryRunLike,
  type RunSummarySpec,
  type RunSummaryStatus,
  summarizeToolPart,
} from '../src/client/lib/run-summary.js';
import type { SessionMessage, SessionPart, ToolPart } from '../src/client/lib/types.js';

// Fixed clock so every assertion is deterministic.
const NOW = Date.parse('2026-01-01T00:00:00Z');
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

function makeRun(
  overrides: { spec?: Partial<RunSummarySpec>; status?: Partial<RunSummaryStatus> } = {},
): RunSummaryRunLike {
  return {
    spec: { project: 'proj', ...overrides.spec },
    status: { phase: 'Running', ...overrides.status },
  };
}

function textPart(text: string): SessionPart {
  return { id: 'text-1', messageID: 'm1', type: 'text', text };
}

function toolPart(tool: string, input: Record<string, unknown> = {}, title?: string): ToolPart {
  return {
    id: `tool-${tool}`,
    messageID: 'm1',
    type: 'tool',
    callID: `call-${tool}`,
    tool,
    state: { status: 'completed', input, ...(title ? { title } : {}) },
  };
}

function message(
  role: 'user' | 'assistant',
  created: number,
  parts: SessionPart[] = [],
): SessionMessage {
  return {
    info: { id: `msg-${created}`, sessionID: 's1', role, time: { created } },
    parts,
  };
}

const task = (over: Partial<RunSummaryRelatedTask> = {}): RunSummaryRelatedTask => ({
  name: 'percussionist-dev-build-ae42f4',
  title: 'Add run summary API',
  type: 'BUILD',
  ...over,
});

// ---------------------------------------------------------------------------
// Purpose

describe('deriveRunPurpose', () => {
  it('prefers the related task as "<TYPE> · <title>"', () => {
    const { purpose, purposeKind } = deriveRunPurpose(makeRun(), task());
    expect(purpose).toBe('BUILD · Add run summary API');
    expect(purposeKind).toBe('task');
  });

  it('renders PLAN tasks with their type', () => {
    const { purpose, purposeKind } = deriveRunPurpose(makeRun(), task({ type: 'PLAN' }));
    expect(purpose).toBe('PLAN · Add run summary API');
    expect(purposeKind).toBe('task');
  });

  it('falls through when the related task has no title', () => {
    const { purpose, purposeKind } = deriveRunPurpose(
      makeRun({ spec: { task: 'Implement the thing' } }),
      task({ title: '   ' }),
    );
    expect(purpose).toBe('Implement the thing');
    expect(purposeKind).toBe('prompt');
  });

  it('uses the first non-empty prompt line and strips a TASK: prefix', () => {
    const run = makeRun({
      spec: { task: '\n\nTASK: percussionist-dev-build-ae42f4 — Add run summary API\nmore text' },
    });
    const { purpose, purposeKind } = deriveRunPurpose(run);
    expect(purpose).toBe('percussionist-dev-build-ae42f4 — Add run summary API');
    expect(purposeKind).toBe('prompt');
  });

  it('collapses whitespace inside the prompt line', () => {
    const run = makeRun({ spec: { task: 'Do   the\tthing\nsecond line' } });
    expect(deriveRunPurpose(run).purpose).toBe('Do the thing');
  });

  it('truncates long prompt purposes to ~120 chars', () => {
    const long = 'x'.repeat(300);
    const { purpose, purposeKind } = deriveRunPurpose(makeRun({ spec: { task: long } }));
    expect(purposeKind).toBe('prompt');
    expect(purpose).not.toBeNull();
    expect(purpose?.length).toBeLessThanOrEqual(120);
    expect(purpose?.endsWith('…')).toBe(true);
  });

  it('prefers the bounded taskPreview over the full task', () => {
    const run = makeRun({ spec: { taskPreview: 'Preview line', task: 'Full prompt line two' } });
    expect(deriveRunPurpose(run).purpose).toBe('Preview line');
  });

  it('renders an interactive run with no task', () => {
    const { purpose, purposeKind } = deriveRunPurpose(makeRun({ spec: { interactive: true } }));
    expect(purpose).toBe('Interactive session');
    expect(purposeKind).toBe('interactive');
  });

  it('reports none when there is no task, prompt or interactive flag', () => {
    const { purpose, purposeKind } = deriveRunPurpose(makeRun());
    expect(purpose).toBeNull();
    expect(purposeKind).toBe('none');
  });

  it('treats a deleted task as absent and falls back to the prompt', () => {
    const run = makeRun({ spec: { boardTask: 'gone', task: 'Fallback prompt' } });
    expect(deriveRunPurpose(run, null)).toEqual({
      purpose: 'Fallback prompt',
      purposeKind: 'prompt',
    });
  });

  it('treats a deleted task as absent and falls back to interactive', () => {
    const run = makeRun({ spec: { boardTask: 'gone', interactive: true } });
    expect(deriveRunPurpose(run, null).purposeKind).toBe('interactive');
  });

  it('ignores a blank prompt and falls through to none', () => {
    expect(deriveRunPurpose(makeRun({ spec: { task: '   \n  ' } })).purposeKind).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// summarizeToolPart

describe('summarizeToolPart', () => {
  it('maps read tools to Reading <basename>', () => {
    expect(summarizeToolPart(toolPart('read', { filePath: '/a/b/run-summary.ts' }))).toBe(
      'Reading run-summary.ts',
    );
    expect(summarizeToolPart(toolPart('read_file', { file_path: 'src/x.ts' }))).toBe(
      'Reading x.ts',
    );
  });

  it.each(['edit', 'write', 'patch', 'apply_patch'])('maps %s to Editing <basename>', (tool) => {
    expect(summarizeToolPart(toolPart(tool, { filePath: 'src/client/RunDetail.tsx' }))).toBe(
      'Editing RunDetail.tsx',
    );
  });

  it('maps bash to Running <first token> … when more tokens follow', () => {
    expect(summarizeToolPart(toolPart('bash', { command: 'pnpm test --filter web' }))).toBe(
      'Running pnpm …',
    );
  });

  it('maps a single-token bash command without an ellipsis', () => {
    expect(summarizeToolPart(toolPart('bash', { command: 'ls' }))).toBe('Running ls');
  });

  it('maps shell commands too', () => {
    expect(summarizeToolPart(toolPart('shell', { cmd: 'git status' }))).toBe('Running git …');
  });

  it('maps search family tools to Searching the workspace', () => {
    for (const tool of ['grep', 'glob', 'search', 'codebase_search']) {
      expect(summarizeToolPart(toolPart(tool))).toBe('Searching the workspace');
    }
  });

  it('maps plan tools to Working on the plan', () => {
    for (const tool of ['write_plan', 'read_plan']) {
      expect(summarizeToolPart(toolPart(tool))).toBe('Working on the plan');
    }
  });

  it('maps task-list tools to Updating the task list', () => {
    for (const tool of ['todowrite', 'task']) {
      expect(summarizeToolPart(toolPart(tool))).toBe('Updating the task list');
    }
  });

  it('maps fetch tools to Fetching a URL', () => {
    for (const tool of ['fetch', 'webfetch']) {
      expect(summarizeToolPart(toolPart(tool))).toBe('Fetching a URL');
    }
  });

  it('falls back to Using <tool> for unknown opencode and claude names', () => {
    expect(summarizeToolPart(toolPart('some_custom_tool'))).toBe('Using some_custom_tool');
    expect(summarizeToolPart(toolPart('multiagent'))).toBe('Using multiagent');
  });

  it('handles PascalCase claude tool names via lowercasing', () => {
    expect(summarizeToolPart(toolPart('Read', { filePath: 'a.ts' }))).toBe('Reading a.ts');
    expect(summarizeToolPart(toolPart('Bash', { command: 'ls -la' }))).toBe('Running ls …');
  });

  it('prefers structured input over runner-generated state.title', () => {
    const part = toolPart('read', { filePath: '/a/real.ts' }, '/etc/passwd');
    expect(summarizeToolPart(part)).toBe('Reading real.ts');
  });

  it('degrades to a generic phrase when no path is present', () => {
    expect(summarizeToolPart(toolPart('read', {}))).toBe('Reading a file');
    expect(summarizeToolPart(toolPart('edit', {}))).toBe('Editing a file');
    expect(summarizeToolPart(toolPart('bash', {}))).toBe('Running a command');
  });
});

// ---------------------------------------------------------------------------
// Terminal activity

describe('deriveLatestActivity — terminal', () => {
  it('reports "Completed in <duration>" for Succeeded runs', () => {
    const run = makeRun({
      status: { phase: 'Succeeded', startedAt: iso(NOW - 12 * MIN), completedAt: iso(NOW) },
    });
    const result = deriveLatestActivity(run, [], NOW);
    expect(result.activity).toBe('Completed in 12m');
    expect(result.activityAt).toBe(NOW);
    expect(result.activityIsStale).toBe(false);
  });

  it('reports "Completed" when timings are missing', () => {
    expect(
      deriveLatestActivity(makeRun({ status: { phase: 'Succeeded' } }), [], NOW).activity,
    ).toBe('Completed');
  });

  it('reports "Failed — <message>" for Failed runs', () => {
    const run = makeRun({ status: { phase: 'Failed', message: 'OOMKilled' } });
    expect(deriveLatestActivity(run, [], NOW).activity).toBe('Failed — OOMKilled');
  });

  it('truncates the failure message to ~80 chars', () => {
    const run = makeRun({ status: { phase: 'Failed', message: 'boom '.repeat(50) } });
    const { activity } = deriveLatestActivity(run, [], NOW);
    expect(activity.startsWith('Failed — ')).toBe(true);
    expect(activity.length).toBeLessThanOrEqual('Failed — '.length + 80);
    expect(activity.endsWith('…')).toBe(true);
  });

  it('reports bare "Failed" without a message', () => {
    expect(deriveLatestActivity(makeRun({ status: { phase: 'Failed' } }), [], NOW).activity).toBe(
      'Failed',
    );
  });

  it('reports "Cancelled" for Cancelled runs', () => {
    const run = makeRun({ status: { phase: 'Cancelled', completedAt: iso(NOW - MIN) } });
    const result = deriveLatestActivity(run, [], NOW);
    expect(result.activity).toBe('Cancelled');
    expect(result.activityAt).toBe(NOW - MIN);
    expect(result.activityIsStale).toBe(false);
  });

  it('never uses an in-progress verb for a terminal run, even with a tool part', () => {
    const run = makeRun({
      status: { phase: 'Succeeded', startedAt: iso(NOW - 2 * MIN), completedAt: iso(NOW) },
    });
    const messages = [message('assistant', NOW - MIN, [toolPart('edit', { filePath: 'a.ts' })])];
    const { activity } = deriveLatestActivity(run, messages, NOW);
    expect(activity).toBe('Completed in 2m');
    expect(activity).not.toContain('Editing');
  });

  it('does not mark old terminal runs stale', () => {
    const run = makeRun({ status: { phase: 'Cancelled', completedAt: iso(NOW - 3 * 60 * MIN) } });
    expect(deriveLatestActivity(run, [], NOW).activityIsStale).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Active activity

describe('deriveLatestActivity — active', () => {
  it('uses the last tool part in the newest message', () => {
    const run = makeRun();
    const messages = [
      message('assistant', NOW - 3 * MIN, [
        toolPart('read', { filePath: 'old.ts' }),
        textPart('some prose'),
        toolPart('edit', { filePath: 'RunDetail.tsx' }),
      ]),
    ];
    const result = deriveLatestActivity(run, messages, NOW);
    expect(result.activity).toBe('Editing RunDetail.tsx');
    expect(result.activityAt).toBe(NOW - 3 * MIN);
  });

  it.each([
    ['read', { filePath: '/repo/run-summary.ts' }, 'Reading run-summary.ts'],
    ['edit', { filePath: 'src/RunList.tsx' }, 'Editing RunList.tsx'],
    ['bash', { command: 'pnpm typecheck' }, 'Running pnpm …'],
    ['grep', { pattern: 'foo' }, 'Searching the workspace'],
    ['write_plan', {}, 'Working on the plan'],
    ['todowrite', {}, 'Updating the task list'],
    ['webfetch', { url: 'https://example.com' }, 'Fetching a URL'],
    ['mystery', {}, 'Using mystery'],
  ])('maps %s tool parts to activity', (tool, input, expected) => {
    const messages = [message('assistant', NOW, [toolPart(tool as string, input)])];
    expect(deriveLatestActivity(makeRun(), messages, NOW).activity).toBe(expected);
  });

  it('never turns assistant text into activity text', () => {
    const prose = 'Here is a long model explanation about the change I made';
    const messages = [message('assistant', NOW, [textPart(prose)])];
    const result = deriveLatestActivity(makeRun(), messages, NOW);
    expect(result.activity).toBe('Thinking…');
    expect(result.activity).not.toContain(prose);
  });

  it('reports Thinking… for an assistant message with no tool part', () => {
    const messages = [message('assistant', NOW - MIN, [])];
    expect(deriveLatestActivity(makeRun(), messages, NOW).activity).toBe('Thinking…');
  });

  it('reports Awaiting agent response when the newest message is a user message', () => {
    const messages = [message('assistant', NOW - 2 * MIN, []), message('user', NOW - MIN, [])];
    const result = deriveLatestActivity(makeRun(), messages, NOW);
    expect(result.activity).toBe('Awaiting agent response');
    expect(result.activityAt).toBe(NOW - MIN);
  });

  it('surfaces a short, non-technical status message when there is no session', () => {
    const run = makeRun({ status: { phase: 'Running', message: 'Waiting for the pod' } });
    expect(deriveLatestActivity(run, [], NOW).activity).toBe('Waiting for the pod');
  });

  it('refuses technical status messages and falls back to a phase verb', () => {
    const run = makeRun({
      status: { phase: 'Running', message: 'init container /bin/sh exited' },
    });
    expect(deriveLatestActivity(run, [], NOW).activity).toBe('Working');
  });

  it('refuses messages with = or over 80 chars', () => {
    expect(
      deriveLatestActivity(makeRun({ status: { message: 'RUN_TASK=foo' } }), [], NOW).activity,
    ).toBe('Working');
    expect(
      deriveLatestActivity(makeRun({ status: { message: 'y'.repeat(81) } }), [], NOW).activity,
    ).toBe('Working');
  });

  it('maps phases to verbs when there is no message', () => {
    expect(deriveLatestActivity(makeRun({ status: { phase: 'Pending' } }), [], NOW).activity).toBe(
      'Starting up',
    );
    expect(
      deriveLatestActivity(makeRun({ status: { phase: 'Initializing' } }), [], NOW).activity,
    ).toBe('Initializing workspace');
    expect(deriveLatestActivity(makeRun({ status: { phase: 'Running' } }), [], NOW).activity).toBe(
      'Working',
    );
  });

  it('reports Waiting for your input for WaitingForInput with no session', () => {
    const run = makeRun({ status: { phase: 'WaitingForInput' } });
    expect(deriveLatestActivity(run, [], NOW).activity).toBe('Waiting for your input');
  });

  it('uses lastEventAt then startedAt when there are no messages', () => {
    const withEvent = makeRun({
      status: { phase: 'Running', startedAt: iso(NOW - 10 * MIN), lastEventAt: iso(NOW - MIN) },
    });
    expect(deriveLatestActivity(withEvent, [], NOW).activityAt).toBe(NOW - MIN);

    const startedOnly = makeRun({ status: { phase: 'Running', startedAt: iso(NOW - MIN) } });
    expect(deriveLatestActivity(startedOnly, [], NOW).activityAt).toBe(NOW - MIN);
  });

  it('returns a null timestamp when nothing is timed', () => {
    const result = deriveLatestActivity(makeRun({ status: { phase: 'Pending' } }), [], NOW);
    expect(result.activityAt).toBeNull();
    expect(result.activityIsStale).toBe(false);
  });

  it('collapses newlines in a status message into a single line', () => {
    const run = makeRun({ status: { message: 'Waiting\nfor\tthe pod' } });
    expect(deriveLatestActivity(run, [], NOW).activity).toBe('Waiting for the pod');
  });
});

// ---------------------------------------------------------------------------
// Staleness

describe('deriveLatestActivity — staleness', () => {
  it('does not flag exactly 5 minutes as stale', () => {
    const messages = [
      message('assistant', NOW - 5 * MIN, [toolPart('read', { filePath: 'a.ts' })]),
    ];
    const result = deriveLatestActivity(makeRun(), messages, NOW);
    expect(result.activity).toBe('Reading a.ts');
    expect(result.activityIsStale).toBe(false);
  });

  it('flags activity just past 5 minutes and appends the age', () => {
    const messages = [
      message('assistant', NOW - (5 * MIN + 1), [toolPart('read', { filePath: 'a.ts' })]),
    ];
    const result = deriveLatestActivity(makeRun(), messages, NOW);
    expect(result.activity).toBe('Reading a.ts (no activity for 5m)');
    expect(result.activityIsStale).toBe(true);
  });

  it('reports a full stale age in minutes', () => {
    const messages = [
      message('assistant', NOW - 7 * MIN, [toolPart('edit', { filePath: 'a.ts' })]),
    ];
    expect(deriveLatestActivity(makeRun(), messages, NOW).activity).toBe(
      'Editing a.ts (no activity for 7m)',
    );
  });

  it('renders "No activity for Xm" when there is no activity source at all', () => {
    const run = makeRun({ status: { phase: 'Pending', startedAt: iso(NOW - 7 * MIN) } });
    const result = deriveLatestActivity(run, [], NOW);
    expect(result.activity).toBe('No activity for 7m');
    expect(result.activityIsStale).toBe(true);
  });

  it('keeps the activity phrase when lastEventAt is the stale source', () => {
    const run = makeRun({
      status: {
        phase: 'Running',
        message: 'Waiting for the pod',
        lastEventAt: iso(NOW - 6 * MIN),
      },
    });
    expect(deriveLatestActivity(run, [], NOW).activity).toBe(
      'Waiting for the pod (no activity for 6m)',
    );
  });
});

// ---------------------------------------------------------------------------
// Top-level view model

describe('deriveRunSummary', () => {
  it('derives a task-linked summary', () => {
    const summary = deriveRunSummary({
      run: makeRun({ status: { phase: 'Running', startedAt: iso(NOW - MIN) } }),
      relatedTask: task(),
      sessionMessages: [
        message('assistant', NOW - 30_000, [toolPart('edit', { filePath: 'a.ts' })]),
      ],
      now: NOW,
    });
    expect(summary).toEqual({
      hasSummary: true,
      purpose: 'BUILD · Add run summary API',
      purposeKind: 'task',
      mode: 'automated',
      activity: 'Editing a.ts',
      activityAt: NOW - 30_000,
      activityIsStale: false,
    });
  });

  it('marks interactive mode from spec.interactive', () => {
    const summary = deriveRunSummary({
      run: makeRun({ spec: { interactive: true } }),
      now: NOW,
    });
    expect(summary.mode).toBe('interactive');
    expect(summary.purposeKind).toBe('interactive');
    expect(summary.hasSummary).toBe(true);
  });

  it('reports hasSummary false with no purpose source but still derives activity', () => {
    const summary = deriveRunSummary({
      run: makeRun({
        status: { phase: 'Succeeded', startedAt: iso(NOW - MIN), completedAt: iso(NOW) },
      }),
      now: NOW,
    });
    expect(summary.hasSummary).toBe(false);
    expect(summary.purpose).toBeNull();
    expect(summary.purposeKind).toBe('none');
    expect(summary.activity).toBe('Completed in 1m');
  });

  it('defaults sessionMessages to an empty array', () => {
    const summary = deriveRunSummary({ run: makeRun({ spec: { task: 'Hi' } }), now: NOW });
    expect(summary.purpose).toBe('Hi');
    expect(summary.activity).toBe('Working');
  });

  it('returns a null activityAt when nothing is timed', () => {
    const summary = deriveRunSummary({ run: makeRun({ spec: { task: 'Hi' } }), now: NOW });
    expect(summary.activityAt).toBeNull();
  });
});
