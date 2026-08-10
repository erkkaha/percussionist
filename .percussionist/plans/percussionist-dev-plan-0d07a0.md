# Plan: Surface PR-gated integration state in the web UI

Task: `percussionist-dev-plan-0d07a0`

## Context

Projects with `flow.integration.mode: "pr"` open a GitHub PR for the plan-level
feature-branch merge, then the task sits in `awaiting-feature-merge` while the
reconciler polls GitHub (`packages/manager-controller/src/reconciler/observations.ts:66-81`,
`decision.ts:1712-1770`). Outcomes recorded on the Task CR:

- `status.worker.prNumber` — set when the PR-open run reports `outcome=pr-opened`
  (`decision.ts:1558`). Schema: `WorkerStatusSchema.prNumber` in
  `packages/api/src/index.ts:904`.
- `status.worker.mergedAt` — set when the PR is merged (`decision.ts:1739`); task → `done`.
- `status.worker.mergeError` — set when the PR is closed without merging
  (`decision.ts:1757`, "PR #N was closed without merging") or on other merge
  failures; task → `awaiting-human`. Schema at `packages/api/src/index.ts:921`.

Relevant existing code:

- **Board payload** (`packages/web/src/server/routes/board.ts`, GET
  `/:project/board`): spreads the *entire* Task CR into `columns`
  (`taskWithProgress = { ...task, childProgress, displayRefs }`), so
  `worker.prNumber` and `worker.mergeError` **already reach the client**. What is
  missing is: (a) a repo web URL so the client can build a PR link, and (b) the
  project's resolved integration mode in `settings`.
- **GitHub URL parsing**: `parseGitHubUrl(url)` in
  `packages/manager-controller/src/reconciler/github-client.ts:34` handles both
  SSH (`git@github.com:owner/repo.git`) and HTTPS forms. The web package does
  **not** depend on manager-controller (deps: `@percussionist/api`,
  `@percussionist/kube`), so this helper is not currently reachable from web.
- **Integration mode resolution**: `resolveFlow(project)` in
  `packages/manager-controller/src/reconciler/flow.ts:145` applies preset
  defaults — `simple`/`review` → `integration.mode: 'disabled'`,
  `plan-build`/`plan-build-review-merge` → `'auto-merge'` — overridden by
  `spec.flow.integration.mode`. Note the actual enum is
  `'auto-merge' | 'pr' | 'manual' | 'disabled'`
  (`packages/api/src/index.ts:1175-1179`); the task description's "auto" is
  `auto-merge`. The reconciler also treats integration as inert when
  `spec.featureBranchingEnabled` is false (`flow-introspection.ts:503`).
- **Detail panel** (`packages/web/src/client/components/board/TaskDetailPanel.tsx`):
  `OverviewContent` renders a metadata grid; the `gitBranch` chip (lines
  597-618) is the styling template for the new PR chip. `TaskDetailPanel` is
  memoized with an explicit prop comparator (lines 1219-1227).
- **Task row** (`packages/web/src/client/components/board/TaskRow.tsx`): already
  renders a phase-specific line for `awaiting-feature-merge` ("Merging feature
  branch to target", lines 187-193). Column color classes at lines 22-29; the
  review lane (where `awaiting-human` tasks land) uses `bg-accent/20 text-accent`.
- **Board header** (`packages/web/src/client/components/board/BoardHeader.tsx`):
  desktop meta line shows `Parallel: N · Phase: X` — natural place for
  `Integration: pr`.
- **Client plumbing**: `fetchBoard` in `packages/web/src/client/lib/api.ts:268`
  types the `settings` object; `BoardView.tsx` destructures `settings` and
  renders `BoardHeader`, `TaskRow` (via `TaskListPanel`), and `TaskDetailPanel`.
- **Tests**: `packages/web/tests/` (bun test) already has `task-row.test.tsx`,
  `board-header.test.tsx`, `board-view.test.tsx`, `board-display-refs.test.ts`
  (server-side route test patterns).

## Approach

1. **Share the GitHub URL parser** by moving `parseGitHubUrl` (and a new
   `buildRepoWebUrl` returning `https://github.com/{owner}/{repo}`) into
   `@percussionist/api`, which both manager-controller and web already depend
   on. `github-client.ts` re-exports it so existing imports/tests keep working.
   (Alternative considered: duplicating the regex in a web server lib — rejected
   because drift between the two parsers would silently break PR links.)
2. **Server**: extend the GET `/:project/board` `settings` object with
   `repoWebUrl` (derived from `project.spec.source?.git?.url`; `undefined` for
   non-GitHub or local projects) and `integrationMode` (resolved with a small
   web-server helper mirroring the preset defaults in `flow.ts`, reporting
   `'disabled'` when `featureBranchingEnabled` is false). No secrets exposed:
   only the derived HTTPS URL string and the mode enum are added — never
   `sshSecret`/`githubTokenSecret` refs or the raw SSH URL.
3. **Client PR state derivation** — no new persisted state. A tiny pure helper
   derives presentation from fields already on the task:
   - `prNumber` + `mergedAt` → `merged`
   - `prNumber` + `mergeError` → `closed` (shown with the error)
   - `prNumber` otherwise (typically phase `awaiting-feature-merge`) → `open`
4. **UI**: PR chip + merge error in `TaskDetailPanel`, "PR open" indicator in
   `TaskRow` (accent styling — same class family as the review/awaiting-human
   lane), `Integration: <mode>` in `BoardHeader`'s meta line.
5. The optional flow-introspection "what is this task waiting on" line is **out
   of scope** (see Risks): web cannot cheaply import
   `manager-controller/src/reconciler/flow-introspection.ts`, and exposing it
   properly needs either a package move or a reconciler-written status field.

## Scope boundaries

- **In scope**: board GET payload additions, client types, TaskDetailPanel,
  TaskRow, BoardHeader, `parseGitHubUrl` relocation to `@percussionist/api`,
  tests for all of the above.
- **Out of scope**: persisting live PR state (open/merged) from GitHub polling
  into the Task CR; flow-introspection exposure over HTTP; project **edit**
  form controls for changing integration mode (display is read-only); non-GitHub
  git hosts (no PR link is rendered when the URL doesn't parse as GitHub).

## Tasks

1. **`@percussionist/api`: add GitHub URL helpers.** In
   `packages/api/src/index.ts` (bottom, near other pure helpers) add
   `parseGitHubUrl(url): { owner, repo } | undefined` (verbatim move from
   `github-client.ts:34-51`) and
   `buildRepoWebUrl(url): string | undefined` → `https://github.com/{owner}/{repo}`.
   Unit tests in `packages/api/src/__tests__/` covering SSH form, HTTPS form,
   `.git` suffix, and non-GitHub URLs.
2. **manager-controller: delegate to the shared parser.** In
   `packages/manager-controller/src/reconciler/github-client.ts`, delete the
   local implementation, `import { parseGitHubUrl } from '@percussionist/api'`
   and re-export it (`export { parseGitHubUrl }`) so
   `observations.ts`/`worker-builder.ts` and `github-client.test.ts` stay
   unchanged and green.
3. **web server: integration-mode resolver.** New
   `packages/web/src/server/lib/integration-mode.ts` with
   `resolveIntegrationMode(project): 'auto-merge' | 'pr' | 'manual' | 'disabled'`:
   returns `'disabled'` if `!project.spec.featureBranchingEnabled`; else
   `spec.flow?.integration?.mode ?? presetDefault` where presetDefault is
   `disabled` for `simple`/`review` and `auto-merge` for
   `plan-build`/`plan-build-review-merge` (default preset is
   `plan-build-review-merge`). Include a comment pointing at
   `manager-controller/src/reconciler/flow.ts` as the authoritative table.
   Unit test in `packages/web/tests/`.
4. **web server: extend board settings.** In
   `packages/web/src/server/routes/board.ts` GET handler, add to `settings`:
   `repoWebUrl: buildRepoWebUrl(project.spec.source?.git?.url ?? '')` and
   `integrationMode: resolveIntegrationMode(project)`. Extend an existing
   board route test (or add `packages/web/tests/board-settings.test.ts`)
   asserting both fields and asserting the response contains no
   `sshSecret`/`githubTokenSecret` material in `settings`.
5. **client: types.** Update the `fetchBoard` return type in
   `packages/web/src/client/lib/api.ts:268` (`settings.repoWebUrl?: string`,
   `settings.integrationMode?: string`).
6. **client: PR presentation helper.** New
   `packages/web/src/client/components/board/pr-presentation.ts` (beside
   `display-refs.ts`): `getPrPresentation(task, repoWebUrl)` returning
   `{ prNumber, url?, state: 'open' | 'merged' | 'closed' } | null` per the
   derivation rules in Approach §3 (`url` only when `repoWebUrl` is set:
   `${repoWebUrl}/pull/${prNumber}`). Unit test
   `packages/web/tests/pr-presentation.test.ts`.
7. **TaskDetailPanel: PR chip.** In `OverviewContent`'s metadata grid, next to
   the Branch chip, render a "Pull Request" entry when
   `getPrPresentation(task, repoWebUrl)` is non-null: an `<a target="_blank"
   rel="noopener noreferrer">` chip styled identically to the gitBranch chip
   (`inline-flex items-center gap-1 rounded border border-border-muted
   bg-surface-overlay px-2 py-0.5 text-xs font-mono …`), with lucide
   `GitPullRequest` icon, text `PR #<n>`, and a small state suffix
   (`open` in accent, `merged` in `text-phase-succeeded`, `closed` in
   `text-phase-failed`). Falls back to a non-link chip when `url` is undefined.
   Requires threading a new `repoWebUrl?: string` prop from `BoardView` →
   `TaskDetailPanel` → `OverviewContent`, and adding `repoWebUrl` to the memo
   comparator at `TaskDetailPanel.tsx:1219-1227`.
8. **TaskDetailPanel: merge error block.** In `OverviewContent`, after the
   "Agent review feedback" section, when `worker?.mergeError` is set render a
   labelled block ("Merge Error", `text-label-md font-mono uppercase` header)
   with the error text in `text-phase-failed/80 text-sm whitespace-pre-wrap`,
   matching the reviewFeedback section's structure.
9. **TaskRow: PR-open indicator.** In `TaskRow.tsx`:
   - In the badges row, when `worker?.prNumber` is set and the task is waiting
     on the open PR (`task.status?.phase === 'awaiting-feature-merge'` and no
     `worker.mergedAt`), render `PR open` (`text-label-md font-mono uppercase
     px-1.5 py-0.5 rounded-sm bg-accent/20 text-accent`, lucide
     `GitPullRequest` h-2.5) — same visual class family as the review lane /
     awaiting-human badge.
   - Refine the existing `awaiting-feature-merge` status line (lines 187-193):
     when `prNumber` is set show `Waiting for PR #<n> to be merged on GitHub`,
     otherwise keep "Merging feature branch to target".
10. **BoardHeader: integration mode.** Add optional `integrationMode?: string`
    prop; in the desktop meta line append `· Integration: <mode>` (skip when
    undefined). `BoardView.tsx` passes `settings.integrationMode`. Give the
    `pr` value a `title` tooltip: "Plan merges open a GitHub PR; a human must
    merge it".
11. **Component tests.**
    - `packages/web/tests/task-row.test.tsx`: add cases — awaiting-feature-merge
      with `prNumber` shows "PR open" + PR number line; without `prNumber` keeps
      the old line; done task with `prNumber` shows no "PR open".
    - `packages/web/tests/board-header.test.tsx`: renders `Integration: pr`.
    - New `packages/web/tests/task-detail-pr.test.tsx`: Overview renders PR
      chip with correct `href` (`https://github.com/org/repo/pull/7`), merged
      state when `mergedAt` set, and the merge error block when `mergeError`
      set; no chip when `prNumber` absent.
12. **Verify workspace-wide**: `bun test` (or per-package test scripts) in
    `packages/api`, `packages/manager-controller`, `packages/web`; typecheck/lint
    per repo convention (biome).

## Proposed BUILD task breakdown

- **BUILD 1 — shared helpers + server payload** (Tasks 1-5): api helpers +
  relocation, integration-mode resolver, board route settings, client types,
  associated tests. Independent and merge-safe on its own.
- **BUILD 2 — task-level UI** (Tasks 6-9, 11 partial): pr-presentation helper,
  TaskDetailPanel chip + merge error, TaskRow indicator, their tests. Depends on
  BUILD 1 (settings.repoWebUrl).
- **BUILD 3 — project-level UI + polish** (Tasks 10-12): BoardHeader integration
  mode, remaining tests, full verification pass. Depends on BUILD 1; can run
  parallel to BUILD 2 except for the shared `BoardView.tsx` prop plumbing (small
  merge risk — keep BoardView edits in BUILD 2 and have BUILD 3 only consume
  `settings.integrationMode`).

## Risks / open questions

- **Preset-default duplication**: `resolveIntegrationMode` in the web server
  mirrors 4 values from `flow.ts` presets. Drift risk is real but bounded;
  promoting the full `resolveFlow` into `@percussionist/api` was judged too
  large for this task. Flagged with cross-referencing comments.
- **PR state freshness**: "open" is derived from task phase, not live GitHub
  state. Between a human merging the PR and the reconciler's next poll (15-min
  TTL cache in `github-client.ts`), the UI may show "PR open" for an
  already-merged PR. Acceptable: the link lets the human check GitHub directly.
- **Non-GitHub remotes**: `buildRepoWebUrl` returns `undefined`; UI degrades to
  a plain non-link `PR #<n>` chip. No GitLab/Bitbucket support planned here.
- **`mergeError` on BUILD tasks**: `mergeError` is also set by non-PR merge
  failures (e.g. `decision.ts:1539`). The detail-panel error block intentionally
  renders for *any* task with `mergeError`, not only PR-mode — that matches the
  task's intent ("today it is only visible via kubectl").
- **Optional flow-introspection line**: not cheap — web has no dependency path
  to `flow-introspection.ts`, and adding one couples the UI server to reconciler
  internals. Recommended follow-up options: (a) have the reconciler write
  `expectedNext.primary` to a task annotation/status field each cycle, or
  (b) extract `flow.ts` + `flow-introspection.ts` into a shared package. Either
  is a separate task.
- **Assumption**: only GitHub is targeted for PR links (matches
  `github-client.ts` scope). The task description's mode list ("pr/auto/manual/
  disabled") is interpreted against the actual schema enum
  (`auto-merge`, not `auto`).

## Acceptance criteria

1. GET `/api/projects/:p/board` returns `settings.repoWebUrl`
   (`https://github.com/org/repo` for `git@github.com:org/repo.git`) and
   `settings.integrationMode`; response contains no secret refs in `settings`.
2. A task with `worker.prNumber = 7` on a GitHub-backed project shows a
   `PR #7` chip in the detail panel linking to
   `https://github.com/org/repo/pull/7`, with state open/merged/closed derived
   from `mergedAt`/`mergeError`.
3. A task with `worker.mergeError` shows the full error text in the detail
   panel Overview.
4. A task in `awaiting-feature-merge` with `prNumber` set shows a "PR open"
   accent badge and "Waiting for PR #7 to be merged on GitHub" in its board row.
5. The board header shows `Integration: <mode>` for the project.
6. All existing and new tests pass in `api`, `manager-controller`, and `web`
   packages; biome checks pass.
