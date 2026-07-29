# Plan: Reduce mobile board header vertical space above filters

## Context

- The board route renders `BoardView` in `packages/web/src/client/components/BoardView.tsx`.
  - The page has a fixed-height shell (`height: calc(100svh - 3.5rem)`) and places `BoardHeader` in a top `shrink-0` section (`px-4 pt-4 pb-3 border-b`) before the task list.
  - On mobile (`useIsMobile()`; `<768px`), the task list still sits below this same header block, so any extra header rows directly reduce the visible area available for filters/tasks.
- `BoardHeader` (`packages/web/src/client/components/board/BoardHeader.tsx`) currently renders several stacked lines on all breakpoints:
  - breadcrumb row (`Projects / {project} / Board`)
  - large title (`h1` with `projectName`)
  - metadata line (`Team`, `Parallel`, `Phase`, auth warning)
  - connection status line (`● live` / `○ polling`)
  - optional metrics row (`Reconciled`, `Pulled`, `Monitored`, error)
  - action buttons (`Code`, `Findings`, `+ Add Task`)
- The user request specifically calls out wasted vertical space above filters on mobile (“team, board name etc. above filters take too much space and give no added value”).
- Filters themselves are rendered by `TaskListPanel` (`packages/web/src/client/components/board/TaskListPanel.tsx`) at the top of the task pane; reducing header height is the direct way to expose more filter/task content without changing filter behavior.

## Scope boundaries

### In scope

- Mobile-first layout changes for board header density on the board page.
- Reducing/removing non-essential informational rows above filters on small screens.
- Keeping desktop behavior intact (or near-identical) unless a tiny shared refactor is required.
- Adding/adjusting client tests for the responsive header behavior.

### Out of scope

- Board API/server changes (`packages/web/src/server/routes/board.ts` etc.).
- Task filtering logic/semantics in `FilterBar`.
- Reworking task list/detail/findings interactions beyond what is needed to preserve current mobile behavior.
- Broader navigation redesign outside board view.

## Assumptions

1. The complaint targets mobile viewport behavior (`<768px`) rather than desktop/tablet widths.
2. The key requirement is to reclaim vertical space before the `Filters` area, not to remove capabilities (add task/findings/code-server access must remain reachable).
3. Metadata such as roster/phase/metrics can be deprioritized or hidden behind a compact affordance on mobile.

## Approach

1. **Introduce responsive header modes in `BoardHeader`**
   - Add an explicit `isMobile` prop (or infer internally with `useIsMobile`, though prop-driven is easier to test and avoids duplicate media hooks).
   - Split render into:
     - **Desktop mode**: preserve current rich header.
     - **Mobile compact mode**: single compact row prioritizing actions and minimal context.

2. **Mobile compact content strategy**
   - Remove/hide high-vertical-cost informational blocks on mobile by default:
     - breadcrumb row,
     - large title,
     - team/parallel/phase sentence,
     - metrics row,
     - standalone live/polling row.
   - Keep a minimal identifier + controls in one row (or two very tight rows max):
     - compact board label (`Board` or truncated project name),
     - `Findings` and `+ Add Task` actions,
     - optional `Code` shortcut if enabled.
   - If status visibility is still desired, move it into a tiny badge/indicator in the same row instead of a dedicated text row.

3. **Tighten mobile container spacing in `BoardView`**
   - Reduce top/bottom/header padding on mobile (`px/pt/pb`) while retaining current desktop spacing.
   - Keep border and `shrink-0` behavior so scrolling/layout contract remains stable.

4. **Guard against regressions with responsive tests**
   - Add component tests (new `board-header.test.tsx` or equivalent) that assert mobile mode omits the verbose metadata rows while preserving action buttons.
   - Add a focused board view test (or header-level class/DOM assertion) that mobile wrapper uses reduced spacing classes.

## Tasks

1. **Refactor `BoardHeader` props for responsive rendering**
   - File: `packages/web/src/client/components/board/BoardHeader.tsx`
   - Add `isMobile` (or `variant`) prop and branch render paths cleanly.

2. **Implement compact mobile header markup**
   - File: `packages/web/src/client/components/board/BoardHeader.tsx`
   - Build a dense mobile header that keeps primary actions (`Findings`, `+ Add Task`, optional `Code`) and minimal board identity only.

3. **Keep desktop header unchanged by default**
   - File: `packages/web/src/client/components/board/BoardHeader.tsx`
   - Ensure existing desktop details (team/phase/metrics/live indicator) remain visible in non-mobile path.

4. **Pass viewport state into header**
   - File: `packages/web/src/client/components/BoardView.tsx`
   - Wire `isMobile={isMobile}` to `BoardHeader`.

5. **Reduce mobile-only outer header padding**
   - File: `packages/web/src/client/components/BoardView.tsx`
   - Replace static `px-4 pt-4 pb-3` with responsive classes (e.g., tighter mobile, current desktop from `md:` upward).

6. **Add/extend board header tests**
   - File(s): `packages/web/tests/board-header.test.tsx` (new) and/or related component tests.
   - Validate:
     - mobile compact mode hides verbose metadata text blocks,
     - mobile still shows actions,
     - desktop still shows metadata.

7. **Run targeted validation**
   - Execute package-level tests relevant to the changed files (web tests and any affected snapshots/assertions).
   - Ensure formatting/linting for touched files is clean.

## Acceptance criteria

- On mobile board view, the area above `Filters` is visibly reduced compared to current behavior.
- Non-essential informational rows (`team/phase/metrics/verbose board header`) are not occupying dedicated vertical lines on mobile.
- `Findings` and `+ Add Task` remain available on mobile header.
- Desktop board header still includes full context (breadcrumbs/title/metadata/metrics/live indicator).
- Automated tests cover mobile vs desktop header behavior and would catch a reintroduction of the verbose mobile header.

## Risks / open questions

1. **How much context to retain on mobile**
   - Removing too much may hurt discoverability (e.g., project identity or live/polling state). Proposed mitigation: keep a compact label/indicator in-row.

2. **Testability of responsive behavior**
   - If implementation relies on runtime media hooks, tests need deterministic control over viewport conditions. Passing `isMobile` explicitly to `BoardHeader` simplifies this.

3. **Potential action crowding on very narrow screens**
   - `Code + Findings + Add Task` might wrap on 320px widths. Mitigation: prioritize `Findings` + `Add Task`, make `Code` optional/compact icon-only on mobile.

4. **Metrics visibility expectations**
   - Some users may rely on reconcile metrics. Consider preserving them only on desktop or behind a future disclosure toggle (not required for this task).

## Proposed BUILD task breakdown

1. **BUILD A — Mobile header compaction implementation**
   - Implement responsive `BoardHeader` mobile variant + `BoardView` mobile spacing updates.
   - Verify mobile interaction parity for add-task/findings sheets.

2. **BUILD B — Responsive regression tests**
   - Add/update tests for `BoardHeader` mobile vs desktop content and action availability.
   - Run web test suite subset for board components.

3. **BUILD C — Final polish and verification**
   - Address visual edge cases (320px wrapping, long project names), ensure class-level consistency, and run formatting/lint checks for touched files.
