# Plan: Fix kube write-path races, dead retry loops, and broken metrics token lookup

Task: `percussionist-dev-plan-rev17`

## Context

All confirmed issues live in `packages/kube/src/index.ts` (2142 lines) — the shared K8s client used by the operator, manager-controller, dispatcher, web, and CLI. Each issue below was verified against the current code on `main` (rev24-era tree) and, where possible, reproduced with a local script.

### 1. `readKubeconfigToken` looks up a CONTEXT name as a USER name (index.ts:2033-2043)

```ts
const currentContext = kc.getCurrentContext();
if (!currentContext) return undefined;
const user = kc.getUser(currentContext);   // ← wrong: getUser() looks up by *user* name
```

`KubeConfig.getUser(name)` searches `users[]` by **user** name; `getCurrentUser()` is the correct call (it resolves `currentContextObject.user`). Verified on the installed client-node: with a kubeconfig whose context name (`loaded-context`) differs from its user name (`user`), `getUser(contextName)` returns `null` while `getCurrentUser()` returns the user with the token. The bug only "works" when context and user happen to share a name (minikube defaults). On virtually all cloud kubeconfigs, `getUser` returns `null`, so **every** metrics helper — `listNodeHostStats` (1561), `listNodeCapacities` (1608), `listNodeMetrics` (1641), `listPodMetrics` (1673), `listPodResources` (1752) — falls through `readServiceAccountToken() ?? readKubeconfigToken()` and throws `"No service account token available"` in local dev. The web package already uses the correct pattern (`attach-ws.ts:41` — `kc.getCurrentUser()?.token?.trim()`), confirming the intent.

### 2. Dead 409-only retry loops on unconditional merge-patches (index.ts:327-358, 361-392, 678-708)

`patchRunStatus`, `patchRunAnnotations`, and `patchProjectStatus` all retry **only** `isConflictError` (409). But an unconditional merge-patch never returns 409 — the codebase itself documents this at `patchTaskStatus` (index.ts:784-797: "an unconditional merge-patch never returns 409"). So the loops are dead: a transient 5xx/429/network error throws on the first attempt. The dispatcher depends on the opposite: `mcp-server.ts:1318-1320` (complete_merge) and `:1386-1391` (complete_review) comment "patchRunAnnotations retries internally" and refuse to mark the run complete if the annotation patch fails — a transient 5xx on first attempt strands the task in `awaiting-human` with no verdict annotation (the orchestrator's only source of truth). Existing tests in `writes-run-status.test.ts` pin the *dead* behavior ("throws immediately on 5xx", "does not retry on 429 (pinned)") and must be updated.

### 3. `writePlanToConfigMap` is a racy read-modify-write replace (index.ts:1208-1280)

Flow: `getPlansConfigMap()` (read) → `createNamespacedConfigMap()` if 404, else `replaceNamespacedConfigMap()` with the stale `resourceVersion`. With `maxParallel` defaulting to 2, two concurrent plan writers (two PLAN agents completing at once, or a writer racing the manager's `write_plan` MCP tool) either:
- both read 404 → both create → loser gets 409, **rethrown, plan artifact lost**, or
- both read the same `resourceVersion` → one replaces, the loser's replace 409s → rethrown, artifact lost.

Neither 409 is caught. The findings ConfigMap was converted to per-key merge-patch for exactly this reason (comment at index.ts:1297-1299; `appendFindingToConfigMap` 1347-1383); plans must follow. `writePlanToConfigMap`'s return shape `{ written, sizeBytes, warning }` is consumed by the dispatcher's `write_plan` handler (mcp-server.ts:756) and the manager's `write_plan` tool (tools.ts:2180-2186) — it must be preserved.

### 4. `appendFindingToConfigMap` create-409 loses findings (index.ts:1347-1383)

Fast path is already a conflict-free per-key merge-patch, but the "ConfigMap does not exist" fallback is a bare create: two concurrent `report_finding` calls both see 404, both create, the loser's 409 is rethrown, and that finding is lost — contradicting the "conflict-free across concurrent agents" docstring. On 409 from create, the fix is to fall back to retrying the merge-patch (the CM now exists).

### 5. Smaller confirmed items

- **`fetchSessionMessages` clears its abort timer before the body is read** (index.ts:989-1016): `return readJsonWithLimit(res, 20_000_000)` inside `try { ... } finally { clearTimeout(timeout) }` — the bare (non-awaited) return makes `finally` run as soon as the promise is created, i.e. right after headers arrive. A slow/hung body stream is never aborted; also, if `fetch` itself rejects, `clearTimeout` never runs at all (the timer is created outside the try). Fix: move the fetch inside `try` and `return await readJsonWithLimit(...)`.
- **`fetchAllSessionMessages` lacks the 20MB guard** (index.ts:1054-1098): it calls `listRes.json()` (1068) and `msgRes.json()` (1086) unbounded, unlike its single-session sibling. Fix: use the existing private `readJsonWithLimit(res, 20_000_000)` for both; per-session "too large" is already swallowed by the per-session `try/catch` (skips that session).
- **`execInWorkspace` pod names collide for long project names** (index.ts:1861): `ws-exec-${projectName}-${Date.now()}`.slice(0, 63) truncates from the **right**, so for project names ≥ ~50 chars the 13-digit timestamp suffix is chopped off and every call produces the *same* pod name (reproduced: 50×`a` → `ws-exec-aaaa…-1786`, no timestamp, identical for consecutive calls). Even with a full timestamp, two calls in the same millisecond collide. Fix: strong random suffix (UUID hex) generated first, and truncate the project prefix (not the suffix) to the 63-char cap.
- **`parseCpuRaw` / `parseMemoryRaw` mis-handle decimals and SI suffixes** (index.ts:1725-1740): reproduced — `parseCpuRaw("0.5")` → 0 (should be 500m); `parseMemoryRaw("100M")` → 0 (should be ~95 Mi); `parseMemoryRaw("0.5Gi")` → 0 (should be 512); `parseMemoryRaw("1.5G")` → 0. Root cause: `parseInt` truncates at the decimal point and the bare-else branches assume integers. Affects `addCpu`/`addMemory`/`listNodeAllocated` and the web dashboard's resource figures.

## Approach

All fixes are confined to `packages/kube/src/index.ts` (+ its `__tests__/`) except one comment-only touch-up in `packages/dispatcher/src/mcp-server.ts` (the "retries internally" comments become true — no dispatcher code change). No public API signatures change except additive optional params.

### Key decisions

1. **Retry loops: extend the retry condition, don't delete the loops.** The dispatcher's contract ("patchRunAnnotations retries internally" at mcp-server.ts:1319, 1388) is the design intent; deleting the loops and retrying at call sites would touch the dispatcher's delicate "do NOT mark the run complete on failure" flow. Since the patches are unconditional (hence idempotent) merge-patches, retrying transient failures is safe. Add a shared predicate `isRetryableKubeError(err)`: true for 409, 408, 429, any 5xx, and network errors (no `statusCode`); false for other 4xx (400/401/403/404/422 must throw immediately). Keep the existing backoff (100/200/400ms) and `maxRetries = 3`. Give `patchProjectStatus` the same optional `sleep` seam the other two already have (currently missing — it uses an inline `setTimeout`, untestable without real waits).
2. **Plans ConfigMap: mirror the findings write path** — per-key merge-patch fast path (sets only `data["{task}.md"]`), 404 → create, and on 409 from create (concurrent winner) retry the merge-patch, in a small bounded attempt loop. Keep labels (`percussionist.dev/project`, `percussionist.dev/component: 'plans'`) and the exact return shape `{ written, sizeBytes, warning }`. The 900KB total-size warning is preserved via a **best-effort** `getPlansConfigMap` read used only for the warning computation; write correctness never depends on the read. Add a `plansDataKey(taskName)` sanitizer mirroring `findingsDataKey` (Task names are DNS-1123 so it is a guard, not a transform — it prevents a silent 422 class like the findings `/`-key bug).
3. **Findings create-409: bounded attempt loop** in `appendFindingToConfigMap` — on 409 from `createNamespacedConfigMap`, `continue` back to the patch attempt; give up (throw) after 3 rounds.
4. **Token lookup: `getCurrentUser()` + trim.** Add an optional injected `kc = kubeConfig()` param to `readKubeconfigToken` so the fix is unit-testable hermetically (construct a `KubeConfig` with a context name ≠ user name and assert the token resolves). Trim the token (`attach-ws.ts` precedent).
5. **Parse helpers: regex-based, decimal-capable, finite-guarded.** Parse `^([0-9]+(?:\.[0-9]+)?)(suffix)?$`; CPU: `n`→÷1e6, `u`→÷1e3, `m`→as-is, bare→×1000 (so `"0.5"`→500m); memory: binary `Ki/Mi/Gi/Ti` (÷1024 ladder) and SI `K/M/G/T` (×1000 ladder then ÷(1024²)), bare→bytes÷(1024²). Non-matching input → 0 (protects the `'0'` defaults `listPodResources` feeds in).
6. **Session fetch: keep the timer alive through the body read.** Restructure `fetchSessionMessages` so `fetch`, error handling, and `return await readJsonWithLimit(...)` all live inside `try`, with `clearTimeout` in `finally`. In `fetchAllSessionMessages`, swap both `.json()` calls for `readJsonWithLimit`.
7. **Exec pod names: `randomUUID()` suffix (hex, 12 chars), truncate the prefix.** `const suffix = randomUUID().replace(/-/g, '').slice(0, 12)`; sanitize/truncate `ws-exec-{project}` to `63 - 1 - 12` chars; join with `-`. Existing name-format tests stay green; new tests assert uniqueness for long project names.

### Scope boundaries

- **In scope:** `packages/kube/src/index.ts` production changes, `packages/kube/src/__tests__/` test changes, and the two comment updates in `packages/dispatcher/src/mcp-server.ts` (complete_merge / complete_review "retries internally" comments). No dispatcher logic changes.
- **Out of scope:** `patchTaskStatus` retry semantics (intentionally different — conditional writes must not replay a stale `resourceVersion`; documented at index.ts:784-797; do not touch). Exec-plugin (`user.exec`) auth support in the token helpers. The operator/manager/web packages' own code. No CRD/schema changes.
- **Verification gates:** each BUILD must leave `pnpm typecheck`, `pnpm lint`, and `bun test` green for the package; final verification runs the repo-root `pnpm test` (unit+smoke tier, < 1 min). No cluster needed — the fake-kube helper covers the API paths.

## Tasks / BUILD task breakdown

All BUILD tasks edit `packages/kube/src/index.ts` (plus its tests), so a strict `predecessorRef` chain is recommended to keep merge runs conflict-free. Each task must pass typecheck + lint + the kube package's `bun test`.

### BUILD 1 — Token lookup fix + CPU/memory parse helpers (foundation, no deps)

- **`readKubeconfigToken` (index.ts:2033-2043):** replace the `getCurrentContext()` + `getUser(currentContext)` pair with `kc.getCurrentUser()`; trim the returned token; add optional injected `kc: KubeConfig = kubeConfig()` param.
- **`parseCpuRaw` (1725-1731) / `parseMemoryRaw` (1733-1740):** rewrite per Approach §5 (regex, decimal support, SI + binary suffixes, `Number.isFinite` guard, non-match → 0). Keep exact behavior for integer forms currently correct: `"100m"`→100, `"1"`→1000, `"2500n"`→0, `"536870912"`→512, `"100Mi"`→100, `"0"`→0.
- **Tests:**
  - New `packages/kube/src/__tests__/kubeconfig-token.test.ts`: construct a `KubeConfig` via `addUser`/`addContext`/`setCurrentContext` with **different** user and context names and a known token; assert `readKubeconfigToken(kc)` returns the token (fails on pre-fix code), and returns `undefined` for a context whose user has no token.
  - New `parse-cpu-memory.test.ts`: `"0.5"`→500, `"0.5m"`→round, `"100M"`(cpu)→0 (SI not valid for CPU), `"100M"`(mem)→95, `"0.5Gi"`→512, `"1.5G"`→1431, `"100Ki"`→0, garbage→0, `addCpu`/`addMemory` sums.
- Acceptance: token test fails on pre-fix code and passes after; parse expectations above all pass; no other package behavior changes.

### BUILD 2 — Transient-error retry in patchRunStatus / patchRunAnnotations / patchProjectStatus

- Add `isRetryableKubeError(err)` next to `isConflictError`/`isNotFoundError` (index.ts:252-264): true for statusCode 408/409/429/≥500, and for errors with **no** statusCode (network/transport); false otherwise.
- **`patchRunStatus` (327-358)** and **`patchRunAnnotations` (361-392):** replace `if (isConflictError(e) && attempt < maxRetries) continue;` with `if (isRetryableKubeError(e) && attempt < maxRetries) continue;`.
- **`patchProjectStatus` (678-708):** same retry-condition change **and** add the optional `sleep` seam (5th param, default `(ms) => new Promise(r => setTimeout(r, ms))`) matching the other two — its callers (`tools.ts` patch_board / findings-ingestion.ts / web / cli) pass ≤4 positional args, so this is backward compatible.
- **Update `writes-run-status.test.ts`** (currently pins dead behavior): 5xx and 429 now retry with backoff (assert attempt count + delays); network error (Error without statusCode) retries; non-retryable 4xx (401/403/422) still throws immediately with a single call; 409 behavior unchanged. Add `patchProjectStatus` coverage (new `writes-project-status.test.ts` or extend the same file) with the injected sleep.
- **Dispatcher comment truth-telling:** update the two comments at `packages/dispatcher/src/mcp-server.ts:1319` and `:1388` only if their wording needs to match (they already claim the retry; leave logic untouched — verify wording, adjust if it says something stale).
- Acceptance: scripted 500→success on 2nd attempt passes (fails pre-fix); 429 exhaustion gives up after maxRetries+1 calls; `writes-run-status.test.ts` fully green.

### BUILD 3 — `writePlanToConfigMap` per-key merge-patch (plans ConfigMap races)

- Rework `writePlanToConfigMap` (index.ts:1208-1280) to the findings pattern:
  - Add `plansDataKey(taskName)` sanitizer (`replace(/[^-._a-zA-Z0-9]+/g, '_')` + `.md`) used by **both** `writePlanToConfigMap` and `readPlanFromConfigMap` (1282-1290).
  - Attempt loop (≤3 rounds): try `patchNamespacedConfigMap` with `body: { metadata: { labels }, data: { [key]: content } }` + `MERGE_PATCH()`; on 404 → `createNamespacedConfigMap` with the same labels and `data: { [key]: content }`; on 409 from create → `continue` (retry patch); any other error → throw.
  - Keep the return shape `{ written: true, sizeBytes: Buffer.byteLength(content), warning }`. Warning: best-effort `getPlansConfigMap` read (wrapped in try/catch, never affects the write) to compute the merged total size vs the 900KB threshold; skip warning on read failure.
  - Remove the `resourceVersion`-carrying replace entirely; `getPlansConfigMap` stays for reads.
- **Rework `writes-plan-cm.test.ts`:** patch fast path (assert patch body: single `{task}.md` key + labels); 404 → create (assert create body); create-409 → retry patch succeeds (assert call sequence patch,create,patch); warning computed from a scripted read; return-shape preserved; non-404 patch error rethrows; sanitizer test (hostile task name → valid key).
- Acceptance: concurrent-writer scenario (scripted 409 on create) yields a successful write with no throw; all `writes-plan-cm` tests green; dispatcher/manager `write_plan` return-shape consumers unaffected.

### BUILD 4 — `appendFindingToConfigMap` create-409 fallback

- Wrap the patch→create flow (index.ts:1347-1383) in a bounded loop (≤3 rounds): patch fast path (unchanged body); on 404 → create; **on 409 from create → `continue` back to patch**; other errors throw. Keep `{ written: true }` return.
- **Extend `writes-findings.test.ts`:** scripted `patch 404 → create 409 → patch ok`; assert final call sequence and that the finding is stored; assert exhaustion (patch 404, create 409 ×3) throws.
- Acceptance: the docstring's "conflict-free across concurrent agents" is now true for the create race; new tests pass.

### BUILD 5 — Session-fetch hardening + exec pod-name uniqueness

- **`fetchSessionMessages` (989-1016):** move `fetch` inside `try`, `return await readJsonWithLimit(res, 20_000_000)` so `finally { clearTimeout(timeout) }` runs after the body is consumed and also runs when `fetch` rejects.
- **`fetchAllSessionMessages` (1054-1098):** replace `listRes.json()` and `msgRes.json()` with `readJsonWithLimit(res, 20_000_000)`; oversized per-session bodies are caught by the existing per-session try/catch (session skipped).
- **`execInWorkspace` (1861):** `import { randomUUID } from 'node:crypto'`; build the name as `ws-exec-{sanitizedProjectPrefix}-{uuidHex12}` where the prefix is capped so the full suffix always survives (`63 - 1 - 12`).
- **Tests:** new `session-fetch.test.ts` with stubbed `globalThis.fetch` returning a `ReadableStream` body — over-limit (>20MB) session list/messages rejected by `fetchAllSessionMessages`, under-limit passes, per-session over-limit skipped; `fetchSessionMessages` rejects over-limit and passes under-limit (timer behavior is structural; assert via completion, not timer introspection). Extend `writes-exec.test.ts`: long project name (50+ chars) → two consecutive calls produce **different** names, each ≤63 chars, `[a-z0-9-]` charset; existing format tests stay green.
- Acceptance: name-uniqueness test fails pre-fix and passes post-fix; over-limit guard tests pass; exec lifecycle tests all green.

### BUILD 6 — Verification & CI pass

- From repo root: `pnpm typecheck`, `pnpm lint`, `pnpm test`. Confirm the kube suite (incl. new files) is picked up by the existing `bun test src/` scripts and the full run stays < 1 min.
- Spot-check `packages/dispatcher/src/__tests__/mcp-server.test.ts` still passes (it mocks `writePlanToConfigMap`/`patchRunAnnotations` — return shapes unchanged).
- Acceptance: green local equivalent of the CI unit/smoke gate; no order-dependent or flaky tests.

## Acceptance criteria (overall)

1. `readKubeconfigToken` returns the current user's token even when context name ≠ user name (regression test fails pre-fix); all five metrics helpers recover the kubeconfig path in local dev.
2. `patchRunStatus` / `patchRunAnnotations` / `patchProjectStatus` retry transient failures (429/5xx/network) with backoff; a scripted 500 → 200 sequence succeeds; non-retryable 4xx still throws immediately. Dispatcher's complete_merge/complete_review no longer lose verdict annotations to a first-attempt transient 5xx.
3. `writePlanToConfigMap` is conflict-free under concurrent writers (per-key merge-patch; create-409 falls back to patch) and preserves its `{ written, sizeBytes, warning }` contract.
4. `appendFindingToConfigMap`'s create race no longer drops findings (409 → patch retry).
5. `fetchSessionMessages` keeps its abort timer armed through the body read; `fetchAllSessionMessages` enforces the 20MB cap.
6. `execInWorkspace` pod names are unique for long project names and always ≤63 chars.
7. `parseCpuRaw`/`parseMemoryRaw` handle decimals and SI/binary suffixes per the expected-value table in BUILD 1.
8. `pnpm typecheck`, `pnpm lint`, `pnpm test` all green; no cluster-dependent tests added.

## Risks / open questions

1. **Retry-loop change alters observable behavior for genuinely failing endpoints** — a permanently 5xx-ing API server now costs ~700ms of backoff before throwing instead of an instant throw. Accepted: the idempotent-merge-patch justification holds, and the dispatcher already expects the retry. If the facilitator prefers fail-fast, the alternative (delete loops, retry at call sites) touches the dispatcher's verdict-annotation flow and is a larger diff.
2. **`patchTaskStatus` left untouched** — it has the same dead-loop shape for its unconditional mode, but its conditional mode (with `resourceVersion`) correctly disables retries, and its semantics are documented as deliberate. Out of scope per the task; flag for a follow-up if consistency is wanted.
3. **`writePlanToConfigMap` warning becomes best-effort** — the total-size warning now depends on a possibly-stale read and is skipped on read failure. The 900KB warning is advisory; the write path never blocks on it. If a stronger guarantee is needed, the manager could compute sizes from `readPlanFromConfigMap` during pruning instead.
4. **Exec-plugin (exec/exec-interactive) kubeconfig auth** — `getCurrentUser()` fixes the lookup, but a user whose kubeconfig authenticates via an exec plugin still has no `.token` field, so metrics helpers would still return "No service account token available". Running exec auth to mint a token is a larger change; noted here as a follow-up, not in scope.
5. **`fetchAllSessionMessages` per-session skip on over-limit** — an oversized single session is silently skipped (existing catch). The web fallback path (`readAllSessionsFromConfigMap`) already handles the truncated snapshot case; no behavior change intended beyond the guard.
6. **Same-file BUILD chaining** — all six builds edit `packages/kube/src/index.ts`; the strict predecessor chain avoids merge conflicts, at the cost of sequential execution. If the orchestrator prefers parallelism, BUILD 1 and BUILD 5 touch disjoint regions (token/parse vs session/exec) and could run concurrently.
