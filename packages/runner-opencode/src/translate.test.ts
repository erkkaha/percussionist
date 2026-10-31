import { describe, expect, test } from 'bun:test';
import {
  contentToText,
  providerListing,
  translateMessage,
  translateMessages,
  type V2Message,
} from './translate.js';

// Payloads captured from @opencode/sdk 2.0.10 on 2026-09-19 (opencode-go /
// deepseek-v4.1-flash), trimmed to the fields the translator reads.
const SID = 'ses_f44d8dc97ffetfFrmDpOz7l9Qn';

const userMsg: V2Message = {
  id: 'msg_0bb2723d8001lgsNyd5kWlfn9h',
  time: { created: 1789846300538 },
  text: "Call the tool percussionist_complete_run with summary 'PONG'.",
  type: 'user',
};

const toolTurn: V2Message = {
  id: 'msg_0bb272789001YK830UL8UGiSGx',
  time: { created: 1789846300561, streamed: 1789846302246, completed: 1789846302269 },
  type: 'assistant',
  agent: 'build',
  model: { id: 'deepseek-v4.1-flash', providerID: 'opencode-go', variant: 'default' },
  content: [
    {
      type: 'reasoning',
      text: 'The user wants me to call the tool.',
      time: { created: 1789846301720, completed: 1789846302237 },
    },
    {
      type: 'tool',
      id: 'call_00_XjBN5n3RKcKL6oDpee6B8600',
      name: 'execute',
      executed: false,
      state: {
        status: 'completed',
        input: { code: 'return await tools.percussionist_complete_run({ summary: "PONG" });' },
        content: [{ type: 'text', text: 'run marked complete' }],
        metadata: {
          toolCalls: [
            { tool: 'percussionist_complete_run', status: 'completed', input: { summary: 'PONG' } },
          ],
          truncated: false,
        },
      },
      time: { created: 1789846302114, ran: 1789846302245, completed: 1789846302267 },
    },
  ],
  finish: 'tool-calls',
  rawFinish: 'tool_calls',
  cost: 0.0012432,
  tokens: { input: 7768, output: 55, reasoning: 75, cache: { read: 0, write: 0 } },
};

const textTurn: V2Message = {
  id: 'msg_0bb272e45001pRy1Vr0oMf0NUV',
  time: { created: 1789846302286, streamed: 1789846306700, completed: 1789846306701 },
  type: 'assistant',
  agent: 'build',
  model: { id: 'deepseek-v4.1-flash', providerID: 'opencode-go', variant: 'default' },
  content: [{ type: 'text', text: 'DONE' }],
  finish: 'stop',
  rawFinish: 'stop',
  cost: 0.00005979,
  tokens: { input: 233, output: 3, reasoning: 0, cache: { read: 7680, write: 0 } },
};

const idleMsg: V2Message = {
  id: 'msg_0bb273f8e002CAiC4NNnEaqwZ0',
  time: { created: 1789846306702 },
  type: 'idle',
};

const switched: V2Message = {
  id: 'msg_0bb2723d40013YuibDQpVJKQfd',
  time: { created: 1789846299604 },
  type: 'model-switched',
  model: { id: 'deepseek-v4.1-flash', providerID: 'opencode-go' },
};

const failedTurn: V2Message = {
  id: 'msg_0bb25a713001xa1PzlbTpewiu4',
  time: { created: 1789846202137, completed: 1789846202751 },
  type: 'assistant',
  agent: 'build',
  model: { id: 'nemotron-3.5-lightning-free', providerID: 'opencode' },
  content: [],
  finish: 'error',
  error: {
    type: 'provider.auth',
    message: "OpenCode's free tier can only be used from within OpenCode",
    status: 403,
  },
};

describe('translateMessage', () => {
  test('user message becomes role=user with one text part', () => {
    const out = translateMessage(SID, userMsg);
    expect(out?.info).toEqual({
      id: userMsg.id,
      sessionID: SID,
      role: 'user',
      time: { created: 1789846300538 },
    });
    expect(out?.parts).toEqual([{ type: 'text', text: userMsg.text as string }]);
  });

  test('assistant info carries tokens, cost and model in v1 spelling', () => {
    const out = translateMessage(SID, textTurn);
    expect(out?.info.role).toBe('assistant');
    expect(out?.info.model).toEqual({ providerID: 'opencode-go', modelID: 'deepseek-v4.1-flash' });
    expect(out?.info.tokens).toEqual(textTurn.tokens);
    expect(out?.info.cost).toBe(0.00005979);
    expect(out?.info.time).toEqual({ created: 1789846302286, completed: 1789846306701 });
    expect(out?.info.agent).toBe('build');
  });

  test('assistant text turn ends with a step-finish part', () => {
    const parts = translateMessage(SID, textTurn)?.parts ?? [];
    expect(parts[0]).toEqual({ type: 'text', text: 'DONE' });
    expect(parts.at(-1)).toEqual({
      type: 'step-finish',
      id: `${textTurn.id}-finish`,
      messageID: textTurn.id,
      reason: 'stop',
      tokens: textTurn.tokens,
      cost: textTurn.cost,
    });
  });

  test('Code Mode execute is unwrapped into the inner tool call', () => {
    const parts = translateMessage(SID, toolTurn)?.parts ?? [];
    const tools = parts.filter((p) => p.type === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toEqual({
      type: 'tool',
      tool: 'percussionist_complete_run',
      callID: 'call_00_XjBN5n3RKcKL6oDpee6B8600:0',
      state: {
        status: 'completed',
        input: { summary: 'PONG' },
        output: 'run marked complete',
        metadata: { codeMode: true },
        time: { start: 1789846302245, end: 1789846302267 },
      },
    });
    expect(parts[0]).toEqual({ type: 'reasoning', text: 'The user wants me to call the tool.' });
    expect(parts.at(-1)?.type).toBe('step-finish');
  });

  test('execute with no recorded inner calls is reported as itself', () => {
    const m: V2Message = {
      ...toolTurn,
      content: [
        {
          type: 'tool',
          id: 'call_1',
          name: 'execute',
          state: { status: 'completed', input: { code: 'return 1+1' }, content: '2' },
        },
      ],
    };
    const tools = translateMessage(SID, m)?.parts.filter((p) => p.type === 'tool');
    expect(tools).toEqual([
      {
        type: 'tool',
        tool: 'execute',
        callID: 'call_1',
        state: {
          status: 'completed',
          input: { code: 'return 1+1' },
          output: '2',
          time: { start: undefined, end: undefined },
        },
      },
    ]);
  });

  test('2.2 ToolStateError surfaces state.error.message and execute metadata.error marks status=error', () => {
    const m: V2Message = {
      ...toolTurn,
      content: [
        {
          type: 'tool',
          id: 'call_err',
          name: 'read',
          state: {
            status: 'error',
            input: { path: '/missing.ts' },
            error: { type: 'tool.execution', message: 'File not found: /missing.ts' },
          },
        },
        {
          type: 'tool',
          id: 'call_cm_err',
          name: 'execute',
          state: {
            status: 'completed',
            input: { code: 'throw new Error("boom")' },
            content: [{ type: 'text', text: 'Error: boom' }],
            metadata: { toolCalls: [], error: true },
          },
        },
      ],
    };
    const tools = translateMessage(SID, m)?.parts.filter((p) => p.type === 'tool');
    expect(tools).toEqual([
      {
        type: 'tool',
        tool: 'read',
        callID: 'call_err',
        state: {
          status: 'error',
          input: { path: '/missing.ts' },
          output: 'File not found: /missing.ts',
          time: { start: undefined, end: undefined },
        },
      },
      {
        type: 'tool',
        tool: 'execute',
        callID: 'call_cm_err',
        state: {
          status: 'error',
          input: { code: 'throw new Error("boom")' },
          output: 'Error: boom',
          time: { start: undefined, end: undefined },
        },
      },
    ]);
  });

  test('file tools synthesize a file part; task tools a subtask part', () => {
    const m: V2Message = {
      ...toolTurn,
      content: [
        {
          type: 'tool',
          id: 'c_edit',
          name: 'edit',
          state: { status: 'completed', input: { filePath: '/workspace/src/a.ts' } },
        },
        {
          type: 'tool',
          id: 'c_exec',
          name: 'execute',
          state: {
            status: 'completed',
            metadata: {
              toolCalls: [
                { tool: 'write', status: 'completed', input: { filePath: '/workspace/b.md' } },
                {
                  tool: 'task',
                  status: 'running',
                  input: { description: 'explore', subagent_type: 'explore' },
                },
              ],
            },
          },
        },
      ],
    };
    const parts = translateMessage(SID, m)?.parts ?? [];
    expect(parts.filter((p) => p.type === 'file')).toEqual([
      { type: 'file', filename: 'a.ts', path: '/workspace/src/a.ts' },
      { type: 'file', filename: 'b.md', path: '/workspace/b.md' },
    ]);
    expect(parts.filter((p) => p.type === 'subtask')).toEqual([
      { type: 'subtask', id: 'c_exec:1', description: 'explore', agentType: 'explore' },
    ]);
    const task = parts.find((p) => p.type === 'tool' && p.tool === 'task');
    expect(task && task.type === 'tool' ? task.state?.status : undefined).toBe('running');
  });

  test('provider error lands on info.error', () => {
    const out = translateMessage(SID, failedTurn);
    expect(out?.info.error).toEqual({
      name: 'provider.auth',
      message: "OpenCode's free tier can only be used from within OpenCode",
      status: 403,
    });
    expect(out?.parts).toEqual([
      {
        type: 'step-finish',
        id: `${failedTurn.id}-finish`,
        messageID: failedTurn.id,
        reason: 'error',
        tokens: undefined,
        cost: undefined,
      },
    ]);
  });

  test('bookkeeping message types are dropped', () => {
    expect(translateMessage(SID, idleMsg)).toBeUndefined();
    expect(translateMessage(SID, switched)).toBeUndefined();
  });
});

describe('translateMessages', () => {
  test('orders oldest-first and drops non-transcript types', () => {
    // message.list returns newest-first by default.
    const out = translateMessages(SID, [idleMsg, textTurn, toolTurn, userMsg, switched]);
    expect(out.map((m) => m.info.id)).toEqual([userMsg.id, toolTurn.id, textTurn.id]);
    expect(out.map((m) => m.info.role)).toEqual(['user', 'assistant', 'assistant']);
  });

  test('is stable for equal timestamps', () => {
    const a: V2Message = { ...userMsg, id: 'a', time: { created: 5 } };
    const b: V2Message = { ...userMsg, id: 'b', time: { created: 5 } };
    expect(translateMessages(SID, [a, b]).map((m) => m.info.id)).toEqual(['a', 'b']);
  });

  test('2.2 idle(interrupted) marks in-flight assistant message as MessageAbortedError', () => {
    const inFlight: V2Message = {
      id: 'msg_asst_1',
      time: { created: 10 },
      type: 'assistant',
      agent: 'build',
      content: [{ type: 'text', text: 'partial' }],
    };
    const interruptedIdle: V2Message = {
      id: 'msg_idle_1',
      time: { created: 11 },
      type: 'idle',
      outcome: 'interrupted',
    };
    const out = translateMessages(SID, [
      { ...userMsg, time: { created: 1 } },
      inFlight,
      interruptedIdle,
    ]);
    expect(out).toHaveLength(2);
    expect(out[1]?.info.error).toEqual({
      name: 'MessageAbortedError',
      message: 'The operation was aborted.',
    });
  });

  test('2.2 idle(failed) synthesizes an error assistant message when no step started, without duplicating step errors', () => {
    const failedIdle: V2Message = {
      id: 'msg_idle_err',
      time: { created: 10 },
      type: 'idle',
      outcome: 'failed',
      error: { type: 'model.unavailable', message: 'Model unavailable' },
    };
    // Case 1: failed before any assistant step started
    const preStep = translateMessages(SID, [{ ...userMsg, time: { created: 1 } }, failedIdle]);
    expect(preStep).toHaveLength(2);
    expect(preStep[1]?.info.role).toBe('assistant');
    expect(preStep[1]?.info.error).toEqual({
      name: 'model.unavailable',
      message: 'Model unavailable',
    });

    // Case 2: failed during a step (assistant message already carries the error)
    const afterStep = translateMessages(SID, [
      { ...userMsg, time: { created: 1 } },
      { ...failedTurn, time: { created: 5, completed: 6 } },
      failedIdle,
    ]);
    expect(afterStep).toHaveLength(2);
    expect(afterStep[1]?.info.error).toEqual({
      name: 'provider.auth',
      message: "OpenCode's free tier can only be used from within OpenCode",
      status: 403,
    });
  });
});

describe('contentToText', () => {
  test('joins text content blocks and passes strings through', () => {
    expect(contentToText('x')).toBe('x');
    expect(
      contentToText([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('a\nb');
    expect(contentToText([{ type: 'file', uri: 'u' }])).toBeUndefined();
    expect(contentToText(undefined)).toBeUndefined();
  });
});

describe('providerListing', () => {
  test('groups models by provider and marks listed providers connected', () => {
    const out = providerListing(
      [{ id: 'opencode-go', name: 'OpenCode Go' }, { id: 'llama.cpp' }, { name: 'no-id' }],
      [
        { id: 'deepseek-v4.1-flash', providerID: 'opencode-go', name: 'DeepSeek V4.1 Flash' },
        { modelID: 'muse-glimmer-30b', providerID: 'llama.cpp' },
        { id: 'orphan', providerID: 'other' },
      ],
    );
    expect(out).toEqual({
      all: [
        {
          id: 'opencode-go',
          name: 'OpenCode Go',
          models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }],
        },
        {
          id: 'llama.cpp',
          name: 'llama.cpp',
          models: [{ id: 'muse-glimmer-30b', name: 'muse-glimmer-30b' }],
        },
      ],
      default: {},
      connected: ['opencode-go', 'llama.cpp'],
    });
  });
});
