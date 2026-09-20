// tools-start-interactive-run.test.ts
//
// Unit coverage for the `start_interactive_run` manager MCP tool.
//
// The tool is phase-independent and never creates a Run itself: it validates
// project/task, rejects `done`/`idea`, generates a random request id, and
// writes an InteractiveRunRequest JSON payload to the Task annotation
// (preserving existing annotations). The reconciler consumes the annotation on
// its next cycle. These tests pin:
//   - the annotation payload shape (id + optional overrides);
//   - that the payload round-trips through InteractiveRunRequestSchema;
//   - preservation of unrelated annotations;
//   - the deterministic runName returned (derived from the same id);
//   - that `createRun` is never called (the reconciler owns Run creation);
//   - rejection of done/idea tasks without any patch;
//   - schema rejection of an out-of-range timeout override.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

// Load the real kube module first and spread it into the mock factory so the
// transitive imports of tools.js (worker-builder.ts imports kube helpers)
// resolve even when this file runs alone.
const realKube = await import('@percussionist/kube');

const state = {
  taskPhase: 'running' as string,
  annotations: {} as Record<string, string>,
  taskPatches: [] as Array<{ name: string; patch: Record<string, unknown>; ns: string }>,
  createRunCalls: 0,
};

mock.module('@percussionist/kube', () => ({
  ...realKube,
  apps: () => ({}),
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
  getTask: async () => ({
    metadata: { name: 'task-1', namespace: 'percussionist', annotations: state.annotations },
    spec: { type: 'BUILD', projectRef: 'proj', title: 't', agent: 'builder' },
    status: { phase: state.taskPhase },
  }),
  gitUrlHash: (url: string) => String(url.length),
  listClusterAgents: async () => [],
  listPodsByLabels: async () => [],
  listRuns: async () => [],
  listTasks: async () => [],
  patchTask: async (name: string, patch: Record<string, unknown>, ns: string) => {
    state.taskPatches.push({ name, patch, ns });
    return { metadata: { name } };
  },
  patchTaskStatus: async () => ({}),
  readAllSessionsFromConfigMap: async () => null,
  readPlanFromConfigMap: async () => null,
  readPodLog: async () => '',
  readSessionConfigMap: async () => null,
  validateAgentTaskCapability: async () => ({ ok: true }),
  writePlanToConfigMap: async () => undefined,
}));

const { __test } = await import('../tools.js');
const { INTERACTIVE_RUN_ANNOTATION, InteractiveRunRequestSchema, interactiveRunName } =
  await import('@percussionist/api');

interface ToolResponse {
  isError: boolean | undefined;
  text: string;
  parsed: Record<string, unknown>;
}

interface TaskAnnotationPatch {
  metadata?: { annotations?: Record<string, string> };
}

function annotationPatch(): Record<string, string> {
  const patch = state.taskPatches[0]?.patch as TaskAnnotationPatch | undefined;
  return patch?.metadata?.annotations ?? {};
}

function requestPayload(): {
  id: string;
  agent?: string;
  model?: string;
  timeoutSeconds?: number;
} {
  const raw = annotationPatch()[INTERACTIVE_RUN_ANNOTATION];
  expect(raw, 'interactive-run annotation is written').toBeDefined();
  return JSON.parse(raw as string);
}

async function callTool(args: Record<string, unknown> = {}): Promise<ToolResponse> {
  const response = (await __test.handleMcp({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'start_interactive_run',
      arguments: { project: 'proj', task: 'task-1', ...args },
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

describe('start_interactive_run writes the request annotation', () => {
  beforeEach(() => {
    state.taskPhase = 'running';
    state.annotations = {};
    state.taskPatches = [];
    state.createRunCalls = 0;
  });

  afterEach(() => {
    state.taskPatches = [];
    state.createRunCalls = 0;
  });

  it('patches the task and returns the deterministic run name', async () => {
    const { isError, parsed } = await callTool();

    expect(isError).toBeUndefined();
    expect(state.taskPatches).toHaveLength(1);
    expect(state.taskPatches[0]?.name).toBe('task-1');
    expect(state.taskPatches[0]?.ns).toBe('percussionist');

    const request = requestPayload();
    expect(request.id).toMatch(/^[a-z0-9]{8}$/);
    expect(request.agent).toBeUndefined();
    expect(request.model).toBeUndefined();
    expect(request.timeoutSeconds).toBeUndefined();

    // The payload must be consumable by the reconciler's own parse.
    expect(InteractiveRunRequestSchema.safeParse(request).success).toBe(true);
    // The tool only writes the annotation; the reconciler creates the Run.
    expect(state.createRunCalls).toBe(0);

    expect(parsed.project).toBe('proj');
    expect(parsed.task).toBe('task-1');
    expect(parsed.runName).toBe(interactiveRunName('proj', 'task-1', request.id));
    expect(String(parsed.note)).toContain('reconciler');
  });

  it('preserves unrelated annotations and records agent/model/timeout overrides', async () => {
    state.annotations = { 'percussionist.dev/other': 'keep-me' };

    const { isError } = await callTool({
      agent: 'fixer',
      model: 'openai/gpt-5',
      timeoutSeconds: 7200,
    });

    expect(isError).toBeUndefined();
    expect(annotationPatch()['percussionist.dev/other']).toBe('keep-me');

    const request = requestPayload();
    expect(request.agent).toBe('fixer');
    expect(request.model).toBe('openai/gpt-5');
    expect(request.timeoutSeconds).toBe(7200);
  });

  it.each(['done', 'idea'])('rejects %s tasks without patching', async (phase) => {
    state.taskPhase = phase;

    const { isError, text } = await callTool();

    expect(isError).toBe(true);
    expect(text).toContain(phase);
    expect(state.taskPatches).toHaveLength(0);
    expect(state.createRunCalls).toBe(0);
  });

  it('rejects an out-of-range timeout override', async () => {
    const { isError } = await callTool({ timeoutSeconds: 999_999 });

    expect(isError).toBe(true);
    expect(state.taskPatches).toHaveLength(0);
  });

  it('rejects a task that belongs to a different project', async () => {
    const { isError, text } = await callTool({ project: 'other-project' });

    expect(isError).toBe(true);
    expect(text).toContain('other-project');
    expect(state.taskPatches).toHaveLength(0);
  });
});
