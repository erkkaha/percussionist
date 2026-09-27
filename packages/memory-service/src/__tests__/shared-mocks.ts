// Shared mock for ../embed.js — called once at module scope so Bun's
// module cache is populated with the mock before any test file imports it.
//
// The fake model honours EMBEDDING_DIMENSIONS the way a real embedding model
// honours its configuration, so the 1024-dimension project test exercises the
// same code path at a different width. MOCK_EMBEDDING_DIMENSIONS overrides it
// to simulate a model that disagrees with the project configuration.
//
// mockEmbeddingFor(text) is deterministic and gives each text its own direction,
// so "the memory whose content matches the query ranks first" is a real
// assertion instead of a tie broken by the query planner.

import { mock } from 'bun:test';
import { DEFAULT_EMBEDDING_DIMENSIONS } from '../schema.js';

export function mockEmbeddingDimensions(): number {
  const raw = process.env.MOCK_EMBEDDING_DIMENSIONS ?? process.env.EMBEDDING_DIMENSIONS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_EMBEDDING_DIMENSIONS;
  const dims = Number(raw);
  return Number.isInteger(dims) && dims > 0 ? dims : DEFAULT_EMBEDDING_DIMENSIONS;
}

export function mockEmbeddingFor(text: string): Float32Array {
  const dims = mockEmbeddingDimensions();
  const values = new Float32Array(dims);
  let state = 2166136261;
  for (let i = 0; i < text.length; i++) {
    state = Math.imul(state ^ text.charCodeAt(i), 16777619) >>> 0;
  }
  for (let i = 0; i < dims; i++) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    values[i] = (state / 0xffffffff) * 2 - 1;
  }
  return values;
}

export function mockEmbedding(): Float32Array {
  return new Float32Array(Array.from({ length: mockEmbeddingDimensions() }, (_, i) => Math.sin(i)));
}

mock.module('../embed.js', () => ({
  getEmbedding: async (text: string) => mockEmbeddingFor(text),
}));
