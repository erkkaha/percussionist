# Plan: Make Stats Models table horizontally scrollable on mobile

## Context

- The Stats page is rendered in `packages/web/src/client/components/StatsView.tsx`.
- The Models tab uses `ModelBreakdown()` (around lines 217–277) to render the models table.
- Current Models table structure uses:
  - outer card container: `rounded-lg border ... overflow-hidden`
  - table: `<table className="w-full text-sm">`
- Unlike other mobile-safe tables (for example `RunList.tsx`, which uses `overflow-x-auto` + `min-w-[640px]`), this Models table has no horizontal scroll container and no enforced minimum table width. On narrow viewports, columns compress instead of creating a scrollable overflow region.
- The app shell in `Layout.tsx` uses `main` with `overflow-x-hidden`, so page-level horizontal overflow is intentionally clipped. Any wide table must provide its own internal horizontal scroller.

## Scope boundaries

### In scope
- Frontend-only fix for the Models table in Stats page mobile layout.
- `packages/web/src/client/components/StatsView.tsx` (`ModelBreakdown` only, unless a tiny shared style helper is needed).
- Class-level UI/layout adjustments to enable horizontal scrolling on small screens.

### Out of scope
- Backend stats endpoints (`packages/web/src/server/routes/stats.ts`) and data model changes.
- Redesigning the Stats page information architecture.
- Broad refactors for all tables in the app (can be follow-up hardening if desired).

## Approach

1. **Adopt existing table-overflow pattern used elsewhere in the app**
   - Wrap the Models table in an explicit horizontal scroll container (`overflow-x-auto`) with touch momentum (`-webkit-overflow-scrolling: touch`, via utility/class if needed).
   - Keep the current card styling while moving clipping responsibility to an inner scroll wrapper.

2. **Force real horizontal overflow at small widths**
   - Add a minimum width to the table (e.g. `min-w-[680px]` or similar tuned width) so the table remains readable and becomes scrollable on narrow screens.
   - Prevent critical header/data cells from wrapping unpredictably (`whitespace-nowrap` on numeric headers/cells and short labels as appropriate).

3. **Preserve current desktop behavior**
   - Keep `w-full` and existing visual styling so desktop layout remains unchanged while mobile gains horizontal pan.
   - Keep model-name truncation behavior (`max-w` + `truncate`) so long model IDs still render cleanly.

4. **Validate on actual narrow breakpoints**
   - Manual verification in browser responsive mode (320px, 375px, 390px, 430px, 768px).
   - Ensure tab switching and scrolling gestures work (horizontal in table, vertical page scroll outside table).

## Acceptance criteria

1. In `StatsView` → Models tab, the Models table can be horizontally scrolled on mobile viewport widths (≤768px).
2. At least the rightmost columns (e.g. `Cost`, `Token Share`) remain reachable via horizontal pan on narrow screens.
3. Desktop/tablet layout remains visually equivalent to current behavior (no regression in spacing or readability).
4. No TypeScript/build regressions from the UI change.
5. Touch scrolling remains smooth on mobile browsers (or responsive emulation), with no full-page sideways shift.

## Tasks (implementation steps)

1. Update `ModelBreakdown` in `packages/web/src/client/components/StatsView.tsx`:
   - Replace the non-scrollable table container with a nested scroll wrapper (`overflow-x-auto`) inside the card.
2. Set explicit table minimum width in Models tab:
   - Add `min-w-[...]` (target width chosen to fit all columns comfortably) while preserving `w-full`.
3. Harden table cell/header wrapping behavior:
   - Add `whitespace-nowrap` to headers and numeric/text cells where wrapping hurts readability.
4. Verify no clipping regression from parent layout:
   - Confirm compatibility with `Layout.tsx` `overflow-x-hidden` by ensuring overflow is internal to the Models table wrapper.
5. Manual QA pass:
   - Stats page Models tab at mobile widths: horizontal scroll works and reaches final column.
   - Regression spot-check Sessions/Agents tabs for unchanged behavior.
6. Run standard checks expected by repo workflow:
   - `pnpm typecheck`
   - `pnpm build` (or package-equivalent build if full build is too heavy in CI context).

## Proposed BUILD task breakdown

1. **BUILD A — Mobile overflow fix for Stats Models table**
   - Implement `ModelBreakdown` scroll container + min table width + nowrap hardening.
   - Validate in responsive view and run type/build checks.

2. **(Optional follow-up) BUILD B — Stats tables mobile consistency sweep**
   - Audit other Stats tab tables (`AgentCharts` detail table, etc.) for the same pattern and align them to a shared responsive table convention.

## Risks / open questions

1. **Minimum width tuning**
   - Too small: columns still cramped; too large: excessive horizontal pan. Choose width based on real content in the Models tab.

2. **Utility-only vs shared class**
   - Decide whether to keep this as inline Tailwind utilities in `StatsView.tsx` or introduce a reusable table-scroll class for consistency.

3. **Potential adjacent issue in Stats Agent table**
   - The Agents detail table in `StatsView.tsx` also uses `overflow-hidden` without explicit horizontal scroll. Not required for this task, but likely similar on very narrow devices.
