import { describe, expect, test } from 'bun:test';
import { normalizeToolName } from './tool-names.js';
import { type ToolPart, TranscriptBuilder } from './translate.js';

const SESSION = 'ext-session-id';

function assistant(content: unknown[], extra: Record<string, unknown> = {}) {
  return {
    type: 'assistant',
    uuid: 'msg-1',
    session_id: 'sdk-internal-id',
    parent_tool_use_id: null,
    message: { role: 'assistant', model: 'claude-sonnet-5', content },
    ...extra,
  };
}

function toolResult(id: string, content: unknown, isError = false, extra = {}) {
  return {
    type: 'user',
    uuid: 'msg-2',
    session_id: 'sdk-internal-id',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
    },
    ...extra,
  };
}

function toolPartsOf(b: TranscriptBuilder): ToolPart[] {
  return b
    .snapshot()
    .flatMap((m) => m.parts)
    .filter((p): p is ToolPart => p.type === 'tool');
}

describe('normalizeToolName', () => {
  test('lowercases built-in tools', () => {
    expect(normalizeToolName('Read')).toBe('read');
    expect(normalizeToolName('Bash')).toBe('bash');
  });

  // The load-bearing one: SessionView.tsx compares against 'todowrite' to route
  // todo updates into the checklist widget instead of a generic tool row.
  test('maps TodoWrite to the name the dashboard checks for', () => {
    expect(normalizeToolName('TodoWrite')).toBe('todowrite');
  });

  test('passes MCP tool names through untouched', () => {
    expect(normalizeToolName('mcp__dispatcher__fail_run')).toBe('mcp__dispatcher__fail_run');
  });
});

describe('TranscriptBuilder', () => {
  test('reports the external session id, not the SDK internal one', () => {
    const b = new TranscriptBuilder(SESSION);
    b.push(assistant([{ type: 'text', text: 'hello' }]));
    expect(b.snapshot()[0]?.info.sessionID).toBe(SESSION);
  });

  test('turns text blocks into text parts', () => {
    const b = new TranscriptBuilder(SESSION);
    b.push(assistant([{ type: 'text', text: 'hello' }]));
    const parts = b.snapshot()[0]?.parts ?? [];
    expect(parts).toEqual([{ type: 'text', text: 'hello' }]);
  });

  test('drops thinking blocks', () => {
    const b = new TranscriptBuilder(SESSION);
    b.push(
      assistant([
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'done' },
      ]),
    );
    expect(b.snapshot()[0]?.parts).toEqual([{ type: 'text', text: 'done' }]);
  });

  test('correlates tool_use with a tool_result on a later message', () => {
    const b = new TranscriptBuilder(SESSION);
    b.push(assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]));

    let tool = toolPartsOf(b)[0];
    expect(tool?.state?.status).toBe('running');

    b.push(toolResult('t1', 'file-a\nfile-b'));
    tool = toolPartsOf(b)[0];
    expect(tool?.tool).toBe('bash');
    expect(tool?.callID).toBe('t1');
    expect(tool?.state?.status).toBe('completed');
    expect(tool?.state?.output).toBe('file-a\nfile-b');
    expect(tool?.state?.time?.end).toBeNumber();
  });

  test('marks failed tool results as errors', () => {
    const b = new TranscriptBuilder(SESSION);
    b.push(assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]));
    b.push(toolResult('t1', 'boom', true));
    expect(toolPartsOf(b)[0]?.state?.status).toBe('error');
  });

  test('surfaces a bash exit code as state.metadata.exit', () => {
    const b = new TranscriptBuilder(SESSION);
    b.push(assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]));
    b.push(toolResult('t1', 'nope', true, { tool_use_result: { exitCode: 2 } }));
    expect(toolPartsOf(b)[0]?.state?.metadata?.exit).toBe(2);
  });

  test('flattens block-array tool output to text', () => {
    const b = new TranscriptBuilder(SESSION);
    b.push(assistant([{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]));
    b.push(
      toolResult('t1', [
        { type: 'text', text: 'line-1' },
        { type: 'text', text: 'line-2' },
      ]),
    );
    expect(toolPartsOf(b)[0]?.state?.output).toBe('line-1\nline-2');
  });

  // SessionTimeline.tsx renders file parts as their own rows; the SDK has no
  // such event, so they must be synthesised from the tool input.
  test('synthesises a file part from a Write call', () => {
    const b = new TranscriptBuilder(SESSION);
    b.push(
      assistant([
        { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/workspace/src/a.ts' } },
      ]),
    );
    const file = b.snapshot()[0]?.parts.find((p) => p.type === 'file');
    expect(file).toEqual({ type: 'file', path: '/workspace/src/a.ts', filename: 'a.ts' });
  });

  test('does not synthesise a file part for non-file tools', () => {
    const b = new TranscriptBuilder(SESSION);
    b.push(assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]));
    expect(b.snapshot()[0]?.parts.some((p) => p.type === 'file')).toBe(false);
  });

  test('synthesises a subtask part from a Task call', () => {
    const b = new TranscriptBuilder(SESSION);
    b.push(
      assistant([
        {
          type: 'tool_use',
          id: 't1',
          name: 'Task',
          input: { description: 'audit deps', subagent_type: 'Explore' },
        },
      ]),
    );
    const sub = b.snapshot()[0]?.parts.find((p) => p.type === 'subtask');
    expect(sub).toEqual({
      type: 'subtask',
      id: 't1',
      description: 'audit deps',
      agentType: 'Explore',
    });
  });

  test('emits step-finish and totals from the result message', () => {
    const b = new TranscriptBuilder(SESSION);
    b.push(assistant([{ type: 'text', text: 'done' }]));
    b.push({
      type: 'result',
      subtype: 'success',
      uuid: 'res-1',
      session_id: 'sdk-internal-id',
      is_error: false,
      stop_reason: 'end_turn',
      total_cost_usd: 0.25,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 20,
      },
    });

    const msg = b.snapshot()[0];
    expect(msg?.info.cost).toBe(0.25);
    expect(msg?.info.tokens).toEqual({
      input: 10,
      output: 5,
      cache: { read: 100, write: 20 },
    });
    const step = msg?.parts.find((p) => p.type === 'step-finish');
    expect(step).toMatchObject({ type: 'step-finish', reason: 'end_turn', cost: 0.25 });
  });

  // `usage` on the result message is one message's usage — the final turn —
  // while `modelUsage` holds the run's cumulative totals. Reporting the former
  // as the run total made every run look tiny: with prompt caching a closing
  // turn's uncached input really is about 2 tokens, and no other transcript
  // message carries usage to make up the difference.
  test('takes run totals from modelUsage, not the final turn', () => {
    const b = new TranscriptBuilder(SESSION);
    b.push(assistant([{ type: 'text', text: 'done' }]));
    b.push({
      type: 'result',
      subtype: 'success',
      uuid: 'res-1',
      session_id: 'x',
      is_error: false,
      stop_reason: 'end_turn',
      total_cost_usd: 1.5,
      usage: { input_tokens: 2, output_tokens: 68, cache_read_input_tokens: 40 },
      modelUsage: {
        'claude-sonnet-5': {
          inputTokens: 120,
          outputTokens: 48_000,
          cacheReadInputTokens: 2_400_000,
          cacheCreationInputTokens: 15_000,
        },
      },
    });

    expect(b.snapshot()[0]?.info.tokens).toEqual({
      input: 120,
      output: 48_000,
      cache: { read: 2_400_000, write: 15_000 },
    });
  });

  test('sums modelUsage across models', () => {
    const b = new TranscriptBuilder(SESSION);
    b.push(assistant([{ type: 'text', text: 'done' }]));
    b.push({
      type: 'result',
      subtype: 'success',
      uuid: 'res-1',
      session_id: 'x',
      is_error: false,
      stop_reason: 'end_turn',
      total_cost_usd: 1,
      // Subagents run on a cheaper model, so a run's usage is split across two.
      modelUsage: {
        'claude-sonnet-5': { inputTokens: 100, outputTokens: 200 },
        'claude-haiku-4-5': { inputTokens: 5, outputTokens: 30 },
      },
    });

    expect(b.snapshot()[0]?.info.tokens).toMatchObject({ input: 105, output: 230 });
  });

  test('falls back to the final turn usage when modelUsage is absent', () => {
    const b = new TranscriptBuilder(SESSION);
    b.push(assistant([{ type: 'text', text: 'done' }]));
    b.push({
      type: 'result',
      subtype: 'success',
      uuid: 'res-1',
      session_id: 'x',
      is_error: false,
      stop_reason: 'end_turn',
      total_cost_usd: 1,
      usage: { input_tokens: 7, output_tokens: 9 },
    });

    expect(b.snapshot()[0]?.info.tokens).toMatchObject({ input: 7, output: 9 });
  });

  test('records an error on the assistant message when the run fails', () => {
    const b = new TranscriptBuilder(SESSION);
    b.push(assistant([{ type: 'text', text: 'partial' }]));
    b.push({
      type: 'result',
      subtype: 'success',
      uuid: 'res-1',
      session_id: 'x',
      is_error: true,
      result: 'Failed to authenticate',
      api_error_status: 401,
      stop_reason: null,
      usage: {},
    });
    expect(b.snapshot()[0]?.info.error).toMatchObject({
      message: 'Failed to authenticate',
      status: 401,
    });
  });

  // polling.ts fails a run the instant it sees info.error on the last message.
  // A turn the session is about to retry must therefore leave that field alone,
  // or a recoverable 529 kills the run from the transcript regardless of the
  // retry succeeding.
  test('suppressError keeps a retried turn out of info.error', () => {
    const b = new TranscriptBuilder(SESSION);
    b.push(assistant([{ type: 'text', text: 'partial' }]));
    b.push(
      {
        type: 'result',
        subtype: 'error_during_execution',
        uuid: 'res-1',
        session_id: 'x',
        is_error: true,
        result: 'API Error: 529 Overloaded',
        api_error_status: 529,
        stop_reason: null,
        usage: { input_tokens: 3, output_tokens: 7 },
        total_cost_usd: 0.02,
      },
      { suppressError: true },
    );
    const msg = b.snapshot()[0];
    expect(msg?.info.error).toBeUndefined();
    // The attempt still happened and was billed — cost and tokens are real.
    expect(msg?.info.cost).toBe(0.02);
    expect(msg?.info.tokens).toMatchObject({ input: 3, output: 7 });
    expect(msg?.parts.some((p) => p.type === 'step-finish')).toBe(true);
  });

  test('records the error once retries are given up on', () => {
    const b = new TranscriptBuilder(SESSION);
    b.push(assistant([{ type: 'text', text: 'partial' }]));
    b.push(
      {
        type: 'result',
        uuid: 'res-1',
        session_id: 'x',
        is_error: true,
        result: 'API Error: 529 Overloaded',
        api_error_status: 529,
        usage: {},
      },
      { suppressError: false },
    );
    expect(b.snapshot()[0]?.info.error).toMatchObject({ status: 529 });
  });

  // A subagent's own turns must not steal the step-finish that belongs to the
  // main loop, or turn accounting attributes the run's totals to a subtask.
  test('does not anchor step-finish to a subagent message', () => {
    const b = new TranscriptBuilder(SESSION);
    b.push(assistant([{ type: 'text', text: 'main turn' }]));
    b.push(
      assistant([{ type: 'text', text: 'subagent turn' }], {
        parent_tool_use_id: 't1',
        uuid: 'sub-1',
      }),
    );
    b.push({
      type: 'result',
      subtype: 'success',
      uuid: 'res-1',
      session_id: 'x',
      is_error: false,
      stop_reason: 'end_turn',
      total_cost_usd: 1,
      usage: {},
    });

    const [main, sub] = b.snapshot();
    expect(main?.parts.some((p) => p.type === 'step-finish')).toBe(true);
    expect(sub?.parts.some((p) => p.type === 'step-finish')).toBe(false);
  });

  test('a genuine string user turn becomes a user message', () => {
    const b = new TranscriptBuilder(SESSION);
    b.push({
      type: 'user',
      uuid: 'u1',
      session_id: 'x',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'do the thing' },
    });
    expect(b.snapshot()[0]?.info.role).toBe('user');
    expect(b.snapshot()[0]?.parts).toEqual([{ type: 'text', text: 'do the thing' }]);
  });

  test('a tool_result carrier does not become a visible user message', () => {
    const b = new TranscriptBuilder(SESSION);
    b.push(assistant([{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]));
    b.push(toolResult('t1', 'contents'));
    expect(b.snapshot().filter((m) => m.info.role === 'user')).toHaveLength(0);
  });

  test('finalizeOpenTools closes tools left running at run end', () => {
    const b = new TranscriptBuilder(SESSION);
    b.push(assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]));
    b.finalizeOpenTools();
    const tool = toolPartsOf(b)[0];
    expect(tool?.state?.status).toBe('error');
    expect(tool?.state?.time?.end).toBeNumber();
  });

  test('ignores control messages with no transcript content', () => {
    const b = new TranscriptBuilder(SESSION);
    b.push({ type: 'system', subtype: 'init', session_id: 'x' });
    b.push({ type: 'stream_event', event: {} });
    expect(b.snapshot()).toHaveLength(0);
  });
});

describe('empty-turn handling', () => {
  test('drops a thinking-only assistant turn instead of emitting a blank row', () => {
    const b = new TranscriptBuilder(SESSION);
    b.push(assistant([{ type: 'thinking', thinking: 'pondering' }]));
    expect(b.snapshot()).toHaveLength(0);
  });

  test('still lands cost when no renderable assistant turn was produced', () => {
    const b = new TranscriptBuilder(SESSION);
    b.push(assistant([{ type: 'thinking', thinking: 'pondering' }]));
    b.push({
      type: 'result',
      subtype: 'success',
      uuid: 'res-1',
      session_id: 'x',
      is_error: false,
      stop_reason: 'end_turn',
      total_cost_usd: 0.5,
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    const msgs = b.snapshot();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.info.cost).toBe(0.5);
    expect(msgs[0]?.parts.some((p) => p.type === 'step-finish')).toBe(true);
  });
});

// dispatcher/polling.ts reads time.completed off the LAST transcript element to
// decide a run has settled. If a subagent turn lands after the final main turn,
// an unstamped tail means the run hangs to the idle timeout instead of
// reaching Succeeded.
describe('settle detection', () => {
  test('stamps time.completed on the transcript tail, not just the main turn', () => {
    const b = new TranscriptBuilder(SESSION);
    b.push(assistant([{ type: 'text', text: 'main turn' }]));
    b.push(
      assistant([{ type: 'text', text: 'subagent tail' }], {
        parent_tool_use_id: 't1',
        uuid: 'sub-1',
      }),
    );
    b.push({
      type: 'result',
      subtype: 'success',
      uuid: 'res-1',
      session_id: 'x',
      is_error: false,
      stop_reason: 'end_turn',
      total_cost_usd: 1,
      usage: { input_tokens: 3, output_tokens: 4 },
    });

    const msgs = b.snapshot();
    const tail = msgs[msgs.length - 1];
    expect(tail?.info.time?.completed).toBeNumber();
    expect(msgs[0]?.info.time?.completed).toBeNumber();
  });
});
