# Plan: Stop accepting auth tokens via `?token=` query param (credential leak into web pod logs) — percussionist-dev-plan-rev10

**Task:** `getAuthValue` (`packages/web/src/server/auth.ts:72-74`) accepts `c.req.query('token')` as a credential, and `app.ts:38` registers Hono's `logger()` for every route. Hono's logger prints the path including the query string, so any client authenticating with `?token=` has its admin-equivalent credential persisted in web pod stdout and any log aggregation layer.

## Context

- **The vulnerable branch** — `getAuthValue` (`packages/web/src/server/auth.ts:63-75`) resolves a credential from, in order: `Authorization: Bearer`, `x-auth-token`, `x-api-key`, and finally `c.req.query('token')`. It is called by all three middleware factories (`auth()` line 188, `adminAuth()` line 234, `scoped()` line 270), by `hasNoCredential()` (line 110), and by `usage-lock-middleware.ts:48` (credential-*presence* check only — never reads the value).
- **The logger** — `app.ts:38` does `app.use('*', logger())` with `hono/logger` (hono 4.12.27). Verified in the shipped implementation: the logged path is `url.slice(url.indexOf('/', 8))`, i.e. **path + full query string**, printed twice per request (`<--` incoming and `-->` outgoing lines). So a valid `?token=` credential is written to pod stdout twice per request.
- **Prior art in this repo** — the codebase already fixed this exact leak once, for WebSockets: `attach-ws.ts:290-317` documents that the WS `?token=` param was replaced with cookie auth *because* "Hono's logger middleware printed it", and only honours `?token=` on the upgrade request under `LEGACY_TOKEN_AUTH=1` for rolling-upgrade continuity. The general HTTP query-param path in `getAuthValue` was left behind.
- **Logger exposure of the WS path** — WS upgrades are intercepted in `index.ts:139-172` *before* `app.fetch(req)`, so a genuine upgrade never reaches Hono's logger. But a request to `/api/runs/:name/attach?token=…` **without** the `upgrade: websocket` header (curl probing, a proxy stripping headers) falls through to `app.fetch` at line 172 and *is* logged with the token — so log redaction has real value even with the WS legacy path kept.
- **No legitimate query-param callers exist.** Every in-repo caller authenticates via headers or cookies:
  - Agents: `dispatcher/src/stats-reporter.ts:88,165`, `manager-controller/src/web-headers.ts:15`, `manager-controller/src/agent/stats-reporter.ts:237,310`, `operator/src/run-key-client.ts:30` — all `Authorization: Bearer`.
  - Browser SPA: httpOnly session cookies; `client/lib/auth.tsx:6-10` explicitly states no `?token=` query parameter is needed any more, and `client/hooks/useSseSubscription.ts:66` relies on cookies for SSE *specifically because* "query strings end up in server logs".
  - CLI (`beatctl`): `packages/cli/src/auth.ts` manages the secret in a K8s Secret; it never sends `?token=`.
- **Tests** — `packages/web/tests/auth.test.ts` runs the full app via `createApp()` + `app.request()` with `LEGACY_TOKEN_AUTH=1` and `AUTH_SECRET='test-secret-token-12345'`. It covers Bearer and `x-auth-token` headers (valid → not 401, wrong → 401) but has **no test touching the query param**, so nothing in the suite depends on the branch being removed.

## Approach

**Remove the `queryToken` branch from `getAuthValue` entirely** (the task's preferred option), plus **defense-in-depth redaction of `token` query values in the logger**.

Key decisions:

1. **Drop, don't gate.** Gating the query param under `LEGACY_TOKEN_AUTH=1` would still write live credentials to logs whenever the flag is on — which is exactly during a migration, when the shared secret is most exposed. The legacy flag exists to keep the *header/shared-secret* path working (`isValidToken` against `AUTH_SECRET`), and that continues to work unchanged via `Authorization: Bearer` / `x-auth-token`. No in-repo caller loses anything.
2. **Keep the WS upgrade legacy path untouched.** `isAttachAuthorized` (`attach-ws.ts:301-317`) reads `?token=` itself from the raw URL, not via `getAuthValue`, is already gated behind `LEGACY_TOKEN_AUTH=1`, and its rationale (browsers cannot set WS headers; open terminals must survive a rolling upgrade) still holds. Out of scope.
3. **Redact `token=` query values from logger output** as a second layer: pass a print function to `logger()` in `app.ts` that masks the value of any `token` query parameter before writing. This covers the non-upgrade-header attach probe described above and any future regression that reintroduces a token in a URL. Implement as a small exported pure function so it is unit-testable.
4. **Regression tests over trust.** Add explicit tests that a valid legacy secret presented *only* via `?token=` yields 401 (with `LEGACY_TOKEN_AUTH=1` set), and that the redaction function masks tokens.

**Scope boundaries (out of scope):** the WS attach legacy `?token=` path (`attach-ws.ts`) — already gated and documented; redacting arbitrary other query parameters or headers (only `token` is a known credential-bearing param today); rotating any secret that may already have landed in historical logs (operational concern — flagged in Risks); removing `LEGACY_TOKEN_AUTH` itself (tracked separately per the comment at `auth.ts:27-30`).

## Tasks

1. **Remove the query-param branch:** in `packages/web/src/server/auth.ts`, delete lines 72-73 (`const queryToken = c.req.query('token'); if (queryToken) return queryToken;`) from `getAuthValue`. Add one comment line noting query params are deliberately not accepted because the logger prints query strings (mirror the wording of `attach-ws.ts:294-296`).
2. **Add a redacting print function for the logger:** in `packages/web/src/server/app.ts` (or a tiny `src/server/lib/log-redact.ts` if preferred for testability — exported either way), add `export function redactTokenParam(line: string): string` that replaces `/([?&]token=)[^\s&]+/g` with `$1[REDACTED]`, and change `app.use('*', logger())` at `app.ts:38` to `app.use('*', logger((line) => console.log(redactTokenParam(line))))`.
3. **Regression test — query token no longer authenticates:** in `packages/web/tests/auth.test.ts`, add a `describe('?token= query param is not a credential')` block asserting `GET /api/settings?token=test-secret-token-12345` → 401 and `POST /api/runs?token=test-secret-token-12345` → 401 (the suite already runs with `LEGACY_TOKEN_AUTH=1` and that exact `AUTH_SECRET`, so these prove the *valid* secret is rejected when sent via query).
4. **Regression test — header/cookie paths unchanged:** confirm the existing `x-auth-token` / Bearer tests in `auth.test.ts` still pass unmodified (no edits expected; they are the guard that this change doesn't over-remove).
5. **Unit test — redaction:** add tests for `redactTokenParam`: `<-- GET /api/settings?token=abc123` → value masked; `?foo=1&token=abc&bar=2` → only the token value masked; lines with no `token=` pass through byte-identical.
6. **Comment sync:** update the `attach-ws.ts:290-299` comment block's last paragraph (or add one line) noting the general HTTP query-param path in `getAuthValue` has now been removed as well, so future readers don't go looking for it.
7. **Verify no stragglers:** `grep -rn "query('token')\|queryToken" packages/` returns nothing outside `attach-ws.ts` after the change; run `pnpm --filter web test` (or `bun test` per `packages/web/package.json`) and the repo lint (`biome`).

### Proposed BUILD task breakdown

Single BUILD task — the change is small and the pieces are tightly coupled (removing the branch without the tests, or vice versa, is not independently shippable):

- **BUILD 1:** Implement tasks 1-7 above: remove the `queryToken` branch from `getAuthValue`, add `redactTokenParam` + wire it into `logger()`, add the 401-via-query and redaction tests, sync the `attach-ws.ts` comment, run web tests + lint. Conventional commit suggestion: `fix(web): stop accepting auth tokens via ?token= query param and redact token= from request logs` with a body noting the log-leak rationale.

## Risks / open questions

- **Out-of-tree breakage:** any operator script or third-party client authenticating with `?token=` (nothing in-repo does) will start getting 401. Mitigation: the same secret keeps working via `Authorization: Bearer` / `x-auth-token` under `LEGACY_TOKEN_AUTH=1`; call the change out in the changelog/release notes as a deliberate hardening.
- **Historical exposure:** credentials sent via `?token=` before this fix are already in pod logs and any aggregation layer. This plan does not rotate them; recommend operators rotate `AUTH_SECRET` (`beatctl auth web-token set`) after upgrading. Worth a line in release notes.
- **Redaction is line-based and best-effort:** it masks `token=` values in whatever string Hono's logger emits. If a different credential-bearing query param is ever introduced, it must be added to the regex — acceptable, since the primary fix (removing the credential path) makes the redaction a backstop rather than the control.
- **Assumption:** `usage-lock-middleware.ts:48` intentionally only checks credential *presence*; after the change a `?token=`-only request counts as credential-less there too, which is consistent (it would also fail auth). No separate handling needed.

## Acceptance criteria

- A request carrying a valid `AUTH_SECRET` **only** as `?token=` receives 401 on protected API routes, even with `LEGACY_TOKEN_AUTH=1` (new tests in `auth.test.ts` prove this).
- All existing header- and cookie-based auth tests (`packages/web/tests/auth.test.ts`, `agent-keys.test.ts`, `attach-ws.test.ts`) pass unchanged.
- Web pod request logs never contain the value of a `token` query parameter: `redactTokenParam` unit tests pass, and the logger in `app.ts` routes through it.
- The WS attach legacy path (`isAttachAuthorized`) behaves exactly as before.
- `grep -rn "query('token')" packages/web/src/server` matches only the documented legacy branch in `attach-ws.ts`.
