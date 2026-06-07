# Plan: Fix Stats page tab bar clipping on mobile

## Context

- The Stats screen tab UI is implemented in `packages/web/src/client/components/StatsView.tsx`.
- The tab strip (`/* Tab toggle */`) currently renders as a plain horizontal flex row:
  - container class: `"flex gap-1 border-b border-border"` (around line ~965)
  - tab buttons use `px-4 py-2` with icon + text for five tabs (`Overview`, `Sessions`, `Agents`, `Models`, `Tools`).
- On narrow viewports, this row can exceed available width, but the container is not scrollable and the labels are not constrained to a single-line scroll strip.
- `packages/web/src/client/components/Layout.tsx` sets `main` to `overflow-x-hidden`, so content that extends horizontally is clipped unless the component itself provides an internal horizontal scroller.
- Similar mobile-safe tab behavior already exists elsewhere (e.g. `SettingsPage.tsx` uses `overflow-x-auto` on its tab bar, and `TaskDetailPanel.tsx` uses `overflow-x-auto` with `whitespace-nowrap` tab buttons).

## Scope boundaries

### In scope
- Frontend-only fix for Stats page tab bar responsiveness in `StatsView.tsx`.
- Minimal class-level styling adjustments to ensure all stats tabs remain reachable on mobile.
- Optional small accessibility/UX polish tied directly to horizontal scrolling behavior (e.g. preserve touch momentum scrolling classes).

### Out of scope
- Changes to stats data fetching, chart/table logic, API routes, or backend code.
- Broad design-system refactors across unrelated pages.
- Any behavior changes to which tab content is shown.

## Approach

1. Convert the Stats tab strip into an explicit horizontal scroll container on small screens.
2. Keep desktop behavior visually equivalent (same tab order, active state styles, borders) while making overflow intentional on mobile.
3. Prevent tab label wrapping/shrinking so each trigger remains legible and discoverable by horizontal swipe.
4. Validate no regression in keyboard/tab interaction and ensure the active indicator remains visible while scrolling.

## Tasks

1. **Update Stats tab container for horizontal scrolling**
   - File: `packages/web/src/client/components/StatsView.tsx`
   - Change the tab row wrapper near the `/* Tab toggle */` block to include mobile-safe horizontal overflow behavior (e.g. `overflow-x-auto`, optional scrollbar suppression class, and width constraints that allow internal scroll instead of clipping).

2. **Make tab triggers non-wrapping, non-collapsing chips**
   - File: `packages/web/src/client/components/StatsView.tsx`
   - Ensure each tab button keeps its full label/icon shape in a scroll row (e.g. `shrink-0` and/or `whitespace-nowrap`) so tabs do not compress into unreadable widths.

3. **Keep desktop layout parity**
   - File: `packages/web/src/client/components/StatsView.tsx`
   - Verify class combination still renders the same desktop strip (no accidental wrapping, spacing regressions, or border offsets).

4. **Cross-check consistency against existing patterns**
   - Reference files:
     - `packages/web/src/client/components/SettingsPage.tsx`
     - `packages/web/src/client/components/board/TaskDetailPanel.tsx`
   - Align Stats tab implementation with existing project conventions for horizontal tab overflow rather than inventing a one-off pattern.

5. **Verify behavior manually in mobile widths**
   - Confirm at narrow widths (e.g. ~320–430px) that:
     - rightmost tabs are accessible via horizontal swipe,
     - tabs are no longer cut off,
     - active tab border/text state remains correct,
     - no horizontal page-level overflow is introduced outside the tab strip.

6. **Run quick regression checks for the web package**
   - Run at minimum relevant checks used in this repo workflow (type/build or targeted web build check) to ensure no compile/runtime breakage from class updates.

## Acceptance criteria

1. On mobile viewport widths, all Stats tabs (`Overview`, `Sessions`, `Agents`, `Models`, `Tools`) are reachable by horizontal scrolling.
2. No tabs are visually truncated/cut off by the viewport edge without a way to reach them.
3. Desktop tab appearance and interaction remain unchanged from current behavior.
4. Tab switching still works identically (no state/logic regressions).
5. No new horizontal overflow appears at the page level outside the tab component.

## Proposed BUILD task breakdown

1. **BUILD A — Implement mobile-scrollable Stats tab strip**
   - Update `StatsView.tsx` container + button classes for horizontal overflow and no-wrap behavior.
   - Deliverable: code diff that resolves clipping on narrow screens.

2. **BUILD B — Responsive QA + parity validation**
   - Validate mobile interaction and desktop parity; adjust minor class details if needed.
   - Deliverable: verified behavior across mobile/desktop breakpoints, with no regression in tab switching.

3. **BUILD C — Lightweight safeguard checks**
   - Run relevant web/type/build verification and record results in task notes.
   - Deliverable: passing checks confirming the styling update is safe to merge.

## Risks / open questions

1. **Scrollbar visibility tradeoff**
   - If scrollbar hiding utilities are used, discoverability of scroll may depend on touch gestures. Need to keep interaction intuitive while preserving visual cleanliness.

2. **Pattern duplication vs reuse**
   - Stats currently uses custom buttons rather than shared `ui/tabs`; this fix should stay minimal, but a later consistency pass may choose to standardize all tab bars.

3. **Mobile-only validation dependency**
   - The bug is viewport-dependent; if not tested in actual mobile-size rendering, clipping could appear resolved in desktop-only validation but still regress on devices.
