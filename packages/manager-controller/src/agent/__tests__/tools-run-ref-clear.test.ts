// tools-run-ref-clear.test.ts
//
// Regression coverage for the `runName: undefined` merge-patch bug in the
// admin tools (agent/tools.ts).
//
// patchTaskStatus (packages/kube/src/index.ts) sends a JSON merge patch
// (RFC 7386), and JSON.stringify strips `undefined` object values — so a
// patch body of { worker: { runName: undefined } } serializes to {} and the
// stale runName survives in Task.status.worker. After
// set_task_state(..., cancelRunning: true) deletes the run, the next
// reconcile sees no observed run → WorkerRunMissing → the task flips to
// failed, the opposite of the intended recovery.
//
// The fix: the five call sites must carry `runName: null` (runtime null),
// which the merge patch honors. This suite captures the patchTaskStatus
// calls and asserts the worker patch contains runName: null — and never
// runName: undefined.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

// Load the real kube module first and spread it into the mock factory so the
// transitive imports of tools.js (reconciler-bridge.ts imports
// makeNodeApiClient/NAMESPACE) resolve even when this file runs alone —
// bun's mock.module replaces the whole module with the factory otherwise.
const realKube = await import('@percussionist/kube');

const state = {
  taskPhase: 'running' as string,
  worker: {
    runName: 'proj-task-1',
    status: 'Running',
    retryCount: 2,
    aiReworkCount: 1,
  },
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
  getProject: async () => ({
    metadata: { name: 'proj', uid: 'uid', namespace: 'percussionist' },
    spec: { agents: [{ name: 'builder' }], source: { local: true } },
  }),
  getRun: async () => ({ status: { phase: 'Succeeded' }, spec: {} }),
  getTask: async (_name: string, _ns: string) => ({
    metadata: { name: 'task-1' },
    spec: { type: 'BUILD', projectRef: 'proj', title: 't', agent: 'builder' },
    status: { phase: state.taskPhase, worker: state.worker },
  }),
  gitUrlHash: (url: string) => String(url.length),
  listClusterAgents: async () => [],
  listPodsByLabels: async () => [],
  listRuns: async () => [],
  listTasks: async () => [],
  patchTaskStatus: async (name: string, patch: Record<string, unknown>, ns: string) => {
    state.patches.push({ name, patch, ns });
    return { metadata: { name }, status: patch };
  },
  readAllSessionsFromConfigMap: async () => null,
  readPlanFromConfigMap: async () => null,
  readPodLog: async () => '',
  readSessionConfigMap: async () => null,
  validateAgentTaskCapability: async () => ({ ok: true }),
  writePlanToConfigMap: async () => undefined,
}));

const { __test } = await import('../tools.js');

async function callTool(name: string, args: Record<string, unknown>): Promise<void> {
  const response = (await __test.handleMcp({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  })) as {
    result?: { isError?: boolean; content?: Array<{ text: string }> };
  };
  expect(response.result?.isError).toBeUndefined();
}

function lastPatch(): { name: string; patch: Record<string, unknown> } {
  const last = state.patches[state.patches.length - 1];
  if (!last) throw new Error('expected a patchTaskStatus call');
  return last;
}

function workerOf(patch: Record<string, unknown>): Record<string, unknown> {
  const worker = patch.worker;
  if (typeof worker !== 'object' || worker === null) {
    throw new Error('expected worker in patch');
  }
  return worker as Record<string, unknown>;
}

describe('admin tools clear worker.runName with null (merge-patch safe)', () => {
  beforeEach(() => {
    state.patches = [];
    state.taskPhase = 'running';
    state.worker = {
      runName: 'proj-task-1',
      status: 'Running',
      retryCount: 2,
      aiReworkCount: 1,
    };
  });

  afterEach(() => {
    state.patches = [];
  });

  it('set_task_state → pending patches worker.runName to null', async () => {
    state.taskPhase = 'failed';
    await callTool('set_task_state', {
      project: 'proj',
      task: 'task-1',
      targetPhase: 'pending',
    });

    expect(state.patches).toHaveLength(1);
    const { patch } = lastPatch();
    expect(patch.phase).toBe('pending');
    const worker = workerOf(patch);
    expect(Object.hasOwn(worker, 'runName')).toBe(true);
    expect(worker.runName).toBeNull();
    // JSON merge patch serialization must carry the key.
    expect(JSON.stringify(patch)).toContain('"runName":null');
  });

  it('set_task_state → done patches worker.runName to null', async () => {
    state.taskPhase = 'succeeded';
    await callTool('set_task_state', {
      project: 'proj',
      task: 'task-1',
      targetPhase: 'done',
    });

    expect(state.patches).toHaveLength(1);
    const { patch } = lastPatch();
    expect(patch.phase).toBe('done');
    const worker = workerOf(patch);
    expect(Object.hasOwn(worker, 'runName')).toBe(true);
    expect(worker.runName).toBeNull();
    expect(JSON.stringify(patch)).toContain('"runName":null');
  });

  it('set_task_state → failed patches worker.runName to null', async () => {
    await callTool('set_task_state', {
      project: 'proj',
      task: 'task-1',
      targetPhase: 'failed',
    });

    expect(state.patches).toHaveLength(1);
    const { patch } = lastPatch();
    expect(patch.phase).toBe('failed');
    const worker = workerOf(patch);
    expect(Object.hasOwn(worker, 'runName')).toBe(true);
    expect(worker.runName).toBeNull();
    expect(JSON.stringify(patch)).toContain('"runName":null');
  });

  it('set_task_state → running (with cancelRunning: true) patches worker.runName to null', async () => {
    state.taskPhase = 'initializing';
    await callTool('set_task_state', {
      project: 'proj',
      task: 'task-1',
      targetPhase: 'running',
      preserveRuns: false,
      cancelRunning: true,
    });

    expect(state.patches).toHaveLength(1);
    const { patch } = lastPatch();
    expect(patch.phase).toBe('running');
    const worker = workerOf(patch);
    expect(Object.hasOwn(worker, 'runName')).toBe(true);
    expect(worker.runName).toBeNull();
    expect(JSON.stringify(patch)).toContain('"runName":null');
  });

  it('force_retry with createRun: false resets worker.runName to null', async () => {
    await callTool('force_retry', {
      project: 'proj',
      task: 'task-1',
      createRun: false,
    });

    expect(state.patches).toHaveLength(1);
    const { patch } = lastPatch();
    expect(patch.phase).toBe('pending');
    const worker = workerOf(patch);
    expect(Object.hasOwn(worker, 'runName')).toBe(true);
    expect(worker.runName).toBeNull();
    expect(JSON.stringify(patch)).toContain('"runName":null');
  });

  it('set_task_state without existing worker still clears runName on the fresh worker', async () => {
    state.taskPhase = 'failed';
    state.worker = { status: 'Running', retryCount: 1, aiReworkCount: 0 };
    await callTool('set_task_state', {
      project: 'proj',
      task: 'task-1',
      targetPhase: 'pending',
    });

    const { patch } = lastPatch();
    const worker = workerOf(patch);
    expect(worker.runName).toBeNull();
  });
});
