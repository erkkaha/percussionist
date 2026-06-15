# Plan: Sidebar session tracking category indicator dot

## Context

The sidebar usage UI is rendered in `packages/web/src/client/components/UsageBar.tsx` and mounted from `packages/web/src/client/components/app-sidebar.tsx`.

Relevant existing behavior and structure:

- `useUsageTracker()` in `packages/web/src/client/hooks/useUsageTracker.ts` categorizes active routes into usage categories:
  - `reviewing` for board/session detail routes
  - `planning` for plan routes
  - `other` for everything else
- `UsageBar` currently reads local usage (`readTodayUsage`) and server cache (`getServerCache`) and renders:
  - a segmented horizontal bar with category colors:
    - reviewing → `bg-blue-500`
    - planning → `bg-emerald-500`
    - other → `bg-gray-500`
  - a text label under the bar
  - settings popover button
- There is currently **no explicit “currently tracked category” visual marker** in the sidebar usage row.

This task asks for a small round dot in the sidebar session tracking component that indicates which category is currently being tracked, using the same colors as the bar.

## Scope boundaries

### In scope
- Frontend-only change in the web client sidebar usage component.
- Expose current active tracking category from route context and display a small round color indicator in the sidebar usage area.
- Reuse the same category-to-color mapping as the usage bar segments.

### Out of scope
- Changing route categorization rules themselves (`categorizeRoute()` semantics remain unchanged unless a bug is discovered).
- Backend usage APIs (`/api/usage/*`) and storage schema.
- Redesigning UsageBar layout beyond adding the indicator and minimal alignment tweaks.

## Approach

1. **Single source of truth for category colors**
   - Avoid duplicating color maps in multiple files.
   - Extract/centralize category color constants so both bar segments and the new active-category dot use exactly the same mapping.

2. **Derive active category from current route in UI**
   - Reuse existing route categorization logic from `useUsageTracker.ts` by extracting a shared helper (e.g. `categorizeUsageRoute(pathname)` in `usage-settings.ts` or a new small utility module).
   - In `UsageBar`, use `useLocation()` to compute the active category for current pathname.

3. **Render compact indicator next to usage bar controls**
   - Add a `w-1.5 h-1.5 rounded-full` (or `w-2 h-2`) dot using the shared category color class.
   - Place it in the top row near the bar/settings button to remain visible in both normal and collapsed sidebar states.
   - Add an accessible label (`aria-label`/`title`) like `Tracking: Reviewing`.

4. **Keep behavior unchanged otherwise**
   - No changes to tick/heartbeat logic, max-time warning behavior, or label calculations.

## Acceptance criteria

1. Sidebar usage section shows a small round dot indicating the currently tracked usage category.
2. Dot color matches the existing usage bar segment color mapping for the same category.
3. Indicator updates automatically when navigation changes category (e.g. board → plans → other pages).
4. Existing usage bar rendering, settings popover behavior, and lock/warning states remain unchanged.
5. Typecheck and client build pass after refactor.

## Tasks

1. **Locate and confirm rendering entry points**
   - Verify `UsageBar` placement within `AppSidebar` (`app-sidebar.tsx`) and confirm no separate “session tracking component” exists.

2. **Extract shared route categorization helper**
   - Move route categorization logic from `useUsageTracker.ts` into a reusable exported helper (module choice: `usage-settings.ts` or a new `usage-categorization.ts`).
   - Update `useUsageTracker` to call the shared helper to preserve existing tracker behavior.

3. **Extract/shared category color map**
   - Move `SEGMENT_COLORS` from local constant in `UsageBar.tsx` to shared exported constant (same module as category helpers).
   - Update `UsageBar` to import and use this shared map for bar segments.

4. **Add active category computation in `UsageBar`**
   - Import `useLocation` from `react-router-dom`.
   - Compute active category via shared categorization helper using `location.pathname`.

5. **Render active-category indicator dot**
   - Add small round dot element in `UsageBar` top row.
   - Apply color class from shared category color map using computed active category.
   - Add tooltip/title + screen-reader text/label indicating category name.

6. **Adjust micro-layout for collapsed sidebar**
   - Ensure dot remains visible and does not overlap with `UsageSettingsPopover` in both normal and `group-data-[collapsible=icon]` states.

7. **Consistency pass with related usage UI**
   - Optionally align `UsageLockOverlay.tsx` color map import to the same shared constant to avoid drift (if done, keep change minimal and non-functional).

8. **Verification**
   - Run `pnpm typecheck`.
   - Run targeted web build check (either `pnpm build` root or package-specific build command used in repo).
   - Manual sanity check: navigate across representative routes and confirm dot color transitions reviewing/planning/other correctly.

## Proposed BUILD task breakdown

1. **BUILD 1 — Shared usage categorization + color constants**
   - Extract and export reusable route categorization and category color mapping.
   - Wire existing tracker/bar to shared constants without behavior change.

2. **BUILD 2 — Sidebar indicator UI**
   - Add active-category dot to `UsageBar` with accessibility metadata.
   - Verify collapsed sidebar layout and color parity with segments.

3. **BUILD 3 — Validation and cleanup**
   - Optional dedupe in `UsageLockOverlay` (if included).
   - Run checks and confirm no regressions.

## Risks / open questions

1. **Component naming ambiguity**
   - Request says “sidebar session tracking component”; repository currently exposes this behavior via `UsageBar`. Assumption: this is the target component.

2. **Color source duplication risk**
   - Color maps currently exist in more than one file (`UsageBar`, `UsageLockOverlay`), which can drift. Centralizing avoids mismatch but slightly broadens touch surface.

3. **Route-category coupling**
   - If categorization helper is moved, behavior parity must be preserved exactly to avoid subtle tracking changes.

4. **Collapsed sidebar constraints**
   - Very compact horizontal space may require tiny spacing/class adjustments to keep icon, dot, and settings button legible.
