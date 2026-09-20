import { afterEach, describe, expect, it } from 'bun:test';
import { ollamaFetch, resolveOllamaBaseUrl } from '../ollama.js';

const originalBaseUrl = process.env.OLLAMA_BASE_URL;
const originalAllowedOrigins = process.env.OLLAMA_ALLOWED_ORIGINS;

afterEach(() => {
  if (originalBaseUrl === undefined) delete process.env.OLLAMA_BASE_URL;
  else process.env.OLLAMA_BASE_URL = originalBaseUrl;
  if (originalAllowedOrigins === undefined) delete process.env.OLLAMA_ALLOWED_ORIGINS;
  else process.env.OLLAMA_ALLOWED_ORIGINS = originalAllowedOrigins;
});

describe('resolveOllamaBaseUrl', () => {
  it('accepts an operator-allowlisted origin', () => {
    process.env.OLLAMA_BASE_URL = 'https://ollama.example.test/base/';
    process.env.OLLAMA_ALLOWED_ORIGINS = 'https://ollama.example.test';
    expect(resolveOllamaBaseUrl()).toBe('https://ollama.example.test/base');
  });

  it('rejects a project-selected origin outside the operator allowlist', () => {
    process.env.OLLAMA_BASE_URL = 'https://attacker.example.test';
    process.env.OLLAMA_ALLOWED_ORIGINS = 'http://ollama.percussionist.svc.cluster.local:11434';
    expect(() => resolveOllamaBaseUrl()).toThrow('origin is not allowed');
  });

  it('rejects embedded credentials', () => {
    process.env.OLLAMA_BASE_URL = 'http://user:pass@ollama.example.test';
    process.env.OLLAMA_ALLOWED_ORIGINS = 'http://ollama.example.test';
    expect(() => resolveOllamaBaseUrl()).toThrow('must not contain credentials');
  });
});

describe('ollamaFetch', () => {
  it('disables redirects', async () => {
    process.env.OLLAMA_BASE_URL = 'https://ollama.example.test';
    process.env.OLLAMA_ALLOWED_ORIGINS = 'https://ollama.example.test';
    const originalFetch = globalThis.fetch;
    let redirect: RequestRedirect | undefined;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      redirect = init?.redirect;
      return Promise.resolve(new Response('{}'));
    }) as typeof fetch;
    try {
      await ollamaFetch('/api/tags', { redirect: 'follow' });
      expect(redirect).toBe('error');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
