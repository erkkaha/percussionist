// tools-pause-reconciliation.test.ts
//
// Tool-level coverage for the per-project pause tools (finding A4 from
// percussionist-dev-plan-4abf54): pause_reconciliation, resume_reconciliation,
// get_reconcile_status. Pins:
//   - pausing one project never freezes another (per-project map);
//   - pause_reconciliation writes the reconcile-paused annotations and
//     resume_reconciliation clears them (merge-patch null, not undefined);
//   - get_reconcile_status reports real elapsedMs/remainingMs and a real (or
//     absent) lastReconcile — never a fabricated timestamp;
//   - get_reconcile_status honors the annotations with no in-memory state
//     (pause survives a manager restart).

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

// Load the real kube module first and spread it into the mock factory so the
// transitive imports of tools.js (reconciler-bridge.ts imports
// makeNodeApiClient/NAMESPACE) resolve even when this file runs alone —
// bun's mock.module replaces the whole module with the factory otherwise.
const realKube = await import('@percussionist/kube');

const state = {
  /** Annotations as seen on each project CR (patched by patchProject). */
  annotationsByProject: {} as Record<string, Record<string, string>>,
  patches: [] as Array<{ name: string; patch: Record<string, unknown>; ns: string }>,
};

mock.module('@percussionist/kube', () => ({
  ...realKube,
  apps: () => ({}),
  buildTask: (args: Record<string, unknown>) => ({
    metadata: { name: args.name },
    ...args,
    status: { phase: 'pending' },
  }),
  createRun: async () => ({}),
  createTask: async (task: Record<string, unknown>) => task,
  deleteRun: async () => undefined,
  execInWorkspace: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  fetchAllSessionMessages: async () => ({ sessions: [], allMessages: [] }),
  fetchSessionMessages: async () => ({ messages: [], total: 0, nextSince: 0 }),
  getDeploymentImages: async () => ({}),
  getDispatcherImageFromOperatorDeployment: async () => 'dispatcher:latest',
  getProject: async (name: string, _ns: string) => ({
    metadata: {
      name,
      uid: `uid-${name}`,
      namespace: 'percussionist',
      ...(state.annotationsByProject[name]
        ? { annotations: { ...state.annotationsByProject[name] } }
        : {}),
    },
    spec: { agents: [{ name: 'builder' }], source: { local: true } },
  }),
  getRun: async () => ({ status: { phase: 'Succeeded' }, spec: {} }),
  getTask: async () => ({
    metadata: { name: 'task-1' },
    spec: { type: 'BUILD', projectRef: 'proj', title: 't', agent: 'builder' },
    status: { phase: 'pending', worker: { retryCount: 0, aiReworkCount: 0 } },
  }),
  gitUrlHash: (url: string) => String(url.length),
  listClusterAgents: async () => [],
  listPodsByLabels: async () => [],
  listRuns: async () => [],
  listTasks: async () => [],
  patchProject: async (name: string, patch: Record<string, unknown>, ns: string) => {
    state.patches.push({ name, patch, ns });
    // Mirror a merge patch: apply annotation writes, honor null as "delete".
    const annotations =
      (patch.metadata as { annotations?: Record<string, unknown> } | undefined)?.annotations ?? {};
    const current = state.annotationsByProject[name] ?? {};
    state.annotationsByProject[name] = current;
    for (const [key, value] of Object.entries(annotations)) {
      if (value === null) delete current[key];
      else current[key] = String(value);
    }
    return { metadata: { name, annotations: { ...current } } };
  },
  patchTaskStatus: async () => ({ metadata: { name: 'task-1' } }),
  readAllSessionsFromConfigMap: async () => null,
  readPlanFromConfigMap: async () => null,
  readPodLog: async () => '',
  readSessionConfigMap: async () => null,
  validateAgentTaskCapability: async () => ({ ok: true }),
  writePlanToConfigMap: async () => undefined,
}));

const { __test } = await import('../tools.js');
// Same module instance tools.js imports — used to clear in-memory pause state
// between tests (the tool writes annotations too, but the map is the fast path).
const { setPaused } = await import('../../reconciler-bridge.js');

interface McpResponse {
  isError: boolean | undefined;
  text: string;
  parsed: Record<string, unknown>;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<McpResponse> {
  const response = (await __test.handleMcp({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  })) as {
    result?: { isError?: boolean; content?: Array<{ text: string }> };
  };
  const text = response.result?.content?.[0]?.text ?? '';
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // keep {} — assertion helpers below surface the raw text
  }
  return { isError: response.result?.isError, text, parsed };
}

describe('pause_reconciliation / resume_reconciliation / get_reconcile_status', () => {
  beforeEach(() => {
    state.patches = [];
    state.annotationsByProject = {};
    // Clear the shared in-memory pause map so tests start clean.
    setPaused('tool-proj-a', false, 0, 'percussionist');
    setPaused('tool-proj-b', false, 0, 'percussionist');
  });

  afterEach(() => {
    state.patches = [];
    state.annotationsByProject = {};
    setPaused('tool-proj-a', false, 0, 'percussionist');
    setPaused('tool-proj-b', false, 0, 'percussionist');
  });

  it('pause_reconciliation pauses only the addressed project', async () => {
    const result = await callTool('pause_reconciliation', {
      project: 'tool-proj-a',
      durationSeconds: 600,
    });

    expect(result.isError).toBeUndefined();
    expect(result.parsed.paused).toBe(true);
    expect(result.parsed.durationSeconds).toBe(600);
    expect(result.parsed.autoResumeAt).toBeDefined();

    const statusA = await callTool('get_reconcile_status', { project: 'tool-proj-a' });
    expect(statusA.parsed.paused).toBe(true);
    expect(statusA.parsed.remainingMs).toBeGreaterThan(0);
    expect(statusA.parsed.remainingMs).toBeLessThanOrEqual(600_000);
    expect(statusA.parsed.elapsedMs).toBeGreaterThanOrEqual(0);

    const statusB = await callTool('get_reconcile_status', { project: 'tool-proj-b' });
    expect(statusB.parsed.paused).toBe(false);
    expect(statusB.parsed.elapsedMs).toBe(0);
    expect(statusB.parsed.remainingMs).toBe(0);
  });

  it('pause_reconciliation writes the reconcile-paused annotations', async () => {
    await callTool('pause_reconciliation', { project: 'tool-proj-a', durationSeconds: 600 });

    expect(state.patches).toHaveLength(1);
    const { name, patch, ns } = state.patches[0] ?? {};
    expect(name).toBe('tool-proj-a');
    expect(ns).toBe('percussionist');
    const annotations = (patch?.metadata as { annotations?: Record<string, unknown> } | undefined)
      ?.annotations;
    expect(annotations?.['percussionist.dev/reconcile-paused']).toBe('true');
    expect(annotations?.['percussionist.dev/reconcile-paused-duration']).toBe('600');
    expect(annotations?.['percussionist.dev/reconcile-paused-at']).toBeDefined();
    // The mock patchProject applied them to the CR — a subsequent read sees them.
    expect(state.annotationsByProject['tool-proj-a']?.['percussionist.dev/reconcile-paused']).toBe(
      'true',
    );
  });

  it('resume_reconciliation clears the in-memory pause and the annotations', async () => {
    await callTool('pause_reconciliation', { project: 'tool-proj-a', durationSeconds: 600 });
    state.patches = [];

    const result = await callTool('resume_reconciliation', { project: 'tool-proj-a' });
    expect(result.isError).toBeUndefined();
    expect(result.parsed.paused).toBe(false);

    const statusA = await callTool('get_reconcile_status', { project: 'tool-proj-a' });
    expect(statusA.parsed.paused).toBe(false);

    // The resume patch clears the annotations with merge-patch null.
    expect(state.patches).toHaveLength(1);
    const annotations = (
      state.patches[0]?.patch.metadata as { annotations?: Record<string, unknown> } | undefined
    )?.annotations;
    expect(annotations?.['percussionist.dev/reconcile-paused']).toBeNull();
    expect(annotations?.['percussionist.dev/reconcile-paused-at']).toBeNull();
    expect(annotations?.['percussionist.dev/reconcile-paused-duration']).toBeNull();
    expect(JSON.stringify(state.patches[0]?.patch)).toContain(
      '"percussionist.dev/reconcile-paused":null',
    );
    expect(state.annotationsByProject['tool-proj-a']).toEqual({});
  });

  it('get_reconcile_status never fabricates lastReconcile', async () => {
    const status = await callTool('get_reconcile_status', { project: 'tool-proj-a' });

    expect(status.isError).toBeUndefined();
    expect(status.parsed.paused).toBe(false);
    // No reconcile has happened in this process — the key must be absent, not
    // a fresh timestamp.
    expect('lastReconcile' in status.parsed).toBe(false);
  });

  it('get_reconcile_status requires a project argument', async () => {
    const result = await callTool('get_reconcile_status', {});

    expect(result.isError).toBe(true);
    expect(result.text).toContain('project is required');
  });

  it('annotation-only pause (written by a previous manager process) is honored', async () => {
    // Simulate a manager restart: the CR carries annotations from a previous
    // process and the in-memory map has no entry.
    state.annotationsByProject['tool-proj-a'] = {
      'percussionist.dev/reconcile-paused': 'true',
      'percussionist.dev/reconcile-paused-at': new Date(Date.now() - 5_000).toISOString(),
      'percussionist.dev/reconcile-paused-duration': '60',
    };
    setPaused('tool-proj-a', false, 0, 'percussionist');

    const status = await callTool('get_reconcile_status', { project: 'tool-proj-a' });
    expect(status.isError).toBeUndefined();
    expect(status.parsed.paused).toBe(true);
    expect(status.parsed.elapsedMs).toBeGreaterThanOrEqual(5_000);
    expect(status.parsed.remainingMs).toBeGreaterThan(0);
  });

  it('an expired annotation reports not paused with 0 remaining', async () => {
    state.annotationsByProject['tool-proj-a'] = {
      'percussionist.dev/reconcile-paused': 'true',
      'percussionist.dev/reconcile-paused-at': new Date(Date.now() - 120_000).toISOString(),
      'percussionist.dev/reconcile-paused-duration': '60',
    };
    setPaused('tool-proj-a', false, 0, 'percussionist');

    const status = await callTool('get_reconcile_status', { project: 'tool-proj-a' });
    expect(status.parsed.paused).toBe(false);
    expect(status.parsed.remainingMs).toBe(0);
    expect(status.parsed.elapsedMs).toBe(60_000);
  });
});
