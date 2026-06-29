import { beforeEach, describe, expect, it } from 'bun:test';
import {
  __clearCache,
  __setFetchImpl,
  __setPollTtlMs,
  getPrState,
  parseGitHubUrl,
} from '../github-client.js';

describe('parseGitHubUrl', () => {
  it('parses SSH form git@github.com:owner/repo.git', () => {
    expect(parseGitHubUrl('git@github.com:erkkaha/percussionist.git')).toEqual({
      owner: 'erkkaha',
      repo: 'percussionist',
    });
  });

  it('parses SSH form without trailing .git', () => {
    expect(parseGitHubUrl('git@github.com:erkkaha/percussionist')).toEqual({
      owner: 'erkkaha',
      repo: 'percussionist',
    });
  });

  it('parses HTTPS form https://github.com/owner/repo.git', () => {
    expect(parseGitHubUrl('https://github.com/erkkaha/percussionist.git')).toEqual({
      owner: 'erkkaha',
      repo: 'percussionist',
    });
  });

  it('parses HTTPS form without trailing .git', () => {
    expect(parseGitHubUrl('https://github.com/erkkaha/percussionist')).toEqual({
      owner: 'erkkaha',
      repo: 'percussionist',
    });
  });

  it('returns undefined for non-GitHub URLs', () => {
    expect(parseGitHubUrl('git@gitlab.com:erkkaha/percussionist.git')).toBeUndefined();
    expect(parseGitHubUrl('https://gitlab.com/erkkaha/percussionist.git')).toBeUndefined();
  });

  it('returns undefined for empty/invalid input', () => {
    expect(parseGitHubUrl('')).toBeUndefined();
    expect(parseGitHubUrl('not a url')).toBeUndefined();
  });
});

describe('getPrState', () => {
  beforeEach(() => {
    __clearCache();
    __setPollTtlMs(15 * 60 * 1000);
  });

  function mockFetch(response: {
    ok: boolean;
    status?: number;
    statusText?: string;
    body: Record<string, unknown>;
  }): typeof fetch {
    return (async () =>
      new Response(response.ok ? JSON.stringify(response.body) : '', {
        status: response.status ?? (response.ok ? 200 : 404),
        statusText: response.statusText ?? '',
      })) as typeof fetch;
  }

  it('returns open state for an open PR', async () => {
    __setFetchImpl(
      mockFetch({
        ok: true,
        body: { state: 'open', merged_at: null },
      }),
    );
    const state = await getPrState('erkkaha', 'percussionist', 42, 'fake-token');
    expect(state).toEqual({ state: 'open', mergedAt: null });
  });

  it('returns closed+mergedAt for a merged PR', async () => {
    __setFetchImpl(
      mockFetch({
        ok: true,
        body: { state: 'closed', merged_at: '2026-05-29T12:00:00.000Z' },
      }),
    );
    const state = await getPrState('erkkaha', 'percussionist', 42, 'fake-token');
    expect(state).toEqual({ state: 'closed', mergedAt: '2026-05-29T12:00:00.000Z' });
  });

  it('returns closed+null mergedAt for a closed-without-merge PR', async () => {
    __setFetchImpl(
      mockFetch({
        ok: true,
        body: { state: 'closed', merged_at: null },
      }),
    );
    const state = await getPrState('erkkaha', 'percussionist', 42, 'fake-token');
    expect(state).toEqual({ state: 'closed', mergedAt: null });
  });

  it('returns undefined on 404 (PR not found)', async () => {
    __setFetchImpl(
      mockFetch({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        body: {},
      }),
    );
    const state = await getPrState('erkkaha', 'percussionist', 999, 'fake-token');
    expect(state).toBeUndefined();
  });

  it('returns undefined on auth failure (401)', async () => {
    __setFetchImpl(
      mockFetch({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        body: {},
      }),
    );
    const state = await getPrState('erkkaha', 'percussionist', 42, 'bad-token');
    expect(state).toBeUndefined();
  });

  it('caches result within TTL — second call does not fetch', async () => {
    let calls = 0;
    __setFetchImpl((async () => {
      calls++;
      return new Response(JSON.stringify({ state: 'open', merged_at: null }), {
        status: 200,
      });
    }) as typeof fetch);
    await getPrState('erkkaha', 'percussionist', 42, 'fake-token');
    await getPrState('erkkaha', 'percussionist', 42, 'fake-token');
    expect(calls).toBe(1);
  });

  it('re-fetches after TTL expires', async () => {
    let calls = 0;
    __setFetchImpl((async () => {
      calls++;
      return new Response(JSON.stringify({ state: 'open', merged_at: null }), {
        status: 200,
      });
    }) as typeof fetch);
    __setPollTtlMs(0); // expire immediately
    await getPrState('erkkaha', 'percussionist', 42, 'fake-token');
    await getPrState('erkkaha', 'percussionist', 42, 'fake-token');
    expect(calls).toBe(2);
  });

  it('returns undefined on network error', async () => {
    __setFetchImpl((async () => {
      throw new Error('network down');
    }) as typeof fetch);
    const state = await getPrState('erkkaha', 'percussionist', 42, 'fake-token');
    expect(state).toBeUndefined();
  });
});
