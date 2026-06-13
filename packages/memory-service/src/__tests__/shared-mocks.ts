// Shared mock for ../embed.js — called once at module scope so Bun's
// module cache is populated with the mock before any test file imports it.
// Both routes.test.ts and embed.test.ts import this file first.

import { mock } from 'bun:test';

const FAKE_EMBEDDING = new Float32Array(Array.from({ length: 768 }, (_, i) => Math.sin(i)));

mock.module('../embed.js', () => ({
  getEmbedding: async (_text: string) => FAKE_EMBEDDING,
  getEmbeddings: async (texts: string[]) => texts.map(() => FAKE_EMBEDDING),
}));
