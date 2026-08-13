# Plan: Full code review — duplicate code, test gaps, nonsensical tests, improvement areas

**Task ID:** `percussionist-dev-plan-4abf54`
**Type:** PLAN
**Project:** percussionist-dev
**Revision:** 1

## Context

Percussionist is a pnpm monorepo (10 packages) of TypeScript. The review covered
all production source (`packages/api`, `kube`, `operator`, `dispatcher`,
`manager-controller`, `web`, `cli`, `memory-service`, `runner-claude` — ~18k
lines) and ~110 test files. Four parallel review passes were run (one per
package group); every high-impact claim was then hand-verified against source
before inclusion here. Verified findings are marked **(verified)**; the rest are
high-confidence but should be confirmed by the BUILD agent touching the file.

The review output itself (findings below) is the primary deliverable of this
task; the BUILD breakdown at the end turns the findings into actionable work.

## Approach

1. Read all non-test source for correctness, duplication, and dead code.
2. Mapped source files → test files to find gaps (files with no tests, and
   untested branches within tested files).
3. Inspected test files for tautological/self-referential assertions, tests
   that exercise mocks instead of real code, and copy-pasted tests.
4. Verified the top findings by re-reading the exact lines cited.

## Findings

### A. Bugs & correctness issues (fix first)

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| A1 | **High (verified)** | `sessionRowSelect.resolvedModel` uses `${runs.id}` inside a raw `sql` template; drizzle renders it as unqualified `id`, so the correlated subquery binds to `messages.id` and the user-message model fallback never resolves. `GET /api/stats/sessions/:name` (line 692) always returns `resolvedModel: 'unknown'` when the model only exists on a user message. The file's own comment (lines 488-492) documents the correct raw `runs.id` form — the inline `/sessions` route uses it, `sessionRowSelect` (added later) reintroduced the bug. | `packages/web/src/server/routes/stats.ts:455-463` vs `:493-501` |
| A2 | **High (verified)** | Manager `buildPayloads` never populates `toolCallsPayload` — the part loop pushes only to `fileOpsPayload`; `toolCallsPayload` is declared, never written, and returned as `[]`. Every manager chat-session's tool metrics are silently lost in the web Stats view, and the manager's own test pins the broken empty behavior. The dispatcher copy (which the comment at line 44 claims to mirror) does correlate tool-use/tool-result. | `packages/manager-controller/src/agent/stats-reporter.ts:55-149` |
| A3 | **High (verified)** | `create_run` MCP tool documents "The task must be in the 'pending' phase" but `isValidTransition('pending', 'running')` is false (`TRANSITION_TABLE.pending = ['scheduled']`); the only phase with a `→ running` edge is `initializing`. The tool is unusable for exactly the phase it advertises. Either add a `pending → running` admin edge (or accept an `admin` flag) or fix the description to say `initializing`. Its success path has zero test coverage (only the capability-failure path is tested). | `packages/manager-controller/src/agent/tools.ts:232-234`, `:1353-1360`; `packages/api/src/index.ts:893-895` |
| A4 | **High (verified)** | `pause_reconciliation` claims per-project pause but is backed by a single module-global `pausedUntil` in the reconciler bridge; the per-project `percussionist.dev/reconcile-paused` annotation written by the tool is never read by `reconcile()`. Pausing project A freezes every project; a manager restart drops the pause (annotation ignored). `getPauseStatus` returns a dead `elapsedMs: 0` on both branches and the tool fabricates `lastReconcile: new Date().toISOString()`. | `packages/manager-controller/src/reconciler-bridge.ts:31-49`; `packages/manager-controller/src/agent/tools.ts:1887-1958` |
| A5 | **High (verified)** | Memory-service `limit`/`offset` are unvalidated: `Math.min(body.limit ?? 10, 100)` passes negative values through, and in SQLite a negative `LIMIT` means *no limit* — a client can pull the whole table. `limit: "abc"` → `NaN` → bun:sqlite bind throws a 500. | `packages/memory-service/src/routes.ts:151`, `:214-215`; entry points `src/index.ts:124-145` |
| A6 | **Medium (verified)** | `compactMessagesForSnapshot` marks every tool part `metadata.truncated: true` unconditionally, even when output was under the 4k-char cap and not truncated. Every tool call in every ConfigMap session snapshot is reported as truncated to web session view and facilitation context. | `packages/dispatcher/src/session.ts:99-128` (line 114) |
| A7 | Medium | `readProjectGithubToken` caches transient read failures (503 / temporary Secret read error) as `{ token: undefined }` for the full 15-min `_tokenTtlMs`, silently disabling PR-mode polling. Only NotFound should be cached as a miss. | `packages/manager-controller/src/reconciler/github-client.ts:102-111` |
| A8 | Medium | `pullModel`'s `throw new Error('pull error: ...')` on Ollama `event.error` is swallowed by the sibling "skip non-JSON line" catch, so the real pull error never aborts and the specific error message is lost. | `packages/memory-service/src/model-warmup.ts:140-154` |
| A9 | Medium | `submit --timeout` with a non-numeric value: `Number('abc')` → `NaN` → falsy → silently ignored, run gets project default (up to 1h). `wait.ts` and `doctor.ts` validate the same flag; `submit.ts` doesn't. | `packages/cli/src/submit.ts:118,167` |
| A10 | Medium | `doctor` `checkDns` unconditionally requires the `ollama` Service while `checkHealth` treats ollama as optional unless a project enables `spec.embedding` — a cluster with no embedding projects always fails the DNS check. Similarly `checkStorage` hardcodes `{project}-data` and ignores the documented `spec.data.pvcName` override. | `packages/cli/src/doctor-static.ts:359,413-442,642`; `doctor-platform.ts:329-345` |
| A11 | Medium | Operator `patchStatus` swallows every failure (`catch { err(...) }`, no rethrow) — a lost status patch means the informer never re-fires and there is no retry path for the pod-phase mirror / terminal-Failed claim. | `packages/operator/src/reconciler.ts:95-111` |
| A12 | Medium | Web client mutating API helpers (~20 of them, e.g. `submitRun`, `submitProject`, `addBoardTask`, `saveSettings`) skip the 401→login and 423→`setGloballyLocked` handling that `fetchJSON` provides, so the daily usage lock never surfaces in the lock UI on mutating pages. | `packages/web/src/client/lib/api.ts:136-147` etc.; `fetchJSON` at `:31-48` |
| A13 | Low | `UNRELATED ISSUES` prompt guard `task.spec.type !== 'BUILD' || !description.includes('merge')` can never fire for merge runs (built by `buildMergeRun`, which doesn't call `buildWorkerRun`), but does suppress the block for any BUILD whose description merely contains "merge". | `packages/manager-controller/src/worker-builder.ts:234` |
| A14 | Low | `resolveAgentModel` swallows all ClusterAgent lookup errors (not just NotFound), silently falling back to project/cluster default model on transient API errors — runs execute under an unintended model. | `packages/manager-controller/src/worker-builder.ts:44-51` |
| A15 | Low | `ideURLFor` hardcodes `http://` even when `PERCUSSIONIST_INGRESS_BASE_URL` is https (deploy default) — broken link once surfaced in UI. | `packages/operator/src/code-server.ts:644-647` |
| A16 | Low | `useMetrics` silently replaces a failed `/api/metrics/nodes` **or** `/api/metrics/pods` response with `{items: []}` with no partial-failure signal — a broken metrics endpoint half-looks like "no data". | `packages/web/src/client/hooks/useMetrics.ts:86-121` |

### B. Duplicate code

| # | Finding | Locations |
|---|---------|-----------|
| B1 | `getOptionalClusterSettings` byte-identical copy (different log prefix only). | `manager-controller/src/worker-builder.ts:54-65` & `facilitator.ts:36-47` |
| B2 | Manual-action annotation key maps + parse functions triplicated (`TASK_ANNOTATION_KEYS`/`normalizeManualActions`, `ACTION_ANNOTATION_KEYS`/`extractManualActions`, `APPROVE_ANNOTATION_KEYS`). | `reconciler/observations.ts:21-27,101-111`; `reconciler/flow-introspection.ts:60-77`; `agent/tools.ts:959-962` |
| B3 | `decideAwaitingMerge` vs `decideAwaitingFeatureMerge` — two ~200-line near-copies (verdict message, merged→done, push-failed→failed, conflict→awaiting-human, no-verdict escalate, stale-running check). | `reconciler/decision.ts:1000-1182` & `:1488-1741` |
| B4 | Label-selector `k=v` filter loop inlined three times in `list_crs`. | `agent/tools.ts:1134-1146`, `:1161-1173`, `:1196-1208` |
| B5 | Stats payload builder duplicated between manager and dispatcher — already diverged (see A2). | `manager-controller/src/agent/stats-reporter.ts:46-159`; `dispatcher/src/stats-reporter.ts:209-340` |
| B6 | Findings auto-task creation duplicated between reconciler and `create_task_from_finding` tool, with different name suffixes (`-{hash}` vs `-find-{hash}`) — same finding can become two tasks with no dedup across paths. | `reconciler/findings-ingestion.ts:209-289`; `agent/tools.ts:2706-2831` |
| B7 | `isNotFound`/status-code extraction reimplemented 3× in operator (`reconciler.ts:674-679`, `ttl.ts:27-32`, inline in `pvc-helper.ts:62-63,115-116`) while `@percussionist/kube` has `getErrorStatusCode`/`isNotFoundError` that are **not exported**. | `packages/operator/...`; `packages/kube/src/index.ts:252-264` |
| B8 | `pickFreePort`/`startPortForward` duplicated between `port-forward.ts` and `manager-mcp.ts` (the file's own header says port-forward.ts is their single home) — and the copies have already diverged (MCP copy has a timeout, the other doesn't). | `cli/src/port-forward.ts:21-81`; `cli/src/manager-mcp.ts:55-126` |
| B9 | 3-line `errorMessage(e)` redefined 6×. | `cli/src/doctor.ts:320`, `doctor-runtime.ts:615`, `doctor-static.ts:744`, `doctor-platform.ts:476`, `manager-mcp.ts:299`, `operator/src/reconciler.ts:78` |
| B10 | Shell snippets duplicated inside `pod-builder.ts`: package-install block (`:473-482` vs `:610-619`), ref-sync loop inlined (`:512-522`) while `renderRefSyncSnippet()` helper exists (`:85-98`), cache env vars twice (`:699-703` vs `:894-898`), initScript runner block (`:595-605` vs `:670-680`). Security-relevant templates — a fix in one copy silently misses the other. | `packages/operator/src/pod-builder.ts` |
| B11 | SSH host-key verification computed twice (pod-builder and code-server, code-server comment says "Mirrors pod-builder.ts"), including the known-hosts volume fallback. | `operator/src/pod-builder.ts:441-458,789-808`; `operator/src/code-server.ts:134-144,610-629` |
| B12 | `parseCpu`/`parseMemory` byte-identical in web server and client hook. | `web/src/server/metrics-collector.ts:79-93`; `web/src/client/hooks/useMetrics.ts:50-64` |
| B13 | `resolvedModel` SQL subquery duplicated — and diverged into the A1 bug. | `web/src/server/routes/stats.ts:455-463` & `:493-501` |
| B14 | "fetch with auth + 423 lock + error parse" implemented ≥3 ways; raw-fetch hooks (`useMetrics`, `useMetricsTimeSeries`) bypass the shared helper entirely. | `web/src/client/lib/api.ts:31-48`; `lib/usage-settings.ts:121-136`; `hooks/useMetrics.ts:80-89`; `hooks/useMetricsTimeSeries.ts:31-40` |
| B15 | Route→usage-category classification expressed twice with identical regexes. | `web/src/client/lib/usage-categorization.ts:9-13`; `web/src/client/hooks/useUsageTracker.ts:27-49` |
| B16 | `readJsonWithLimit` (20 MB cap) duplicated verbatim; cap constant in two places. | `dispatcher/src/session.ts:71-97`; `kube/src/index.ts:962-1012` |
| B17 | `parseModelRef` reimplemented inline in dispatcher polling; api docstring says it "Mirrors the dispatcher's parsing" — dependency inverted. | `dispatcher/src/polling.ts:1005-1015`; `api/src/index.ts:160-173` |
| B18 | 409-retry patch loop copy-pasted 4× in kube. | `kube/src/index.ts:327-358,361-392,678-708,798-833` |
| B19 | Ollama URL/model defaults defined 3× in memory-service. | `memory-service/src/embed.ts:1-3`; `routes.ts:391-393`; `model-warmup.ts:16-17` |
| B20 | `summarizePodFailure`/`collectContainerExitCodes` duplicate the same container-status traversal with an identical exit-code filter. | `operator/src/reconciler.ts:706-725,740-768` |

### C. Test gaps (no coverage for non-trivial logic)

| # | Gap | Location |
|---|-----|----------|
| C1 | `branch-resolver.ts` — zero tests. Branch-naming contract (`feature/{plan}`, `feature/{plan}--{build}`) and error paths (BUILD referencing missing parent PLAN) are load-bearing for every feature-branched task; a regression wedges all of them. | `manager-controller/src/branch-resolver.ts` (170 lines, **no test file**) |
| C2 | Run builders (`buildWorkerRun`, `buildMergeRun`, `buildPrOpenRun`) never execute in tests — `effects.test.ts:76-78` mocks all three. Auth validation, memory-context injection, `source.git.ref` override untested. | `manager-controller/src/worker-builder.ts:73-397,623-752` |
| C3 | `chat-handler.ts` (296 lines: ConfigMap persistence, session reuse, abort race) — zero tests. | `manager-controller/src/agent/chat-handler.ts` (**no test file**) |
| C4 | `reconciler-bridge.ts` (worker loop, 404-vs-other backoff, pause) — zero tests; `reconcile.test.ts` only tests `reconcileProject`. | `manager-controller/src/reconciler-bridge.ts` (**no test file**) |
| C5 | `events.ts`, `web-headers.ts`, `reconciler/audit.ts` — zero tests; these are the sole channel to the web audit log / K8s Events. | `manager-controller/src/events.ts`, `web-headers.ts`, `reconciler/audit.ts` |
| C6 | Session-summarizer retry loop (3× backoff) and `compactSessionForSummary` truncation cap untested. | `manager-controller/src/session-summarizer.ts:131-189` |
| C7 | `create_run` success path untested (only capability-failure path is). | `manager-controller/src/agent/__tests__/tools-capability-gating.test.ts:103-124` |
| C8 | Web `/tool-metrics` cost/token attribution math, `/trends`, `/metrics-timeseries` — zero functional tests (money-adjacent math). | `web/src/server/routes/stats.ts:851-998,1004-1103,1126-1230` |
| C9 | Web metrics routes + client `parseCpu`/`parseMemory` unit tests missing (unit-conversion bugs are silent and visually plausible). | `web/src/server/routes/metrics.ts:28-144`; `web/src/client/hooks/useMetrics.ts:50-64` |
| C10 | Web `session.ts` 3-source fallback chain (snapshot → live → DB replay) has no route-level test (was the subject of two bug-fix commits). | `web/src/server/routes/session.ts:22-92` |
| C11 | Web routes with **no** test file: `runs.ts` (incl. `POST /:name/reply`), `logs.ts`, `upgrade.ts` (patches live Deployments), `plans.ts`, `agent-chat.ts`, `project-memories.ts`, `settings.ts`, `metrics.ts`. | `web/src/server/routes/*.ts` |
| C12 | `runRetentionCleanup` — the hourly production data-deletion query (relies on FK cascade) — untested; tests cover only the wrapper. | `web/src/server/routes/stats.ts:833-849` |
| C13 | `useUsageTracker` core logic (5s increments, per-project counters, pruning, heartbeat/lock coupling) untested — only `parseRouteUsage` is. | `web/src/client/hooks/useUsageTracker.ts:60-124` |
| C14 | Operator `reconcileClusterSettings`/`injectDispatcherMcpStanza`/`ssaConfigMap` — zero tests; determines every run pod's MCP stanza + agent-config. | `operator/src/reconciler.ts:158-416` |
| C15 | Operator `memory-service.ts` (212 lines) — no test file; rendered env/volumes/owner-refs never asserted. | `operator/src/memory-service.ts` |
| C16 | Operator `code-server.ts` — only `renderIdeDeployment` tested; Service/Ingress/`ideURLFor` untested (Ingress is the externally reachable IDE surface). | `operator/src/code-server.ts:640-761` |
| C17 | Operator `ttl.ts` `buildCleanupJob` shell script (mirror prune + `git branch -D`) untested — reclaims PVC space. | `operator/src/ttl.ts:129-144` |
| C18 | CLI `deploy.ts` (769 lines, regex YAML patching) — zero tests. | `cli/src/deploy.ts` |
| C19 | CLI `auth.ts`/`auth-keys.ts`/`auth-login.ts` (device-flow poller with real branches) — zero tests. | `cli/src/auth*.ts` |
| C20 | CLI `submit.ts` `waitForRunning` (flagship `--attach` polling loop) untested — `wait.test.ts` tests a different function. | `cli/src/submit.ts:276-308` |
| C21 | CLI `board.ts` annotation-based approve/request-changes/retry paths untested (only `resolveTaskMove` is). | `cli/src/board.ts:143-645` |
| C22 | Dispatcher `session.ts` (`compactMessagesForSnapshot` — contains A6) — zero tests, and `sendStats` full flush (3-attempt retry) untested. | `dispatcher/src/session.ts`; `dispatcher/src/stats-reporter.ts:116-204` |
| C23 | Dispatcher `search_code` (execs `rg`/`grep` with a workspace-escape guard) and its output parsers (`parseRgJson`/`parseGrepOutput`) untested — security surface. Also `handleCreateTask`/`handleReportFinding`. | `dispatcher/src/mcp-server.ts:498-740,986-1135` |
| C24 | `doctorClients()` itself untested (every doctor test injects stubs). | `cli/src/k8s-clients.ts:37-49` |

### D. Nonsensical / tautological / copy-pasted tests

| # | Finding | Location |
|---|---------|----------|
| D1 | Source-string "schema" tests read `tools.ts` as a string and assert substrings (e.g. "should require project arg" only checks the word "project" appears somewhere). They can never fail on the property they claim to check and give false confidence about the JSON-schema contract. | `manager-controller/src/agent/__tests__/findings-tools.test.ts:44-55`, `approve-tool.test.ts:60-72`, `flow-introspection-tools.test.ts:60-63`, `memory-tools.test.ts:128-160` |
| D2 | `expect(patchTaskStatusSpy).toHaveBeenCalledTimes(4)` pins the current *double-heal loop structure* (would fail if the redundant second loop is removed with identical observable behavior). | `manager-controller/src/reconciler/__tests__/reconcile.test.ts:117` |
| D3 | Duplicate test: "logs a warning when storeMemory throws" is a near-verbatim copy of the same test with different seed names. | `manager-controller/src/__tests__/summarizer.test.ts:266-303` vs `:175-209` |
| D4 | `usage-bar-expand-collapse.test.ts` asserts on source-text substrings (Tailwind classes, `onClick` text) — and its header claims "no React component test harness exists", which is false (`usage-bar-component.test.tsx` renders the real component). Passes even if the component is completely broken at runtime. | `web/tests/usage-bar-expand-collapse.test.ts` (234 lines) |
| D5 | `providers-claude-engine.test.ts` reimplements `withClaudeEngine`/`visibleProviderIds` locally ("route's own helper is module-private") — every assertion exercises the test's copy, never the route. | `web/tests/providers-claude-engine.test.ts:16-36`; real code `web/src/server/routes/providers.ts:72-78` |
| D6 | `task-diff.test.ts` asserts on the exact generated shell text (`RESOLVE()`, `command -v git` ordering, MCP arg plumbing) — pins formatting, not behavior. | `web/tests/task-diff.test.ts:443-483,505-508` |
| D7 | `embed.test.ts` asserts `getEmbedding` returns a 768-length Float32Array — but `shared-mocks.ts` replaces `getEmbedding` with a mock returning exactly that constant. Tautological; the real HTTP/Ollama path is untested. | `memory-service/src/__tests__/embed.test.ts`; `__tests__/shared-mocks.ts:7-11` |
| D8 | "caps limit at 200" seeds only 5 rows — passes with or without the cap; the `Math.min(limit, 200)` would need to be deleted to see it fail. | `memory-service/src/__tests__/routes.test.ts:371-375` |
| D9 | Enum self-comparison tests (`FindingSeverity.enum.low === 'low'`) assert constants equal themselves. | `api/src/__tests__/finding-schema.test.ts:132-150` |
| D10 | Two `complete_run` tests with identical setup and assertions (same mock `gitCheck.isClean`, same assertions) — same test twice. | `dispatcher/src/__tests__/mcp-server.test.ts:516-536` & `:579-598` |
| D11 | Legacy-name dispatch test compares two identical early-exit errors (both return "RUN_PROJECT not set" before any dispatch logic) — vacuously proves nothing about name routing. | `dispatcher/src/mcp-server.test.ts:88-99` |
| D12 | Pod-builder: four near-identical copy-pasted tests (same fixture, same substring assertions); a test whose name admits redundancy ("keeps the parent-baseline substring assertions passing"); log-message tests asserting strings rendered unconditionally (verify template text, not runtime branch); a precedence test pinning *duplicate* env entries ("last value wins" semantics) that breaks if the duplication is fixed. | `operator/src/pod-builder.test.ts:91-194,299-304,406-457,518-563,636-664` |

### E. Dead code / minor hygiene

- `clearWorkerRunRefs` in `manager-controller/src/agent/worker-status.ts:3-13` — unused export kept alive only by its test; contains the `null as unknown as undefined` casts that encode a workaround now done inline.
- `ANNOTATION_PREFIXES` / `annotationKey` in `api/src/index.ts:1840-1864` — dead exports, zero references repo-wide (drift risk for board-approval annotations).
- `_parseStorageBytes` in `web/src/client/hooks/useMetrics.ts:67-75` — defined, never called (storage values pass through as numbers).
- Unreachable branch in `/trends` model pivot (`pivotMap.get(date)` can never be undefined since `sortedDates` comes from `pivotMap.keys()`) — `web/src/server/routes/stats.ts:1218-1222`.
- `HISTORY_CAP = 50` duplicated as a hardcoded `.slice(0, 50)` in `useNotificationHistory.ts:31` — drift risk.
- `beatctl ls -A/--all-namespaces` accepted but silently ignored (`cli/src/index.ts:156`).
- `beatctl board task move|approve|retry|request-changes|remove` accept a `<project>` positional arg and ignore it (`cli/src/board.ts:243,284,504,557,613`).
- `withProbeTimeout` silently disables the timeout for `ms <= 0` (`cli/src/doctor-util.ts:22`).
- `auth key rotate <component>` interpolates arbitrary input into a printed kubectl command with no whitelist (`cli/src/auth-keys.ts:98-116`).

## Scope boundaries

- **In scope:** findings above and their fixes; new tests that pin the fixed behavior; deletion/replacement of nonsensical tests; deduplication of verified duplicate code.
- **Out of scope:** refactoring `decideAwaitingMerge`/`decideAwaitingFeatureMerge` into a single function (B3) — high-risk, ~400 lines of reconciler logic, needs its own dedicated review; do not fold into other tasks.
- **Out of scope:** architecture changes (e.g. new shared packages beyond small helper exports from `@percussionist/kube`), dependency upgrades, formatting/style churn.
- Each BUILD must pass `pnpm typecheck` and `pnpm test` (repo-wide, per AGENTS.md) before merge.

## Proposed BUILD task breakdown

Ordered by dependency; each task is independently mergeable.

1. **BUILD-1 — Fix web session model resolution (A1, B13).** Delete the duplicated `resolvedModel` subquery: keep one raw-SQL form with `runs.id` (unqualified) shared by both `/sessions` and `/sessions/:name`. Add a regression test (extend `smoke.test.ts` or a new route test) seeding a run with `runs.model = null` and a user message carrying the model, asserting `resolvedModel` resolves (not `'unknown'`). *Files:* `packages/web/src/server/routes/stats.ts`, tests.
2. **BUILD-2 — Populate manager `toolCallsPayload` (A2, B5).** Port the dispatcher's tool-use/tool-result correlation (success/error/duration) into the manager `buildPayloads`; update the manager test that currently pins `toolCallsPayload: []` to assert populated tool-call rows with the same shape as the dispatcher's. *Files:* `packages/manager-controller/src/agent/stats-reporter.ts` + its test.
3. **BUILD-3 — Fix `create_run` doc/validation mismatch (A3, C7).** Decide with maintainers: either (preferred) add `pending → running` to the admin tool path via an explicit admin override, or correct the description to `initializing`. Add a success-path test (valid transition → run created, status patched; AlreadyExists with Failed/Cancelled → delete-and-recreate). *Files:* `packages/manager-controller/src/agent/tools.ts`, `packages/api/src/index.ts` (transition table if changed), tests.
4. **BUILD-4 — Make pause_reconciliation per-project (A4).** Move pause state to per-project (map keyed by project, or read the `percussionist.dev/reconcile-paused` annotation in `reconcile()`); compute `elapsedMs`/`remainingMs` for real; drop the fabricated `lastReconcile` or track an actual timestamp; add tests for pause/resume/expiry and for the annotation-based path surviving restart. *Files:* `manager-controller/src/reconciler-bridge.ts`, `agent/tools.ts`, tests.
5. **BUILD-5 — Harden memory-service validation + warmup (A5, A8).** Coerce/validate `limit`/`offset` (integer ≥ 1 / ≥ 0, max 100/200) in routes and entry points; fix `pullModel` so `event.error` aborts and propagates the real message; add tests for negative/NaN/oversized limits (replace D8's capped-at-200 test with a seeded >200-row or mocked-SQL test; delete/repair D7). *Files:* `packages/memory-service/src/routes.ts`, `index.ts`, `model-warmup.ts`, tests.
6. **BUILD-6 — Fix dispatcher snapshot truncation flag + session tests (A6, C22).** Only set `metadata.truncated: true` when the output was actually sliced; add `session.test.ts` covering `compactMessagesForSnapshot` (budget cap, marker, flag correctness) and `waitForHealthy`. *Files:* `packages/dispatcher/src/session.ts`, new test.
7. **BUILD-7 — Shared-helper dedup (B7, B8, B9, E).** Export `getErrorStatusCode`/`isNotFoundError` from `@percussionist/kube` and replace operator copies; make `manager-mcp.ts` import `pickFreePort`/`startPortForward` from `port-forward.ts` (reconcile the timeout divergence deliberately); collapse `errorMessage` into one shared helper; delete dead code (E1 `clearWorkerRunRefs`, E2 `ANNOTATION_PREFIXES`/`annotationKey` if confirmed unreferenced, E3 `_parseStorageBytes`). *Files:* `packages/kube/src/index.ts`, `packages/operator/src/{reconciler,ttl,pvc-helper}.ts`, `packages/cli/src/{manager-mcp,port-forward,doctor*,doctor-runtime,doctor-static,doctor-platform}.ts`, `manager-controller/src/agent/worker-status.ts`, `api/src/index.ts`, `web/src/client/hooks/useMetrics.ts`.
8. **BUILD-8 — Critical unit-test coverage (C1-C4).** New tests for `branch-resolver.ts` (naming contract + missing-parent errors), the run builders (real `buildWorkerRun`/`buildMergeRun`/`buildPrOpenRun` with a fake kube, covering auth validation, memory-context injection, `source.git.ref`), `reconciler-bridge.ts` (runWorker 404-vs-other backoff, pause), and `chat-handler.ts` (ConfigMap patch-then-create, session reuse, abort race). *Files:* `manager-controller` test suite additions.
9. **BUILD-9 — Operator/CLI test coverage (C14-C21, C24).** Tests for `injectDispatcherMcpStanza`/`ssaConfigMap`, memory-service renderers (env keys, volumes, owner refs), code-server Service/Ingress, `buildCleanupJob` script, `submit` `waitForRunning`, `board.ts` approve/request-changes/retry annotation semantics, `doctorClients()`, and `deploy.ts` `patchedOperatorManifest` (regex patching). *Files:* `packages/operator`, `packages/cli` test suites.
10. **BUILD-10 — Web test coverage (C8-C13).** Route-level tests for `/tool-metrics` token attribution math, `/trends`, `/metrics-timeseries`, metrics routes + `parseCpu`/`parseMemory` unit tests, session.ts fallback chain (stub `kube.ts`), `runRetentionCleanup` (seed + verify cascade delete), `useUsageTracker` logic, and a first smoke test for the untested routes in C11 (`runs.ts` reply path and `upgrade.ts` at minimum). *Files:* `packages/web/tests/`, `packages/web/src/server/routes/`.
11. **BUILD-11 — Purge nonsensical tests (D1-D12).** Delete source-string schema tests (D1) or convert to real schema assertions against the actual `inputSchema` JSON; replace D4 with component-harness assertions (or delete, since `usage-bar-component.test.tsx` covers it); export the real helper for D5; trim D6's formatting assertions; delete D7/D8/D9/D10/D11; dedupe D12 pod-builder tests to one test per behavior and fix D12's env-duplication pinning (see also B10). Keep only tests that can fail on real regressions. *Files:* across `manager-controller`, `web`, `memory-service`, `api`, `dispatcher`, `operator` test suites.
12. **BUILD-12 — Web client + CLI + minor fixes (A9-A16, A12).** Route mutating API helpers through the shared `fetchJSON` error/lock handling; add a partial-failure signal to `useMetrics`; validate `submit --timeout`; make doctor `checkDns` ollama-optional and `checkStorage` honor `spec.data.pvcName`; fix A7 (only cache NotFound as token-miss), A13 (remove/wrong-target guard), A14 (scope `resolveAgentModel` catch to NotFound + log others), A11 (retry path for lost status patch), A15 (scheme-aware `ideURLFor`), and the E5-E8 CLI hygiene items. Each with a minimal test.

## Risks / open questions

- **A3 design decision:** whether to extend `TRANSITION_TABLE` with a `pending → running` edge (affects `force_retry`/admin semantics everywhere `isValidTransition` is used) vs. only fixing docs — needs maintainer sign-off; BUILD-3 must not silently broaden the transition table.
- **B3 twins:** `decideAwaitingMerge`/`decideAwaitingFeatureMerge` are the highest-duplication hotspot but merging them risks subtle behavior drift in two different phase paths; deliberately excluded from BUILD-7, flagged for a dedicated follow-up.
- **B6 dedup:** reconciler vs tool auto-task creation differences in name suffix and dedup keys may be intentional (different sources); BUILD-7 must verify intent before unifying.
- **D5/D6 fixes** depend on whether `@testing-library/react` component tests are the accepted pattern for `web/tests` (they exist for UsageBar but not everywhere); keep assertions behavioral, not text-level.
- Some medium/low findings (A7-A16, C5, C24) were reported by review passes and not individually re-verified line-by-line here; BUILD agents must confirm exact line numbers on the current branch before editing.
- Test-suite volume: BUILD-8/9/10 add a lot of tests; keep them deterministic (no LLM output assertions), per `docs/testing-strategy.md`.
