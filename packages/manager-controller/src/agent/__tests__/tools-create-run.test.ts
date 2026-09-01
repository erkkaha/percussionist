// tools-create-run.test.ts
//
// Success-path coverage for the reworked `create_run` MCP tool (finding A3 /
// test gap C7 from percussionist-dev-plan-4abf54).
//
// `create_run` no longer creates Run CRs and no phase is special-cased: it
// advances a task one legal step (`pending` | `rework-requested` → `scheduled`)
// via the standard TRANSITION_TABLE edges, and the reconciler's ScheduleRun
// effect creates the run on its next reconcile cycle. These tests pin:
//   - the exact phase-only status patch;
//   - that `createRun` is never called by the tool;
//   - the deterministic `expectedRunName` formula (same as decision.ts:271);
//   - idempotency for already-`scheduled`/`initializing` tasks and the
//     re-read race guard (concurrent reconciler transition → no-op, no patch);
//   - rejection of phases without a `→ scheduled` edge, naming the
//     `force_retry`/`set_task_state` admin tools.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

// Load the real kube module first and spread it into the mock factory so the
// transitive imports of tools.js (reconciler-bridge.ts imports
// makeNodeApiClient/NAMESPACE) resolve even when this file runs alone —
// bun's mock.module replaces the whole module with the factory otherwise.
const realKube = await import('@percussionist/kube');

const state = {
  taskPhase: 'pending' as string,
  worker: { retryCount: 0, aiReworkCount: 0 },
  getTaskCalls: 0,
  /** When set, the second getTask read (re-read before patch) returns this phase. */
  reReadPhase: undefined as string | undefined,
  patches: [] as Array<{ name: string; patch: Record<string, unknown>; ns: string }>,
  createRunCalls: 0,
};

mock.module('@percussionist/kube', () => ({
  ...realKube,
  apps: () => ({}),
  buildTask: (args: Record<string, unknown>) => ({
    metadata: { name: args.name },
    ...args,
    status: { phase: 'pending' },
  }),
  createRun: async () => {
    state.createRunCalls++;
    return {};
  },
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
  getTask: async (_name: string, _ns: string) => {
    state.getTaskCalls++;
    const phase =
      state.getTaskCalls === 2 && state.reReadPhase !== undefined
        ? state.reReadPhase
        : state.taskPhase;
    return {
      metadata: { name: 'task-1' },
      spec: { type: 'BUILD', projectRef: 'proj', title: 't', agent: 'builder' },
      status: { phase, worker: state.worker },
    };
  },
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
const { workerRunName } = await import('../../worker-builder.js');

interface CreateRunResponse {
  isError: boolean | undefined;
  text: string;
  parsed: Record<string, unknown>;
}

async function callCreateRun(): Promise<CreateRunResponse> {
  const response = (await __test.handleMcp({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'create_run',
      arguments: { project: 'proj', task: 'task-1' },
    },
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

describe('create_run schedules through reconciliation', () => {
  beforeEach(() => {
    state.taskPhase = 'pending';
    state.worker = { retryCount: 0, aiReworkCount: 0 };
    state.getTaskCalls = 0;
    state.reReadPhase = undefined;
    state.patches = [];
    state.createRunCalls = 0;
  });

  afterEach(() => {
    state.patches = [];
    state.createRunCalls = 0;
  });

  it('pending task → patches phase to scheduled exactly, never creates a run', async () => {
    const { isError, parsed } = await callCreateRun();

    expect(isError).toBeUndefined();
    expect(state.patches).toHaveLength(1);
    expect(state.patches[0]).toEqual({
      name: 'task-1',
      patch: { phase: 'scheduled' },
      ns: 'percussionist',
    });
    expect(state.createRunCalls).toBe(0);
    expect(parsed.phase).toBe('Scheduled');
    expect(parsed.expectedRunName).toBe(workerRunName('proj', 'task-1', 0, 0));
    expect(parsed.note).toContain('reconciler');
  });

  it('rework-requested task → same schedule-through-reconciliation behavior', async () => {
    state.taskPhase = 'rework-requested';

    const { isError, parsed } = await callCreateRun();

    expect(isError).toBeUndefined();
    expect(state.patches).toHaveLength(1);
    expect(state.patches[0]?.patch).toEqual({ phase: 'scheduled' });
    expect(state.createRunCalls).toBe(0);
    expect(parsed.phase).toBe('Scheduled');
    expect(parsed.expectedRunName).toBe(workerRunName('proj', 'task-1', 0, 0));
  });

  it('pending task whose re-read shows scheduled (concurrent reconciler won) → no-op, no patch', async () => {
    state.reReadPhase = 'scheduled';

    const { isError, parsed } = await callCreateRun();

    expect(isError).toBeUndefined();
    expect(state.patches).toHaveLength(0);
    expect(state.createRunCalls).toBe(0);
    expect(parsed.phase).toBe('Scheduled');
    expect(parsed.note).toContain('phase changed');
  });

  it.each([
    'scheduled',
    'initializing',
  ])('already-%s task → idempotent no-op, no error, no patch', async (phase) => {
    state.taskPhase = phase;

    const { isError, parsed } = await callCreateRun();

    expect(isError).toBeUndefined();
    expect(state.patches).toHaveLength(0);
    expect(state.createRunCalls).toBe(0);
    expect(parsed.phase).toBe('Scheduled');
    expect(parsed.note).toContain('already being scheduled');
  });

  it.each([
    'running',
    'waiting-for-input',
    'failed',
    'done',
  ])('%s task → rejected with allowed-transitions error naming force_retry/set_task_state; no patch, no run', async (phase) => {
    state.taskPhase = phase;

    const { isError, text, parsed } = await callCreateRun();

    expect(isError).toBe(true);
    expect(text).toContain('cannot schedule a run');
    expect(text).toContain(`"${phase}"`);
    expect(text).toContain('force_retry');
    expect(text).toContain('set_task_state');
    expect(state.patches).toHaveLength(0);
    expect(state.createRunCalls).toBe(0);
    expect(parsed).toEqual({});
  });
});
