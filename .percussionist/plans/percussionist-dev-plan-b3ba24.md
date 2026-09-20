# Plan: Board UI fixes — diff filename overflow + focus-mode overlap

Task: `percussionist-dev-plan-b3ba24`

## Context

Two visual defects in the board / task-detail web UI:

1. **Diff view long filenames can extend the table too wide.**
2. **Task focus mode overlaps filter buttons.**

The relevant client code lives in `packages/web/src/client/components`:

- `BoardView.tsx` — board body flex row: task-list column (`TaskListPanel`) + desktop
  detail panel (`TaskDetailPanel`) + optional Findings panel.
  - Body row: L194 `<div className="flex flex-1 min-h-0">`.
  - Task-list column: L196-198, `min-w-0 w-full` and `md:hidden` when `detailFocused`.
  - Desktop detail wrapper: L217-224, `hidden md:flex flex-col flex-1 min-h-0`
    (testid `desktop-detail-panel`) — **no `min-w-0`**.
  - Findings panel: L227-234, `w-80 shrink-0` (testid `desktop-findings-panel`).
  - Mobile detail Sheet inner wrapper: L244, `flex-1 min-h-0 overflow-hidden flex flex-col`
    — **no `min-w-0`**.
- `TaskDetailPanel.tsx` — inside the detail panel.
  - Panel root: L1097-1100 `flex flex-col h-full min-h-0 border-l border-border`.
  - Tab content scroll region: L1421 `<div className="flex-1 overflow-y-auto">`.
  - Diff tab `DiffContent`: L327-560. Ref banner L387-393 renders
    `baseRef` / `headRef` / `defaultRef` as `font-mono` spans with no wrap/truncate.
  - Diff header of the *task* (branch/PR) already uses `truncate max-w-full` (L617, L625).
- `FileDiff.tsx` — per-file diff card used by the Diff tab, the Commits view, the
  Session view and the timeline.
  - Card root: L260 `rounded-lg border ... overflow-hidden`.
  - Header button: L262-265 `flex items-center gap-2 w-full ...` (no `min-w-0`).
  - File-path label: L273 `<span className="text-sm font-mono text-text flex-1 text-left truncate">`
    (no `min-w-0`, no `title`).
  - Diff body scroll wrapper: L336 `<div className="overflow-x-auto text-xs font-mono">`.
  - "Unmapped findings" anchor-path paragraph: L376-383 `text-[10px] ... font-mono`
    rendering `path:side:line-line` strings with no `break`/`truncate`.
- `OrphanFindings.tsx` — same unbreakable anchor-path paragraph at L85-92.
- `board/FilterBar.tsx` — filter pills. Column-tab row L31 has `overflow-x-auto`,
  `flex-wrap`, and `shrink-0` pills (`pillBase`). Type/priority chip groups L81-93 and
  L96-108 are single-line `flex` groups that cannot wrap internally.

### Existing layout guards (context, not bugs)

- The task-list column already carries `min-w-0` (added by commit `813de7a3` precisely to
  stop it competing with the findings panel) and the findings panel is `w-80 shrink-0`.
- The desktop detail wrapper is the **only** flex sibling in the body row that still lacks
  `min-w-0`.

## Problem analysis

### Common root cause: missing `min-w-0` on unbreakable content

Both symptoms are consistent with a single flexbox failure mode:

> A `flex-1` flex item with the default `min-width: auto` refuses to shrink below the
> min-content width of its contents. When that content contains an unbreakable string
> (a long file path, branch ref, or anchor path), the item grows past its share of the
> row and overlaps / crushes its flex siblings.

The task-list column was already given `min-w-0`, so the detail panel is the item that
misbehaves. In particular:

- The **FileDiff card header path** (L273) has `truncate` but its flex parent has no
  `min-w-0`; the same pattern in the commit header (L288) is unguarded.
- The **"Unmapped findings" anchor path** (FileDiff L376-383) and the **OrphanFindings
  anchor path** (L85-92) are unbreakable `font-mono` strings inside a block that
  propagates its min-content width up to the detail panel.
- The **ref banner** (DiffContent L387-393) renders arbitrarily long branch names as
  unbreakable `font-mono` spans.

### Bug 1 — diff view long filenames extend the table

The file-path label in the FileDiff header, the unmapped-finding anchor paths, and the
base/head/default refs are the unbreakable strings. When one is long, the FileDiff card —
and the `<table class="diff">` it contains (react-diff-view sets `.diff { width: 100% }`
but the card is what grows) — extends past the detail panel's column.

### Bug 2 — task focus mode overlaps filter buttons

When a task is open (`detailPanel`) and the detail wrapper lacks `min-w-0`, wide diff
content makes the wrapper grow past its `flex-1` share. The body row then has
`list(min-w-0, can shrink) + detail(won't shrink) + findings(w-80 shrink-0)`, so the
detail panel is drawn over its neighbour. The visible "filter buttons" in that state are
the **Findings panel severity filter chips** (FindingsPanel L154-182), which sit at the
top of the `w-80 shrink-0` panel immediately to the right of the detail panel. (When
focus mode is on, the task-list `FilterBar` is inside the `md:hidden` list column, so the
Findings chips are the filter buttons still on screen.) The same mechanism also lets the
detail panel overlap the task-list column's `FilterBar` when the findings panel is closed
and the task-list column has been shrunk.

## Assumptions

- "Diff view long filenames" means the file-path/anchor/ref strings listed above (the
  Diff tab and the reusable `FileDiff` card), not the `react-diff-view` `<table>` code
  cells (those already wrap via the library's `word-break: break-all`).
- "Task focus mode overlaps filter buttons" means the expanded/open detail panel
  overlapping the adjacent panel's filter controls (Findings severity chips, and the
  task-list FilterBar) — i.e. the missing `min-w-0` overlap. The exact repro (findings
  panel open vs. closed, focus on vs. off) must be confirmed visually in BUILD-1; the
  structural fix below is the same either way.

## Approach

Constrain the detail panel and its unbreakable content so it can never exceed its flex
share, and guarantee the long-path strings ellipsize or wrap instead of setting a large
min-content width. Keep the change CSS-only (Tailwind utility classes + `title`
attributes); no data flow, API, or server changes.

Principles:

- Add `min-w-0` to every flex item in the chain from the body row down to the scroll
  region (the detail wrapper, the detail panel root, the tab content wrapper).
- Add `min-w-0`/`max-w-full` to the `FileDiff` card root and header, and make the path
  label explicitly shrinkable with a `title` so the full path is still discoverable.
- Make unbreakable path strings (`unmapped findings` anchor paths, orphan anchor paths,
  ref banner) wrap with `break-all` (or truncate with `title` for the refs).
- Keep the existing `overflow-x-auto` diff wrapper as the only horizontal scroll region;
  it already confines `.diff`.
- Add regression tests that assert the className contracts and the `title` fallback, plus
  a manual visual checklist entry.

## Tasks

1. **Reproduce and capture (BUILD-1 prerequisite).** Run `pnpm web` (or `pnpm web:client`)
   and open `/projects/<p>/board?task=<t>` for a task with a diff containing a very long
   path. Confirm (a) the FileDiff card / diff table extends past its column and (b) with
   the Findings panel open (header "Findings" button), toggling **Expand to full width**
   makes the detail panel overlap the findings severity chips. Note the exact viewport
   widths. Record a before screenshot in the PR description.

2. **Constrain the `FileDiff` card** (`packages/web/src/client/components/FileDiff.tsx`):
   - L260 root: add `min-w-0 max-w-full`.
   - L265 header button: add `min-w-0`.
   - L273 path span: add `min-w-0`, keep `truncate`, and add `title={displayPath}` so the
     ellipsized path is still readable on hover.
   - L336 diff body wrapper: add `min-w-0 max-w-full` (keep `overflow-x-auto`).

3. **Wrap unbreakable diff paths** (`FileDiff.tsx` L376-383):
   - Add `break-all` to the unmapped-findings anchor-path `<p>` and a `title` with the
     joined path string.
   - Mirror the same change in `OrphanFindings.tsx` L85-92.

4. **Constrain the ref banner** (`TaskDetailPanel.tsx` L387-393):
   - Make the row `flex flex-wrap items-center gap-x-2 gap-y-0.5` (replace the literal
     double-space separators) or add `break-all`/`min-w-0 truncate` to each ref span so a
     long branch name wraps/truncates instead of widening the panel.

5. **Constrain the detail panel flex chain** (`BoardView.tsx`,
   `TaskDetailPanel.tsx`):
   - `BoardView.tsx` L220 `desktop-detail-panel`: add `min-w-0` (and consider
     `overflow-hidden` to clip any residual overflow).
   - `BoardView.tsx` L244 mobile Sheet inner wrapper: add `min-w-0`.
   - `TaskDetailPanel.tsx` L1099 panel root: add `min-w-0`.
   - `TaskDetailPanel.tsx` L1421 tab content: add `min-w-0` (and `overflow-x-hidden` if
     repro shows a stray child forcing width).

6. **Harden the commit header truncation** (`TaskDetailPanel.tsx` L275-292):
   - Add `min-w-0` to the commit header button (L277) and to the subject span (L288) so
     `truncate` is guaranteed to bind on the flex item.

7. **Harden the filter chips so they cannot spill under the detail panel**
   (`board/FilterBar.tsx`):
   - Add `flex-wrap` to the type group (L81) and priority group (L96), and add `min-w-0`
     to the outer search/chips row (L60) and the search wrapper (L61).
   - This keeps the chips wrapping inside the task-list column rather than overflowing
     under the detail panel when the column is narrow.

8. **Regression tests** (see Test plan) under `packages/web/tests/`.

9. **Update the manual checklist** `packages/web/tests/focus-mode-manual-checklist.md`
   with a "long-path diff" section and an explicit "focus mode + Findings panel: no
   overlap of the severity chips" check.

## Test plan

Web tests run with `bun test --isolate --preload ./tests/setup.ts tests/` (see
`packages/web/package.json`). `--isolate` is mandatory because `mock.module` is
process-global (`AGENTS.md`); do not stub a module that is the subject of another suite.

1. **New `packages/web/tests/file-diff-overflow.test.tsx`.**
   Render the real `FileDiff` with:
   - a ~200-char `path`, and
   - `findings` containing an anchor whose path is long (forces the unmapped-findings
     block), and
   - a minimal valid unified diff for the "expand" path.
   Assert:
   - card root `className` contains `min-w-0` and `max-w-full`;
   - header path span has `min-w-0`, `truncate`, and `title` equal to the path;
   - the unmapped anchor-path `<p>` contains `break-all`.
   `FileDiff` imports `react-diff-view/style/index.css`, which the existing
   `session-view-todowrite.test.tsx` already exercises indirectly, so the import is safe
   in bun's test runner.

2. **Extend `packages/web/tests/board-view-focus.test.tsx`.**
   Add assertions that the `desktop-detail-panel` wrapper has `min-w-0` in both the
   unfocused and focused cases, without weakening the existing
   `md:hidden` / `max-w-none` assertions.

3. **New `packages/web/tests/filter-bar-wrap.test.tsx`.**
   Render `FilterBar` with a `columnCounts` map and assert the type/priority groups carry
   `flex-wrap` (or that the root chip row does). Keep it a pure component test with no
   BoardView mocking.

4. **Full gates:** `pnpm typecheck` and `pnpm test`. If a test proves the CSS contract is
   already satisfied (e.g. jsdom normalizes nothing), assert on the literal className
   strings as the existing board tests do.

## Risks / open questions

- **Exact overlap repro is unverified by static analysis.** The `min-w-0` chain is the
  most likely fix, but BUILD-1 must confirm the overlap target (Findings chips vs.
  task-list FilterBar) and whether `overflow-hidden` on the detail wrapper is needed.
  If the repro shows the Findings panel should simply be hidden while focused, that is
  the alternative already flagged in the original focus-mode plan
  (`percussionist-dev-plan-0a0b7f`, Risks) — gate the `showFindings` block on
  `!detailFocused` — but prefer the non-destructive width fix first.
- **`min-w-0` changes width distribution.** Adding it to `desktop-detail-panel` can, in
  pathological cases, let the list column keep more than 40% if the detail content is
  wide. Manually verify the 40/60 split still looks right with a normal task and with the
  findings panel open.
- **`overflow-x-hidden` on the tab content could clip focus rings/shadows.** Prefer
  leaving it out unless the repro requires it; the FileDiff `overflow-x-auto` wrapper is
  the intended scroll region.
- **react-diff-view global CSS.** Its `.diff-code { word-break: break-all }` already wraps
  code; do not override it. The fix is around the card, not the table.
- **Global module mocks.** Any new test must run under `--isolate` and avoid stubbing
  shared modules; follow the notes at the top of `board-view.test.tsx`.
- **No server/API changes** are expected; if the diff response itself returns paths with
  unusual characters, confirm `normalizeAnchorPath` is applied consistently (already used
  in path comparisons and the unmapped-path render).

## Acceptance criteria

1. A file-path label that is too long for the diff column is ellipsized, and hovering it
   shows the full path; the FileDiff card does not grow beyond the detail panel.
2. Long unmapped-finding anchor paths and long base/head/default refs wrap (or truncate)
   instead of widening the card; the page acquires no horizontal scrollbar.
3. With a task open and the Findings panel visible, toggling focus mode (Expand to full
   width) does not visually overlap the Findings panel severity filter chips; the detail
   panel shrinks within its flex share.
4. With no Findings panel, the detail panel does not overlap the task-list `FilterBar`.
5. `pnpm typecheck` and `pnpm test` (including the new tests under `--isolate`) pass.
6. The updated manual checklist covers the long-path diff case and the focus + findings
   overlap case.

## Proposed BUILD task breakdown

- **BUILD-1 (web/ui):** Reproduce both defects and capture before-screenshots; apply the
  `FileDiff` card/header/path constraints and the "unmapped findings"/`OrphanFindings`
  `break-all` fixes (Tasks 2-3) plus the commit-header `min-w-0` (Task 6). Delivers
  bug 1.
- **BUILD-2 (web/ui):** Constrain the detail-panel flex chain (`min-w-0` on
  `desktop-detail-panel`, mobile Sheet inner wrapper, `TaskDetailPanel` root, tab
  content) and fix the ref banner (Tasks 4-5). Delivers bug 2. Depends conceptually on
  BUILD-1's repro but touches disjoint files; may ship in the same PR.
- **BUILD-3 (web/ui):** Harden `FilterBar` chip groups to wrap/shrink (Task 7), only if
  BUILD-1's repro shows the task-list chips spilling under the detail panel.
- **BUILD-4 (web/test):** Add the regression tests and update the manual checklist
  (Tasks 8-9). Depends on BUILD-1/2/3.
