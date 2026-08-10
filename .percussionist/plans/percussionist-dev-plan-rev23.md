# Plan: Deduplicate copy-pasted infrastructure across packages (SSE loops, worktree shell, MCP clients, port-forward helpers)

Task: `percussionist-dev-plan-rev23`

## Context

Verified duplication (against the current worktree at `bd11e7b`, `origin/main` merged into `feature/percussionist-dev-plan-rev23`). In every case a fix applied to one copy is today missed by the others — and in two cases the duplication has already re-introduced a known bug or a security hazard.

### 1. `packages/dispatcher/src/polling.ts` — SSE loop ×2, usage recording ×2

- **SSE parse loop duplicated**: `runInteractive`'s `streamEvents` (lines 433–545) and `runPrompt`'s `streamEvents` (lines 1084–1201) share ~90 lines of transport: fetch `${BASE_URL}/event`, reconnect counting + `maybeLogStreamReconnect`, `!ok`/`!body` → 5 s sleep, the `\n\n` buffer split / `data:` line filter / `JSON.parse` loop, `logEvent`, `reader.cancel()`, 5-stream-errors → throw `'opencode server unreachable: stream disconnected'`, 5 s error backoff, and the 1 s inter-reconnect delay (added to fix the SSE reconnection storm per AGENTS.md). Only the per-event handlers differ (`session.idle` / `permission.updated` / `message.updated`).
- **Interactive usage recording re-implements `recordUsage` with a collapsing key** (bug): `runInteractive.discoverSessions` (lines 410–427) records usage with fallback id `` `${sessionID}-idx` `` — constant per session, so two usage-bearing messages without ids collapse into one entry. `recordUsage` (lines 229–265) exists precisely to fix this, using `` `${sessionID}-idx-${i}` `` (indexed). Prompt mode already routes through `recordUsage` (line 758); interactive does not.
- Prompt-mode `message.updated` (1153–1181) and interactive `message.updated` (489–525) also share the `tokens.update(…, p.info.id ?? \`${sid}-live\`)` + `flush` shape — left as-is unless trivial to fold in.

### 2. `packages/operator/src/pod-builder.ts` — worktree-setup shell ×2, reset stanza ×5, unescaped interpolation

- `renderPod` is 1128 lines; the workspace-init worktree section is the worst offender:
  - **worktreeReuse branch** (lines 462–552) and **freshWorktree branch** (lines 553–608) duplicate the same "re-sync mirror refs → force-add/normal-add worktree → reset to remote tip → else create from parentRef baseline → else error+exit 1" chain line-for-line, differing only in the prologue (resume-existing vs remove-first).
  - **"reset to remote tip" stanza appears 5 times** (486–490, 522–526, 530–534, 579–583, 587–591) with drift already visible (e.g. the `elif` indentation differs between the reuse branch and the fresh branch).
  - **Mirror refs re-sync loop duplicated** (503–512 and 560–569).
- **Unescaped shell interpolation (security hazard)**: `git.url` is interpolated into `sh -c` scripts at 448 (`git clone --mirror "${git.url}"`) and 611 (`remote set-url origin "${git.url}"`); `git.ref`/`git.parentRef` at 470–476, 516–540, 573–597 and inside `parentBaselineResolve` (49–79). A ref containing `'`, `$()`, or `;` would execute arbitrary shell in the init container. `INIT_SCRIPT` already ships via env var (709, `{ name: 'INIT_SCRIPT', value: initScript }`); git fields should follow the same pattern.

### 3. `packages/operator/src/reconciler.ts` — `reconcileProject` upsert ×4

`reconcileProject` (910–1103) repeats the read → SSA-patch (`PatchStrategy.ServerSideApply`, fieldManager `'percussionist-operator'`, `force: true`) → on-NotFound-create upsert four times: code-server Deployment (936–963), code-server Service (965–992), memory Deployment (1040–1067), memory Service (1069–1096). The data-PVC preamble (920–934 and 1024–1038) is also duplicated. The Ingress block (994–1012) uses a different read-only pattern and is out of scope. `reconciler-flow.test.ts` (fake-kube) asserts exact recorded call sequences (`readNamespacedDeployment` → `patchNamespacedDeployment` → `createNamespacedDeployment`), so the helper must preserve method order and log strings.

### 4. `packages/web/src/server` — MCP JSON-RPC clients ×5, `upsertSecret` ×3

- **Five hand-rolled JSON-RPC `tools/call` clients** with divergent error handling, each with its own `MCP_URL` constant:
  - `routes/task-diff.ts` 227–299 (`exec_in_workspace`; body-text error surfacing, non-JSON guard, `result.isError` → throw)
  - `routes/plans.ts` 33–65 (`read_plan`; JSON-response error json, 502 on HTTP failure)
  - `routes/upgrade.ts` 35–63 (`check_for_updates`) and 132–162 (`apply_upgrade`; `isError` + empty-text checks)
  - `routes/providers.ts` 85–109 (`list_models`; returns `null` on any failure, 10 s timeout)
  - `lib/manager-mcp.ts` already exists and owns `managerMcpHeaders()` — the natural home for a shared `callManagerTool(name, args, timeoutMs)` and the `MANAGER_MCP_URL` constant.
- **`upsertSecret` (read → replace; catch-any → create) exists three times**: `routes/settings.ts` 17–31, `lib/agent-keys.ts` 285–298 (its comment at 271–273 literally says "Mirrors upsertSecret() in routes/settings.ts…"), and `routes/projects.ts` `upsertInjectFileSecret` 118–138 (same pattern plus labels). `upsertProjectConfigCm` (49–66) is the ConfigMap twin (optional generalization).

### 5. `packages/cli/src` — `pickFreePort`/`startPortForward`/`openBrowser` ×2–3

- `pickFreePort`: `web.ts` 29–45, `web-client.ts` 81–97, `chat.ts` 58–74 — identical bodies.
- `startPortForward`: `web.ts` 64–102, `web-client.ts` 99–125, `chat.ts` 76–111 — identical except service/port constants and stderr filtering (web/web-client filter to `error|unable` lines; chat writes every chunk to stderr).
- `openBrowser`: `web.ts` 104–123, `auth-login.ts` 49–63 — identical except web.ts lacks the try/catch.
- `web.ts` also has `resolveLocalPort` (47–62) which layers default-port preference on `pickFreePort`.

### 6. `packages/manager-controller/src/agent/tools.ts` — `gitUrlHash` reimplemented inline ×2

- Lines 1027–1031 (`cleanupRunWorktree`) and 2094–2098 (`read_plan` git fallback) both reimplement the exact djb2 from `@percussionist/kube` `gitUrlHash` (`packages/kube/src/index.ts:1450–1456`, `h = ((h << 5) + h + c) >>> 0`, `toString(16).padStart(8, '0')`), which is unit-tested in `packages/kube/src/__tests__/git-url-hash.test.ts`. `tools.ts` already imports ~20 symbols from `@percussionist/kube` (40–57) — adding `gitUrlHash` is a two-line diff. A URL-hash mismatch between the operator (mirror path) and the manager (worktree cleanup / plan fallback) would silently target the wrong mirror directory.

## Approach

One shared helper per pattern, each in the package where it is consumed; no cross-package API surface changes beyond the existing dependency edges (`manager-controller → kube` already exists).

1. **Dispatcher**: extract a module-level `streamSseEvents(opts)` that owns the fetch/decode/parse/reconnect/backoff machinery and calls `opts.onEvent(evt)` per parsed event; both `streamEvents` closures become thin wrappers supplying `mode`, `isTerminated`, `sleep`, and their per-event handler. Fix the interactive undercount by replacing the inline usage block with `recordUsage(tokens, sessionID, msgs)`.
2. **pod-builder**: two-phase. First pass `git.url`/`git.ref`/`git.parentRef` through the workspace-init `env` array (`GIT_URL`/`GIT_REF`/`GIT_PARENT_REF`) and reference them in the shell — behavior-preserving for well-formed branch names, a security fix for hostile ones. Then extract shared shell-snippet builders so the worktreeReuse and freshWorktree modes and the reset stanza have exactly one copy.
3. **reconciler**: add `upsertDeployment(project, ns, logPrefix, name, render)` and `upsertService(project, ns, logPrefix, name, render)` helpers preserving the exact read → SSA → create-on-NotFound sequence and log strings; refactor the four call sites; optionally fold the duplicated PVC preamble into `ensureDataPvcOrBail`.
4. **web**: add `callManagerTool(name, args, timeoutMs)` + export `MANAGER_MCP_URL` from `lib/manager-mcp.ts`; refactor the five call sites, preserving each route's timeout, response-shape handling and error mapping (callers keep their own try/catch → HTTP-status mapping). Extract `upsertSecret(name, data, labels?)` into `lib/kube-upsert.ts`; refactor settings.ts, agent-keys.ts, projects.ts.
5. **cli**: new `src/port-forward.ts` exporting `pickFreePort()`, `startPortForward(namespace, service, remotePort, localPort)`, `openBrowser(url)`; refactor web.ts, web-client.ts, chat.ts, auth-login.ts to import them.
6. **manager-controller**: import `gitUrlHash` from `@percussionist/kube` and delete both inline copies.

Every BUILD task must pass `pnpm typecheck`, `pnpm lint`, and its package's `bun test` before review. Refactors must be behavior-preserving; the two genuine bug fixes (interactive usage undercount, shell interpolation) are called out explicitly and get regression tests or content assertions.

## Scope boundaries

- **In scope**: the six duplication areas enumerated above; the interactive usage-recording bug fix; the env-var security hardening for git refs/url in workspace-init; targeted regression/content tests that pin the fixes.
- **Out of scope** (deliberately): any other dedup not enumerated (CLI `attach.ts`/`logs.ts`, `web/routes/agent-chat.ts` plain-HTTP proxy, `operator` `code-server.ts`/`memory-service.ts` renderers, kube `execInWorkspace`, dispatcher `discoverSessions` restructure beyond the `recordUsage` swap); behavior changes beyond the enumerated fixes; the reconciler Ingress block; new CRDs/schemas; E2E tests; docs.
- **Testing rules**: deterministic, model-agnostic, cluster-free; assert on code/script content and recorded call sequences, never on prose; no order-dependent tests (`bun test --isolate` where module-global mocks are used, per AGENTS.md).

## Tasks / BUILD task breakdown

All BUILD tasks target `@percussionist` packages; agent: `builder`. Each must pass typecheck, lint, and its package's tests before review. Tasks are ordered so shared helpers land before their consumers.

### BUILD 1 — manager-controller: use `gitUrlHash` from `@percussionist/kube`
- File: `packages/manager-controller/src/agent/tools.ts`.
- Add `gitUrlHash` to the existing `@percussionist/kube` import block (40–57).
- Replace the inline djb2 in `cleanupRunWorktree` (1027–1031) with `const hash = gitUrlHash(gitUrl);` and the inline copy in the `read_plan` git fallback (2094–2098) with `const urlHash = gitUrlHash(gitUrl);`.
- Acceptance: `grep -rn 5381 packages/manager-controller` returns nothing; typecheck + lint pass; `git-url-hash.test.ts` (kube) still green.

### BUILD 2 — web: extract `callManagerTool` and refactor the five MCP clients
- File: `packages/web/src/server/lib/manager-mcp.ts` — add `export const MANAGER_MCP_URL = \`http://percussionist-manager.${NAMESPACE}.svc.cluster.local:4097/mcp\`` (import `NAMESPACE` from `../kube.js`) and:
  ```ts
  export interface ManagerToolResult { isError?: boolean; content?: Array<{ type: string; text: string }>; }
  export async function callManagerTool(name: string, args: Record<string, unknown>, timeoutMs = 30_000): Promise<ManagerToolResult>
  ```
  Request body: `{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }` with `managerMcpHeaders()` and `AbortSignal.timeout(timeoutMs)`. Error handling (shared, strict): non-OK → throw with status + first 200 chars of body; non-JSON body → throw; `error` field → throw with its message. Returns `result` (callers check `isError`).
- Refactor call sites to use it, preserving each one's contract:
  - `routes/task-diff.ts` `execInWorkspaceViaManager` (227–299): `callManagerTool('exec_in_workspace', { project, command, mountPath: '/data', timeoutSeconds, namespace, skipSanitization: true, image: DEFAULT_EXEC_IMAGE }, timeoutMs + 5_000)`; keep `isError` → throw content, keep the `{ stdout, exitCode }` extraction; delete local `MCP_URL` (225) and the fetch/parse block.
  - `routes/plans.ts` (33–65): `callManagerTool('read_plan', { project, task: taskId, namespace: NAMESPACE })`; map throw → 502/500 JSON exactly as today.
  - `routes/upgrade.ts` (35–63 and 132–162): `check_for_updates` / `apply_upgrade` with the existing `isError` and empty-text checks preserved.
  - `routes/providers.ts` `fetchOpencodeProviders` (85–109): `callManagerTool('list_models', {}, 10_000)` inside the existing try/catch that returns `null`.
- Delete the four local `MCP_URL`/`MANAGER_MCP_URL` constants.
- Acceptance: `packages/web/tests/task-diff.test.ts` (spies `globalThis.fetch` and asserts response handling) stays green; no `jsonrpc: '2.0'` literals remain in `routes/*.ts` except through the helper; typecheck + lint + `bun test --isolate --preload ./tests/setup.ts tests/` pass.

### BUILD 3 — web: shared `upsertSecret`
- New file `packages/web/src/server/lib/kube-upsert.ts`: `export async function upsertSecret(name: string, data: Record<string, string>, labels?: Record<string, string>): Promise<void>` — body `{ apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace: NAMESPACE, ...(labels ? { labels } : {}) }, stringData: data }`; read → `replaceNamespacedSecret`; catch-any → `createNamespacedSecret` (preserve the current catch-all semantics exactly).
- Refactor: `routes/settings.ts` 17–31, `lib/agent-keys.ts` 285–298 (delete the "Mirrors upsertSecret()" comment at 271–273 and the local copy), `routes/projects.ts` `upsertInjectFileSecret` 118–138 (pass `{ [INJECT_FILE_SECRET_KEY]: content }` and `{ 'percussionist.dev/project': projectName }` labels).
- Optional (same task, low priority): generalize the ConfigMap twin `upsertProjectConfigCm` (projects.ts 49–66) into `upsertConfigMap(name, data, labels?)` in the same file — only if it stays a mechanical move.
- Acceptance: `packages/web/tests/agent-keys.test.ts` and the web suite stay green; `grep -rn "async function upsertSecret" packages/web/src/server` returns only the lib definition.

### BUILD 4 — cli: shared port-forward module
- New file `packages/cli/src/port-forward.ts` exporting:
  - `pickFreePort(): Promise<number>` — exact body from `web.ts` 29–45.
  - `startPortForward(namespace: string, service: string, remotePort: number, localPort: number): Promise<ChildProcess>` — body from `web.ts` 64–102 parameterized; unify stderr filtering on the `error|unable`-only behavior (see Risks §5).
  - `openBrowser(url: string): void` — the try/catch version from `auth-login.ts` 49–63.
- Refactor:
  - `web.ts`: import the three; delete locals (29–45, 64–102, 104–123); `startPortForward(ns, WEB_SERVICE, WEB_PORT, localPort)`; keep `resolveLocalPort` (47–62) using shared `pickFreePort`.
  - `web-client.ts`: import `pickFreePort`/`startPortForward`; delete locals (81–97, 99–125); `startPortForward(ns, WEB_SERVICE, WEB_PORT, localPort)`.
  - `chat.ts`: import `pickFreePort`/`startPortForward`; delete locals (58–74, 76–111); `startPortForward(ns, MANAGER_SERVICE, MANAGER_PORT, localPort)`.
  - `auth-login.ts`: import `openBrowser`; delete local (49–63).
- Acceptance: `grep -rn "function pickFreePort\|function startPortForward\|function openBrowser" packages/cli/src` returns only `port-forward.ts`; typecheck + lint pass; a small deterministic unit test for `pickFreePort` (binds an ephemeral port, closes it) is nice-to-have.

### BUILD 5 — dispatcher: shared SSE-stream helper + interactive `recordUsage` fix
- File: `packages/dispatcher/src/polling.ts`.
- Extract module-level:
  ```ts
  interface SseStreamOptions {
    mode: 'interactive' | 'prompt';
    isTerminated: () => boolean;
    sleep: (ms: number) => Promise<void>;
    onEvent: (evt: { type?: string; properties?: Record<string, unknown> }) => void | Promise<void>;
  }
  async function streamSseEvents(opts: SseStreamOptions): Promise<void>
  ```
  owning: the `${BASE_URL}/event` fetch with `Accept: text/event-stream`; reconnect counter + `maybeLogStreamReconnect(mode, reconnects)`; `!ok`/`!body` → 5 s sleep; the `\n\n` split / `data:` filter / `JSON.parse` loop calling `opts.onEvent(evt)`; `logEvent(evt)`; `reader.cancel()`; 5-stream-errors → throw `'opencode server unreachable: stream disconnected'`; 5 s error sleep; 1 s inter-reconnect sleep (all guarded by `isTerminated()`). The `biome-ignore` comments for the parse loop move with the loop.
- Rewrite `runInteractive.streamEvents` (433–545) and `runPrompt.streamEvents` (1084–1201) as thin wrappers: `streamSseEvents({ mode: 'interactive' | 'prompt', isTerminated: () => terminate | pollState.terminate, sleep, onEvent: async (evt) => { …existing per-event logic unchanged… } })`. Interactive keeps `sleep`; prompt keeps `doSleep`. No constant changes (`SETTLE_MS`, `IDLE_TIMEOUT_MS`, error message text).
- Fix interactive usage (410–427): replace the inline loop with
  ```ts
  for (const sessionID of knownSessions) {
    recordUsage(tokens, sessionID, await fetchMessages(sessionID));
  }
  ```
  Deliberate behavior change: `recordUsage` keys the fallback id by index (`` `${sessionID}-idx-${i}` ``) — fixes the collapsing-key undercount — and filters to `role === 'assistant'` (usage-bearing messages are assistant-only in practice; prompt mode already relies on this).
- Tests: new `packages/dispatcher/src/__tests__/sse-stream.test.ts` — `spyOn(globalThis, 'fetch')` with a scripted `Response`/`ReadableStream`: events split across chunks are delivered; `logEvent`-worthy events flow; 5 consecutive failures throw the exact message; success resets the counter; backoff sleeps (5000/1000) observed via injected `sleep`. Existing `run-prompt.test.ts` (503-stub fetch) must stay green.
- Acceptance: sse-stream tests pass; run-prompt + token-aggregator tests pass; no two `streamEvents` bodies with `\n\n`-parsing remain (`grep -c "buffer.indexOf('\\n\\n')" src/polling.ts` == 1).

### BUILD 6 — operator: generic upsert helper in `reconcileProject`
- File: `packages/operator/src/reconciler.ts`.
- Add module-level helpers near `reconcileProject`:
  ```ts
  async function upsertDeployment(project: Project, ns: string, logPrefix: string, name: string, render: (p: Project) => V1Deployment): Promise<void>
  async function upsertService(project: Project, ns: string, logPrefix: string, name: string, render: (p: Project) => V1Service): Promise<void>
  ```
  each: `read` → on success SSA-patch (`PatchStrategy.ServerSideApply`, fieldManager `'percussionist-operator'`, `force: true`) + log `patched deployment|service ${name}`; on NotFound → create + log `created …`; other errors → `err(…)` + rethrow. Order and log strings must match today's exactly.
- Refactor the four call sites (936–963, 965–992, 1040–1067, 1069–1096) to one-liners. Optionally fold the duplicated PVC preamble (920–934 / 1024–1038) into `ensureDataPvcOrBail(project, ns, logPrefix): Promise<boolean>` returning false (caller returns) on failure.
- Tests: `reconciler-flow.test.ts` stays green (fake-kube asserts method sequences). Add an upsert-path case with codeServer+embedding enabled and missing resources → `createNamespacedDeployment`/`createNamespacedService` in order; with existing resources → `patchNamespacedDeployment`/`patchNamespacedService` (SSA) with no create.
- Acceptance: typecheck + lint + operator `bun test src/` pass; `grep -c "ServerSideApply" src/reconciler.ts` == 2 (both in the helpers).

### BUILD 7 — operator pod-builder: pass git.url/ref/parentRef via env vars
- File: `packages/operator/src/pod-builder.ts`.
- In the workspace-init container `env` array (705–719) add, for remote git only:
  ```ts
  ...(git ? [
    { name: 'GIT_URL', value: git.url },
    ...(git.ref ? [{ name: 'GIT_REF', value: git.ref }] : []),
    ...(git.parentRef ? [{ name: 'GIT_PARENT_REF', value: git.parentRef }] : []),
  ] : [])
  ```
- Replace every `${git.url}` / `${git.ref}` / `${git.parentRef}` interpolation in the shell with `"$GIT_URL"` / `"$GIT_REF"` / `"$GIT_PARENT_REF"`: 448, 470–477, 481–490, 516–540, 573–597, 611, and inside `parentBaselineResolve` (49–79: `_PARENT_REMOTE_REF="refs/remotes/origin/$GIT_PARENT_REF"`, `refs/heads/$GIT_PARENT_REF`, messages use `$GIT_REF`). Change `parentBaselineResolve(git)` → `parentBaselineResolve()` (reads the env vars; drop the `git` param and its throw-on-missing checks since the values are now optional-by-construction — the shell's existing `else`/`exit 1` path still guards missing refs).
- Behavior-preserving for well-formed branch names; a security fix for refs with shell metacharacters. Keep the single-quoted `'…'` literals around the branch names where present (`git -C "$WORKTREE_DIR" checkout "$GIT_REF"` etc.).
- Tests: extend `pod-builder.test.ts` — assert env contains `GIT_URL`/`GIT_REF`/`GIT_PARENT_REF` for a run with parentRef; assert the rendered script contains `"$GIT_REF"` / `"$GIT_URL"` and **no** `${git.` template remnants (`expect(args).not.toContain('${git.')`); existing substring assertions (`_PARENT_REMOTE_REF=`, `refs/remotes/origin/`) must keep passing.
- Acceptance: pod-builder tests green; `grep -n '\${git\.' src/pod-builder.ts` returns nothing.

### BUILD 8 — operator pod-builder: single copy of the worktree-setup shell
- File: `packages/operator/src/pod-builder.ts`.
- Extract module-level snippet builders (returning `string[]`, referencing `$MIRROR_DIR`/`$WORKTREE_DIR`/`$GIT_REF`/`$GIT_PARENT_REF`):
  - `renderRefSyncSnippet(): string[]` — the mirror refs/heads re-sync loop (503–512 / 560–569).
  - `renderResetToRemoteTip(): string[]` — the reset-to-`origin/$GIT_REF`-or-skip stanza (486–490 / 522–526 / 530–534 / 579–583 / 587–591).
  - `renderAddWorktree(git): string[]` — the force-add / normal-add / elif-parentRef-baseline / else-error chain (500–551 minus its prologue, 558–607 minus the remove-first prologue).
- Rebuild the two mode blocks from the builders: worktreeReuse (462–552) = resume-existing branch + `else` + `renderAddWorktree(git)` + `fi`; freshWorktree (553–608) = remove-first + `renderAddWorktree(git)`.
- Tests: extend `pod-builder.test.ts` — assert the reset stanza text occurs exactly once per rendered script (`(args.match(/reset to origin\//g) ?? []).length` == 1 for a ref run); assert the worktreeReuse=true fresh-create branch and worktreeReuse=false mode produce identical add-worktree content (compare the substrings after the mode-specific prologue); keep all existing assertions green.
- Acceptance: rendered scripts for the full matrix (worktreeReuse × {ref, ref+parentRef, no-ref}) still contain every currently-asserted fragment; `grep -c "worktree add --force" src/pod-builder.ts` == 1.

### BUILD 9 — verification & CI pass
- Run from repo root: `pnpm typecheck`, `pnpm lint`, `pnpm test` (must stay < 1 min). Confirm per-package suites (dispatcher `bun test src/`, operator `bun test src/`, web `bun test --isolate --preload ./tests/setup.ts tests/`, cli `bun test test/`, manager-controller) are green.
- Run the no-duplication grep gates: `5381` only in kube; `pickFreePort|startPortForward|openBrowser` only in `cli/src/port-forward.ts`; `async function upsertSecret` only in `lib/kube-upsert.ts`; `buffer.indexOf('\n\n')` only once in dispatcher; `\${git\.` nowhere in pod-builder; `ServerSideApply` only in the two reconciler helpers; `jsonrpc: '2.0'` only in `lib/manager-mcp.ts` (web) and the MCP servers (dispatcher/manager, untouched).
- Acceptance: green CI-equivalent local run; all grep gates pass; no order-dependent/flaky tests.

## Acceptance criteria (overall)

1. Every enumerated duplication has exactly one remaining copy (grep gates in BUILD 9).
2. Both genuine bug fixes are shipped with evidence:
   - interactive usage no longer collapses messages without ids (indexed fallback via `recordUsage`) — covered by existing `token-aggregator.test.ts` + the interactive path using it;
   - git.url/ref/parentRef no longer interpolated into `sh -c` (env-var pass-through) — covered by BUILD 7 content assertions.
3. `pnpm typecheck`, `pnpm lint`, and `pnpm test` are green for all touched packages; no behavior change outside the enumerated fixes and the two documented bug fixes.
4. Existing test suites (`run-prompt.test.ts`, `task-diff.test.ts`, `reconciler-flow.test.ts`, `pod-builder.test.ts`, `agent-keys.test.ts`, `git-url-hash.test.ts`) pass unmodified unless a test explicitly pins a fixed behavior.

## Risks / open questions

1. **Dispatcher SSE extraction (BUILD 5) is the riskiest pure-refactor**: the loops are long-lived background coroutines whose subtle timing (terminate checks, error counters, backoff) is load-bearing — the 1 s reconnection delay exists to prevent a known reconnect storm (AGENTS.md). Mitigation: mechanical extraction with identical constants/error text, plus the new scripted-stream test; run-prompt.test.ts must pass untouched.
2. **Interactive `recordUsage` swap changes semantics slightly**: `recordUsage` filters to `role === 'assistant'`; the old inline block recorded any usage-bearing message. In practice usage lives on assistant messages (prompt mode already relies on this), so the change is the intended fix; if a reviewer wants strict parity, keep the role filter out by passing messages unfiltered — flag for review, default is `recordUsage` as-is.
3. **pod-builder shell refactors (BUILD 7 + 8) touch production init scripts**; a regression breaks worktree setup silently (init container failure → run stuck). Mitigation: the two builds are separated so env-var pass-through is verified independently of the dedup; script-content assertions pin the rendered output; the refactor is strictly mechanical (no logic reordering, `exit 1` guards preserved).
4. **Reconciler upsert helper (BUILD 6)**: `reconciler-flow.test.ts` asserts exact recorded call sequences and `safeReconcileProject` behavior; the helper must preserve read→patch→create order, fieldManager/force flags, log strings, and rethrow-on-non-NotFound. The Ingress block is intentionally left alone (read-only pattern, differs).
5. **CLI `startPortForward` unification (BUILD 4)**: chat.ts currently writes every stderr chunk to stderr; unifying on the `error|unable`-only filter changes chat's stderr chatter cosmetically. Accepted (diagnostics still flow; stdout stays clean); flagged so reviewers know it is deliberate.
6. **Web `callManagerTool` strictness vs `providers.ts` tolerance**: the shared helper throws on HTTP/JSON-RPC errors; providers.ts must keep its try/catch → `null` contract (it does — the call sits inside `fetchOpencodeProviders`'s existing try/catch). task-diff.ts's richer error text (body snippet) is preserved in the helper's thrown message.
7. **No prior rev23 artifacts exist** (no plan in git, none in ConfigMap) — this plan is evaluated against current `main` (`bd11e7b`); line numbers above are from that snapshot.
