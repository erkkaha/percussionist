# Focus mode — manual acceptance checklist

Component tests for the "Expandable Board Task Detail View (focus mode)" feature
live in `packages/web/tests/task-detail-focus.test.tsx` and
`packages/web/tests/board-view-focus.test.tsx`. They cover the toggle wiring
and the two layout effects (desktop list collapse, mobile Sheet full-bleed).

The following manual checks require a real browser / device and are **not**
covered by the unit tests — run them before declaring the feature done.

## Desktop (≥768px, `md:` breakpoint)
- [ ] Open a task that has a diff. The task list sits at ~40% width
      (`md:w-2/5`) and the detail panel fills the rest.
- [ ] Click the **Maximize2** ("Expand to full width") button in the detail
      header.
- [ ] The task list disappears (`md:hidden`) and the detail panel (Diff +
      findings) now uses the full board width.
- [ ] Click again (**Minimize2**, "Collapse task list"). The list returns.

## Foldable unfolded (>640px, `sm:` breakpoint)
- [ ] Open a task on an unfolded foldable (viewport >640px). The mobile Sheet
      is normally capped at `sm::max-w-lg` (512px).
- [ ] Click Expand. The detail Sheet goes **edge-to-edge** — the
      `sm:max-w-lg` cap is replaced by `max-w-none` (`sm:max-w-none`), so the
      diff uses the entire unfolded screen.

## Foldable folded / narrow (<640px, or generally narrow)
- [ ] On a narrow viewport the diff and finding comments remain readable; the
      toggle still works and the full-bleed Sheet gives the diff as much room
      as possible.

## Findings panel
- [ ] The Findings panel toggle in the board header still works on desktop.
- [ ] Toggling focus mode does not break or disable the Findings panel; the two
      controls are independent.
- [ ] **Focus mode + Findings panel: no overlap of the severity chips.** With a
      task open, the Findings panel visible (header "Findings" button), and a
      diff containing a very long path, toggle **Expand to full width**. The
      detail panel must shrink within its flex share and must **not** overlap the
      Findings panel's severity filter chips at the top of the right-hand panel.
      Toggle focus off and confirm the chips are still fully visible and
      clickable.
- [ ] With the Findings panel closed, repeat the focus toggle with a long-path
      diff and confirm the detail panel does not overlap the task-list
      `FilterBar` chips on the left.

## Long-path diff overflow
- [ ] Open a task whose diff contains a ~200-character file path. The FileDiff
      card stays within the detail panel's column; the page acquires **no**
      horizontal scrollbar.
- [ ] The FileDiff header path is ellipsized (`truncate`) and hovering it shows
      the full path via its `title` tooltip.
- [ ] Expand the card. Any "Unmapped findings" anchor path wraps onto multiple
      lines (`break-all`) instead of widening the card, and hovering the anchor
      path shows the full `path:side:line` string.
- [ ] In the Diff tab's ref banner, long `Base` / `Head` / `Default` branch refs
      wrap within the banner instead of widening the panel.
- [ ] Switch to the Commits view with a long commit subject; the subject
      truncates rather than pushing the file count off-screen.

## Regressions
- [ ] `bun test --isolate` passes for `board-view.test.tsx`,
      `board-view-focus.test.tsx`, `file-diff-overflow.test.tsx`,
      `filter-bar-wrap.test.tsx`, and the `task-detail-*.test.tsx` suites.
- [ ] No console errors / React warnings when toggling focus repeatedly or
      while switching between tasks (focus intentionally persists across task
      switches, and resets on close/deselect).
