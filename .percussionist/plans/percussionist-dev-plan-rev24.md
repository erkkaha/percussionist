# Plan: Test coverage for the paths where the bugs actually live — reconcile loops, kube write helpers, dispatcher polling

Task: `percussionist-dev-plan-rev24`

## Context

The review found a consistent blind spot: **pure functions are tested; API interaction and state-machine paths are not** — and every high-severity bug from the batch lived in those untested paths. This plan adds unit/smoke-tier tests (deterministic, no cluster) for exactly those paths, plus regression tests for each bug the review batch fixed or surfaced.

### Current coverage state (verified against `main` @ 0ef6eed)

**`packages/operator`** — existing tests: `pod-builder.test.ts`, `code-server.test.ts`, `adapters/*.test.ts` (renderers), `reconciler.test.ts` (250 lines: terminal-run dequeue branch, `dequeue()`, `classifyProjectReconcileError`, `hasReconcileStatusChanged`, `projectKey`), `ttl.test.ts` (110 lines: `isExpired`, `buildCleanupJob`), `index.test.ts` (`handleRunDelete`).
**Missing:** the non-terminal `reconcile()` path (service/ConfigMap/PVC/pod creation sequence), the **Succeeded/Failed asymmetry** (`reconciler.ts:645-663`: pod `Failed` → operator claims `RunPhase.Failed` + cleans up; pod `Succeeded` → cleanup only, no terminal claim — so a dispatcher that dies after the pod succeeds leaves the run non-terminal and the next resync recreates the pod and re-runs the task), the **queue/dirty/requeue semantics** (`enqueue`/`dequeue`/`runWorker`/`dirty`, `reconciler.ts:766-844`), `run-key-client.ts`, `agent-resolver.ts`, `pvc-helper.ts`, and `runTTLCleanup`/`spawnWorktreeCleanupJob` (`ttl.ts:79-107, 195-210`).

**`packages/manager-controller`** — `reconciler/__tests__/decision.test.ts` (2156 lines) is extensive, but the non-happy paths are thin:
- `decideWaitingForInput` (`decision.ts:495-513`): with an **answer present but the worker run terminated or deleted** (phase ≠ `Running`) it returns a no-op — task parks in `waiting-for-input` forever with no timeout/escalation. Untested.
- `decideGeneratingBuilds` (`decision.ts:1168+`): **stale/failed buildgen run** → `awaiting-human` + `buildTasksFacilitatorRun: null` (`BuildGenFailed`) is untested (only the "no run name", "succeeded", "succeeded but no children" branches have tests).
- The `reconcileProject` loop (`reconciler/index.ts:19-133`): **poison-task isolation** (one task whose observe/decide/executeEffects throws must not starve the rest of the board) and **findings-ingestion failure tolerance** are untested at loop level.
- The impossible-wait deadlock (awaiting-children `mergedAt` gate) was fixed in rev02 — regression tests now exist (`decision.test.ts:712, 890, 922`). The plan adds one explicit "no no-op branch survives" guard test so the deadlock cannot silently return.
- Closed-PR handling (`decision.ts:1714-1715`: `closed + no mergedAt → awaiting-human`) is already tested (`decision.test.ts:1214`); no new work needed there beyond confirming coverage.

**`packages/kube`** — `__tests__/findings-cm.test.ts` covers the **parsers and key constructors only**. **Writes are untested:** `writePlanToConfigMap` (`index.ts:1200`), `appendFindingToConfigMap` 404→create fallback (`index.ts:1331-1370`), `patchFindingsConfigMap`, `getFindingsConfigMap`, the **409 retry/backoff loops** in `patchRunStatus`/`patchRunAnnotations` (`index.ts:301-381`), and `execInWorkspace` (`index.ts:1834`). This is the same blind spot the postmortem comment at `index.ts:1283-1291` describes (the ConfigMap-key 422 bug — every write 422'd and no test asked the API server to accept a key; only the *parse* side was covered).

**`packages/dispatcher`** — `__tests__/` has `token-aggregator.test.ts`, `mcp-server.test.ts`, `report-finding.test.ts` only. **`pollStatus` (closure inside `runPrompt`, `polling.ts:789-930`), `runPrompt` (`629-1184`), `runInteractive` (`355-574`), `FatalRunError` escapes, and the `Promise.race` completion/failure paths (`1111-1183`) have zero tests.** Two named bugs from the batch:

1. **Unreachable zero-token guard** — `sawBusy = true` is set at `polling.ts:831` before the guard `if (!sawBusy) throw new FatalRunError('opencode produced an assistant response with zero token usage…')` at `877-882`. `!sawBusy` can never be true when the guard is reached → dead code. A first assistant message with zero tokens silently falls through to `waitingForInput` instead of failing the run. No test ever fed a scripted zero-token stream, so it survived.
2. **Snapshot-less hard-timeout exit** — the `hardTimeout` guard (`polling.ts:1051-1059`) calls `process.exit(0)`/`process.exit(3)` directly when `HARD_TIMEOUT_MS` (65 min) elapses: **no session snapshot, no `sendStats`, no `RunPhase.Failed` patch** — exactly the failure mode `FatalRunError` was introduced to prevent (see the comment at `polling.ts:19-33`). The manager is left with no context and a run stuck in `Running`.

### Existing test seams (what to build on)

- `spyOn(CoreV1Api.prototype, …)` already works in `operator/src/reconciler.test.ts` — prototype/instance spies on the lazy singleton clients are an established pattern.
- Manager tests use `spyOn(kube, 'listTasks' | 'patchTaskStatus' | …)` (`reconcile.test.ts`) plus `reconciler/__tests__/fixtures.ts` (`makeProject`/`makeTask`).
- Dispatcher tests use `mock.module('@percussionist/kube', …)` (`mcp-server.test.ts`).
- kube CRUD helpers already accept an optional `client = custom()` param (`index.ts:259-300`) — the convention to extend to the write helpers.

## Approach

### 1. Thin fake kube-client layer (per package, no monorepo surgery)

Introduce a small recording fake, installed via `spyOn`, that intercepts the exact method subset each code path calls and answers from a script table with scripted **failures: 404 / 409 / 429 / 5xx**, plus a recorded call log. Design:

- **Shape**: `installFakeKube(script: FakeKubeScript): { calls: KubeCall[]; restore(): void }` where `FakeKubeScript = Record<methodName, ScriptedResponse | ScriptedResponse[]>` and `ScriptedResponse = { value?: unknown } | { error?: Error } | { once: … }`.
- **kube package**: installs on the `core()` / `custom()` singleton instances (`spyOn(core(), 'patchNamespacedConfigMap')` etc.) — no production change needed for most helpers; add optional `client`/`getProjectFn` params only where the code has no seam (`execInWorkspace`, see Task 2).
- **operator package**: installs on `CoreV1Api.prototype`/`CustomObjectsApi.prototype` (matches `reconciler.test.ts` precedent) for the method set used by `reconcile()`/`runWorker`/`safeReconcileProject`/`ttl`.
- **manager package**: no fake client needed — the loop already calls `@percussionist/kube` functions; keep `spyOn(kube, …)` and extend the scenario table.
- Duplication is deliberate (≈120 lines × 2 packages): avoids adding a workspace package, Docker image surface, or dependency-order churn for test-only code. Consolidation into a shared `@percussionist/test-kube` package is a follow-up if it earns its keep.

### 2. Behavior-preserving test seams (small, gated refactors)

Production behavior must not change; the seams are defaults that tests override:

- **`execInWorkspace`**: add optional `client = core()` and `getProjectFn = getProject` params (same convention as the file's existing `client = custom()` helpers) so the pod-lifecycle poll and the project-override lookup are stubbable.
- **`runWorker`/`enqueue`/`dequeue`** (`operator/src/reconciler.ts:766-838`): extract the single-iteration body into an exported `runWorkerOnce(): Promise<boolean>` (processes one key or sleeps 250ms) and have `runWorker` loop over it; inject the 250ms idle sleep and the 5s error-requeue `setTimeout` as `delay`/`scheduleRequeue` params (defaults = current `setTimeout`). Enables queue-semantics tests without spawning the infinite loop.
- **`run-key-client.ts`**: the module-level `authEnabledPromise` cache (line 77) must be resettable for tests — export a `__resetForTests()` (or convert to a mutable export) and stub `fetch` via `mock.module('node:fetch')`/global fetch mock; `WEB_STATS_URL`/`WEB_AUTH_TOKEN` come from `config.ts` env vars the test sets in `beforeEach`.
- **dispatcher `pollStatus` extraction**: lift the closure at `polling.ts:789-930` into an exported `runPollStatusLoop(deps)` where `deps = { fetchMessages, checkHealth, patchStatus, sleep, now, isShuttingDown, sessionID, constants: { pollMs, firstResponseTimeoutMs, settleMs, idleTimeoutMs, healthFailThreshold } }` and `runPrompt` calls it with the real implementations (currently `fetchMessages`/`checkHealth` come from `session.ts`, `sleep` is passed in, `Date.now()` inlined — all become injectable). Same for `runPrompt`: add an optional `deps` param with `{ postMessage, fetchMessages, checkHealth, sleep, now, patchStatus }` defaulting to today's code. No constant changes.

### 3. Regression tests for the review-batch bugs (priority order)

1. **Dispatcher**: scripted-stream tests that would have caught the unreachable zero-token guard and the snapshot-less hard-timeout exit — **and fix both guards** as part of the BUILD tasks (the tests must pass):
   - Zero-token fix: move `sawBusy = true` to *after* the zero-token check (or drop the `!sawBusy` condition) so a zero-token first assistant response throws `FatalRunError`.
   - Hard-timeout fix: replace `process.exit` in the timeout guard with a thrown `FatalRunError` (or a rejected signal the race observes) so `main()`'s catch does the normal snapshot/stats/`Failed` work; the run must never exit without a snapshot. Keep exit codes only for genuinely unhandled top-level cases in `index.ts`.
2. **kube**: write-path tests for the findings 404→create fallback and the ConfigMap-key contract (`inbox.<id>.json`) that the 422 bug violated, plus the 409 retry loops and `execInWorkspace` lifecycle.
3. **operator**: `reconcile()` table-driven scenarios pinning the Succeeded/Failed asymmetry, queue/dirty/requeue semantics, and `safeReconcileProject` retry/backoff classification.
4. **manager**: `waiting-for-input` with terminated/deleted run, failed buildgen, poison-task isolation, and the awaiting-children "no impossible wait" guard.

### 4. Bug-or-behavior decisions (flag to reviewer/facilitator, don't silently fix)

- **Succeeded pod-phase asymmetry** (`reconciler.ts:645-663`): pin as documented behavior (dispatcher owns terminal phases; only Failed is claimed because re-running burns tokens) **or** fix to claim Succeeded too. Default in this plan: pin with a test that documents the asymmetry and its token-burn consequence; open question for the reviewer.
- **`waiting-for-input` + terminated run** (`decision.ts:495-513`): currently a permanent no-op. Default: add tests pinning the current behavior AND file the deadlock as a separate finding for a follow-up fix (or fix within the task if the facilitator approves — see Risks).

## Scope boundaries

- **In scope**: unit/smoke-tier tests only (`bun test` per package); deterministic, model-agnostic, no cluster access; production changes limited to the seams in Approach §2 and the two dispatcher guard fixes in §3.1.
- **Out of scope**: E2E tests, web package, CLI package, memory-service, new CRDs/schemas, performance work, and any behavior change outside the enumerated fixes.
- **Testing rules** (from AGENTS.md): assert only on status fields and recorded call sequences — never on LLM prose; every test must run in <1 min total per package; no test may depend on test-file execution order (run with `bun test --isolate` where module-global mocks are used).

## Tasks / BUILD task breakdown

All BUILD tasks target `@percussionist` packages; agent: `builder`. Each task must pass `pnpm typecheck`, `pnpm lint`, and its package's `bun test` before review.

### BUILD 1 — Fake kube-client test helper (foundation)
- Files: `packages/kube/src/__tests__/helpers/fake-kube.ts`, `packages/operator/src/test-helpers/fake-kube.ts`.
- Implement `installFakeKube(script)` → `{ calls, restore }` as described in Approach §1: method-name→scripted-response map, `once` sequences, recorded call log (`{ method, args }`), failure injection (404/409/429/500).
- For kube: installs on the `core()`/`custom()` singletons; for operator: installs on `CoreV1Api.prototype`/`CustomObjectsApi.prototype`/`AppsV1Api.prototype`/`NetworkingV1Api.prototype` with the method subset used by `reconcile()`/`runWorker`/`ttl`.
- Include a self-test file proving recording + scripted failure + restore work.
- Acceptance: helper + self-tests typecheck/lint/pass; no production code touched.

### BUILD 2 — kube write-path regression tests (`packages/kube/src/__tests__/writes-*.test.ts`)
- `writePlanToConfigMap`: create path (no existing CM → `createNamespacedConfigMap` with `{task}.md` key), replace path (existing CM with `resourceVersion` → `replaceNamespacedConfigMap`), size-warning threshold, merged data preserves existing keys.
- `appendFindingToConfigMap`: patch fast path (merge-patch body carries `data["inbox.<id>.json"]` + labels), **404 → create fallback** (assert create body key/labels — regression for the 422 ConfigMap-key bug at `index.ts:1283-1291`), **non-404 → rethrow**, and the `inboxFindingKey` charset contract end-to-end (a write body key must always match `[-._a-zA-Z0-9]+`).
- `getFindingsConfigMap` (404→null, non-404 throws), `patchFindingsConfigMap` (merge-patch with `null` deletions).
- `patchRunStatus`/`patchRunAnnotations`: 409 → retry with backoff (assert attempt count via recorded calls; assert delay via injected sleep), success on 2nd attempt, 409 exhaustion → throws, non-409 (e.g. 404/500) → immediate throw, no retry on 429 (pin current behavior).
- `execInWorkspace`: pod create body (name sanitization/63-char cap, PVC claim from `spec.data.pvcName` or `{project}-data`, mountPath, image precedence `imageOverride > spec.exec.image > DEFAULT_EXEC_IMAGE`); poll loop Succeeded → exitCode + logs; Failed → exitCode; readNamespacedPod throws → break with logs-unavailable; deadline timeout; project-not-found → defaults; delete best-effort (non-404 errors swallowed).
- Small refactor: add optional `client`/`getProjectFn` params to `execInWorkspace` (Approach §2).
- Acceptance: all write helpers have ≥1 failure-path test; findings 404→create and key-charset regressions present.

### BUILD 3 — operator queue/dirty/requeue semantics (`packages/operator/src/queue.test.ts`)
- Refactor `runWorker` → `runWorkerOnce` + loop with injectable `delay`/`scheduleRequeue` (Approach §2).
- Tests: `enqueue` (new key queued once; duplicate not re-queued; while `processing` → `dirty` only); `dequeue` (removes from queue/pending/processing/dirty/seen; idempotent); `runWorkerOnce` success (fresh GET via `co.getNamespacedCustomObject` → `reconcile` called); reconcile throws 404 → `dequeue`; reconcile throws transient → `scheduleRequeue` invoked (assert callback re-enqueues after delay, and `enqueue` during the 5s window marks dirty, not duplicate); `finally` dirty → re-enqueue; key with no `seen` entry → skipped; missing ns/name split → uses cached run.
- `startPeriodicResync` — assert the interval callback enqueues all `seen` (invoke the callback once via injected interval or `setInterval` spy).
- Acceptance: queue semantics fully covered with scripted `co` responses; no infinite loop spawned in tests.

### BUILD 4 — operator `reconcile()` + `safeReconcileProject` table-driven scenarios (`packages/operator/src/reconciler-flow.test.ts`)
Drive `reconcile()` with the BUILD-1 fake, table style (input Run + script → expected recorded calls + status patches):
- Non-terminal happy path: Service create, opencode-config sync, agents CM create, PVC ensure, Pod create, `Initializing` status patches (podName/serviceName), pod-phase mirror (`podPhase` patch when changed).
- **Succeeded/Failed asymmetry** (pin): pod `Failed` → run phase claimed `Failed` + `cleanupChildResources`; pod `Succeeded` → cleanup only, run phase untouched (documented consequence: non-terminal run + deleted pod → pod recreated next resync; add a follow-up finding if reviewer confirms it's a bug).
- Missing ClusterAgents → `Initializing` warning message, run proceeds; `ValidationError` (credentials) → `Failed` patch, no pod created; PVC failure → `Failed` patch + rethrow; pod create `already exists` → re-read existing; service/CM create `already exists` → tolerated; terminal run + pod exists → cleanup; terminal run + pod 404 → dequeue (existing behavior, now in the table).
- `safeReconcileProject`: success → `status.reconcile` Ready + generation (skip when unchanged — `hasReconcileStatusChanged`); transient error → `Error` status + 30s `scheduleProjectRetry` (assert single timer, cancel on next event); permanent 4xx → `Error` status, **no** retry.
- Regression anchor: terminal-cleanup dequeue behavior must keep passing (existing `reconciler.test.ts` untouched or folded into the table).
- Acceptance: every branch of `reconcile()` exercised; Succeeded/Failed asymmetry pinned by name in a test title.

### BUILD 5 — operator unit gaps: run-key-client, agent-resolver, pvc-helper, ttl
- `run-key-client.test.ts`: mint when auth-disabled (health returns `authDisabled: true`) → null, no HTTP; no `WEB_AUTH_TOKEN` → null + warn-once; HTTP non-2xx → null; body without `key` → null; success → key; `revokeRunKey` best-effort (errors swallowed, HTTP error logged). Reset the `authEnabledPromise` cache between tests (Approach §2).
- `agent-resolver.test.ts`: resolves ClusterAgents, records missing, inline overrides ClusterAgent of same name, inline appended when no duplicate.
- `pvc-helper.test.ts`: exists → returned (no create); 404 → create with ownerReference/labels/accessMode/size/storageClass; create 409 → read-back and return; non-404 read/create → rethrow.
- `ttl-flow.test.ts`: `runTTLCleanup` deletes expired terminal runs only (scripted list + delete), tolerates 404 on delete, logs count; `fetchRunTTLDays` fallback to 7 on ClusterSettings missing/error; `spawnWorktreeCleanupJob` skips when no project label and no pvcName, tolerates 409, propagates non-409.
- Acceptance: each of the four files has failure-path coverage; run-key tests don't touch the network (fetch fully stubbed).

### BUILD 6 — manager non-happy-path regression tests
- `decision.test.ts` additions:
  - `waiting-for-input`: answer + run `Succeeded`/`Failed`/deleted → pin current no-op behavior and mark the deadlock in a comment/finding (see Risks); answer + run `Running` → `running` (existing); no answer → no-op (existing).
  - `generating-builds`: buildgen run `Failed` → `awaiting-human` + `worker.buildTasksFacilitatorRun: null` (`BuildGenFailed`); buildgen run missing but name set → no-op wait; buildgen `Succeeded` with children → `awaiting-children` (already partially covered — complete the table).
  - `awaiting-children`: add an explicit guard test — for every flow configuration, a `done` child without `mergedAt` and without `abandoned` must **never** yield a no-op (regression for the rev02 impossible-wait deadlock); escalate to `awaiting-human` (`ChildrenDoneWithoutMerge`).
- `reconcile.test.ts` additions (loop level, spyOn kube module): **poison-task isolation** — one task whose `observe` or `executeEffects` throws does not prevent the next task's transition or findings ingestion; heal-failure tolerated; `listTasks` 429 → loop survives to next cycle; `patchTaskStatus` 409 on heal → tolerated.
- Acceptance: the four named non-happy paths have named tests; deadlock guards assert no no-op branch.

### BUILD 7 — dispatcher: extract `pollStatus` + scripted-stream tests (`packages/dispatcher/src/__tests__/poll-status.test.ts`)
- Refactor (Approach §2): export `runPollStatusLoop(deps)`; `runPrompt` uses it. No behavior change; keep `token-aggregator` tests green.
- Table-driven tests with scripted `fetchMessages` message streams + scripted `now`/`sleep`:
  - first assistant message → `sawBusy` set, usage recorded, no premature settle;
  - completed assistant message + `completingSince` ≥ `SETTLE_MS` → loop terminates (settle path);
  - **zero-token first assistant message → `FatalRunError` (regression for the unreachable guard — fix guard in this task, see Approach §3.1)**;
  - idle timeout: `waitingForInput` + `idleSince` ≥ `IDLE_TIMEOUT_MS` → terminate;
  - `needsHumanInput` flip → `patchStatus({ phase: WaitingForInput })` then back to `Running`;
  - health check fails ×3 → `FatalRunError`;
  - no first response within `firstResponseTimeoutMs` → `FatalRunError`;
  - MessageAbortedError on last message → `waitingForInput` + `needsHumanInput`;
  - non-abort `session error:` → rethrown (not swallowed);
  - transient `fetchMessages` rejection → swallowed, loop continues.
- Acceptance: settle/idle/waiting/FatalRunError transitions each have a named test; the zero-token regression fails on pre-fix code.

### BUILD 8 — dispatcher: `runPrompt` race-path tests + hard-timeout fix (`packages/dispatcher/src/__tests__/run-prompt.test.ts`)
- Drive `runPrompt` with injectable deps (`postMessage`, `fetchMessages`, `checkHealth`, `sleep`, `now`, `patchStatus`, `coreApi` snapshot stub, signals):
  - `completionSignal` resolves → `Succeeded` status patch with summary, `sendStats` Succeeded, snapshot called, returns `{sessionID, startedAt}`;
  - `failureSignal` resolves → throws `session error: agent signalled failure — …`;
  - `planSignal` resolves → `Succeeded` with plan summary;
  - abort (MessageAbortedError in race) → stays `Running`, `waiting for input (message aborted)` patch, stats recorded as Running;
  - raceError path → `sendStats` Failed with message + rethrow;
  - promptPost retry: ECONNRESET → retry with 5s sleep; session already has messages → skip re-POST; 3 retries exhausted → throw; non-retryable error → throw immediately;
  - **hard-timeout regression**: `HARD_TIMEOUT_MS` elapsed without first response / while waiting — replace `process.exit` in the guard (`polling.ts:1051-1059`) with a thrown `FatalRunError`/rejected signal so the run exits via the normal snapshot→stats→Failed path; test asserts snapshot + `sendStats` + `patchStatus Failed` happen and no `process.exit` path is reachable from `runPrompt` (stub `process.exit` and assert it is never called).
- `runInteractive` (lower priority): smoke test — session discovery patches `sessionID`, snapshot on first `session.idle`.
- Acceptance: all five race outcomes + retry matrix + hard-timeout regression have named tests; hard-timeout test fails on pre-fix code.

### BUILD 9 — verification & CI pass
- Run `pnpm typecheck`, `pnpm lint`, `pnpm test` from repo root; confirm each new test file is picked up by the existing per-package `bun test src/` scripts (no script changes expected) and the full suite stays < 1 min.
- Confirm `bun test --isolate` for any file using `mock.module`/global mocks (AGENTS.md requirement for the web suite applies to dispatcher tests using module-global stubs).
- Update `docs/testing-strategy.md` only if the fake-kube helper pattern is worth documenting (optional).
- Acceptance: green CI-equivalent local run; no flaky order-dependent tests.

## Acceptance criteria (overall)

1. Every named bug path has a **named regression test that fails on pre-fix code** and passes after:
   - unreachable zero-token guard (dispatcher),
   - snapshot-less hard-timeout exit (dispatcher),
   - findings ConfigMap-key 422 (kube write path),
   - awaiting-children impossible wait (manager guard test),
   - Succeeded/Failed asymmetry (operator, pinned),
   - waiting-for-input terminated-run deadlock (manager, pinned + finding).
2. `reconcile()` (operator), `reconcileProject` loop (manager), `writePlanToConfigMap`/`appendFindingToConfigMap`/`patchRunStatus`/`execInWorkspace` (kube), and `pollStatus`/`runPrompt` (dispatcher) each have table-driven scenario coverage with scripted failures 404/409/429/5xx.
3. All tests are deterministic, model-agnostic, cluster-free; `pnpm test` < 1 min; typecheck + lint clean.
4. Production behavior changes are limited to the enumerated seams (Approach §2) and the two dispatcher guard fixes; nothing else in the diff touches runtime behavior.

## Risks / open questions

1. **Dispatcher extraction is the riskiest change** — lifting `pollStatus` out of `runPrompt` could subtly alter timing/state capture. Mitigation: pure extraction with default-wired deps, keep all constants identical, rely on existing `token-aggregator`/`mcp-server` tests plus the new suite; typecheck + lint gates.
2. **Timer-based assertions** — bun:test has no fake timers; all timing must flow through injected `sleep`/`now`/`scheduleRequeue`/`scheduleProjectRetry` deps. Any production site still calling `setTimeout`/`Date.now()` directly in a tested path must gain a seam in the same BUILD task.
3. **Succeeded pod-phase asymmetry — fix or pin?** The review flags it; the plan pins it by default because "claim Succeeded" would change terminal-state ownership that the dispatcher already handles, and the failure mode (re-run burning tokens) only occurs when the dispatcher dies between pod success and status patch. Route to reviewer: if a fix is approved, the same BUILD-4 table gains a "pod Succeeded + dispatcher dead → operator claims Succeeded" case.
4. **`waiting-for-input` + terminated run deadlock** — decideWaitingForInput no-ops when the run is not `Running`, so an answered question can never resume a run that terminated. Pinning the current behavior + filing a finding is the default; if the facilitator prefers a fix, it belongs in BUILD 6 (transition to `failed` or schedule a fresh run) with tests updated accordingly.
5. **`authEnabledPromise` module cache** (run-key-client) — tests must reset it; a `__resetForTests` export is the least invasive option and is flagged as a test-only surface.
6. **Fake kube duplication across packages** — accepted (Approach §1); if the pattern grows a third consumer, consolidate into a shared test package in a follow-up plan.
7. **Closed-PR paths** are already tested (`decision.test.ts:1214, 1245`); do not duplicate — verify and move on.
