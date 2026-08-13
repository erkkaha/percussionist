# Plan: Dispatcher resilience — retryable completion authorization, notification-path crash, search_code hardening, zero-token guard verification

Task: `percussionist-dev-plan-rev08`

## Context

Four dispatcher robustness items were reported. Verified against current `main`
(the task's line numbers were stale — they match an older revision around commit
`29eccdb`; current line numbers are used throughout):

### Bug 1 (PRIMARY) — one transient ClusterAgent lookup failure permanently disables completion tools

`startMcpServer` caches the completion authorization for the process lifetime
(`packages/dispatcher/src/mcp-server.ts:1506-1510`):

```ts
let completionAuthPromise: Promise<CompletionAuthorization> | undefined;
const getCompletionAuth = (): Promise<CompletionAuthorization> => {
  completionAuthPromise ??= resolveCompletionAuthorization();
  return completionAuthPromise;
};
```

`resolveCompletionAuthorization` (`mcp-server.ts:947-984`) converts **any** error
from `getClusterAgent` into a definitive denial:

```ts
} catch (e) {
  return {
    context, allowedTool, requiredCapability,
    allowed: false,
    denialReason: `failed to resolve cluster agent "${agentName}": ${(e as Error).message}`,
  };
}
```

The k8s client has **no retry** (`packages/kube/src/index.ts:165-174`
`makeNodeApiClient`, `getClusterAgent` at `:465-472`), so a transient apiserver /
DNS blip at pod start rejects the lookup. The denial is then cached forever:

- `tools/list` (`mcp-server.ts:1158-1183`) hides `complete_run` / `complete_plan`
  / `complete_review` / `complete_merge` for the rest of the run.
- `tools/call` (`mcp-server.ts:1186-1206`) rejects them with
  `"completion tool ... is not allowed"`.

The agent does all its work, can never signal completion, and the run ends
`Failed` with `session ended without completion signal`
(`packages/dispatcher/src/polling.ts:1381-1384`).

**Related gap in the same function:** `inferRunCompletionContext`
(`mcp-server.ts:913-945`) swallows `getRun`/`getTask` errors and falls back to
`build-worker`. `RUN_CONTEXT` is only injected for merge and facilitation runs
(`packages/manager-controller/src/worker-builder.ts:543,741`,
`packages/operator/src/pod-builder.ts:1075`) — normal PLAN/BUILD worker runs
depend on inference. A PLAN run whose inference hits a transient error at pod
start permanently caches the wrong context (`build-worker`), so it is gated for
`complete_run`/`run.complete.build` instead of `complete_plan` — same stranded-run
outcome even when `getClusterAgent` succeeds.

### Bug 2 — fire-and-forget notification handler can kill the dispatcher

`mcp-server.ts:1533` dispatches id-less JSON-RPC notifications with no `.catch()`:

```ts
handleMcp(rpc, onFailRun, onCompleteRun, onCompletePlan, getStatus, getCompletionAuth); // side-effects only
```

`packages/dispatcher/src/index.ts:58-61` turns any unhandled rejection into
`process.exit(1)`. A notification-shaped request whose handler rejects (e.g. a
malformed `tools/call` without an id whose `search_code` arg makes ripgrep exit 2,
see Bug 3) kills the dispatcher mid-run.

### Bug 3 — `handleSearchCode` has no try/catch around the rg/grep subprocess

`mcp-server.ts:535-556` runs `execCommand('rg', ...)` / `execCommand('grep', ...)`
unprotected. `execCommand` (`mcp-server.ts:447-476`) only tolerates exit code 1
(no matches); **exit 2** — invalid regex (`[`), unreadable path — rejects. In the
normal `tools/call` path the rejection surfaces as an HTTP 500 via the request
handler's `.catch` (`mcp-server.ts:1545`); combined with Bug 2 it can also crash
the process. The agent gets no actionable message either way.

### Bug 4 — "zero-token fast-fail guard is dead code" — **already fixed; residual race remains**

The task's line numbers (`830-831` vs `877-882`) match the pre-fix code at commit
`29eccdb`, where the guard was `if (!sawBusy) { … zero token … }` while
`sawBusy = true` was set earlier in the same iteration — genuinely unreachable.
Commit `21a949a` ("extract runPollStatusLoop with scripted-stream tests") dropped
the `!sawBusy` condition, added the regression comment at
`polling.ts:855-859` and a passing test (`__tests__/poll-status.test.ts:157-166`).
All 87 dispatcher unit tests pass today.

**Residual race (unverified):** the guard (`polling.ts:852-862`) is gated on
`!state.waitingForInput`, but the SSE handler sets `waitingForInput = true` on
every `session.idle` event (`polling.ts:1164-1176`), which fires after **every**
completed turn; `needsHumanInput` is only set by `permission.updated`
(`polling.ts:1180-1182`). If the `session.idle` SSE event beats the next 2 s poll
tick, a zero-token first response skips the guard and parks the run, burning the
full 15-minute idle timeout (`IDLE_TIMEOUT_MS = 900_000`, `polling.ts:121`) before
failing. Needs confirmation before changing behavior (see Task 7).

## Approach

### Fix 1 — make authorization resolution retryable; cache only definitive outcomes

Split "transient lookup failure" from "definitive denial":

1. **Definitive, cacheable** (unchanged semantics):
   - `allowed: true` after a successful `getClusterAgent` with the required
     capability.
   - Capability missing **from a successfully fetched ClusterAgent**
     (`mcp-server.ts:962-973`).
   - `RUN_AGENT` env missing (`mcp-server.ts:951-960`) — set by the operator at
     pod build time and immutable for the pod's life.
2. **Transient, never cached**:
   - `getClusterAgent` throws → rethrow as a `TransientAuthError` instead of
     returning a denial.
   - Context inference fell back to the default due to a k8s error (only possible
     when `RUN_CONTEXT` is unset) → rethrow as `TransientAuthError`.

The cache layer (`getCompletionAuth` in `startMcpServer`) clears
`completionAuthPromise` when the resolution promise rejects, so the **next** tool
call retries the lookup. Extract the cache into a small exported factory
(`createCompletionAuthCache`) so the retry semantics are unit-testable without an
HTTP server.

### Fix 2 — graceful degradation in `handleMcp`

`tools/list` and `tools/call` catch `TransientAuthError`:

- **`tools/list`**: log a warning and return the tool list with the completion
  tools **included optimistically** (see Risks). Rationale: the MCP client
  (opencode) lists tools once at session start and this transport has no
  server→client stream to push `notifications/tools/list_changed` (the server
  only handles `POST /mcp`, `mcp-server.ts:1512-1550`). Hiding the tools on a
  transient error would re-create the reported symptom at the client's cache even
  though the server cache is fixed. The authoritative gate stays at `tools/call`.
- **`tools/call`** (completion tools only): return a retryable protocol error
  (code `-32000`) — `"completion authorization check failed transiently: <msg>;
  please retry the tool call"` — instead of the permanent `-32602` "not allowed"
  denial. Once a definitive outcome is cached, today's exact behavior resumes.

### Fix 3 — notification path cannot crash the process

Attach `.catch(...)` to the fire-and-forget `handleMcp` call at
`mcp-server.ts:1533` (log-and-continue). `index.ts:58-61` stays as the last-resort
safety net — the root causes are fixed, not the net removed.

### Fix 4 — `handleSearchCode` returns structured errors

Wrap the rg/grep execution in try/catch and return a structured tool result
(`{ error: 'search failed', query, detail, exitCode }`, matching the existing
`{ error: 'query is required' }` style at `mcp-server.ts:503-507`) so the agent
can fix its query. Exit 1 (no matches) behavior unchanged.

### Fix 5 — zero-token guard residual (verify-first)

Confirm the `session.idle` → `waitingForInput` race masks the guard in production
(`polling.ts:1164-1176` vs `:852-862`). If confirmed, re-gate the guard on
`needsHumanInput` (real permission prompt) instead of `waitingForInput`
(session-idle parking), so the first zero-token completed message fails fast
unless a person is genuinely needed. Guard constraints: must never fire for
aborted messages (`MessageAbortedError` sets `needsHumanInput = true`,
`polling.ts:826-834`) or permission prompts; existing resume/reset logic in the
`waitingForInput` branch must be preserved.

## Tasks

### Task 1 — Introduce `TransientAuthError` and make resolution throw on transient failures

File: `packages/dispatcher/src/mcp-server.ts`

1. Add `class TransientAuthError extends Error` (with `cause`).
2. `resolveCompletionAuthorization()` (`:947-984`): replace the catch-all
   (`:975-983`) with `throw new TransientAuthError(\`failed to resolve cluster
   agent "${agentName}": ${msg}\`)`. Keep the two definitive denials
   (`:951-960`, `:962-973`) and the `allowed: true` return unchanged.
3. `inferRunCompletionContext()` (`:913-945`): track lookup failures — add a
   `sawError` flag set in both `catch` blocks. Return `{ context, sawError }`
   (only relevant when no `RUN_CONTEXT` hint was present). Update
   `resolveCompletionAuthorization` to throw `TransientAuthError` when
   `sawError && !explicitHint` so a PLAN run never caches the wrong
   `build-worker` fallback.

### Task 2 — Cache only definitive outcomes (extract + clear-on-reject)

File: `packages/dispatcher/src/mcp-server.ts`

1. Extract a factory near `startMcpServer`:
   ```ts
   export function createCompletionAuthCache(
     resolve: () => Promise<CompletionAuthorization>,
   ): () => Promise<CompletionAuthorization> {
     let cached: Promise<CompletionAuthorization> | undefined;
     return () => {
       if (cached) return cached;
       cached = resolve().catch((e) => {
         cached = undefined; // transient — next call retries the lookup
         throw e;
       });
       return cached;
     };
   }
   ```
2. Use it in `startMcpServer` (`:1506-1510`): replace the inline closure with
   `const getCompletionAuth = createCompletionAuthCache(resolveCompletionAuthorization);`.
3. Add `createCompletionAuthCache` to the `__test__` export block (`:1482-1488`).

### Task 3 — Graceful degradation in `handleMcp`

File: `packages/dispatcher/src/mcp-server.ts`

1. `tools/list` (`:1158-1183`): wrap `await getCompletionAuth()` in try/catch.
   On `TransientAuthError`: `console.error('[mcp-server] tools/list: completion
   authorization failed transiently: …')` and return the tool list with the
   completion tool **included** (Fix 2 rationale). A definitive denial keeps
   today's hide behavior.
2. `tools/call` (`:1188-1206`): wrap the completion-tool auth resolution in
   try/catch. On `TransientAuthError`: `rpcError(req.id, -32000, 'completion
   authorization check failed transiently: <msg>; please retry the tool call')` —
   never the permanent "not allowed" text.

### Task 4 — Notification path cannot reject unhandled

File: `packages/dispatcher/src/mcp-server.ts`

1. `:1533`: attach `.catch((e) => console.error('[mcp-server] notification
   handler failed:', (e as Error).message))` to the fire-and-forget
   `handleMcp(...)` call. Optionally extract a `dispatchNotification(...)`
   helper (with the `.catch` inside) so it is unit-testable.
2. Do **not** modify `index.ts:58-61` (last-resort net stays).

### Task 5 — `handleSearchCode` structured errors

File: `packages/dispatcher/src/mcp-server.ts`

1. Wrap the rg/grep execution (`:535-556`, `hasRipgrep` + `execCommand`) in
   try/catch.
2. On error return `ok(id, { content: [{ type: 'text', text:
   JSON.stringify({ error: 'search failed', query, detail: <stderr or error
   message>, exitCode }) }] })`. Preserve the exit-1 no-match path
   (`execCommand` `:463-467`) and the path-escape guard (`:514-525`).

### Task 6 — Tests

File: `packages/dispatcher/src/mcp-server.test.ts` (plus new file if the cache
factory gets its own spec)

1. **Cache semantics** via `__test__.createCompletionAuthCache` with a scripted
   `resolve` and a call counter:
   - first `resolve` rejects → `get()` re-resolves on the next call → success
     cached (counts: 2 then 1);
   - `allowed: true` cached (count 1);
   - capability-denial (fetched ClusterAgent, missing capability) cached (count 1);
   - `RUN_AGENT`-missing denial cached (count 1);
   - `TransientAuthError` from resolution → cache cleared (same as rejection case).
2. **handleMcp degradation** (inject a throwing `getCompletionAuth`):
   - `tools/list` with a throwing auth → resolves with the completion tool
     included, no rejection;
   - `tools/call` `complete_run` with a throwing auth → error code `-32000`,
     message contains `transiently` and **not** `not allowed`;
   - `tools/list` with a definitive denial → completion tools hidden (existing
     behavior preserved).
3. **search_code**: call `handleMcp` with `tools/call` `search_code`,
   `arguments: { query: '[' }` (invalid regex for both rg and grep; both exit 2)
   → response is a structured result containing `search failed`, does **not**
   reject.
4. **Notification dispatch** (if the helper is extracted): a rejecting handler is
   swallowed (no unhandled rejection).

### Task 7 — Zero-token guard residual (verify-first)

Files: `packages/dispatcher/src/polling.ts`,
`packages/dispatcher/src/__tests__/poll-status.test.ts`

1. **Verify** the race: in `runPrompt` the SSE `onEvent` sets
   `pollState.waitingForInput = true` on every `session.idle`
   (`polling.ts:1164-1176`); `session.idle` fires after every completed turn; the
   zero-token guard (`polling.ts:852-862`) requires `!state.waitingForInput`. If a
   deterministic reproduction is not feasible, trace the event ordering and
   document the conclusion.
2. If confirmed, re-gate the guard on `needsHumanInput` instead of
   `waitingForInput` (see Approach Fix 5; restructure the `if (state.waitingForInput)
   { … } else if (zero tokens) { … }` chain so the zero-token check fires for the
   first completed message whenever `!state.needsHumanInput`, preserving the
   reset-on-resume and abort/permission-prompt paths).
3. Tests (in `poll-status.test.ts`, same harness style):
   - shared state starts `waitingForInput: true, needsHumanInput: false`
     (simulated `session.idle` parking) + first completed message with zero usage
     → `FatalRunError` (`zero token usage`);
   - `waitingForInput: true, needsHumanInput: true` (permission prompt / aborted
     message) + zero-usage message → **no** guard fire, stays parked (idle-timeout
     termination);
   - existing tests (settle, idle timeout, abort, first-response timeout, health
     check) keep passing — run the full dispatcher suite.

## Acceptance criteria

1. A transient `getClusterAgent` failure at the first `tools/list` no longer
   permanently denies completion: once the API recovers, a subsequent `tools/call`
   for the completion tool resolves authorization fresh and succeeds; the run can
   signal completion.
2. Definitive outcomes (`allowed: true`, missing capability from a fetched
   ClusterAgent, missing `RUN_AGENT`) are still cached — `resolveCompletionAuthorization`
   runs at most once per run for those cases.
3. A PLAN run whose context inference hit a k8s error does not permanently cache
   the `build-worker` fallback (retries to `plan-worker` + `complete_plan`).
4. A malformed notification (e.g. id-less `tools/call` with an invalid-regex
   `search_code`) is logged and absorbed — the dispatcher process survives
   (no `unhandledRejection` → `process.exit(1)`).
5. `search_code` with an invalid regex returns a structured error payload instead
   of a 500/rejection.
6. (Task 7, if the race is confirmed) a zero-token first assistant response fails
   fast even when `session.idle` parked the session first; permission-prompt and
   abort parking still work.
7. `cd packages/dispatcher && bun test` green (existing 87 tests + new ones),
   `pnpm typecheck` and `pnpm lint` pass, no Biome regressions.

## Risks / open questions

- **Optimistic `tools/list` on transient error** (recommended): the completion
  tool is advertised before authorization is proven. A genuinely-denied agent sees
  the tool but every call fails with a clear per-call denial until a definitive
  denial is cached and the client re-lists. Acceptable and strictly better than
  the alternative — hiding the tool on a list-once client reproduces the reported
  bug at the client cache despite the fixed server cache. Reviewers may prefer
  hiding; the choice is localized to the `tools/list` catch block.
- **No server→client MCP streaming**: this transport is request/response only
  (`POST /mcp`, no GET SSE endpoint), so `notifications/tools/list_changed`
  cannot be pushed to force a client re-list. Retry therefore depends on the
  client calling a completion tool (authoritative gate) or re-listing. Adding an
  SSE endpoint is out of scope.
- **Context-inference retryable**: costs at most one extra `getRun`/`getTask`
  pair per transient blip; for BUILD runs (whose fallback is correct) it only
  adds a redundant re-resolution. Safe.
- **Zero-token guard restructure touches run-lifecycle logic**: gated on
  confirm-first (Task 7 step 1). Must never fire on aborted messages or
  permission prompts (`needsHumanInput` distinguishes those). `run-prompt.test.ts`
  and `sse-stream.test.ts` must be re-run for regressions.
- **Stale line numbers in the task description**: Bug 4's "dead code" claim was
  fixed in `21a949a` (evidence: `polling.ts:855-859` comment, passing
  `poll-status.test.ts:157-166`); only the residual `session.idle` race remains,
  which is what Task 7 targets. Bugs 1–3 were re-verified as present on current
  `main`.
- **No deterministic E2E**: injecting an apiserver blip deterministically would
  require cluster fault injection; unit tests (cache + handleMcp + search_code)
  are the gate. A future `e2e:extended` scenario could point `RUN_AGENT` at a
  temporarily-absent ClusterAgent name at pod start.
- **`index.ts` unhandledRejection handler unchanged**: kept as the last-resort
  safety net; only the two root causes (Bug 2, Bug 3) that can trigger it are
  fixed.

## Proposed BUILD task breakdown

Two BUILD tasks with **disjoint file sets** (safe to run sequentially or in
parallel):

1. **BUILD: `fix-dispatcher-completion-auth-retry`** (agent `builder`) — Tasks
   1–6, everything in `packages/dispatcher/src/mcp-server.ts` +
   `packages/dispatcher/src/mcp-server.test.ts`: `TransientAuthError`,
   retryable inference, `createCompletionAuthCache` with clear-on-reject,
   graceful `tools/list` + `tools/call` degradation, notification `.catch`,
   `handleSearchCode` structured errors, and all new tests.
2. **BUILD: `fix-dispatcher-zero-token-guard-race`** (agent `builder`) — Task 7,
   `packages/dispatcher/src/polling.ts` +
   `packages/dispatcher/src/__tests__/poll-status.test.ts` (+ verify against
   `run-prompt.test.ts` / `sse-stream.test.ts`): confirm the `session.idle`
   masking race, re-gate the zero-token guard on `needsHumanInput` if confirmed,
   add the two scripted tests.
