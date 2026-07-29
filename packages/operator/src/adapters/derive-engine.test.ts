import { describe, expect, test } from 'bun:test';
import { CLAUDE_ENGINE_PROVIDER_ID, deriveEngine, parseModelRef } from '@percussionist/api';

describe('parseModelRef', () => {
  test('splits provider from model', () => {
    expect(parseModelRef('claude-code/claude-opus-5')).toEqual({
      providerID: 'claude-code',
      modelID: 'claude-opus-5',
    });
  });

  test('a slash-free value is a bare model id', () => {
    expect(parseModelRef('claude-haiku-4-5')).toEqual({ modelID: 'claude-haiku-4-5' });
  });

  // Model ids can themselves contain slashes, so only the first separator counts —
  // this mirrors the dispatcher's MODEL parsing exactly.
  test('splits on the first slash only', () => {
    expect(parseModelRef('github-copilot/org/model-1')).toEqual({
      providerID: 'github-copilot',
      modelID: 'org/model-1',
    });
  });

  test('undefined and empty are handled', () => {
    expect(parseModelRef(undefined)).toEqual({});
    expect(parseModelRef('')).toEqual({});
  });
});

describe('deriveEngine', () => {
  test('defaults to opencode with nothing set', () => {
    expect(deriveEngine({})).toBe('opencode');
  });

  test('a claude-code model reference selects the claude engine', () => {
    expect(deriveEngine({ model: `${CLAUDE_ENGINE_PROVIDER_ID}/claude-opus-5` })).toBe('claude');
  });

  test('another provider carrying a claude model stays on opencode', () => {
    expect(deriveEngine({ model: 'github-copilot/claude-sonnet-4.5' })).toBe('opencode');
  });

  // `anthropic` is an opencode provider driven by an API key, which is exactly why
  // the reserved id is claude-code and not anthropic.
  test('the anthropic opencode provider does not select the claude engine', () => {
    expect(deriveEngine({ model: 'anthropic/claude-sonnet-4-20250514' })).toBe('opencode');
  });

  test('a bare model id does not select the claude engine', () => {
    expect(deriveEngine({ model: 'claude-opus-5' })).toBe('opencode');
  });

  test('explicit engine wins over the model reference', () => {
    expect(deriveEngine({ engine: 'opencode', model: `${CLAUDE_ENGINE_PROVIDER_ID}/x` })).toBe(
      'opencode',
    );
    expect(deriveEngine({ engine: 'claude', model: 'github-copilot/y' })).toBe('claude');
  });

  test('explicit engine works with no model at all', () => {
    expect(deriveEngine({ engine: 'claude' })).toBe('claude');
  });

  // A provider whose name merely starts with the reserved id must not match.
  test('does not match a provider id by prefix', () => {
    expect(deriveEngine({ model: 'claude-code-experimental/x' })).toBe('opencode');
  });
});
