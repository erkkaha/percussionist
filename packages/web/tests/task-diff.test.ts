// task-diff.test.ts — Route-level tests for the diff context upgrade.
//
// Mocks the K8s client and the manager MCP exec endpoint so the route can be
// exercised without a live cluster. Verifies resolved SHAs, diff fingerprint,
// and findings projection (active/stale mapping + stable sort order).

import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DiffFinding, Project, Task } from '@percussionist/api';
import type { Hono } from 'hono';
import * as kube from '../src/server/kube.js';

// ---------------------------------------------------------------------------
// Test environment

const TEST_DATA_DIR = join('/tmp', `percussionist-task-diff-${Date.now()}`);

process.env.DATA_DIR = TEST_DATA_DIR;
process.env.AUTH_DISABLED = '1';

const BASE_SHA = 'base0000000000000000000000000000000000000';
const HEAD_SHA = 'head0000000000000000000000000000000000000';
const FORK_SHA = 'fork0000000000000000000000000000000000000';

const SAMPLE_DIFF = `diff --git a/src/index.ts b/src/index.ts
index 1111111..2222222 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,3 @@
 export function add(a: number, b: number): number {
-  return a + b;
+  return a - b;
 }
`;

const DIFF_FINGERPRINT = createHash('sha256')
  .update(`${FORK_SHA}\n${HEAD_SHA}\n${SAMPLE_DIFF.trim()}`)
  .digest('hex');

function makeGitOutput(diffText: string): string {
  return [
    '___META___',
    `BASE_SHA=${BASE_SHA}`,
    `HEAD_SHA=${HEAD_SHA}`,
    `FORK_SHA=${FORK_SHA}`,
    '___UNIFIED___',
    diffText,
    '___COMMITS___',
    'END',
  ].join('\n');
}

function makeMcpResponse(stdout: string): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ stdout, exitCode: 0 }),
          },
        ],
      },
    }),
    { status: 200, statusText: 'OK' },
  );
}

const MOCK_PROJECT = {
  apiVersion: 'percussionist.dev/v1alpha1',
  kind: 'Project',
  metadata: { name: 'test-proj' },
  spec: {
    source: { local: true },
    agents: [],
    maxParallel: 2,
  },
} as unknown as Project;

function makeTask(diffFindings?: Task['status']['diffFindings']): Task {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Task',
    metadata: { name: 'test-proj-task-1' },
    spec: {
      projectRef: 'test-proj',
      type: 'BUILD',
      title: 'test task',
      agent: 'builder',
    },
    status: {
      phase: 'succeeded',
      worker: {
        status: 'Succeeded',
        gitBranch: 'feature/thing',
        mergeIntoBranch: 'main',
      },
      diffFindings,
    },
  } as unknown as Task;
}

function makeFinding(
  id: string,
  severity: DiffFinding['severity'],
  options: {
    score?: number;
    line?: number;
    path?: string;
    context?: DiffFinding['context'];
  } = {},
): DiffFinding {
  return {
    id,
    source: 'reviewer',
    severity,
    score: options.score,
    title: `Finding ${id}`,
    comment: 'comment',
    anchors: [
      {
        path: options.path ?? 'src/index.ts',
        side: 'new',
        line: options.line ?? 1,
      },
    ],
    context: options.context ?? {
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      forkSha: FORK_SHA,
      diffFingerprint: DIFF_FINGERPRINT,
    },
    createdAt: '2026-01-01T00:00:00Z',
  } as DiffFinding;
}

// ---------------------------------------------------------------------------

let app: Hono;
let getProjectSpy: ReturnType<typeof spyOn>;
let getTaskSpy: ReturnType<typeof spyOn>;
let fetchSpy: ReturnType<typeof spyOn>;

beforeAll(async () => {
  mkdirSync(TEST_DATA_DIR, { recursive: true });

  getProjectSpy = spyOn(kube, 'getProject').mockResolvedValue(MOCK_PROJECT);
  getTaskSpy = spyOn(kube, 'getTask').mockResolvedValue(makeTask());
  fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
    makeMcpResponse(makeGitOutput(SAMPLE_DIFF)),
  );

  const { createApp } = await import('../src/server/app.js');
  app = createApp();
});

afterAll(() => {
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.AUTH_DISABLED;
  getProjectSpy.mockRestore();
  getTaskSpy.mockRestore();
  fetchSpy.mockRestore();
});

beforeEach(() => {
  getProjectSpy.mockResolvedValue(MOCK_PROJECT);
  getTaskSpy.mockResolvedValue(makeTask());
  fetchSpy.mockImplementation(() => Promise.resolve(makeMcpResponse(makeGitOutput(SAMPLE_DIFF))));
});

async function getDiff(project = 'test-proj', task = 'test-proj-task-1') {
  return app.request(`/api/projects/${project}/tasks/${task}/diff`);
}

// ---------------------------------------------------------------------------

describe('GET /api/projects/:project/tasks/:taskName/diff', () => {
  it('returns resolved SHAs, fingerprint, and empty findings', async () => {
    const res = await getDiff();
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      baseRef: string;
      headRef: string;
      baseSha: string;
      headSha: string;
      forkSha: string;
      diffFingerprint: string;
      context: { baseSha: string; headSha: string; forkSha: string; diffFingerprint: string };
      files: unknown[];
      findings: unknown[];
      empty: boolean;
    };

    expect(body.baseRef).toBe('main');
    expect(body.headRef).toBe('feature/thing');
    expect(body.baseSha).toBe(BASE_SHA);
    expect(body.headSha).toBe(HEAD_SHA);
    expect(body.forkSha).toBe(FORK_SHA);
    expect(body.diffFingerprint).toBe(DIFF_FINGERPRINT);
    expect(body.diffFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(body.context).toEqual({
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      forkSha: FORK_SHA,
      diffFingerprint: DIFF_FINGERPRINT,
    });
    expect(body.files.length).toBe(1);
    expect(body.findings).toEqual([]);
    expect(body.empty).toBe(false);
  });

  it('marks findings active when context matches and stale when it does not', async () => {
    const active = makeFinding('f1', 'high', { score: 80, line: 2 });
    const stale = makeFinding('f2', 'medium', {
      score: 50,
      line: 3,
      context: {
        baseSha: 'old-base',
        headSha: HEAD_SHA,
        forkSha: FORK_SHA,
        diffFingerprint: DIFF_FINGERPRINT,
      },
    });

    getTaskSpy.mockResolvedValue(
      makeTask({
        version: 1,
        context: active.context,
        items: [active, stale],
        updatedAt: '2026-01-01T00:00:00Z',
        sourceRunName: 'review-run-1',
      }),
    );

    const res = await getDiff();
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      findings: Array<{ id: string; isActive: boolean; isStale: boolean; severity: string }>;
    };

    expect(body.findings.length).toBe(2);
    expect(body.findings[0].id).toBe('f1');
    expect(body.findings[0].isActive).toBe(true);
    expect(body.findings[0].isStale).toBe(false);
    expect(body.findings[1].id).toBe('f2');
    expect(body.findings[1].isActive).toBe(false);
    expect(body.findings[1].isStale).toBe(true);
  });

  it('sorts findings by severity desc, score desc, path asc, line asc', async () => {
    const findings: DiffFinding[] = [
      makeFinding('a', 'high', { score: 90, line: 10, path: 'src/a.ts' }),
      makeFinding('b', 'critical', { score: 50, line: 1, path: 'src/z.ts' }),
      makeFinding('c', 'high', { score: 90, line: 5, path: 'src/a.ts' }),
      makeFinding('d', 'high', { score: 95, line: 1, path: 'src/a.ts' }),
      makeFinding('e', 'medium', { score: 100, line: 1, path: 'src/a.ts' }),
    ];

    getTaskSpy.mockResolvedValue(
      makeTask({
        version: 1,
        context: findings[0].context,
        items: findings,
        updatedAt: '2026-01-01T00:00:00Z',
        sourceRunName: 'review-run-1',
      }),
    );

    const res = await getDiff();
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      findings: Array<{ id: string; severity: string; score?: number }>;
    };

    const ids = body.findings.map((f) => f.id);
    // critical first, then high by score desc, then path/line asc, then medium
    expect(ids).toEqual(['b', 'd', 'c', 'a', 'e']);
  });

  it('returns empty diff with resolved SHAs/fingerprint when refs are identical', async () => {
    const identicalTask = makeTask();
    identicalTask.status.worker.gitBranch = 'main';
    identicalTask.status.worker.mergeIntoBranch = 'main';
    getTaskSpy.mockResolvedValue(identicalTask);

    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        makeMcpResponse(
          [
            '___META___',
            `BASE_SHA=${BASE_SHA}`,
            `HEAD_SHA=${BASE_SHA}`,
            `FORK_SHA=${BASE_SHA}`,
            '___UNIFIED___',
            '',
            '___COMMITS___',
            'END',
          ].join('\n'),
        ),
      ),
    );

    const res = await getDiff();
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      baseRef: string;
      headRef: string;
      baseSha: string;
      headSha: string;
      forkSha: string;
      diffFingerprint: string;
      files: unknown[];
      findings: unknown[];
      empty: boolean;
    };

    expect(body.baseRef).toBe('main');
    expect(body.headRef).toBe('main');
    expect(body.baseSha).toBe(BASE_SHA);
    expect(body.headSha).toBe(BASE_SHA);
    expect(body.forkSha).toBe(BASE_SHA);
    expect(body.diffFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(body.files).toEqual([]);
    expect(body.findings).toEqual([]);
    expect(body.empty).toBe(true);
  });

  it('marks finding stale when only the diff fingerprint differs', async () => {
    const fingerprintMismatch = makeFinding('f3', 'high', {
      context: {
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
        forkSha: FORK_SHA,
        diffFingerprint: 'different-fingerprint',
      },
    });

    getTaskSpy.mockResolvedValue(
      makeTask({
        version: 1,
        context: fingerprintMismatch.context,
        items: [fingerprintMismatch],
        updatedAt: '2026-01-01T00:00:00Z',
        sourceRunName: 'review-run-1',
      }),
    );

    const res = await getDiff();
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      findings: Array<{ id: string; isActive: boolean; isStale: boolean }>;
    };

    expect(body.findings.length).toBe(1);
    expect(body.findings[0].isActive).toBe(false);
    expect(body.findings[0].isStale).toBe(true);
  });

  it('returns stored findings even when the diff is empty', async () => {
    const identicalTask = makeTask();
    identicalTask.status.worker.gitBranch = 'main';
    identicalTask.status.worker.mergeIntoBranch = 'main';
    getTaskSpy.mockResolvedValue(
      makeTask({
        version: 1,
        context: {
          baseSha: BASE_SHA,
          headSha: HEAD_SHA,
          forkSha: FORK_SHA,
          diffFingerprint: DIFF_FINGERPRINT,
        },
        items: [makeFinding('f4', 'medium')],
        updatedAt: '2026-01-01T00:00:00Z',
        sourceRunName: 'review-run-1',
      }),
    );

    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        makeMcpResponse(
          [
            '___META___',
            `BASE_SHA=${BASE_SHA}`,
            `HEAD_SHA=${BASE_SHA}`,
            `FORK_SHA=${BASE_SHA}`,
            '___UNIFIED___',
            '',
            '___COMMITS___',
            'END',
          ].join('\n'),
        ),
      ),
    );

    const res = await getDiff();
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      files: unknown[];
      findings: Array<{ id: string }>;
      empty: boolean;
    };

    expect(body.files).toEqual([]);
    expect(body.empty).toBe(true);
    expect(body.findings.length).toBe(1);
    expect(body.findings[0].id).toBe('f4');
  });
});
