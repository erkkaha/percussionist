# Plan: Code Review Remediation (dead code, bugs, fragility, test gaps)

## Context

A full review across all 8 packages (`api`, `kube`, `operator`, `dispatcher`,
`manager-controller`, `memory-service`, `web`, `cli`) surfaced dead code, real
correctness/security bugs, fragility hazards, and test-coverage gaps. Every
finding below was verified by reading source — `file:line` references are exact.

Important baseline facts:
- `noUnusedLocals` / `noUnusedParameters` are **not** set anywhere in
  `tsconfig.base.json` or any package tsconfig (verified), and tests are excluded
  from typecheck — so dead imports/vars and test `as any` never fail CI.
- Packages with **zero tests**: `api`, `kube`, `cli`, `dispatcher`. The web React
  client (~14K LOC) also has zero component/hook tests.

## Scope boundaries

### In scope
- Fix verified correctness bugs (C1–C4) and security gaps (S1–S3).
- Remove verified dead code (~700+ lines) with no production callers.
- De-duplicate the 6×-copied djb2 hash into one shared helper.
- Add highest-value missing tests that would have caught the bugs above.

### Out of scope
- Re-architecting the reconciler decision engine or effect model.
- Broad refactors of the web client or adding a client test runner harness
  (track separately; only server-side tests are added here).
- Tightening Zod schemas globally (resource-quantity regex, metadata passthrough).
- Changing the task transition table semantics (only adding completeness tests).

## Assumptions
1. "Review code" = produce actionable remediation; this plan is the deliverable
   and each numbered item becomes a candidate BUILD task.
2. Fixes must preserve existing behavior except where the behavior is the bug.
3. `git.url`/`git.ref` are Zod-validated and operator/human-set (not fully
   untrusted), so S2 is treated as defense-in-depth + fragility, not a remote RCE.

---

## Findings (verified, severity-ranked)

### SECURITY

- **S1 [HIGH] Secrets CRUD guarded by `auth()` not `adminAuth()`**
  `packages/web/src/server/routes/settings.ts:19` applies `settings.use("/*", auth())`
  to the whole router, including `POST /secrets` (:164), `PUT /secrets/:name` (:188),
  `DELETE /secrets/:name` (:212), `GET /secrets` (:148). Every other mutating router
  requires `adminAuth()`. Any authenticated non-admin can list/create/overwrite/
  delete cluster Secrets. Invisible to tests (auth suite only checks 401-vs-not-401).

- **S2 [MEDIUM] Shell injection / fragility in pod-builder git script**
  `packages/operator/src/pod-builder.ts` interpolates `git.url` (:513), `git.ref`,
  `git.parentRef`, `initScript`, `runner.packages` directly into `/bin/sh -c`
  (:319–565), with `eval "${INIT_SCRIPT}"` (:526/:560). No quoting/escaping helper.

- **S3 [MEDIUM] `SettingsPage` fetch omits auth header → silent 401**
  `packages/web/src/client/components/SettingsPage.tsx:388` —
  `fetch("/api/settings/decision-agent-default")` does not pass `authHeaders()`; the
  route sits behind `auth()` (S1), so with auth enabled it 401s and `.catch(() => {})`
  (:393) swallows it — the decision-agent default content silently never loads.

- **S4 [LOW, latent] `/bin/sh` vs bash process substitution**
  `pod-builder.ts:421-481` uses `< <(...)`, unsupported by BusyBox ash (`/bin/sh -c`).

### DEAD CODE (~700+ lines, no production callers — verified via grep)

| Item | Location |
|---|---|
| `backfillStats()` + entire file (~332 lines) | `manager-controller/src/stats-backfill.ts:278` |
| `RunnerAdapter`/`RunnerEvent`/`RunnerMessage` (~47 lines) | `api/src/index.ts:40-86` |
| `getEmbeddings()` (batch path) | `memory-service/src/embed.ts:27` |
| `getServiceNameForRun()` | `web/src/server/kube.ts:64` |
| `optionalAuth()` | `web/src/server/auth.ts:106-122` |
| `patchBoardStatus()`, `fetchNextTaskId()` | `web/src/client/lib/api.ts:288, 354` |
| `buildFacilitationRun`, `buildSuccessReviewRun`, `parseFacilitationResult` | `manager-controller/src/facilitator.ts:49, 124, 574` |
| `spawnTaskWorktreeCleanupPod` | `manager-controller/src/worktree-cleanup.ts:187` |
| `extractLastAssistantText`, `extractAssistantTextWithTimeout` | `manager-controller/src/agent/session.ts:159, 172` |
| `resolveConfig` + `ResolvedConfig` (2 whole files) | `manager-controller/src/reconciler/config-resolver.ts`, `types.ts` |
| `isAgentReady`, `stopAgent` | `manager-controller/src/agent/index.ts:19, 50` |
| `isPVCBound()` | `operator/src/pvc-helper.ts:139` |
| dispatcher `postReply`, `postPermissionReply`, `getPermissions`, `extractLastAssistantText` | `dispatcher/src/session.ts:166, 182, 202, 140` |
| duplicate terminal-phase guard (unreachable) | `operator/src/reconciler.ts:365` |
| unreachable `if (!sawBusy) throw` | `dispatcher/src/polling.ts:583-585` |
| dead effect union members (`CreateRun`, `CreateTask`, `PatchTaskStatus`, `ClearProjectAnnotations`) | `manager-controller/src/reconciler/effects.ts:16-21` |
| CLI `--column` flag on `board task add` (ignored) | `cli/src/board.ts:124, 168-176` |
| CLI `--all-namespaces` (ls/agent), `serverPasswordSecret` | `cli/src/view.ts:18`, `cli/src/submit.ts:47` |
| dead vars: `sessionIds` (`void`), `existing` (pointless round-trip), contradictory branch | `web/.../stats.ts:359`, `web/.../settings.ts:104`, `web/.../SettingsPage.tsx:315-317` |

Plus unused imports (compile only because `noUnusedLocals` off): `decision.ts:7`,
`observations.ts:7`, `effects.ts:9`, `tools.ts:40`.

### CORRECTNESS

- **C1 [HIGH, data integrity] Memory vector rowid desync**
  `memory-service/src/routes.ts:79-93` — `handleStoreMemory` inserts into `memories`
  via Drizzle (auto-rowid), then separately into `vec_memories` with `rowid = null`
  (auto-assigned). The two sequences are not guaranteed aligned. `handleSearch`
  (:114-137) joins `vec_memories.rowid` → `memories.rowid`. After any `DELETE`
  (test fixture's own comment: "DELETE resets the memories rowid counter but not
  vec_memories") search silently returns wrong/empty content. The fixture uses
  `last_insert_rowid()` to stay synced; production does **not**.

- **C2 [HIGH, availability] Transient API error flips healthy task to `failed`**
  `reconciler/observations.ts:35-38` — `getRun(...).catch(() => undefined)` treats
  any fetch failure as "run gone." `decideInitializing` (`decision.ts:260-269`) and
  `decideRunning` (`decision.ts:323-332`) map a missing worker run → `toPhase:
  "failed"`. A momentary observation error during a healthy run marks the task failed.

- **C3 [MEDIUM] Non-deterministic merge/buildgen run names defeat idempotency**
  `decision.ts:742` (and :961/:982) — when no run name is recorded, a random
  `randomBytes(3)` name is minted with `toPhase: undefined`, relying on the status
  patch persisting before the next cycle. If the run is created but the subsequent
  `patchTaskStatus` fails / process dies, the next cycle mints a new random name →
  duplicate merge/buildgen run. "Already exists" guards only protect deterministic
  names (`workerRunName` hash); these don't.

- **C4 [MEDIUM] `set_task_state` → `running` traps the task**
  `agent/tools.ts:1248-1261` — moving a task to `running` sets `runName: undefined`
  and creates no Run; next reconcile observes "worker run missing" and flips to
  `failed` (C2 path). The tool advertises `running` as valid but it's a trap.

- **C5 [LOW] `handleContext` negative "relevance"**
  `memory-service/routes.ts:148-164` — `relevance: 1 - distance` (L2) can go negative
  and isn't cosine similarity; misleading label fed to agents.

- **C6 [LOW, wasteful] Double auto-heal**
  `reconciler/index.ts:27-39` and :63-73 heal missing `status.phase` twice (test
  asserts `toHaveBeenCalledTimes(4)` for 2 tasks).

### FRAGILITY / MAINTAINABILITY

- **F1 [HIGH maintainability] djb2 URL hash duplicated 6× across 5 files**
  `operator/pod-builder.ts:301`, `operator/ttl.ts:103`, `manager-controller/agent/
  tools.ts:670` & `:1435`, `manager-controller/worktree-cleanup.ts:26`, and
  `web/src/server/routes/task-diff.ts:22`. All must produce identical mirror-dir
  hashes (ttl.ts:100 even warns "must match pod-builder"). Change one → cleanup /
  plan reads / diffs silently target the wrong directory.

- **F2 [MEDIUM, pervasive] Error-swallowing conflates 404 with auth/network**
  `try { read } catch { create }` across `operator/reconciler.ts:388,403,434,499`,
  `web/projects.ts` (~15 sites), and `kube` helpers; `agent-resolver.ts:39` drops a
  ClusterAgent permanently on a transient fetch error.

- **F3 [MEDIUM] Unsound `as unknown as Project` casts in effects**
  `manager-controller/reconciler/effects.ts:39,97,119,147,179,246` cast a possibly-
  partial project stub to `Project`. Informers pass bare stubs (`index.ts:129-132,
  169-172`); safe only because the bridge re-fetches. Paired with `metadata.uid!`
  non-null assertions in builders.

- **F4 [MEDIUM] `writePlanToConfigMap` create/replace has no 409 retry**
  `kube/src/index.ts:994,1008` — two `as any` casts; replace path lacks the 409-retry
  loop the status patchers have → lost update / unretried 409.

- **F5 [MEDIUM] `undefined` in merge-patch silently dropped** (documented in AGENTS.md,
  easy to reintroduce). Several status-patch sites rely on correct conditional spreads.

- **F6 [LOW/MED] Misc**: `getDeploymentImages` mis-parses digest-pinned images
  (`kube:1345`, `lastIndexOf(":")` splits inside `@sha256:`); dispatcher
  `incrementalFlush` cursor race with no mutex (`polling.ts:295,649`); no
  `unhandledRejection` handler in operator/dispatcher; brittle abort detection
  `includes("Aborted")` (`dispatcher/index.ts:215`); `RUN_TIMEOUT_SECONDS` injected
  (`pod-builder.ts:846`) but never read; `FacilitationAction` enum duplicated as
  magic-string unions (`facilitator.ts:581,668`, `config.ts:22`); stale comment
  `TaskStatusSchema.column` "never written by new code" is false (`cli/board.ts:201`).

### TEST GAPS (highest value)
- `resolveRunConfig()` 4-level merge precedence (`api:1173`) — untested, 6 call sites.
- kube 409 retry boundary conditions (`patchRunStatus`/`patchProjectStatus`/`patchTaskStatus`).
- `effects.ts` effect execution (only place K8s mutations + unsound casts happen).
- MCP tools (`tools.ts`, 1881 lines, 30 tools) — zero tests.
- memory round-trip **after DELETE** (would catch C1; fixture currently hides it).
- web analytics SQL (`/tool-metrics`, `/trends`, `/metrics-timeseries`).
- web user-vs-admin authz (would catch S1).
- `transitions.test.ts:9-31` completeness test omits `awaiting-children` /
  `awaiting-feature-merge`.

---

## Tasks (candidate BUILD breakdown)

### Phase 1 — Correctness & security (highest priority)

1. **C2 — Distinguish "run not found" from transient errors**
   - `manager-controller/src/reconciler/observations.ts:34-39`: catch only 404
     (return `undefined`), re-throw other errors so the reconcile retries the task
     rather than treating a transient blip as a missing run.
   - Add a unit test in `__tests__/` asserting a 404 → `undefined` while a 500 throws.

2. **C1 — Sync `memories` and `vec_memories` rowids in production**
   - `memory-service/src/routes.ts:79-93`: insert via raw SQL using
     `last_insert_rowid()` (mirror the fixture in `__tests__/routes.test.ts:42-63`)
     so the two rowids always align; or wrap both inserts in one transaction.
   - Add a route test: store → delete → store → search returns correct content.

3. **S1 — Require `adminAuth()` for secrets mutations**
   - `web/src/server/routes/settings.ts`: split routing so
     `POST/PUT/DELETE /secrets*` use `adminAuth()` while reads stay on `auth()`.
   - Extend `web/tests/auth.test.ts` to assert user-token is rejected (403) on the
     secrets mutating endpoints while admin-token passes.

4. **S3 — Send auth header from SettingsPage**
   - `web/src/client/components/SettingsPage.tsx:388`: pass `authHeaders()` to the
     `decision-agent-default` fetch; stop swallowing a non-OK response silently.

5. **C4 — `set_task_state` → `running` should not strand the task**
   - `manager-controller/src/agent/tools.ts:1248-1261`: either create a Run for the
     `running` target (like `create_run`) or reject `running` as an invalid manual
     target with a clear error directing to `create_run`/`force_retry`.

6. **C3 — Deterministic aux run names**
   - `decision.ts:742,961,982`: derive merge/buildgen run names deterministically
     (hash of `{project, task, kind, retryCount}`) like `workerRunName`, so the
     "already exists" guard makes re-creation idempotent across crashes.

### Phase 2 — Fragility hardening

7. **F1 — Extract one shared `mirrorHash`/`urlHash` helper**
   - Add to `@percussionist/api` (or `@percussionist/kube`) and replace all 6 copies:
     `operator/pod-builder.ts:301`, `operator/ttl.ts:103`,
     `manager-controller/agent/tools.ts:670` & `:1435`,
     `manager-controller/worktree-cleanup.ts:26`, `web/.../task-diff.ts:22`.
   - Add a unit test pinning the hash output for a known URL.

8. **F4 — Add 409 retry to `writePlanToConfigMap`** and remove the two `as any`
   casts (`kube/src/index.ts:994,1008`).

9. **S2 — Shell-escape interpolated git values** in `operator/src/pod-builder.ts`
   (quote `git.url`/`git.ref`/`git.parentRef`; pass via env where feasible).

10. **F6 — Targeted small fixes**: digest-aware image parse (`kube:1345`);
    add `process.on("unhandledRejection")` to operator + dispatcher entrypoints;
    delete dead `RUN_TIMEOUT_SECONDS` wiring or actually consume it; fix stale
    `column` comment.

### Phase 3 — Dead code removal

11. **Remove dead code** per the table above (start with `stats-backfill.ts`,
    `RunnerAdapter` block, `config-resolver.ts`/`types.ts`, dead session/facilitator
    exports, CLI dead flags). Delete the dead `ReconcileEffect` union members and
    their unreachable executor branches.

12. **Enable `noUnusedLocals` + `noUnusedParameters`** in `tsconfig.base.json` after
    the sweep, then fix any newly-surfaced unused imports/vars. (Do this last so it
    catches regressions going forward.)

### Phase 4 — Tests

13. **Add unit tests**: `resolveRunConfig` precedence (`api`); kube 409 retry
    boundary; `transitions.test.ts` completeness for the two missing phases;
    `effects.ts` happy-path + transition-drift guard.

14. **Add web server tests**: user-vs-admin authz matrix (covers S1); a smoke test
    for the analytics SQL endpoints returning well-formed shapes.

## Validation

- `pnpm typecheck` and `pnpm test` must pass after every task (pre-commit hook
  enforces both).
- For reconciler changes, run the existing `manager-controller` Bun suite.
- No E2E required for these unit-level fixes, but `pnpm e2e:core` is advisable
  before merging C2/C3/C4 since they touch run lifecycle.

## Acceptance criteria

1. C1–C4 fixed with a regression test for each (the memory round-trip-after-delete
   test fails on `main` and passes after the fix).
2. Secrets mutations require admin; `auth.test.ts` proves user-token is rejected.
3. SettingsPage loads the decision-agent default with auth enabled.
4. A single shared hash helper backs all former 6 copies; pinned by a test.
5. Listed dead code is removed; `pnpm typecheck`/`pnpm test` stay green;
   `noUnusedLocals` is enabled with no violations.

## Risks / open questions

1. **C2 retry semantics**: re-throwing on non-404 re-enqueues the whole project for
   that cycle (one poison task can stall siblings — see `reconciler/index.ts:138`).
   Consider per-task error isolation as a follow-up.
2. **C3 name change**: deterministic aux names alter run-name format; confirm no
   external consumer parses the old `randomBytes` suffix.
3. **S1 split**: confirm the web UI uses an admin token for secrets management (it
   should, since other mutations already require admin).
4. **Dead-code deletion**: a couple of "dead" exports are test-only seams
   (`resetState`, `closeDb`, `stopMetricsCollector`) — keep those; only remove items
   in the table with zero callers including tests.
