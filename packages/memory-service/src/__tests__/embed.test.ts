import { describe, expect, it } from 'bun:test';

// Ensures the embed.js mock is installed before we import the module.
import './shared-mocks.js';

const { getEmbedding } = await import('../embed.js');

describe('getEmbedding', () => {
  it('returns a Float32Array of the expected length', async () => {
    const result = await getEmbedding('test text');
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(768);
  });
});
