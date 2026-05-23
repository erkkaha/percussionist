# Plan: Settings View Mobile Optimization (percussionist-dev-plan-7fcb1d)

## Context

The Settings page (`/settings`) in the web dashboard is currently desktop-only. It contains 6 tabs (Projects, Agents, Provider Secrets, OpenCode Config, Manager Agent, Runner Defaults) with no responsive adaptations for mobile viewports (< 768px). The codebase already has a `useIsMobile()` hook and Tailwind CSS v4 with breakpoint utilities (`sm:`, `md:`), but none of the settings sub-panels use them.

### Current Issues on Mobile (Verified via Code Inspection)

1. **Root container padding** (`p-6` = 24px) eats too much viewport width on phones — leaves only ~312px for content on a 360px screen
2. **Tab bar** has 6 horizontal tabs with no overflow handling — they wrap or get cut off at narrow widths; the tab bar uses `flex gap-1` without any scroll or wrapping mechanism
3. **SecretsPanel**: Inputs have fixed `w-64` (256px) on lines 202 and 228; input+button rows use `flex gap-2` with no column stacking — on a 360px screen the input + button overflows
4. **OpencodePanel**: Textarea is `h-80` (320px) fixed height — on mobile this takes up most of the viewport, leaving little room for the save button and validation feedback below it
5. **ManagerPanel & RunnerPanel**: Hardcoded `grid grid-cols-2 gap-4` on lines 351, 361, 451, 468, 481 — two columns at ~170px each on a 360px screen makes inputs cramped and labels hard to read
6. **ProjectsPage table**: 8 columns (Name, Display Name, Git URL, Ref, Model, Agent, Age, Actions) — impossible to read on mobile; the table container has `overflow-hidden` via `rounded-lg border-border overflow-hidden` which clips content
7. **AgentsPage table**: 5 columns (Name, Description, Content Preview, Age, Actions) — also clipped by the same `overflow-hidden` pattern

### Existing Infrastructure Available

- `useIsMobile()` hook in `packages/web/src/client/hooks/use-mobile.tsx` (breakpoint: 768px)
- Tailwind CSS v4 with `sm:` breakpoint at 640px already configured
- Sidebar already handles mobile via Sheet/drawer pattern — proves the codebase supports responsive design
- Other views demonstrate responsive patterns: `RunDetail.tsx` uses `grid-cols-1 md:grid-cols-2`, `StatsView.tsx` uses `sm:grid-cols-3 lg:grid-cols-6`, `AgentChatPanel.tsx` uses full-screen on mobile with floating panel on desktop

## Approach

**Strategy**: Use Tailwind's responsive utility classes exclusively. No new components, no media queries in CSS, no JavaScript-based layout switching. This keeps changes minimal and consistent with the existing codebase patterns. All modifications are class-name-only — zero logic changes, zero new imports.

### Key Decisions (and Rationale)

1. **Tab bar → horizontal scroll with snap**: Instead of wrapping (which breaks the tab bar visual identity) or using a dropdown/select (which adds interactivity state), use `overflow-x-auto` + `snap-x` + `snap-mandatory`. This is consistent with native mobile patterns (browser tab bars, Android navigation tabs). Each tab gets `flex-shrink-0 snap-start`. The wrapper uses `-mx-4 px-4` to allow tabs to scroll flush to the edges.

2. **Tables → horizontal overflow**: Wrap both table containers in `overflow-x-auto` instead of `overflow-hidden`. Add `min-w-[700px]` (Projects) and `min-w-[500px]` (Agents) to prevent column squishing. This is the simplest, most reliable approach — no need for card-based mobile layouts which would require significant restructure.

3. **Grids → single-column on mobile**: Use `grid-cols-1 sm:grid-cols-2` pattern consistently across ManagerPanel and RunnerPanel. This matches the existing pattern in `RunDetail.tsx`.

4. **Inputs → responsive widths**: Replace fixed `w-64` with `flex-1 sm:w-64 min-w-0` so inputs expand to fill available space on mobile but cap at 256px on desktop. The `min-w-0` prevents flex child overflow issues.

5. **Textarea heights → viewport-relative**: Use `min-h-[16rem] max-h-[70vh] sm:h-80` for the OpencodePanel textarea. Using `max-h-[70vh]` (instead of 50%) gives more editing space while still leaving room for the save button and validation feedback. The `sm:h-80` restores the original desktop height.

6. **Root padding → responsive**: Change `p-6` to `p-4 sm:p-6` so mobile gets 16px padding (vs 24px) — reclaiming ~16px of precious viewport width on phones.

### Scope Boundaries

**In scope:**
- `packages/web/src/client/components/SettingsPage.tsx` — root container, tab bar wrapper, all 4 sub-panels (SecretsPanel, OpencodePanel, ManagerPanel, RunnerPanel)
- `packages/web/src/client/components/ProjectsPage.tsx` — table overflow handling
- `packages/web/src/client/components/AgentsPage.tsx` — table overflow handling

**Out of scope:**
- Other pages (BoardView, RunDetail, StatsView, etc.) — they already have responsive handling or have separate concerns
- Backend API changes
- New components or hooks
- Dark mode / theme changes
- Touch target sizing improvements beyond what responsive layout provides
- Table card-based mobile layouts (horizontal scroll is sufficient and simpler)

## Tasks

### Task 1: Responsive root container and tab bar in SettingsPage.tsx

**File**: `packages/web/src/client/components/SettingsPage.tsx` (lines 82–111)

**Exact changes:**

Line 83 — change outer div className:
```diff
- <div className="flex flex-col gap-4 p-6 max-w-5xl">
+ <div className="flex flex-col gap-4 p-4 sm:p-6 max-w-5xl">
```

Lines 95–111 — wrap tab bar for horizontal scroll:
```diff
-      <div className="flex gap-1 border-b border-border">
+      <div className="-mx-4 overflow-x-auto px-4 snap-x snap-mandatory border-b border-border pb-1">
         {tabs.map((t) => (
           <button
             key={t.id}
             onClick={() => setActiveTab(t.id)}
             className={cn(
               "px-4 py-2 text-sm font-medium transition-colors",
-              "border-b-2 -mb-px",
+              "flex-shrink-0 snap-start border-b-2 -mb-px",
```

**Rationale**: `-mx-4 px-4` on the wrapper cancels out the `px-4` padding for the first/last tab, allowing them to scroll flush to the edges. `snap-x snap-mandatory` ensures tabs always land fully visible (no partial tabs). `flex-shrink-0` prevents tabs from shrinking when space is tight.

### Task 2: SecretsPanel responsive inputs

**File**: `packages/web/src/client/components/SettingsPage.tsx` (lines 194–245)

**Exact changes:**

Line 197 — stack input+button vertically on mobile:
```diff
-          <div className="flex gap-2">
+          <div className="flex flex-col sm:flex-row gap-2">
```

Line 202 — responsive input width:
```diff
-              className="w-64"
+              className="flex-1 sm:w-64 min-w-0"
```

Line 223 — stack second secret row vertically on mobile:
```diff
-          <div className="flex gap-2">
+          <div className="flex flex-col sm:flex-row gap-2">
```

Line 228 — responsive input width (same pattern):
```diff
-              className="w-64"
+              className="flex-1 sm:w-64 min-w-0"
```

### Task 3: OpencodePanel responsive textarea height

**File**: `packages/web/src/client/components/SettingsPage.tsx` (line 302)

**Exact change:**
```diff
-          className="w-full h-80 font-mono text-sm border border-input bg-background rounded-md p-3 focus:outline-none focus:ring-2 focus:ring-ring resize-y"
+          className="w-full min-h-[16rem] max-h-[70vh] sm:h-80 font-mono text-sm border border-input bg-background rounded-md p-3 focus:outline-none focus:ring-2 focus:ring-ring resize-y"
```

**Rationale**: `min-h-[16rem]` (256px) ensures a reasonable default height on mobile. `max-h-[70vh]` caps the textarea at 70% of viewport height, leaving room for validation feedback and save button. `sm:h-80` restores the original 320px desktop height. The `resize-y` class allows users to manually resize if needed.

### Task 4: ManagerPanel responsive grid

**File**: `packages/web/src/client/components/SettingsPage.tsx` (lines 351, 361)

**Exact changes:**

Line 351 — Agent Name / Decision Agent Name row:
```diff
-        <div className="grid grid-cols-2 gap-4">
+        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
```

Line 361 — Model / Timeout row:
```diff
-        <div className="grid grid-cols-2 gap-4">
+        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
```

The decision agent textarea (line 383) already uses `w-full` — no changes needed.

### Task 5: RunnerPanel responsive grids

**File**: `packages/web/src/client/components/SettingsPage.tsx` (lines 451, 468, 481)

**Exact changes:**

Line 451 — Runner Image / Timeout row:
```diff
-        <div className="grid grid-cols-2 gap-4">
+        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
```

Line 468 — Resource Requests row:
```diff
-          <div className="grid grid-cols-2 gap-4">
+          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
```

Line 481 — Resource Limits row:
```diff
-          <div className="grid grid-cols-2 gap-4">
+          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
```

### Task 6: ProjectsPage table overflow handling

**File**: `packages/web/src/client/components/ProjectsPage.tsx` (lines 147–167)

**Exact changes:**

Line 147 — change container from `overflow-hidden` to `overflow-x-auto`:
```diff
-        <div className="rounded-lg border border-border overflow-hidden">
+        <div className="overflow-x-auto rounded-lg border border-border">
           <table className="w-full text-sm">
+            <colgroup>
+              <col style={{ minWidth: '120px' }} />
+              <col style={{ minWidth: '100px' }} />
+              <col style={{ minWidth: '180px' }} />
+              <col style={{ minWidth: '60px' }} />
+              <col style={{ minWidth: '140px' }} />
+              <col style={{ minWidth: '120px' }} />
+              <col style={{ minWidth: '50px' }} />
+              <col style={{ minWidth: '180px' }} />
+            </colgroup>
```

**Rationale**: Instead of `min-w-[700px]` on the table (which could cause horizontal scroll even when not needed), use `<colgroup>` with per-column minimum widths. This gives more natural column sizing while still preventing squishing. The container change from `overflow-hidden` to `overflow-x-auto` enables scrolling only when content exceeds viewport width.

### Task 7: AgentsPage table overflow handling

**File**: `packages/web/src/client/components/AgentsPage.tsx` (lines 146–163)

**Exact changes:**

Line 146 — change container from `overflow-hidden` to `overflow-x-auto`:
```diff
-        <div className="rounded-lg border border-border overflow-hidden">
+        <div className="overflow-x-auto rounded-lg border border-border">
           <table className="w-full text-sm">
+            <colgroup>
+              <col style={{ minWidth: '140px' }} />
+              <col style={{ minWidth: '200px' }} />
+              <col style={{ minWidth: '250px' }} />
+              <col style={{ minWidth: '60px' }} />
+              <col style={{ minWidth: '140px' }} />
+            </colgroup>
```

### Task 8: Build and typecheck verification

**Commands:**
```bash
pnpm build
pnpm typecheck
```

Verify no TypeScript errors and that the web package builds cleanly.

## Risks / Open Questions

1. **Tab bar scroll discoverability**: Horizontal scrolling tabs on mobile may not be immediately obvious to users. However, this is a well-established pattern (Chrome tab bar, Android navigation). The snap behavior makes it feel natural — each tab "snaps" into place when scrolled. No additional UI hint needed.

2. **Table horizontal scroll awareness**: Users might not realize tables are horizontally scrollable. Using `<colgroup>` with `minWidth` instead of a fixed table width means the table only scrolls when truly needed (narrow viewport), and columns maintain reasonable proportions. This is better than a blanket `min-w-[700px]` which would force horizontal scroll even on tablets.

3. **Textarea `max-h-[70vh]` on iOS Safari**: Viewport height (`vh`) units can be unreliable on mobile browsers with dynamic address bars. The `min-h-[16rem]` fallback ensures usability even if `max-h` doesn't constrain properly. Users can also manually resize via the existing `resize-y` class.

4. **No visual regression testing**: No test framework exists in the project. Manual verification on a device or browser devtools (Chrome DevTools device emulation) is required for acceptance. The changes are purely CSS class modifications with zero logic changes, so there's minimal risk of behavioral regressions.

5. **`<colgroup>` inline styles**: Using `style={{ minWidth: '120px' }}` on `<col>` elements is the simplest approach that works across all browsers without needing custom CSS classes or Tailwind plugins. This is a minor deviation from the "Tailwind-only" principle but is necessary for column-level width control which Tailwind doesn't support natively.

## Acceptance Criteria

- [ ] Settings page renders without horizontal overflow on 360px viewport width (standard phone width)
- [ ] All 6 tabs are accessible via horizontal scroll on mobile; no tab content is cut off
- [ ] Form inputs in SecretsPanel, ManagerPanel, and RunnerPanel stack vertically on mobile (single column)
- [ ] Grid layouts collapse to single column below 640px (`sm:` breakpoint)
- [ ] ProjectsPage table scrolls horizontally without breaking the card container; columns maintain readable widths
- [ ] AgentsPage table scrolls horizontally without breaking the card container; columns maintain readable widths
- [ ] OpencodePanel textarea is usable on mobile (not taller than ~70% of viewport, with minimum 256px height)
- [ ] `pnpm build` succeeds with no errors
- [ ] `pnpm typecheck` passes with no errors

## BUILD Task Breakdown

| # | Task ID | Description | Depends On |
|---|---------|-------------|------------|
| 1 | build-7fcb1d-01 | Responsive root container and tab bar in SettingsPage.tsx (Task 1) | — |
| 2 | build-7fcb1d-02 | SecretsPanel responsive inputs (Task 2) | — |
| 3 | build-7fcb1d-03 | OpencodePanel responsive textarea height (Task 3) | — |
| 4 | build-7fcb1d-04 | ManagerPanel grid → single column on mobile (Task 4) | — |
| 5 | build-7fcb1d-05 | RunnerPanel grids → single column on mobile (Task 5) | — |
| 6 | build-7fcb1d-06 | ProjectsPage table overflow + colgroup widths (Task 6) | — |
| 7 | build-7fcb1d-07 | AgentsPage table overflow + colgroup widths (Task 7) | — |
| 8 | build-7fcb1d-08 | Build and typecheck verification (pnpm build + pnpm typecheck) | all above |

All BUILD tasks are independent (single file each, no cross-file dependencies) except Task 8 which verifies the full build.

## Files to Modify

| File | Lines Changed | Type |
|------|---------------|------|
| `packages/web/src/client/components/SettingsPage.tsx` | ~15 class name changes across root, tabs, secrets, opencode, manager, runner panels | Responsive layout |
| `packages/web/src/client/components/ProjectsPage.tsx` | 2 lines (overflow container + colgroup) | Table scroll |
| `packages/web/src/client/components/AgentsPage.tsx` | 2 lines (overflow container + colgroup) | Table scroll |

**Total estimated change**: ~19 lines of modifications across 3 files. No new imports, no new components, zero logic changes. All changes are class-name-only or minimal structural additions (`<colgroup>`).
