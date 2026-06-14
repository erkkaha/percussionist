import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const state = {
  validationOk: true,
  validationError:
    'agent "reviewer" missing required capability "task.build.execute" for BUILD tasks',
  validationCalls: [] as Array<{ taskType: string; selectedAgent: string }>,
};

mock.module('@percussionist/kube', () => ({
  apps: () => ({}),
  buildTask: (args: Record<string, unknown>) => ({ metadata: { name: args.name }, ...args }),
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
    spec: { agents: [{ name: 'builder' }, { name: 'reviewer' }], source: { local: true } },
  }),
  getRun: async () => ({ status: { phase: 'Succeeded' }, spec: {} }),
  getTask: async (_name: string, _ns: string) => ({
    metadata: { name: 'task-1' },
    spec: { type: 'BUILD', projectRef: 'proj', title: 't', agent: 'builder' },
    status: { phase: 'pending', worker: { retryCount: 0 } },
  }),
  listClusterAgents: async () => [],
  listPodsByLabels: async () => [],
  listRuns: async () => [],
  listTasks: async () => [],
  patchTaskStatus: async () => undefined,
  readAllSessionsFromConfigMap: async () => null,
  readPlanFromConfigMap: async () => null,
  readPodLog: async () => '',
  readSessionConfigMap: async () => null,
  validateAgentTaskCapability: async (
    _project: unknown,
    taskType: string,
    selectedAgent: string,
  ) => {
    state.validationCalls.push({ taskType, selectedAgent });
    return state.validationOk
      ? {
          ok: true,
          requiredCapability: taskType === 'PLAN' ? 'task.plan.execute' : 'task.build.execute',
        }
      : {
          ok: false,
          requiredCapability: taskType === 'PLAN' ? 'task.plan.execute' : 'task.build.execute',
          error: state.validationError,
        };
  },
  writePlanToConfigMap: async () => undefined,
}));

const { __test } = await import('../tools.js');

describe('manager MCP capability enforcement', () => {
  beforeEach(() => {
    state.validationOk = true;
    state.validationError =
      'agent "reviewer" missing required capability "task.build.execute" for BUILD tasks';
    state.validationCalls = [];
  });

  afterEach(() => {
    state.validationOk = true;
    state.validationCalls = [];
  });

  it('create_task returns error payload when assignment lacks required capability', async () => {
    state.validationOk = false;
    const response = (await __test.handleMcp({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'create_task',
        arguments: {
          project: 'proj',
          type: 'BUILD',
          title: 'bad assignment',
          agent: 'reviewer',
        },
      },
    })) as {
      result?: { isError?: boolean; content?: Array<{ text: string }> };
    };

    expect(state.validationCalls).toEqual([{ taskType: 'BUILD', selectedAgent: 'reviewer' }]);
    expect(response.result?.isError).toBe(true);
    expect(response.result?.content?.[0]?.text).toContain('missing required capability');
  });

  it('create_run rejects incompatible override agent', async () => {
    state.validationOk = false;
    const response = (await __test.handleMcp({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'create_run',
        arguments: {
          project: 'proj',
          task: 'task-1',
          agent: 'reviewer',
        },
      },
    })) as {
      result?: { isError?: boolean; content?: Array<{ text: string }> };
    };

    expect(state.validationCalls).toEqual([{ taskType: 'BUILD', selectedAgent: 'reviewer' }]);
    expect(response.result?.isError).toBe(true);
    expect(response.result?.content?.[0]?.text).toContain('missing required capability');
  });

  it('force_retry rejects incompatible override agent', async () => {
    state.validationOk = false;
    const response = (await __test.handleMcp({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'force_retry',
        arguments: {
          project: 'proj',
          task: 'task-1',
          agent: 'reviewer',
        },
      },
    })) as {
      result?: { isError?: boolean; content?: Array<{ text: string }> };
    };

    expect(state.validationCalls).toEqual([{ taskType: 'BUILD', selectedAgent: 'reviewer' }]);
    expect(response.result?.isError).toBe(true);
    expect(response.result?.content?.[0]?.text).toContain('missing required capability');
  });
});
