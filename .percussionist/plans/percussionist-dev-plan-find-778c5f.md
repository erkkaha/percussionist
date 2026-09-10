# Plan: Make dispatcher git-publish tests hermetic (stop assuming `/workspace` is not a git repo)

Task: `percussionist-dev-plan-find-778c5f`
Finding: `1788268239117-a95644599fa3`
File under test: `packages/dispatcher/src/git-publish.test.ts`

## Context

`gitPublish.publishWorkerBranch()` hardcodes its workspace at module scope:

- `packages/dispatcher/src/git-publish.ts:22` — `const WORKSPACE = '/workspace';`
- `git-publish.ts:45-60` — the private `git()` helper runs `execFile('git', …, { cwd: WORKSPACE })`
- `git-publish.ts:74-99` — `publishWorkerBranch()` probes `git rev-parse --is-inside-work-tree` in that cwd; on failure it returns `{ ok: true, skipped: 'not a git worktree' }` (`git-publish.ts:78-82`).

That no-op-on-missing-repo behavior is correct in production. The bug is that the
unit tests assert it while running **inside a Percussionist run pod, where
`/workspace` *is* the agent's git worktree** — so the probe succeeds and real git
plumbing runs against the agent's own checkout (and, with `RUN_GIT_BRANCH` set,
can `git push` to the real `origin`). `RUN_GIT_BRANCH` is injected into every
remote-git run pod (`packages/operator/src/pod-builder.ts:1175`).

Two test files are affected:

1. `packages/dispatcher/src/git-publish.test.ts:35-42` — `no-ops ok when /workspace
   is not a git worktree` sets `RUN_GIT_BRANCH` and calls
   `gitPublish.publishWorkerBranch()` with no cwd. In a worktree the probe
   succeeds, the publish runs, and the assertion
   `skipped.toContain('not a git worktree')` fails. The stale comment at lines
   37-38 ("In the test environment /workspace does not exist") documents the
   wrong assumption.

2. `packages/dispatcher/src/__tests__/mcp-server.test.ts` — the `build-worker
   context` describe (`:468-604`) calls the real completion path through HTTP.
   `mcp-server.ts:1375-1380` calls `gitPublish.publishWorkerBranch()` with no
   arguments; unlike the sibling `src/mcp-server.test.ts` (which stubs the
   mutable `gitPublish.publishWorkerBranch`, `:335-351`), this file never stubs
   it. Two tests assert the *exact* summary with no warning prefix:
   - `:543` `keeps complete_run available for non-merge runs` → `toEqual(['Done with work'])`
   - `:582` `accepts complete_run with force:true even when working tree is dirty` → `toEqual(['Forced completion'])`

   When the real publish fails (rejected push, no creds, read-only remote), the
   code prepends `[warning: branch publish failed: …]\n` (`mcp-server.ts:1378`)
   and both `.toEqual` assertions fail. When it *succeeds* they pass — but only
   because the test just pushed the agent's branch to the real remote.

### Reproduction (verified in this worktree)

`/workspace` here is a git worktree (`git remote -v` → the real GitHub repo), so:

- `cd packages/dispatcher && bun test src/git-publish.test.ts`
  → 3 pass / **1 fail** (`no-ops ok when /workspace is not a git worktree`); the
  run logs `[git-publish] pushed HEAD to refs/percussionist/feature/some-task`.
- `RUN_GIT_BRANCH=feature/probe GIT_SSH_COMMAND=false bun test src/__tests__/mcp-server.test.ts`
  → 15 pass / **2 fail**, exactly the two build-worker tests above (each ~5 s due
  to the `PUSH_ATTEMPTS=3` retry sleeps at `git-publish.ts:23,95`).

Total = the 3 failures named in the finding. Note the failure only needs
`RUN_GIT_BRANCH` set in the pod; it does **not** need a reachable remote, because
a failed push is itself enough to inject the warning. This makes `pnpm test` — the
documented pre-commit/PR gate — non-deterministic in self-dev runs.

## Approach

Make the workspace root injectable at **call time** and point every test that
exercises publish at a hermetic temp directory:

- `git-publish.ts` gains a resolver `resolveWorkspaceRoot(override?)` returning
  `override ?? process.env.WORKSPACE_DIR ?? '/workspace'`, and
  `publishWorkerBranch(options?: { cwd?: string })` threads the resolved root
  through the private `git()` helper. The production default is unchanged
  (`/workspace`), and `WORKSPACE_DIR` matches the convention already used by the
  Claude runner (`packages/runner-claude/src/index.ts:28`).
- `git-publish.test.ts` stops depending on the ambient cwd entirely: the skip
  case runs in an empty temp dir; a new publish-success case creates a real
  `git init` worktree + bare origin fixture under `tmpdir()` and asserts the
  `refs/percussionist/<branch>` ref lands there.
- `src/__tests__/mcp-server.test.ts` isolates the real completion path by setting
  `WORKSPACE_DIR` to an empty temp dir for the `build-worker context` describe, so
  `publishWorkerBranch()` degrades to `{ ok: true, skipped: 'not a git worktree' }`
  (no warning, no real git) regardless of the ambient `RUN_GIT_BRANCH`. This keeps
  the test exercising the production code path while removing the environment
  coupling, and is the regression guard for `WORKSPACE_DIR` support.

### Key decisions

- **`WORKSPACE_DIR` env + optional `cwd` parameter, both resolved per call.**
  Env is what `mcp-server.ts` can use (it calls `publishWorkerBranch()` with no
  args); the explicit `cwd` parameter gives `git-publish.test.ts` a clean,
  concurrency-safe seam without mutating global env. `resolveWorkspaceRoot` is
  exported so it can be unit-tested directly. Resolution must happen inside the
  function, not at module load, so tests can set the env in `beforeEach`.

  ```ts
  // git-publish.ts
  export const DEFAULT_WORKSPACE = '/workspace';
  export function resolveWorkspaceRoot(override?: string): string {
    return override ?? process.env.WORKSPACE_DIR ?? DEFAULT_WORKSPACE;
  }

  function git(args: string[], timeoutMs: number, cwd: string) { … }

  publishWorkerBranch: async (options?: { cwd?: string }): Promise<PublishResult> => {
    const branch = process.env.RUN_GIT_BRANCH;
    if (!branch) return { ok: true, skipped: 'RUN_GIT_BRANCH not set' };
    const cwd = resolveWorkspaceRoot(options?.cwd);
    try { await git(['rev-parse', '--is-inside-work-tree'], 10_000, cwd); }
    catch { return { ok: true, skipped: 'not a git worktree' }; }
    … await git(['push', 'origin', `HEAD:refs/percussionist/${branch}`], 60_000, cwd);
  }
  ```

  Adding an optional parameter is backward compatible for every existing caller
  (`mcp-server.ts:1331,1376,1403`; `index.ts:280`) and for the existing test stub
  (`src/mcp-server.test.ts:344` uses `async () => …`, which is assignable).

- **Assert the publish actually happens, don't assert environment absence.**
  Replace the `'not a git worktree'`-via-real-`/workspace` assertion with a
  fixture that proves the push target, so the test would fail if `cwd` were ever
  ignored (in CI `/workspace` does not exist → `skipped`; in a run pod the ref
  would land in the wrong repo). This is the durable regression guard the current
  test lacks.

- **Keep `gitCheck.isClean` / `handleSearchCode` out of scope.** `gitCheck` uses
  `execCommand` (`mcp-server.ts:459-488`, cwd `/workspace`) and is already
  overridden in tests (`src/__tests__/mcp-server.test.ts:473,485,544,566,583`);
  `handleSearchCode`'s `/workspace` (`:531`) is a deliberate security boundary.
  Neither is causing failures; touching them widens the blast radius.

## Scope boundaries

**In scope**
- `packages/dispatcher/src/git-publish.ts` — `resolveWorkspaceRoot`,
  `publishWorkerBranch(options?)`, `git(args, timeout, cwd)`.
- `packages/dispatcher/src/git-publish.test.ts` — temp-dir skip case, real
  publish fixture, resolver unit tests; delete the stale `/workspace` comment.
- `packages/dispatcher/src/__tests__/mcp-server.test.ts` — `WORKSPACE_DIR`
  isolation for the `build-worker context` describe (set/restore around
  `beforeEach`/`afterEach`).

**Out of scope**
- Any change to the production default workspace path or its env wiring in
  `packages/operator/src/pod-builder.ts`.
- `gitCheck.isClean`, `execCommand`, `handleSearchCode`, and the opencode-web
  `WORKSPACE_ROOT` (`mcp-server.ts:531`).
- CI workflow changes; the fix makes the suite hermetic without them.
- Adding a failure-path publish test (would incur the ~6 s retry sleeps).

## Tasks (proposed BUILD breakdown)

1. **BUILD A — injectable workspace root + hermetic `git-publish` tests.**
   - `git-publish.ts`: add `DEFAULT_WORKSPACE` + exported `resolveWorkspaceRoot(override?)`;
     change the private `git()` signature to take `cwd`; change
     `publishWorkerBranch(options?: { cwd?: string })` to resolve and thread the
     root. Update the doc comment to name `WORKSPACE_DIR` and the `cwd` override.
   - `git-publish.test.ts`: import `mkdtempSync`/`rmSync`/`tmpdir`/`join` and
     `execFileSync`. Add `beforeEach`/`afterEach` temp-dir create/cleanup.
     - Rewrite `no-ops ok when the workspace is not a git worktree` to call
       `gitPublish.publishWorkerBranch({ cwd: emptyDir })` with `RUN_GIT_BRANCH`
       set; assert `skipped` contains `not a git worktree`.
     - Add `resolveWorkspaceRoot` tests: default `/workspace`, `WORKSPACE_DIR`
       honored, explicit `cwd` wins over env.
     - Add a publish-success fixture: `git init --bare bare.git`; `git init work`;
       `git -C work config user.email/user.name`; commit a file; `git -C work
       remote add origin <bare.git>`; set `RUN_GIT_BRANCH='feature/unit'`; call
       `publishWorkerBranch({ cwd: work })`; assert `{ ok: true }` and that
       `git --git-dir=bare.git rev-parse refs/percussionist/feature/unit` equals
       the work HEAD sha.
   - Keep the `afterEach` that deletes `RUN_GIT_BRANCH`; restore `WORKSPACE_DIR`.

2. **BUILD B — make the MCP build-worker tests hermetic.**
   - `src/__tests__/mcp-server.test.ts`: in the `build-worker context` describe,
     create an empty temp dir, set `process.env.WORKSPACE_DIR` to it in
     `beforeEach`, and restore/delete it in `afterEach` (save the original value).
     Do not change assertions: with an empty workspace the real
     `publishWorkerBranch()` returns `{ ok: true, skipped: … }`, so
     `completedSummaries` remains `['Done with work']` / `['Forced completion']`.
   - Add `import { mkdtempSync, rmSync } from 'node:fs'` + `tmpdir`/`join`.
   - Depends on BUILD A (needs `WORKSPACE_DIR` support). Set
     `predecessorRef` to BUILD A's task name.

3. **BUILD A verification.**
   - `pnpm --filter @percussionist/api build && pnpm --filter @percussionist/kube build`
     (dispatcher tests need the workspace deps built).
   - `cd packages/dispatcher && RUN_GIT_BRANCH=feature/probe GIT_SSH_COMMAND=false bun test src/`
     → 0 failures (this is the exact run-pod repro).
   - `cd packages/dispatcher && bun test src/` (no `RUN_GIT_BRANCH`) → 0 failures.
   - `pnpm --filter @percussionist/dispatcher typecheck` and `pnpm lint`.

## Acceptance criteria

- `cd packages/dispatcher && bun test src/` passes with **0 failures** while the
  process cwd `/workspace` is an actual git worktree **and** `RUN_GIT_BRANCH` is
  set (the re-run of the reproduction above is green).
- No dispatcher test performs git plumbing against the real `/workspace` or its
  `origin`: after a full `bun test src/` run in a run pod, `git -C /workspace
  for-each-ref refs/percussionist/feature/probe` shows no ref created by the test.
- `gitPublish.publishWorkerBranch({ cwd })` pushes `HEAD` to
  `refs/percussionist/<RUN_GIT_BRANCH>` on the `origin` of the supplied repo, and
  the success test asserts the ref in a bare-repo fixture.
- `publishWorkerBranch()` with no argument still behaves exactly as production:
  `RUN_GIT_BRANCH` unset → skip; default root `/workspace`; `WORKSPACE_DIR`
  overrides it.
- `pnpm --filter @percussionist/dispatcher typecheck` and `pnpm lint` pass.
- Existing assertions in `src/__tests__/mcp-server.test.ts` are unchanged; no
  test-only branching on whether `/workspace` exists.

## Risks / open questions

- **Side effect observed during planning.** Reproducing the failure ran the real
  code path and pushed `refs/percussionist/feature/some-task` from this worktree's
  `origin` (the real `github.com:erkkaha/percussionist.git`). That is the designed
  durable-copy ref and is harmless, but the builder should not re-run the *old*
  test before applying the fix. After the fix, the suite must not touch origin.
- **`WORKSPACE_DIR` already set in some deployment?** It is not set for the
  dispatcher container today (only the init script's local shell var and
  `runner-claude` use that name). If a future deployment sets it to a non-default
  path, `gitPublish` would follow it — arguably correct, but a behavior change
  worth confirming with `kubectl get deploy/percussionist-manager -o yaml` if in
  doubt. A param-only design avoids this entirely; env support is included
  because `mcp-server.ts` cannot pass a parameter into its internal call.
- **Finding counts.** The finding says "3 tests fail" and cites two "complete_run"
  cases expecting `undefined`. Reproduced exactly as 1 + 2 failures; the two MCP
  cases fail only when the ambient `RUN_GIT_BRANCH` is set *and* the push is
  rejected. When the push succeeds they pass while still executing a real push —
  the underlying defect is non-hermetic tests, not just assertion drift.
- **Retry latency.** `PUSH_ATTEMPTS=3` with `RETRY_DELAY_MS=2000`
  (`git-publish.ts:23,95`) means a failure path costs ~6 s per call. The plan
  deliberately adds only the success fixture and keeps the empty-dir skip, so no
  test intentionally exercises the retry loop.
- **`git` availability.** Fixture tests require `git` on `PATH`. It is present in
  CI and in runner pods; if a future sandbox lacks it, the new tests fail loudly
  (which is preferable to the current silent environment dependence).
- **Follow-up (not in scope).** `gitCheck.isClean()` and `execCommand()` also
  hardcode `/workspace`; a future test that calls them unmocked would hit the same
  non-hermetic trap. Consider a shared `resolveWorkspaceRoot()` there in a
  separate task.
