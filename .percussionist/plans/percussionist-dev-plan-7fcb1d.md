# Plan: Settings View Mobile Optimization (percussionist-dev-plan-7fcb1d)

## Context

The Settings page (`/settings`) in the web dashboard is currently desktop-only. It contains 6 tabs (Projects, Agents, Provider Secrets, OpenCode Config, Manager Agent, Runner Defaults) with no responsive adaptations for mobile viewports (< 768px). The codebase already has a `useIsMobile()` hook and Tailwind CSS v4 with breakpoint utilities (`sm:`, `md:`), but none of the settings sub-panels use them.

### Current Issues on Mobile

1. **Root container padding** (`p-6` = 24px) eats too much viewport width on phones
2. **Tab bar** has 6 horizontal tabs with no overflow handling — they wrap or get cut off
3. **SecretsPanel**: Inputs have fixed `w-64` (256px); input+button rows don't stack
4. **OpencodePanel**: Textarea is `h-80` (320px) — too tall for mobile viewports
5. **ManagerPanel & RunnerPanel**: Hardcoded `grid grid-cols-2 gap-4` — two columns on a 360px screen makes inputs unusable
6. **ProjectsPage table**: 8 columns (Name, Display Name, Git URL, Ref, Model, Agent, Age, Actions) — impossible to read on mobile
7. **AgentsPage table**: 5 columns (Name, Description, Content Preview, Age, Actions) — also unreadable

### Existing Infrastructure

- `useIsMobile()` hook in `packages/web/src/client/hooks/use-mobile.tsx` (breakpoint: 768px)
- Tailwind CSS v4 with `sm:` breakpoint at 640px already configured
- Sidebar already handles mobile via Sheet/drawer pattern — proves the codebase supports responsive design

## Approach

**Strategy**: Use Tailwind's responsive utility classes exclusively. No new components, no media queries in CSS, no JavaScript-based layout switching. This keeps changes minimal and consistent with the existing codebase patterns (e.g., `RunDetail.tsx` uses `grid-cols-1 md:grid-cols-2`, `StatsView.tsx` uses `sm:grid-cols-3 lg:grid-cols-6`).

### Key Decisions

1. **Tab bar**: Make horizontally scrollable with snap scrolling on mobile (`overflow-x-auto`, `snap-x`, `snap-start`) instead of wrapping or using a dropdown. This preserves all 6 tabs visible and accessible without adding complexity.
2. **Tables (ProjectsPage, AgentsPage)**: Wrap in `overflow-x-auto` container. Tables are the simplest approach — no need for card-based mobile layouts which would require significant restructure and could break existing expectations about data presentation. Horizontal scroll is standard for data tables on mobile.
3. **Grids**: Use `grid-cols-1 sm:grid-cols-2` pattern consistently across ManagerPanel and RunnerPanel.
4. **Inputs**: Replace fixed widths (`w-64`) with responsive equivalents (`w-full sm:w-64`).
5. **Textarea heights**: Make OpencodePanel textarea height responsive using `min-h` + `max-h-[60vh]`.

### Scope Boundaries

**In scope:**
- `packages/web/src/client/components/SettingsPage.tsx` — root container, tab bar, all 4 sub-panels (SecretsPanel, OpencodePanel, ManagerPanel, RunnerPanel)
- `packages/web/src/client/components/ProjectsPage.tsx` — table overflow handling
- `packages/web/src/client/components/AgentsPage.tsx` — table overflow handling

**Out of scope:**
- Other pages (BoardView, RunDetail, etc.) — they have their own responsive concerns
- Backend API changes
- New components or hooks
- Dark mode / theme changes
- Touch target sizing improvements beyond what responsive layout provides

## Tasks

### Task 1: Responsive root container and tab bar in SettingsPage.tsx

**File**: `packages/web/src/client/components/SettingsPage.tsx` (lines 82–111)

**Changes:**
- Line 83: Change `p-6 max-w-5xl` → `p-4 sm:p-6 max-w-5xl` (less padding on mobile)
- Lines 95–111: Make tab bar horizontally scrollable on narrow screens:
  - Add wrapper div with `overflow-x-auto`, `snap-x`, `snap-mandatory`, `-mx-4 px-4`, `pb-1` for scroll padding
  - Each tab button gets `flex-shrink-0`, `snap-start` classes
  - This keeps all 6 tabs accessible via horizontal swipe on mobile

### Task 2: SecretsPanel responsive inputs

**File**: `packages/web/src/client/components/SettingsPage.tsx` (lines 185–257)

**Changes:**
- Line 202: Change `className="w-64"` → `className="flex-1 sm:w-64 min-w-0"` on LLM Keys Input
- Line 197: Change `<div className="flex gap-2">` → `<div className="flex flex-col sm:flex-row gap-2">` for both secret input rows (LLM keys and auth secret)
- Same changes at line 228 for Auth Secret Name Input

### Task 3: OpencodePanel responsive textarea height

**File**: `packages/web/src/client/components/SettingsPage.tsx` (lines 289–318)

**Changes:**
- Line 302: Change `className="w-full h-80 font-mono text-sm ..."` → `className="w-full min-h-[16rem] max-h-[50vh] sm:h-80 font-mono text-sm ..."` 
- This gives a reasonable default height on mobile (16rem ≈ 256px) while capping at 50% viewport height, and restores the full 320px on desktop

### Task 4: ManagerPanel responsive grid

**File**: `packages/web/src/client/components/SettingsPage.tsx` (lines 341–410)

**Changes:**
- Line 351: Change `grid grid-cols-2 gap-4` → `grid grid-cols-1 sm:grid-cols-2 gap-4`
- Line 361: Same change for the Model/Timeout row
- Decision agent textarea (line 383) already uses `w-full`, no changes needed

### Task 5: RunnerPanel responsive grids

**File**: `packages/web/src/client/components/SettingsPage.tsx` (lines 442–521)

**Changes:**
- Line 451: Change `grid grid-cols-2 gap-4` → `grid grid-cols-1 sm:grid-cols-2 gap-4` (Runner Image / Timeout row)
- Line 468: Same change for Resource Requests row
- Line 481: Same change for Resource Limits row

### Task 6: ProjectsPage table overflow handling

**File**: `packages/web/src/client/components/ProjectsPage.tsx` (lines 147–167)

**Changes:**
- Wrap the `<table>` element in a div with `overflow-x-auto`:
  ```tsx
  <div className="overflow-x-auto rounded-lg border border-border">
    <table className="w-full text-sm min-w-[700px]">
  ```
- Add `min-w-[700px]` to the table to prevent column squishing — horizontal scroll will reveal all columns

### Task 7: AgentsPage table overflow handling

**File**: `packages/web/src/client/components/AgentsPage.tsx` (lines 146–163)

**Changes:**
- Same pattern as ProjectsPage:
  ```tsx
  <div className="overflow-x-auto rounded-lg border border-border">
    <table className="w-full text-sm min-w-[500px]">
  ```
- `min-w-[500px]` is sufficient for the 5 columns

### Task 8: Build and typecheck verification

**Commands:**
```bash
pnpm build
pnpm typecheck
```

Verify no TypeScript errors and that the web package builds cleanly.

## Risks / Open Questions

1. **Tab bar scroll UX**: Horizontal scrolling tabs on mobile may feel unexpected. Alternative would be a dropdown/select, but that adds interactivity complexity. The snap-scroll approach is consistent with native mobile patterns (e.g., browser tab bars).
2. **Table horizontal scroll**: Users might not realize tables are horizontally scrollable. Could add a subtle visual hint (scroll shadow gradient) but that requires CSS customizations beyond Tailwind utilities. Keeping it simple for now.
3. **Textarea `max-h-[50vh]` on iOS Safari**: Viewport height (`vh`) units can be unreliable on mobile browsers with address bars. The `min-h-[16rem]` fallback ensures usability even if `max-h` doesn't constrain properly.
4. **No visual regression testing**: No test framework exists in the project. Manual verification on a device or browser devtools is required for acceptance.

## Acceptance Criteria

- [ ] Settings page renders without horizontal overflow on 360px viewport width (standard phone width)
- [ ] All 6 tabs are accessible via horizontal scroll on mobile; no tab content is cut off
- [ ] Form inputs in SecretsPanel, ManagerPanel, and RunnerPanel stack vertically on mobile (single column)
- [ ] Grid layouts collapse to single column below 640px (`sm:` breakpoint)
- [ ] ProjectsPage table scrolls horizontally without breaking the card container
- [ ] AgentsPage table scrolls horizontally without breaking the card container
- [ ] OpencodePanel textarea is usable on mobile (not taller than ~50% of viewport)
- [ ] `pnpm build` succeeds with no errors
- [ ] `pnpm typecheck` passes with no errors

## BUILD Task Breakdown

| # | Task ID | Description | Depends On |
|---|---------|-------------|------------|
| 1 | build-7fcb1d-01 | Responsive root container and tab bar in SettingsPage.tsx | — |
| 2 | build-7fcb1d-02 | SecretsPanel responsive inputs (w-full, flex-col→row) | — |
| 3 | build-7fcb1d-03 | OpencodePanel responsive textarea height | — |
| 4 | build-7fcb1d-04 | ManagerPanel grid → single column on mobile | — |
| 5 | build-7fcb1d-05 | RunnerPanel grids → single column on mobile | — |
| 6 | build-7fcb1d-06 | ProjectsPage table overflow wrapper + min-width | — |
| 7 | build-7fcb1d-07 | AgentsPage table overflow wrapper + min-width | — |
| 8 | build-7fcb1d-08 | Build and typecheck verification | all above |

All BUILD tasks are independent (single file each) except Task 8 which verifies the full build.

## Files to Modify

| File | Lines Changed | Type |
|------|---------------|------|
| `packages/web/src/client/components/SettingsPage.tsx` | ~15 class name changes across root, tabs, secrets, opencode, manager, runner panels | Responsive layout |
| `packages/web/src/client/components/ProjectsPage.tsx` | 2 lines (wrap table in overflow div) | Table scroll |
| `packages/web/src/client/components/AgentsPage.tsx` | 2 lines (wrap table in overflow div) | Table scroll |

**Total estimated change**: ~19 lines of Tailwind class modifications across 3 files. No new imports, no new components, no logic changes.

