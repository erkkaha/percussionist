// ollama.ts — validated Ollama base URL + redirect-safe fetch wrapper.
//
// spec.embedding.ollamaUrl is project-controlled input: a project editor could
// otherwise direct embedding requests (which carry memory content) and
// automatic model pulls at an attacker-controlled or internal endpoint.
// This module:
//   - restricts the base URL to operator-allowlisted http(s) origins without
//     embedded credentials,
//   - never follows redirects (a 3xx that re-points to an internal host would
//     otherwise bypass the base-URL check and exfiltrate the request body).

export const DEFAULT_OLLAMA_BASE_URL = 'http://ollama.percussionist.svc.cluster.local:11434';

export function resolveOllamaBaseUrl(): string {
  const raw = process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL;
  const u = new URL(raw);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('OLLAMA_BASE_URL must use http or https');
  }
  if (u.username || u.password) throw new Error('OLLAMA_BASE_URL must not contain credentials');

  const configured = (process.env.OLLAMA_ALLOWED_ORIGINS ?? DEFAULT_OLLAMA_BASE_URL)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => new URL(value).origin);
  if (!configured.includes(u.origin)) {
    throw new Error(`OLLAMA_BASE_URL origin is not allowed: ${u.origin}`);
  }
  return u.origin + u.pathname.replace(/\/$/, '');
}

export function ollamaFetch(path: string, init?: RequestInit): Promise<Response> {
  const base = resolveOllamaBaseUrl();
  return fetch(`${base}${path}`, { ...init, redirect: 'error' });
}
