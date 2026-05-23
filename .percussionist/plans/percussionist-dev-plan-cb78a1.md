# Plan: Settings View Mobile Optimization

**Task:** `percussionist-dev-plan-cb78a1`  
**Project:** `percussionist-dev`  
**Branch:** `feature/percussionist-dev-plan-cb78a1`

---

## Context

The Settings page (`packages/web/src/client/components/SettingsPage.tsx`) is accessed via the sidebar navigation at `/settings`. It contains 6 tabs: Projects, Agents, Provider Secrets, OpenCode Config, Manager Agent, and Runner Defaults. The page uses Tailwind CSS with a `useIsMobile` hook (breakpoint: 768px) already available in the codebase.

The sidebar itself is mobile-responsive — it collapses to an off-canvas Sheet on screens <768px via `SidebarProvider`/`Sidebar`. However, the SettingsPage content has several hardcoded layout patterns that break on narrow viewports:

1. **Tab bar** — horizontal flex with 6 long labels; overflows and truncates on mobile
2. **Grid layouts** — `grid-cols-2` used in ManagerPanel and RunnerPanel without responsive fallback
3. **Fixed-width inputs** — `w-64` class on secret name inputs ignores viewport width
4. **Excessive padding** — `p-6` on the root container wastes space on mobile
5. **Large textareas** — fixed heights (`h-80`, `h-48`) consume too much vertical space
6. **Save buttons** — not full-width on mobile, making them harder to tap

Other pages in the codebase already use responsive patterns (e.g., `StatsView.tsx` uses `sm:grid-cols-3`, `RunDetail.tsx` uses `md:grid-cols-2`). The SettingsPage simply hasn't been updated with these conventions.

---

## Approach

Apply Tailwind CSS responsive utility classes to make the SettingsPage work well on viewports from 320px (small phones) up to desktop. All changes are **purely CSS class adjustments** — no new components, hooks, or logic changes. This keeps the diff small and low-risk.

### Design Decisions

- **Tab bar**: Switch to horizontally scrollable tabs on mobile (`overflow-x-auto` + `whitespace-nowrap`) rather than wrapping or stacking. This preserves the familiar tab UX while fitting all 6 labels.
- **Grids**: Use `grid-cols-1 sm:grid-cols-2` so form fields stack vertically on mobile and go side-by-side at `sm:` breakpoint (640px).
- **Inputs**: Replace fixed widths with responsive classes (`w-full sm:w-64`).
- **Padding**: Reduce from `p-6` to `p-4 sm:p-6`.
- **Textareas**: Use responsive heights — `h-48 sm:h-80` for the OpenCode config editor, `h-32 sm:h-48` for the decision agent content.
- **Buttons**: Make save buttons full-width on mobile (`w-full sm:w-auto`) for better touch targets (minimum 44px tap area).

---

## Tasks

### Task 1: Make tab bar horizontally scrollable on mobile

**File:** `packages/web/src/client/components/SettingsPage.tsx`  
**Line:** ~95

Change the tab bar container from:
```tsx
<div className="flex gap-1 border-b border-border">
```
to:
```tsx
<div className="flex gap-1 border-b border-border overflow-x-auto scrollbar-hide -mx-4 px-4 sm:mx-0 sm:px-0">
```

Also add `whitespace-nowrap` to each tab button and reduce padding on mobile:
```tsx
className={cn(
  "px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap shrink-0",
  "border-b-2 -mb-px sm:px-4 sm:py-2",
  ...
)}
```

This makes the tab bar scrollable on narrow screens while keeping the full layout at `sm:` and above. The `-mx-4 px-4` compensates for the root container's padding so tabs extend edge-to-edge within their section.

### Task 2: Reduce root container padding on mobile

**File:** `packages/web/src/client/components/SettingsPage.tsx`  
**Line:** ~83

Change from:
```tsx
<div className="flex flex-col gap-4 p-6 max-w-5xl">
```
to:
```tsx
<div className="flex flex-col gap-4 p-4 sm:p-6 max-w-5xl">
```

### Task 3: Make save buttons full-width on mobile

**File:** `packages/web/src/client/components/SettingsPage.tsx`  
**Lines:** ~248, ~314, ~392, ~494

Add responsive width to all CardFooter save buttons:
```tsx
className="w-full sm:w-auto"
```

This ensures the tap target is at least 44px wide on mobile.

### Task 4: Fix fixed-width inputs in SecretsPanel

**File:** `packages/web/src/client/components/SettingsPage.tsx`  
**Lines:** ~202, ~228

Change from:
```tsx
className="w-64"
```
to:
```tsx
className="flex-1 sm:w-64 min-w-0"
```

The `flex-1` makes the input fill available space on mobile while `sm:w-64` restores the original width at larger breakpoints. `min-w-0` prevents flex overflow issues.

### Task 5: Make grid layouts responsive in ManagerPanel and RunnerPanel

**File:** `packages/web/src/client/components/SettingsPage.tsx`  
**Lines:** ~351, ~361, ~451, ~468, ~480

Change all instances of `grid grid-cols-2 gap-4` to:
```tsx
grid grid-cols-1 sm:grid-cols-2 gap-4
```

This affects 5 grid containers across the ManagerAgent and RunnerDefaults panels. On mobile (<640px), form fields stack vertically; at `sm:` and above, they go side-by-side as before.

### Task 6: Make textareas responsive on mobile

**File:** `packages/web/src/client/components/SettingsPage.tsx`  
**Lines:** ~302 (OpenCode config textarea), ~383 (decision agent content textarea)

Change from:
```tsx
className="w-full h-80 font-mono ..."
```
to:
```tsx
className="w-full h-48 sm:h-80 font-mono ..."
```

And:
```tsx
className="w-full h-48 font-mono ..."
```
to:
```tsx
className="w-full h-32 sm:h-48 font-mono ..."
```

This reduces the textarea height on mobile to save vertical space while restoring full height at larger breakpoints.

### Task 7: Ensure the header row wraps properly on mobile

**File:** `packages/web/src/client/components/SettingsPage.tsx`  
**Lines:** ~84-92

The header uses `flex items-center justify-between`. On very narrow screens, the save message could push the heading off-screen. Add responsive wrapping:
```tsx
className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
```

This stacks the heading and save message vertically on mobile but keeps them side-by-side at `sm:`+.

---

## Scope Boundaries

**In scope:**
- Only `packages/web/src/client/components/SettingsPage.tsx` (single file, ~523 lines)
- All changes are Tailwind CSS class modifications — no new components or logic

**Out of scope:**
- Other pages (ProjectsPage, AgentsPage, BoardView, etc.) — they have their own mobile issues but are not part of this task
- The sidebar/mobile sheet navigation — already handled by the existing `useIsMobile` + Sheet pattern
- Adding a new mobile-specific component or hook

---

## Risks / Open Questions

1. **Tab bar scroll UX**: Horizontally scrollable tabs on mobile is a known pattern but some users may not realize they can scroll. An alternative would be a segmented control dropdown, but that adds complexity. The horizontal scroll approach is the minimal-change solution and matches common patterns (e.g., Chrome DevTools, VS Code).

2. **Textarea resize on mobile**: Reducing textarea heights means less visible content at once. Users may need to scroll within the textarea or use pinch-to-zoom. This is acceptable trade-off for fitting the page in viewport without excessive scrolling.

3. **No `scrollbar-hide` utility by default**: The plan references a hypothetical `scrollbar-hide` class. If not available, we can use an inline `<style>` block or the Tailwind plugin approach. Alternatively, just use `overflow-x-auto` without hiding the scrollbar — it's acceptable on mobile where scroll direction is intuitive.

4. **Testing**: No automated tests exist for this codebase. Manual testing on a device or browser devtools with narrow viewport will be needed to verify. The changes are purely CSS class additions so regression risk is minimal.

---

## Acceptance Criteria

1. Settings page renders without horizontal overflow at 320px width
2. All 6 tabs are accessible via horizontal scroll on mobile viewports (<768px)
3. Form fields in ManagerAgent and RunnerDefaults panels stack vertically on mobile
4. Save buttons have minimum 44px tap target height on mobile
5. Textareas fit within viewport without requiring page-level scrolling beyond the tab content
6. No visual regression at desktop breakpoints (1024px+) — layout should be identical to current behavior

---

## BUILD Task Breakdown

| # | Title | File | Complexity | Depends On |
|---|-------|------|------------|------------|
| 1 | Make tab bar horizontally scrollable on mobile | `SettingsPage.tsx` (tab bar) | Low | — |
| 2 | Reduce root container padding + fix header wrapping | `SettingsPage.tsx` (root div, header) | Low | — |
| 3 | Fix fixed-width inputs in SecretsPanel | `SettingsPage.tsx` (SecretsPanel) | Low | — |
| 4 | Make grid layouts responsive in ManagerPanel & RunnerPanel | `SettingsPage.tsx` (ManagerPanel, RunnerPanel grids) | Low | — |
| 5 | Make textareas and save buttons responsive | `SettingsPage.tsx` (textareas, CardFooters) | Low | — |

All tasks are independent and can be done in any order. They all modify the same file with small, targeted class changes. A single BUILD task could handle everything, but splitting into 5 makes review easier and allows partial commits if needed.
