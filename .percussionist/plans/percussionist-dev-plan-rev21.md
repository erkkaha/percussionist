# Plan: Web server robustness — stats pagination in JS, export OOM risk, crashable housekeeping, cross-project task actions

**Task:** `percussionist-dev-plan-rev21`
**Scope:** `packages/web/src/server` (plus one small `packages/web/src/server/db.ts` hardening, client remains untouched except test updates)
**Branch:** `feature/percussionist-dev-plan-rev21`

Five confirmed server-side issues. Each was verified against the current code on this
branch (based on `v0.2.13`). One task-stated claim is stale (see Issue 5) — `/reply`
and `/answer` ARE wired end-to-end already and must be kept, per the task's own
parenthetical ("the answer flow should be wired end to end rather than deleted").

---

## Context — relevant existing code

All paths relative to repo root.

### Issue 1 — stats pagination in JS + export OOM risk (`packages/web/src/server/routes/stats.ts`)

- **`GET /api/stats/sessions`** (lines 374–539):
  - `resolvedModel` (385–393) is a correlated subquery (`COALESCE(runs.model, (SELECT model FROM messages WHERE session_id = runs.id AND role='user' …), 'unknown')`) executed **per row**.
  - `baseQuery … .all()` (line 416) materialises **every row in the retention window**; `days=0` means the whole table (no `WHERE`). `total = allRows.length` (418), and every aggregate (`summary`, `modelRows`, `agentSummaries`) is computed in JS over the full row set (421–516).
  - Pagination is `allRows.slice(offset, offset + limit)` (line 519) — `limit`/`offset` never reach SQL.
  - Client contract: `SessionList.tsx` (PAGE_SIZE=50, real `limit`/`offset` paging, needs `total`), `StatsView.tsx` (STATS_LIMIT=500 — note server already caps at 200 — needs full-window `summary`, `agentSummaries`, `modelRows`). Response shape must not change.
- **`GET /api/stats/export`** (lines 341–367):
  - `db.select().from(runs)…all()` (350–351) loads the whole window; `days=0` ⇒ whole table; `RETENTION_DAYS=0` disables retention (`routes/stats.ts:544`), so the table is unbounded in that config.
  - N+1 per session: `messages`/`toolCalls`/`fileOps` fetched one session at a time (357–362). The comment "Session count is bounded to ~10 concurrent runs so N+1 is fine" (line 356) is wrong — the bound is the entire retention window.
  - Documented as a JSON array piped to an LLM (README: `curl …/api/stats/export?days=0 > sessions.json`); the array shape must be preserved.
- Retention: `RETENTION_DAYS` (544), `runRetentionCleanup()` (546–562), default 30 days; `days=0` on both endpoints disables the window filter.

### Issue 2 — `pruneExpiredRunKeys` can crash the pod (`index.ts` + `lib/agent-keys.ts`)

- `index.ts:28–31` installs a process-level `unhandledRejection` handler that calls `process.exit(1)`.
- `index.ts:110–117` runs `void pruneExpiredRunKeys()` (startup + hourly interval) with **no try/catch**. `pruneExpiredRunKeys` (`lib/agent-keys.ts:188–202`) has no internal catch. A single `SQLITE_BUSY` (concurrent stats-POST write from a dispatcher; **no `PRAGMA busy_timeout` is set** — `db.ts:30–38`) rejects the promise → `unhandledRejection` → `process.exit(1)` → every open SSE stream and attach terminal dies.
- Same exposure, synchronous variant: `runRetentionCleanup()` at `index.ts:93–94` runs inside `setInterval` with no try/catch — a thrown error is an `uncaughtException` (no handler installed) and also kills the process.
- The repo's established pattern for background loops: `lib/push-triggers.ts:171–183` (`tick()` with try/catch/finally + `running` re-entrancy guard) and `metrics-collector.ts:37–77` (try/catch inside `poll`). `pruneExpiredRunKeys` and `runRetentionCleanup` are the only loops not following it.

### Issue 3 — board task action routes skip the project check (`routes/board.ts`)

- `approve` (473–496), `request-changes` (501–536), `retry-review` (545–584), `abandon` (589–611), `answer` (616–648) all call `getTask(taskName)` with the **default namespace** (`NAMESPACE`) and never verify `task.spec.projectRef === :project`:
  - Tasks in non-default namespaces 404 on approve/request-changes/answer (the default-ns `getTask` misses).
  - When `getTask` succeeds in the default namespace, the annotation is patched on **whatever task shares the name**, and `appendTaskEvent(name, …)` (490, 528, 578, 605, 642) records the event **under the URL project** — corrupting the activity feed.
- `delete` (381–393) and `move` (403–468) do it right: `getProject(projectName)` → `ns = project.metadata.namespace ?? NAMESPACE` → `getTask(taskName, ns)`.
- `getTask(name, ns = NAMESPACE)` and `patchTask`/`patchTaskStatus` are in `packages/kube/src/index.ts` (742–754, 798–853). `TaskSpecSchema.projectRef` is required (`packages/api/src/index.ts:1354`), so the projectRef check is reliable. `retry-review` resolves `ns` from `task.metadata.namespace` only *after* the default-ns `getTask` — which 404s first for non-default namespaces.

### Issue 4 — activity feed cursor vs sort key (`routes/activity.ts`)

- `GET /api/activity` (12–35): the `before` cursor filters `lt(taskEvents.id, beforeId)` (line 23) but the query orders by `desc(taskEvents.createdAt)` (line 30).
- `taskEvents.createdAt` is `datetime('now')` — second resolution (`schema.ts:155`); multiple events in the same second share a `createdAt`, and id order (autoincrement, `schema.ts:143`) diverges from createdAt order → pages skip/repeat events.
- Client (`client/pages/ActivityPage.tsx:236–264`) passes `before=oldestId` where `oldestId` is the min **id** of the fetched page — consistent only with id-ordering on the server.

### Issue 5 — dead product surface (verification results)

Verified by searching the client (`client/lib/api.ts`, components), CLI, manager-controller, and e2e suites:

| Endpoint | Claimed dead | Actual | Disposition |
|---|---|---|---|
| `POST /runs/:name/reply` (`routes/runs.ts:169–205`) | yes | **Wired**: `replyToRun` (`client/lib/api.ts:152`) called by the TaskDetailPanel answer flow (`TaskDetailPanel.tsx:1039`) | **Keep** |
| `POST …/board/tasks/:taskName/answer` (`board.ts:616–648`) | yes | **Wired**: `answerTask` (`client/lib/api.ts:424`), answer box `TaskDetailPanel.tsx:1283–1328`; annotation consumed by manager `decideWaitingForInput` (`reconciler/decision.ts:481`); unit tests exist (`tests/task-detail-answer.test.tsx`, `reconciler/__tests__/effects.test.ts`) | **Keep** (task's parenthetical: wire end-to-end, don't delete) |
| `POST …/board/tasks/:taskName/abandon` (`board.ts:589–611`) | yes | No client/CLI/e2e callers; only `auth.test.ts:293` 401 check. Manager still understands the `percussionist.dev/action-abandon` annotation | **Delete route** (annotation handling stays in manager) |
| findings-triage routes (`routes/findings.ts`: GET list, GET `:id`, PATCH `:id`, POST `:id/task`) | yes | No client callers — `FindingsPanel`/`BoardHeader` read `status.findings` from the board response; the manager reads the ConfigMap directly (its own `ingestFindings`), not the web API. Helpers `getFindingsConfigMap`/`patchFindingsConfigMap`/`parseTriagedFindings`/`inboxFindingKey`/`triagedFindingKey` used only here + kube tests | **Delete module + app.ts mount** |
| `GET /stats/exists/:sessionID` (`stats.ts:328–334`) | yes | No callers anywhere (only `smoke.test.ts:174,231`, `auth.test.ts:222`) | **Delete route + tests** |

---

## Approach

### Issue 1 — push aggregation + LIMIT/OFFSET into SQL

**`/sessions`**: keep the exact response shape (`sessions`, `total`, `limit`, `offset`, `summary{…}`, `agentSummaries[]`, `modelRows[]`) but compute everything in SQLite:

1. **Page query** — the existing `baseQuery` (with the `resolvedModel` correlated subquery) gets `.limit(limit).offset(offset)` — the subquery then runs only for the page rows.
2. **`total` + `summary`** — one aggregate query over the window: `COUNT(*)`, `SUM(CASE phase='Succeeded')`, `SUM(CASE phase='Failed')`, `SUM(tokensIn/tokensOut/cost)`, and `AVG` of `(julianday(completedAt)-julianday(startedAt))*86400000` (same arithmetic as `/trends`, `stats.ts:857–860`). JS keeps only the derived `successRate`/`avgDurationMs` rounding.
3. **`modelRows`** — `GROUP BY COALESCE(runs.model, (SELECT model FROM messages WHERE session_id=runs.id AND role='user' AND model IS NOT NULL LIMIT 1), 'unknown')` with `COUNT/SUM(tokensIn)/SUM(tokensOut)/SUM(cost)`, ordered by `SUM(tokensIn) DESC` (matches current sort).
4. **`agentSummaries`** — `GROUP BY runs.agent` with `COUNT(*)`, `SUM(CASE phase='Succeeded'|'Failed')`, `SUM(tokensIn/Out/cost)`, `AVG(duration)`; plus one small `SELECT agent, model … GROUP BY agent, model` to rebuild the per-agent `models[]` arrays. JS derives `successRate`, `avgTokensPerRun`, `avgDurationMs`, sorts by `runs DESC`.

`days=0` still means "whole table" for the aggregates (needed for the summary), but no longer materialises rows in JS; the page query is bounded.

**`/export`**: keep the JSON-array shape; make the bound real:

1. Add `EXPORT_MAX_SESSIONS` (constant, env-overridable, default **200**) and push it into SQL as `.limit(EXPORT_MAX_SESSIONS)` on the run query — the cap applies inside the window.
2. Replace the N+1 child fetches with batched queries: `WHERE session_id IN (…chunk…)`, chunked at 400–500 ids (SQLite variable limit safety), one pass per table (`messages`, `toolCalls`, `fileOps`), assembled by `sessionId` into the same nested shape.
3. `console.warn` when the cap truncates; update the stale "bounded to ~10 concurrent runs" comment (line 356).

### Issue 2 — harden the housekeeping loops

1. Add a small `runHousekeeping(name, fn)` wrapper (or follow the `push-triggers` `tick` pattern) that catches and logs, used for both `pruneExpiredRunKeys` and `runRetentionCleanup` in `index.ts` (startup + both intervals). Never let a background-loop rejection/exception reach `unhandledRejection`/`uncaughtException`.
2. Defense-in-depth: add `PRAGMA busy_timeout = 5000` (or Bun `Database` `timeout` option) in `db.ts:openDatabase` so transient writer contention is retried instead of surfacing as `SQLITE_BUSY`.
3. Optional: keep `pruneInterval.unref()` and startup ordering unchanged.

### Issue 3 — project-scoped task actions

1. Add a shared helper in `routes/board.ts` (e.g. `getProjectTask(projectName, taskName)`):
   - `getProject(projectName)` → `ns = project.metadata.namespace ?? NAMESPACE`
   - `getTask(taskName, ns)` → if `task.spec.projectRef !== projectName` (also cross-check the `percussionist.dev/project` label), return 404 (`{ error: 'Task not found in project' }` — same class of miss as the existing `errStatus` path) **before** any patch/annotation/event write.
2. Use the resolved `ns` for every `patchTask`/`patchTaskStatus` in `approve`, `request-changes`, `retry-review`, `answer` (and `abandon` while it still exists — see Issue 5).
3. `appendTaskEvent(projectName, …)` then only ever records events under a project the task actually belongs to — fixes the activity-feed corruption.

### Issue 4 — order by the cursor key

`routes/activity.ts:30`: `.orderBy(desc(taskEvents.createdAt))` → `.orderBy(desc(taskEvents.id))` (id is the autoincrement primary key; monotonic with insertion; matches the `before` cursor). Consider the same change in `routes/board-db.ts:21,40` for consistency (limit-only feeds; optional, low risk).

### Issue 5 — clean up the genuinely dead surface, keep the answer flow

1. **Keep** `POST /runs/:name/reply` and `POST …/answer` — wired end-to-end (client answer box → `/reply` + `/answer` annotation → manager `decideWaitingForInput`). Update the task's stale premise in comments/docs where it surfaces. Add an optional deterministic e2e (see Tasks) to close the "unverified on a live cluster" gap noted in `TaskDetailPanel.tsx:1033`.
2. **Delete** `POST …/abandon` route (no callers; manager annotation handling is out of scope and stays).
3. **Delete** `routes/findings.ts` (all four triage routes) + its `app.ts` mount (line 17, 73). Keep the kube helpers (`getFindingsConfigMap` etc.) — they back kube tests and remain available.
4. **Delete** `GET /stats/exists/:sessionID` (no callers).
5. Update `tests/auth.test.ts` (remove the `/abandon` and `/stats/exists` 401 entries) and `tests/smoke.test.ts` (remove the two `/stats/exists` tests).

---

## Tasks (proposed BUILD breakdown)

Sequential BUILD tasks (feature branches from the PLAN branch); each is independently verifiable. All tests follow the repo's deterministic principles (no cluster needed except e2e).

### BUILD 1 — `/api/stats/sessions`: SQL LIMIT/OFFSET + SQL aggregation
- `packages/web/src/server/routes/stats.ts` (sessions handler, 374–539).
- Add `.limit(limit).offset(offset)` to the page query.
- Replace JS aggregate loops with SQL aggregate queries (summary, modelRows, agentSummaries + agent-models lookup) preserving the exact response shape.
- Tests: extend `packages/web/tests/smoke.test.ts` — insert >limit sessions (e.g. 3 with `limit=2`), assert `sessions.length === 2`, `total` covers the full window, `summary`/`modelRows`/`agentSummaries` match hand-computed values; keep existing sessions test green. Update `session-list.test.tsx` if the mocked payload shape shifts.

### BUILD 2 — `/api/stats/export`: SQL cap + batched child fetches
- `packages/web/src/server/routes/stats.ts` (export handler, 341–367).
- Add `EXPORT_MAX_SESSIONS` (default 200, env-overridable), `.limit()` on the run query, batched `IN`-chunked fetches for messages/toolCalls/fileOps, `console.warn` on truncation, fix the stale comment.
- Tests: extend `smoke.test.ts` — export returns ≤ cap sessions, nested messages present for returned sessions, cap respected when inserting more sessions than the cap.

### BUILD 3 — crash-proof housekeeping loops
- `packages/web/src/server/index.ts` (28–31, 93–94, 110–117) + `packages/web/src/server/db.ts` (openDatabase, busy_timeout).
- Wrap `pruneExpiredRunKeys` and `runRetentionCleanup` in a try/catch/logging helper (push-triggers `tick` pattern); add `PRAGMA busy_timeout`.
- Tests: extract the wrapper as a testable unit (e.g. `lib/run-housekeeping.ts`) and unit-test that a throwing fn is caught and logged; add a direct test that `pruneExpiredRunKeys` resolves (not rejects) against a live temp DB, and that a forced busy/error does not propagate.

### BUILD 4 — project-scoped board task actions
- `packages/web/src/server/routes/board.ts`: add `getProjectTask(projectName, taskName)` helper; apply to `approve`, `request-changes`, `retry-review`, `answer` (and `abandon` until BUILD 6 lands — coordinate order: BUILD 4 before BUILD 6, or have BUILD 6 adjust the helper usage).
- Resolve `ns` from the project and pass it to all `patchTask`/`patchTaskStatus` calls; 404 on `projectRef` mismatch before any write.
- Tests: new `packages/web/tests/board-actions-project-check.test.ts` following the `board-move.test.ts` spy pattern (`getProject`/`getTask`/`patchTask`/`patchTaskStatus` spies) — (a) task in a non-default namespace (project.metadata.namespace = 'other-ns') resolves and patches in that ns; (b) `projectRef` mismatch → 404 and no patch/appendTaskEvent; (c) default-ns happy path still works.

### BUILD 5 — activity feed cursor consistency
- `packages/web/src/server/routes/activity.ts` line 30 → `desc(taskEvents.id)`; optionally the same in `routes/board-db.ts:21,40`.
- Tests: new `packages/web/tests/activity.test.ts` — insert events sharing the same `createdAt` with distinct ids, assert id-desc order and that `before=<min id>` returns exactly the older set with no skips/repeats.

### BUILD 6 — remove dead product surface
- Delete `POST …/abandon` (board.ts 589–611), the whole `routes/findings.ts` + `app.ts` mount, `GET /stats/exists/:sessionID` (stats.ts 328–334).
- Keep: `/reply`, `/answer`, and the manager's annotation handling for `action-abandon`/`action-answer`.
- Update `tests/auth.test.ts` (drop `/abandon`, `/stats/exists` entries) and `tests/smoke.test.ts` (drop the two `/stats/exists` tests; add a 404 check for removed paths using the existing `expectHandledNotRouterMiss`-style guard flipped: the catch-all must now answer for the deleted routes).
- Optional but recommended: add a deterministic e2e (`tests/e2e/e2e-answer-flow.test.ts` + a `CRITICAL OVERRIDE` ClusterAgent fixture that parks on `WaitingForInput`) asserting the answer flow resumes a `waiting-for-input` task to `running` (CR-status assertions only). Coordinate with the waiting-for-input deadlock findings from plan rev24 — the e2e must not depend on fixing the terminated-run deadlock.

**Dependency order:** BUILD 1 → BUILD 2 (same file), BUILD 3 independent, BUILD 4 → BUILD 6 (abandon deletion touches the same routes; if BUILD 6 lands first, BUILD 4's helper simply has four consumers instead of five), BUILD 5 independent. BUILD 6's auth.test.ts edits must rebase cleanly after BUILD 4/5 if they touch the same file regions.

---

## Risks / open questions

1. **Response-shape drift on `/sessions`** — the client (SessionList/StatsView) parses `sessions/total/summary/agentSummaries/modelRows` strictly. SQL aggregation must reproduce rounding (`Math.round` for successRate/avgDurationMs/avgTokensPerRun), the `'unknown'` model fallback, sort orders, and `models[]` arrays exactly. Mitigation: shape-asserting smoke tests before/after.
2. **`days=0` semantics** — kept as "whole table" for `/sessions` aggregates (the summary is meant to cover the window); the *page* is bounded by LIMIT/OFFSET. For `/export`, `days=0` becomes "whole table capped at `EXPORT_MAX_SESSIONS`". Document the cap (README mentions the export workflow) so `curl …?days=0` users know it truncates.
3. **Export cap choice** — 200 is a guess; too low breaks large-window LLM analyses, too high re-introduces the OOM. Env-overridable; acceptance criteria assert the cap is *honored*, not its exact value.
4. **Deleting `/abandon` and the findings routes** — the annotations/ConfigMap mechanics the manager relies on are untouched; only the web HTTP surface is removed. Verified no client/CLI/e2e/MCP callers. If a reviewer knows of an external consumer (scripts, docs), it must be re-surfaced before merge — this is the one change that could silently break an undocumented caller.
5. **`SQLITE_BUSY` root cause** — the wrap prevents crashes; `busy_timeout` reduces the errors. A WAL-mode `SQLITE_BUSY` is still possible under heavy concurrent writers; the plan treats it as transient and logged, matching the other loops.
6. **Task-description claim about `/reply`/`/answer` is stale** — verified they have live client callers and unit tests on this branch; they are kept per the task's own instruction. If the facilitator intended them deleted anyway, that contradicts the parenthetical and should be resolved before BUILD 6.
7. **BUILD 6 coordinate with rev24 findings** — the answer-flow e2e must pin only the already-working resume path (`WaitingForInput` + run `Running` + answer annotation → `running`), not the terminated-run deadlock rev24 pinned as a separate finding.

---

## Acceptance criteria

1. `GET /api/stats/sessions?days=N&limit=L&offset=O` executes the page query with `LIMIT/OFFSET` in SQL; response shape unchanged; `total`/`summary`/`agentSummaries`/`modelRows` cover the full window via SQL aggregates; `days=0` no longer materialises the whole table in JS.
2. `GET /api/stats/export` never loads more than `EXPORT_MAX_SESSIONS` sessions or their children; nested shape unchanged; truncation logged.
3. A `SQLITE_BUSY`/rejection from `pruneExpiredRunKeys` or `runRetentionCleanup` is logged, never reaches `unhandledRejection`/`uncaughtException`, and never calls `process.exit(1)`. `PRAGMA busy_timeout` set on the stats DB.
4. `approve`/`request-changes`/`retry-review`/`answer` (and `abandon`, until removed): tasks in non-default namespaces resolve via the project's namespace; `projectRef` mismatch returns 404 with no annotation patch and no `task_events` row.
5. `GET /api/activity` orders by `id DESC`; cursor pages never skip or repeat events (including same-second inserts).
6. Dead surface removed: `/abandon`, all four findings-triage routes, `/stats/exists/:sessionID` return the API 404 catch-all; `POST /runs/:name/reply` and `/answer` remain and are covered by tests; the client answer flow still works end-to-end.
7. `pnpm typecheck`, `pnpm lint`, `pnpm test` (web package) pass; no cluster required for unit/smoke coverage; optional e2e added for the answer flow if approved.

## Explicitly out of scope

- Client-side changes to the answer UI (already wired; only optional e2e added).
- The manager's `decideWaitingForInput` terminated-run deadlock (tracked in plan rev24 as a pinned finding).
- `runRetentionCleanup` semantics/`RETENTION_DAYS` policy changes beyond making the loop crash-proof.
- Changing the `limit` cap on `/sessions` (currently 200 max) — pre-existing behavior, not part of this task.
