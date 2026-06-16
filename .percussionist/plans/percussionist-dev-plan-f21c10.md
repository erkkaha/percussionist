# Plan: sidebar usage tracker expand/collapse mode

## Context

- The sidebar footer renders usage tracking via `UsageBar` in `packages/web/src/client/components/app-sidebar.tsx`.
- Current `UsageBar` (`packages/web/src/client/components/UsageBar.tsx`) is a single compact mode:
  - one thin stacked bar for `reviewing/planning/other`
  - one label line (`"xh ym today"` or percent text)
  - settings button (`UsageSettingsPopover`) and active-category dot
  - hidden label text in sidebar icon-collapsed mode via `group-data-[collapsible=icon]:hidden`
- Usage data already includes category totals from local + server cache (`readTodayUsage`, `getServerCache`) and category colors from `usage-categorization.ts`; no backend/API changes are required for this UI request.
- Sidebar already supports desktop collapse/expand state (`useSidebar` in `components/ui/sidebar.tsx`), but `UsageBar` itself does not have an internal display mode toggle.

## Scope boundaries

### In scope

- Add an internal **display mode toggle** to sidebar `UsageBar` (compact vs expanded).
- Keep compact mode visually equivalent to current behavior (“collapsed should show as is”).
- Add expanded mode with:
  - visible section labels per category
  - separate bars (one row per category) instead of one merged stacked bar
- Keep existing usage settings popover and lock/max visual cues functional.

### Out of scope

- Any server/API/storage changes (`/api/usage/*`, schema, heartbeats).
- Changes to usage tracking logic (`useUsageTracker`) or categorization semantics.
- New dashboard pages or non-sidebar usage UI redesign.

## Assumptions

1. “Collapsed should show as is” means the current compact `UsageBar` layout and behavior should remain the default/fallback mode.
2. The new expanded/collapsed toggle is for the usage tracker module itself, independent of the main sidebar open/closed state.
3. Expanded view should remain readable within the sidebar footer width without introducing new global CSS files.

## Approach

1. **Introduce local UI state in `UsageBar`** for display mode (`compact` / `expanded`) with a small toggle control.
2. **Refactor rendering** in `UsageBar` into two branches:
   - Compact branch: preserve existing stacked bar + single label text.
   - Expanded branch: render per-category rows with label, bar, and value/percent.
3. **Compute shared normalized values once** (totals, max-time denominator, per-category percentages) and reuse in both branches to avoid divergence.
4. **Respect sidebar icon-collapsed behavior** by hiding expanded details and forcing compact rendering when parent sidebar is icon-collapsed.
5. **Optionally persist mode in localStorage** so user preference survives reload (small, isolated key under web client namespace).

## Tasks

1. **Map current compact behavior into explicit reusable helpers**
   - In `UsageBar.tsx`, extract existing calculations for totals, max-time percentage, warning classes, and label text into local constants/helpers.
   - Preserve exact current compact output strings and warning thresholds.

2. **Add usage tracker view-mode state**
   - Add local state (e.g. `viewMode`) in `UsageBar` with default `compact`.
   - Add a compact toggle button near `UsageSettingsPopover` (use existing icon system from `lucide-react`, with accessible label/title).
   - Ensure control has clear affordance in narrow footer space.

3. **Implement compact-mode render path (unchanged visual contract)**
   - Keep current merged stacked progress bar and active-category indicator dot.
   - Keep existing bottom label line and current `group-data-[collapsible=icon]:hidden` semantics.
   - Ensure no spacing regressions in `SidebarFooter`.

4. **Implement expanded-mode render path with section labels + separate bars**
   - Render three rows in `SEGMENT_ORDER` (`reviewing`, `planning`, `other`).
   - For each row, show:
     - label text (humanized category name)
     - separate horizontal bar using `CATEGORY_COLORS[cat]`
     - numeric context (duration and/or percent, aligned with `showPercent` preference)
   - Retain max-limit context (e.g., denominator `maxSeconds` when enabled) and visual warning cues where appropriate.

5. **Integrate with sidebar icon-collapsed state**
   - Use `useSidebar()` state from `components/ui/sidebar.tsx` inside `UsageBar` (or compatible prop plumbing) so that when main sidebar is icon-collapsed, expanded details do not render.
   - In icon-collapsed sidebar mode, always show compact tracker surface to match existing UX constraints.

6. **(Optional but recommended) persist user mode preference**
   - Store/retrieve `UsageBar` mode with a dedicated localStorage key (e.g. `percussionist:usagebar:view-mode`).
   - Guard against invalid stored values.

7. **Polish accessibility and interaction states**
   - Add `aria-label`, `title`, and keyboard-focus-visible styles to the mode toggle.
   - Verify tooltip/popover interactions are not obstructed by new controls.

8. **Regression checks in sidebar contexts**
   - Validate desktop expanded sidebar, desktop icon-collapsed sidebar, and mobile sidebar sheet.
   - Verify active-category dot still reflects route category.
   - Verify settings changes (`showPercent`, `maxTimeHours`) update both compact and expanded rendering coherently.

9. **Add/adjust UI tests if harness exists**
   - If component tests exist for web client UI, add focused tests for:
     - mode toggle switches views
     - compact mode preserves old layout contract
     - expanded mode shows three labeled bars
     - icon-collapsed sidebar suppresses expanded details

## Acceptance criteria

1. Sidebar usage tracker has a user-toggleable compact/expanded mode.
2. Compact mode visually and behaviorally matches current tracker layout.
3. Expanded mode shows labeled sections and separate bars for reviewing/planning/other.
4. In sidebar icon-collapsed state, tracker remains compact and does not overflow.
5. Existing usage settings popover and usage warning/max-limit cues continue to work.

## Proposed BUILD task breakdown

1. **BUILD A — UsageBar state + rendering refactor**
   - Add mode state/toggle and split compact vs expanded render paths in `UsageBar.tsx`.

2. **BUILD B — Sidebar integration + persistence polish**
   - Ensure icon-collapsed compatibility via `useSidebar`, optional mode persistence, and interaction/accessibility refinements.

3. **BUILD C — Verification/tests**
   - Add focused tests (if available) and perform manual regression validation for desktop/mobile/sidebar states.

## Risks / open questions

1. **Spec ambiguity on per-row values**
   - “labels for sections and separate bars” does not explicitly require durations vs percentages per row; implementation should pick one clear default (or follow `showPercent`) and keep it consistent.

2. **Footer density constraints**
   - Sidebar footer is narrow; expanded mode may feel cramped. Spacing and typography may need iteration to avoid visual noise.

3. **Mobile sheet behavior**
   - On mobile, sidebar opens as a sheet; expanded usage mode could consume vertical space. May require conservative defaults (e.g., start compact).

4. **Potential naming confusion**
   - Request says “collapsed should show as is” while sidebar already has a collapsed state; implementation should clearly distinguish “usage tracker mode” from “sidebar collapse state” in code comments and naming.
