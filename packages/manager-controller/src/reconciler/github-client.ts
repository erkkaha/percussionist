// github-client.ts — minimal GitHub REST client for PR-mode integration.
//
// Used by the reconciler to poll the state of a PR opened from a PLAN's
// feature branch to the target branch. All requests are throttled by a
// module-level TTL cache so that reconcile-cycle frequency does not translate
// to unbounded GitHub API usage.

import { type ParsedGitHubRepo, type Project, parseGitHubUrl } from '@percussionist/api';
import { core, isNotFoundError, NAMESPACE } from '@percussionist/kube';

// ---------------------------------------------------------------------------
// Types

export interface PrState {
  /** 'open' while the PR is awaiting review/merge; 'closed' once merged or rejected. */
  state: 'open' | 'closed';
  /** ISO timestamp when the PR was merged, or null if not merged. */
  mergedAt: string | null;
  /** GitHub login that opened the PR (the project's PAT identity) — used to
   *  exclude the system's own comments from feedback detection. */
  authorLogin?: string;
}

/** One human comment on a PR — from the issue-comment feed, the review-comment
 *  (inline diff) feed, or a submitted review's top-level body. */
export interface PrComment {
  author: string;
  body: string;
  /** ISO timestamp the comment was created (reviews: submitted). */
  createdAt: string;
  kind: 'issue-comment' | 'review-comment' | 'review';
}

export type { ParsedGitHubRepo };

// ---------------------------------------------------------------------------
// URL parsing — delegates to the shared @percussionist/api implementation so
// the web server's PR-link derivation never drifts from this parser.

export { parseGitHubUrl };

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

/** Cache entry for PR comment feeds. */
interface PrCommentsCacheEntry {
  comments: PrComment[];
  fetchedAt: number;
}

/** Hardcoded poll interval (15 minutes). Tuned to keep GitHub API usage < 1% of budget. */
const PR_POLL_TTL_MS = 15 * 60 * 1000;
/** Token rotation is rare; cache for the same window as PR state. */
const TOKEN_TTL_MS = 15 * 60 * 1000;

const prCache = new Map<string, PrCacheEntry>();
const tokenCache = new Map<string, TokenCacheEntry>();
const prCommentsCache = new Map<string, PrCommentsCacheEntry>();

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
  prCommentsCache.clear();
}

// ---------------------------------------------------------------------------
// Token resolution

/**
 * Read the GitHub token for a project from its `source.git.githubTokenSecret`.
 * Cached per-project for `_tokenTtlMs`. Returns undefined if no token secret is
 * configured, the secret is missing, or the key is absent.
 *
 * Only a NotFound is cached as a miss. A transient read failure (503 /
 * temporary API error) is NOT cached — the reconcile cycle re-reads on the next
 * pass so a flaky API server cannot silently disable PR-mode polling for the
 * full TTL window.
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
      if (!isNotFoundError(e)) {
        // Transient failure (503, temporary Secret read error) — do not cache;
        // the next reconcile cycle re-reads.
        return undefined;
      }
      // Secret genuinely missing — cache as a miss so we stop hammering the
      // API server for the TTL window (matches the "no secret configured" case).
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

    const body = (await res.json()) as {
      state?: string;
      merged_at?: string | null;
      user?: { login?: string };
    };
    const state: PrState = {
      state: body.state === 'closed' ? 'closed' : 'open',
      mergedAt: body.merged_at ?? null,
      authorLogin: body.user?.login,
    };

    prCache.set(cacheKey, { state, fetchedAt: now });
    return state;
  } catch (e) {
    console.warn(`[github-client] PR poll error for ${cacheKey}:`, (e as Error).message);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// PR comment polling — the PR-mode feedback loop's detection signal.

const GH_HEADERS = (token: string) => ({
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'X-GitHub-Api-Version': '2022-11-28',
});

async function fetchJsonArray(url: string, token: string): Promise<unknown[] | undefined> {
  const res = await _fetchImpl(url, { headers: GH_HEADERS(token) });
  if (!res.ok) {
    console.warn(`[github-client] fetch failed: ${res.status} ${res.statusText} for ${url}`);
    return undefined;
  }
  const body = (await res.json()) as unknown;
  return Array.isArray(body) ? body : undefined;
}

/**
 * Fetch human feedback on a PR: issue comments, inline review comments, and
 * submitted review bodies, excluding those authored by `excludeLogin` (the
 * PAT identity that opened the PR — its own comments must not re-trigger the
 * feedback loop). Cached per (owner,repo,number) for `_prPollTtlMs`; callers
 * filter by watermark client-side so the cache stays watermark-independent.
 *
 * Returns undefined when every feed fails (network error / auth failure) so
 * the caller treats the poll as "no signal yet" and retries next cycle. A
 * partially failing poll returns what succeeded — comments only ever arrive
 * late, never falsely.
 */
export async function getPrComments(
  owner: string,
  repo: string,
  number: number,
  token: string,
  excludeLogin: string | undefined,
): Promise<PrComment[] | undefined> {
  const cacheKey = `${owner}/${repo}/${number}`;
  const now = Date.now();
  const cached = prCommentsCache.get(cacheKey);
  if (cached && now - cached.fetchedAt < _prPollTtlMs) {
    return cached.comments;
  }

  const base = `https://api.github.com/repos/${owner}/${repo}`;
  try {
    const [issueComments, reviewComments, reviews] = await Promise.all([
      fetchJsonArray(`${base}/issues/${number}/comments?per_page=100`, token),
      fetchJsonArray(`${base}/pulls/${number}/comments?per_page=100`, token),
      fetchJsonArray(`${base}/pulls/${number}/reviews?per_page=100`, token),
    ]);
    if (!issueComments && !reviewComments && !reviews) return undefined;

    const comments: PrComment[] = [];
    const push = (raw: unknown, kind: PrComment['kind'], createdField: string) => {
      const obj = raw as Record<string, unknown>;
      const author = (obj.user as { login?: string } | undefined)?.login;
      const body = typeof obj.body === 'string' ? obj.body.trim() : '';
      const createdAt = obj[createdField];
      if (!author || typeof createdAt !== 'string') return;
      if (excludeLogin && author === excludeLogin) return;
      // A review submitted with an empty body and no verdict carries no
      // feedback of its own (its inline comments arrive via the pulls feed).
      if (kind === 'review') {
        const state = obj.state;
        if (!body && state !== 'CHANGES_REQUESTED') return;
      } else if (!body) {
        return;
      }
      comments.push({ author, body, createdAt, kind });
    };

    for (const c of issueComments ?? []) push(c, 'issue-comment', 'created_at');
    for (const c of reviewComments ?? []) push(c, 'review-comment', 'created_at');
    for (const r of reviews ?? []) push(r, 'review', 'submitted_at');

    comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    prCommentsCache.set(cacheKey, { comments, fetchedAt: now });
    return comments;
  } catch (e) {
    console.warn(`[github-client] PR comments poll error for ${cacheKey}:`, (e as Error).message);
    return undefined;
  }
}
