# Plan: Show green checkmark on completed child tasks in the board's child task list

Task: `percussionist-dev-plan-906e19`

## Context

The board renders a "Child Tasks (X/Y complete)" list for PLAN tasks parked in
`awaiting-children` (all child BUILD tasks finished or in flight). The summary
count is visible, but the enumerated list gives no per-child status — every
child row looks identical — so the user cannot tell *which* children are done.

Relevant code (all in `packages/web`):

- **Server — `src/server/routes/board.ts:137-158`**: for each PLAN task in
  `awaiting-children`, `GET /api/projects/:project/board` computes a
  `childProgress` object:
  - `total` — number of child BUILD tasks (`spec.type === 'BUILD' &&
    spec.parentTaskRef === taskName`)
  - `completed` — count of children with `status.phase === 'done'`
  - `childRefs` — child task names, in filter order
  - `childDisplayRefs` — display labels (title, or `title (shortId)` on
    duplicate titles), same order
  - **Missing: any per-child phase/status.** The client can compute the
    aggregate count but cannot tell which children are `done`.
  - `childProgress` is attached per-request to `taskWithProgress`
    (`board.ts:196-205`); it is never persisted to CRs — no CRD/schema impact.

- **Client type — `src/client/lib/types.ts:43-48`**: `Task.childProgress`
  mirrors the server shape (`total`, `completed`, `childRefs`,
  `childDisplayRefs?`). No per-child status field.

- **Client render — `src/client/components/board/TaskDetailPanel.tsx:888-918`**:
  the actual child *list*. Each child is a clickable row (navigates the board to
  the child task) with a `Wrench` icon + `childRef.text` label. No status
  indicator. `CheckCircle2` is already imported (line 11) and the file already
  uses the green-checkmark pattern `CheckCircle2 className="h-3.5 w-3.5
  text-green-500"` (line 464), so the icon/color convention exists.

- **Client helper — `src/client/components/board/display-refs.ts`**:
  `getChildRefPresentation(task, childName, index)` returns `{ text, tooltip }`
  only; pure presentation helpers for board refs live here by convention
  (`getParentRefPresentation`, `getBlockedReasonPresentation`).

- **`TaskRow.tsx:239-254`** shows only the aggregate "X/Y child BUILD tasks
  complete" + a progress bar in the board column — no per-child list there.

- **Phase model — `@percussionist/api` `TaskPhase`** (`packages/api/src/index.ts:846-869`);
  a child counts as complete iff `phase === 'done'` (matches `completed` in
  `board.ts`).

Existing tests to build on:
- `tests/board-display-refs.test.ts` (server, spies `kube.listTasks`) — has a
  childProgress test asserting `total`/`completed`/`childRefs`/`childDisplayRefs`
  alignment (lines 149-192).
- `tests/task-detail-answer.test.tsx` — component-test pattern for
  `TaskDetailPanel` (mocks `src/client/lib/api`, real QueryClient + MemoryRouter).
- `tests/board-display-refs-client.test.ts` — unit tests for `display-refs.ts`
  helpers.

## Approach

**Server-side enrichment (data first), then client rendering.** The client has
no way to know per-child completion today, so the board response must carry it.

1. **Add `childPhases`** to the `childProgressMap` entries in `board.ts` — a
   parallel array (same order as `childRefs`/`childDisplayRefs`) of each child's
   `status.phase ?? 'pending'`. Pure additive server change; no behavior change
   for existing fields; no CRD/annotation/persistence changes.

2. **Mirror the type** in `src/client/lib/types.ts`:
   `childPhases?: TaskPhase[]` (import `TaskPhase` type from
   `@percussionist/api`, which is already re-exported from this file's import
   list source). Optional field keeps the client tolerant of stale cached board
   responses that predate the field.

3. **Render the green checkmark** in `TaskDetailPanel.tsx`'s child list: for
   each child index, if `childPhases?.[index] === 'done'` render
   `<CheckCircle2 className="h-3.5 w-3.5 text-green-500" />` (existing pattern,
   line 464) in place of the `Wrench` icon; otherwise keep `Wrench`. Add a
   `title`/`aria-label` of "Done" / "In progress" for accessibility. No layout
   change — same row structure, same click-to-navigate behavior.

4. **Put the phase check in `display-refs.ts`** as a small pure helper (e.g.
   `getChildPhasePresentation(task, index): { done: boolean }`) so the
   completion logic is unit-testable without rendering, consistent with the
   other `get*Presentation` helpers. The component consumes the helper.

5. **Tests**:
   - Server: extend the existing childProgress test in
     `board-display-refs.test.ts` to assert `childPhases` is aligned with
     `childRefs` (child B `done` → `childPhases` contains `'done'` at B's index).
   - Client: add a component test `task-detail-child-progress.test.tsx` (copy
     the `task-detail-answer.test.tsx` harness: mock `api`, real QueryClient +
     MemoryRouter) asserting a `done` child renders a green checkmark and a
     non-done child renders the wrench.
   - Client: extend `board-display-refs-client.test.ts` for the new helper.

Scope: the enumerated child list in `TaskDetailPanel` only. `TaskRow`'s summary
line already conveys aggregate progress and is not "the list"; no change there.

## Tasks / BUILD task breakdown

All BUILD tasks target `packages/web`; agent: `builder`. Each must pass
`pnpm typecheck`, `pnpm lint`, and the web suite (`bun test` in `packages/web`,
which already runs with `--isolate` per AGENTS.md).

### BUILD 1 — Data plumbing: `childPhases` in the board response
- `packages/web/src/server/routes/board.ts:149-156` — add
  `childPhases: children.map((t) => t.status?.phase ?? 'pending')` to each
  `childProgressMap` entry (same `children` array, same order as `childRefs`).
- `packages/web/src/client/lib/types.ts:43-48` — add `childPhases?: TaskPhase[]`
  to `Task.childProgress`; extend the `@percussionist/api` type import at line 7
  with `TaskPhase`.
- `packages/web/tests/board-display-refs.test.ts:149-192` — extend the existing
  childProgress test: assert `childPhases` length/alignment (e.g. child B is
  `'done'`, child A is not), and add a case with ≥2 children in mixed phases.
- Acceptance: server test passes; `childPhases` is aligned with `childRefs` by
  index; existing fields unchanged.

### BUILD 2 — Client rendering: green checkmark on done children
- `packages/web/src/client/components/board/display-refs.ts` — add
  `getChildPhasePresentation(task: Task, index: number): { done: boolean }`
  (true iff `task.childProgress?.childPhases?.[index] === 'done'`; false when
  the array is absent — graceful degradation on stale responses).
- `packages/web/src/client/components/board/TaskDetailPanel.tsx:895-914` — in
  the child-list `map`, branch on the helper: `done` → `CheckCircle2` with
  `text-green-500` (matches line 464), else `Wrench`; add
  `title`/`aria-label` ("Done" / "In progress"). Keep click-to-navigate row
  behavior and `getChildRefPresentation` label/tooltip intact.
- `packages/web/tests/board-display-refs-client.test.ts` — unit test the helper
  (done / not-done / missing `childPhases`).
- New `packages/web/tests/task-detail-child-progress.test.tsx` — component test
  following the `task-detail-answer.test.tsx` harness: render a PLAN task in
  `awaiting-children` with `childProgress` incl. `childPhases`; assert a green
  checkmark (`text-green-500` / accessible name "Done") for the `done` child and
  the wrench for the non-done child.
- Acceptance: visual/behavioral requirement met (green checkmark on completed
  children); non-done children unchanged; `pnpm typecheck && pnpm lint && pnpm
  test` (web) green; no regressions in `board-view.test.tsx` (mocks
  TaskDetailPanel wholesale — unaffected) or `task-detail-*.test.tsx`.

### BUILD 3 — Verification
- Run `pnpm typecheck`, `pnpm lint`, `pnpm test` from repo root; confirm the web
  suite stays green and the new tests are picked up by existing scripts.
- Manually sanity-check via `kubectl port-forward` + board UI on a project with
  an `awaiting-children` PLAN (optional; not a CI gate).
- Acceptance: green CI-equivalent local run.

## Acceptance criteria (overall)

1. In `TaskDetailPanel`'s Child Tasks list, every child with `status.phase ===
   'done'` shows a green checkmark (green `CheckCircle2`), and non-done children
   show the existing wrench icon.
2. The board response includes `childPhases`, aligned by index with `childRefs`
   and `childDisplayRefs`; `completed`/`total` semantics unchanged (`done` only).
3. Graceful degradation: if `childPhases` is absent (stale cached response), all
   children render as today (wrench, no checkmark); no crash.
4. No CRD/schema/migration changes; `childProgress` remains a server-computed
   view field only.
5. Server unit test, client helper unit test, and a `TaskDetailPanel` component
   test cover the new behavior; `pnpm typecheck && pnpm lint && pnpm test` pass.

## Risks / open questions

1. **Definition of "completed"**: the checkmark matches the existing
   `completed` count (`phase === 'done'`). Children in `failed`/`awaiting-human`
   keep the wrench; if the reviewer wants richer status icons (failed = red X,
   etc.), that is a follow-up, out of scope here.
2. **Optional-field staleness**: the board response is fetched fresh on each
   load; `childPhases?.[index]` optional chaining covers any transient cache.
   The memo comparator for `TaskDetailPanel` (`resourceVersion`-based,
   `TaskDetailPanel.tsx:1380-1389`) needs no change since the whole task object
   flows through `resourceVersion`.
3. **Icon/color consistency**: `text-green-500` + `CheckCircle2` is the
   file-local precedent (line 464) and is also used elsewhere (`Check` icons in
   TaskRow use `text-phase-succeeded`). `text-green-500` is chosen to match the
   checkmark-like precedent; flag if the reviewer prefers the theme token.
4. **Test isolation**: the new component test must keep the
   `task-detail-answer.test.tsx` conventions (`mock.module` for `api`; real
   QueryClient + MemoryRouter); the web suite runs with `--isolate` — do not
   introduce static top-level stubs.
