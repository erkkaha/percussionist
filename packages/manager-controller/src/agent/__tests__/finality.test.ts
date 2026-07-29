// Unit coverage for the finality test waitForCompletion uses to decide that an
// agent has answered. The integration path is covered in stats-reporter.test.ts;
// these pin the predicate itself, including the case it deliberately does not
// handle.
import { describe, expect, it } from 'bun:test';
import { collectText, findLastAssistant, isFinalAnswer } from '../session.js';

const assistant = (parts: unknown[], completed = true) => ({
  info: { role: 'assistant' as const, time: completed ? { completed: 1 } : {} },
  parts: parts as never,
});

describe('collectText', () => {
  it('concatenates every text part and ignores the rest', () => {
    expect(
      collectText(
        assistant([
          { type: 'text', text: 'one ' },
          { type: 'tool', tool: 'read_session_live' },
          { type: 'text', text: 'two' },
        ]),
      ),
    ).toBe('one two');
  });

  it('returns empty string for a message with no parts', () => {
    expect(collectText({ info: { role: 'assistant' } })).toBe('');
  });

  it('skips a text part with an empty body', () => {
    expect(collectText(assistant([{ type: 'text', text: '' }]))).toBe('');
  });
});

describe('findLastAssistant', () => {
  it('returns the newest assistant message, not the newest message', () => {
    const first = assistant([{ type: 'text', text: 'first' }]);
    const last = assistant([{ type: 'text', text: 'last' }]);
    const msgs = [
      first,
      { info: { role: 'user' as const } },
      last,
      { info: { role: 'user' as const } },
    ];

    expect(findLastAssistant(msgs)).toBe(last);
  });

  it('returns undefined when the agent has not spoken yet', () => {
    expect(findLastAssistant([{ info: { role: 'user' } }])).toBeUndefined();
  });
});

describe('isFinalAnswer', () => {
  it('accepts a turn that only speaks', () => {
    expect(isFinalAnswer(assistant([{ type: 'text', text: 'The run is clean.' }]))).toBe(true);
  });

  // The narration bug: a tool-calling turn completes before its tools run, so
  // its opening line would otherwise be returned as the agent's answer.
  it('rejects a turn that speaks and also calls a tool', () => {
    expect(
      isFinalAnswer(
        assistant([
          { type: 'text', text: "I'll look that up first." },
          { type: 'tool', tool: 'read_session_live' },
        ]),
      ),
    ).toBe(false);
  });

  it('rejects a turn that only calls a tool', () => {
    expect(isFinalAnswer(assistant([{ type: 'tool', tool: 'patch_board' }]))).toBe(false);
  });

  // Both spellings appear in the wild depending on which engine produced the
  // transcript, so neither may be mistaken for prose.
  it.each([
    'tool',
    'tool-use',
    'tool_use',
    'tool-result',
    'tool_result',
  ])('treats a %s part as asking for something', (type) => {
    expect(isFinalAnswer(assistant([{ type: 'text', text: 'hi' }, { type }]))).toBe(false);
  });

  it('rejects a turn with no text at all', () => {
    expect(isFinalAnswer(assistant([]))).toBe(false);
  });

  // Documents the accepted narrowing rather than asserting it is desirable: an
  // answer sharing a step with a tool call is not recognised, and the caller
  // falls through to its activity timeout. Change this test if an engine is
  // ever seen emitting that shape.
  it('does not recognise an answer that shares a step with a tool call', () => {
    expect(
      isFinalAnswer(
        assistant([
          { type: 'text', text: 'The answer is 42.' },
          { type: 'tool', tool: 'read_session_live' },
        ]),
      ),
    ).toBe(false);
  });
});
