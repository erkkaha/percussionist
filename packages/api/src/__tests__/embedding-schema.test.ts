import { describe, expect, it } from 'bun:test';
import { EmbeddingSpecSchema } from '../index.js';

describe('EmbeddingSpecSchema ollamaUrl', () => {
  it('accepts HTTP and HTTPS URLs without credentials', () => {
    expect(EmbeddingSpecSchema.parse({ ollamaUrl: 'http://ollama.internal:11434' }).ollamaUrl).toBe(
      'http://ollama.internal:11434',
    );
  });

  it('rejects non-HTTP protocols and embedded credentials', () => {
    expect(() => EmbeddingSpecSchema.parse({ ollamaUrl: 'file:///etc/passwd' })).toThrow();
    expect(() =>
      EmbeddingSpecSchema.parse({ ollamaUrl: 'http://user:pass@ollama.internal' }),
    ).toThrow();
  });
});
