import { describe, expect, it } from 'bun:test';
import { parseModelProvider, requiresCloudAuth, validateModelAuth } from '../index.js';

describe('parseModelProvider', () => {
  it('parses provider from providerID/modelID format', () => {
    expect(parseModelProvider('anthropic/claude-sonnet-4-20250514')).toBe('anthropic');
  });

  it('returns undefined when no slash present', () => {
    expect(parseModelProvider('claude-sonnet-4-20250514')).toBeUndefined();
  });

  it('handles empty string', () => {
    expect(parseModelProvider('')).toBeUndefined();
  });

  it('handles multi-part provider IDs', () => {
    expect(parseModelProvider('github-copilot/claude-sonnet')).toBe('github-copilot');
    expect(parseModelProvider('google-genai/gemini-2.0-flash')).toBe('google-genai');
  });
});

describe('requiresCloudAuth', () => {
  it('returns true for known cloud providers', () => {
    expect(requiresCloudAuth('anthropic/claude-sonnet-4-20250514')).toBe(true);
    expect(requiresCloudAuth('openai/gpt-4o')).toBe(true);
    expect(requiresCloudAuth('google/gemini-2.0-flash')).toBe(true);
    expect(requiresCloudAuth('github-copilot/claude-sonnet')).toBe(true);
    expect(requiresCloudAuth('azure/gpt-4')).toBe(true);
    expect(requiresCloudAuth('aws/claude-v3')).toBe(true);
    expect(requiresCloudAuth('bedrock/claude-v3')).toBe(true);
    expect(requiresCloudAuth('together/llama-3')).toBe(true);
    expect(requiresCloudAuth('groq/llama-3')).toBe(true);
    expect(requiresCloudAuth('mistral/mistral-large')).toBe(true);
    expect(requiresCloudAuth('cohere/command-r')).toBe(true);
    expect(requiresCloudAuth('deepseek/deepseek-chat')).toBe(true);
    expect(requiresCloudAuth('xai/grok-2')).toBe(true);
    expect(requiresCloudAuth('perplexity/sonar-pro')).toBe(true);
    expect(requiresCloudAuth('fireworks/llama-v3')).toBe(true);
  });

  it('returns false for local providers', () => {
    expect(requiresCloudAuth('ollama/llama3')).toBe(false);
    expect(requiresCloudAuth('lm-studio/qwen')).toBe(false);
    expect(requiresCloudAuth('local/model')).toBe(false);
  });

  it('returns false for unrecognised providers', () => {
    expect(requiresCloudAuth('my-custom-provider/model')).toBe(false);
  });

  it('returns false when no slash present', () => {
    expect(requiresCloudAuth('model-without-provider')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(requiresCloudAuth('')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(requiresCloudAuth('Anthropic/claude-sonnet')).toBe(true);
    expect(requiresCloudAuth('OLLAMA/llama3')).toBe(false);
  });
});

describe('validateModelAuth', () => {
  it('passes when no model is set', () => {
    const result = validateModelAuth(undefined);
    expect(result.ok).toBe(true);
  });

  it('passes when model is empty string', () => {
    const result = validateModelAuth('');
    expect(result.ok).toBe(true);
  });

  it('passes for local providers even without secrets', () => {
    const result = validateModelAuth('ollama/llama3');
    expect(result.ok).toBe(true);

    const result2 = validateModelAuth('lm-studio/qwen');
    expect(result2.ok).toBe(true);

    const result3 = validateModelAuth('local/model');
    expect(result3.ok).toBe(true);
  });

  it('passes for unrecognised providers without secrets', () => {
    const result = validateModelAuth('my-custom-provider/model');
    expect(result.ok).toBe(true);
  });

  it('passes for cloud providers with authSecret', () => {
    const result = validateModelAuth('anthropic/claude-sonnet-4-20250514', {
      authSecret: { name: 'my-auth', key: 'auth.json' },
    });
    expect(result.ok).toBe(true);
  });

  it('passes for cloud providers with llmKeysSecret', () => {
    const result = validateModelAuth('openai/gpt-4o', {
      llmKeysSecret: 'my-llm-keys',
    });
    expect(result.ok).toBe(true);
  });

  it('passes for cloud providers with both secrets', () => {
    const result = validateModelAuth('anthropic/claude-sonnet-4-20250514', {
      authSecret: { name: 'my-auth', key: 'auth.json' },
      llmKeysSecret: 'my-llm-keys',
    });
    expect(result.ok).toBe(true);
  });

  it('fails for cloud providers without any auth secrets', () => {
    const result = validateModelAuth('anthropic/claude-sonnet-4-20250514');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('anthropic');
      expect(result.error).toContain('requires authentication');
      expect(result.error).toContain('authSecret');
      expect(result.error).toContain('llmKeysSecret');
    }
  });

  it('fails for all known cloud providers without secrets', () => {
    const providers = [
      'anthropic/claude',
      'openai/gpt-4o',
      'google/gemini',
      'google-genai/gemini',
      'github-copilot/claude',
      'azure/gpt-4',
      'aws/claude',
      'bedrock/claude',
      'together/llama',
      'groq/llama',
      'mistral/mistral',
      'cohere/command',
      'deepseek/deepseek',
      'xai/grok',
      'perplexity/sonar',
      'fireworks/llama',
    ];
    for (const model of providers) {
      const result = validateModelAuth(model);
      expect(result.ok).toBe(false);
    }
  });

  it('fails with null secrets object', () => {
    const result = validateModelAuth('anthropic/claude-sonnet-4-20250514', null);
    expect(result.ok).toBe(false);
  });

  it('fails with empty secrets object', () => {
    const result = validateModelAuth('anthropic/claude-sonnet-4-20250514', {});
    expect(result.ok).toBe(false);
  });
});
