// github-client.ts — minimal GitHub REST client for PR-mode integration.
//
// Used by the reconciler to poll the state of a PR opened from a PLAN's
// feature branch to the target branch. All requests are throttled by a
// module-level TTL cache so that reconcile-cycle frequency does not translate
// to unbounded GitHub API usage.

import type { Project } from '@percussionist/api';
import { core, NAMESPACE } from '@percussionist/kube';

// ---------------------------------------------------------------------------
// Types

export interface PrState {
  /** 'open' while the PR is awaiting review/merge; 'closed' once merged or rejected. */
  state: 'open' | 'closed';
  /** ISO timestamp when the PR was merged, or null if not merged. */
  mergedAt: string | null;
}

export interface ParsedGitHubRepo {
  owner: string;
  repo: string;
}

// ---------------------------------------------------------------------------
// URL parsing

/**
 * Parse a GitHub repository URL into {owner, repo}. Supports both SSH
 * (`git@github.com:owner/repo.git`) and HTTPS (`https://github.com/owner/repo.git`)
 * forms. Returns undefined for non-GitHub URLs or unparseable inputs.
 */
export function parseGitHubUrl(url: string): ParsedGitHubRepo | undefined {
  if (!url || typeof url !== 'string') return undefined;

  // SSH form: git@github.com:owner/repo.git
  const sshMatch = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch?.[1] && sshMatch[2]) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  // HTTPS form: https://github.com/owner/repo.git[.extra]
  const httpsMatch = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/);
  if (httpsMatch?.[1] && httpsMatch[2]) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// TTL cache

/** Cache entry for PR-state polls. */
interface PrCacheEntry {
  state: PrState;
  fetchedAt: number;
}

/** Cache entry for project GitHub tokens. */
interface TokenCacheEntry {
  token: string | undefined;
  fetchedAt: number;
}

/** Hardcoded poll interval (15 minutes). Tuned to keep GitHub API usage < 1% of budget. */
const PR_POLL_TTL_MS = 15 * 60 * 1000;
/** Token rotation is rare; cache for the same window as PR state. */
const TOKEN_TTL_MS = 15 * 60 * 1000;

const prCache = new Map<string, PrCacheEntry>();
const tokenCache = new Map<string, TokenCacheEntry>();

/** Test seam: override TTLs. */
let _prPollTtlMs = PR_POLL_TTL_MS;
let _tokenTtlMs = TOKEN_TTL_MS;
/** Test seam: inject a fetch implementation. */
let _fetchImpl: typeof fetch = fetch;

export function __setPollTtlMs(ms: number): void {
  _prPollTtlMs = ms;
}
export function __setTokenTtlMs(ms: number): void {
  _tokenTtlMs = ms;
}
export function __setFetchImpl(impl: typeof fetch): void {
  _fetchImpl = impl;
}
/** Clear all caches. Intended for tests. */
export function __clearCache(): void {
  prCache.clear();
  tokenCache.clear();
}

// ---------------------------------------------------------------------------
// Token resolution

/**
 * Read the GitHub token for a project from its `source.git.githubTokenSecret`.
 * Cached per-project for `_tokenTtlMs`. Returns undefined if no token secret is
 * configured, the secret is missing, or the key is absent.
 */
export async function readProjectGithubToken(project: Project): Promise<string | undefined> {
  const cacheKey = `${project.metadata.namespace ?? NAMESPACE}/${project.metadata.name}`;
  const now = Date.now();
  const cached = tokenCache.get(cacheKey);
  if (cached && now - cached.fetchedAt < _tokenTtlMs) {
    return cached.token;
  }

  const secretRef = project.spec.source?.git?.githubTokenSecret;
  let token: string | undefined;
  if (secretRef) {
    try {
      const ns = project.metadata.namespace ?? NAMESPACE;
      const key = secretRef.key ?? 'token';
      const res = await core().readNamespacedSecret({ name: secretRef.name, namespace: ns });
      const data = res.data;
      const raw = data?.[key];
      if (typeof raw === 'string') {
        // Kubernetes Secrets store values base64-encoded.
        token = Buffer.from(raw, 'base64').toString('utf-8');
      }
    } catch (e) {
      console.warn(
        `[github-client] Failed to read token secret ${secretRef.name} for ${cacheKey}:`,
        (e as Error).message,
      );
      token = undefined;
    }
  }

  tokenCache.set(cacheKey, { token, fetchedAt: now });
  return token;
}

// ---------------------------------------------------------------------------
// PR state polling

/**
 * Fetch the state of a GitHub PR. Cached per (owner,repo,number) for
 * `_prPollTtlMs` to throttle reconcile-cycle-driven calls.
 *
 * Returns undefined on any non-transient error (404, auth failure, rate limit,
 * network error) — the caller should treat a missing state as "still pending".
 */
export async function getPrState(
  owner: string,
  repo: string,
  number: number,
  token: string,
): Promise<PrState | undefined> {
  const cacheKey = `${owner}/${repo}/${number}`;
  const now = Date.now();
  const cached = prCache.get(cacheKey);
  if (cached && now - cached.fetchedAt < _prPollTtlMs) {
    return cached.state;
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`;
  try {
    const res = await _fetchImpl(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!res.ok) {
      // 404/403/401 etc. — do not cache; let next cycle retry.
      console.warn(
        `[github-client] PR poll failed: ${res.status} ${res.statusText} for ${cacheKey}`,
      );
      return undefined;
    }

    const body = (await res.json()) as { state?: string; merged_at?: string | null };
    const state: PrState = {
      state: body.state === 'closed' ? 'closed' : 'open',
      mergedAt: body.merged_at ?? null,
    };

    prCache.set(cacheKey, { state, fetchedAt: now });
    return state;
  } catch (e) {
    console.warn(`[github-client] PR poll error for ${cacheKey}:`, (e as Error).message);
    return undefined;
  }
}
