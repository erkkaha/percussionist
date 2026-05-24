# Plan: Settings Page Mobile Optimization

## Context

The `SettingsPage` component (`packages/web/src/client/components/SettingsPage.tsx`) and its sub-panels (SecretsPanel, OpencodePanel, ManagerPanel, RunnerPanel) along with the ProjectsPage and AgentsPage tabs are not mobile-optimized. On narrow viewports (320px–768px), several layout issues occur:

1. **Fixed-width inputs** (`w-64`) overflow on screens < 480px
2. **Two-column grids** (`grid-cols-2`) don't reflow to single column on mobile
3. **Tab bar** with 6 tabs is cramped and may not wrap or scroll properly
4. **Page header** (title + save message) doesn't collapse gracefully
5. **Tables** in ProjectsPage/AgentsPage overflow horizontally without scroll containers
6. **Padding** (`p-6` = 24px) wastes precious screen real estate on mobile

The project uses Tailwind CSS v4 with `@import "tailwindcss"` and the `cn()` utility for class merging. The Layout component wraps all pages in a `SidebarInset > main` structure with `p-6` padding. The sidebar already has mobile support via `useIsMobile()` (breakpoint: 768px).

## Approach

**Strategy**: Add responsive overrides using Tailwind's built-in responsive prefixes (`sm:`, `md:`) and a small custom CSS block in `index.css` for media queries targeting specific breakpoints. **No desktop layout changes.** Only add mobile-specific classes that override defaults at narrow viewports.

### Key Decisions

1. **Use Tailwind responsive utilities** where possible (e.g., `p-4 sm:p-6`, `w-full sm:w-64`, `grid-cols-1 sm:grid-cols-2`)
2. **Add a custom `<style>` block in `index.css`** for:
   - Horizontal scroll on tables at narrow widths
   - Tab bar overflow handling (scrollable tabs)
3. **Keep the existing component structure** — only modify className strings, no structural changes
4. **Target breakpoints**: 320px (minimum), 480px (small phones), 768px (tablet/mobile boundary matching `useIsMobile`)

## Tasks

### Task 1: Add mobile CSS overrides to `index.css`

**File**: `packages/web/src/client/index.css`

Add a `<style>` block at the end of the file with media queries for:
- **320px breakpoint**: Reduce all page-level padding, ensure inputs are full-width
- **480px breakpoint**: Stack form fields vertically, shrink header text sizes
- **768px breakpoint**: Make tables horizontally scrollable within a container

```css
/* Mobile responsive overrides for settings pages */
@media (max-width: 480px) {
  /* Ensure all inputs and form controls are full width on very small screens */
  .settings-mobile-full-width input,
  .settings-mobile-full-width textarea {
    width: 100% !important;
  }

  /* Stack tab labels vertically or allow wrapping */
  .settings-tabs-wrap {
    flex-wrap: wrap;
  }

  .settings-tabs-wrap button {
    flex: 1 1 auto;
    min-width: 80px;
    text-align: center;
    font-size: 0.75rem;
    padding: 0.5rem 0.75rem;
  }

  /* Reduce header spacing */
  .settings-header-mobile {
    flex-direction: column;
    align-items: flex-start !important;
    gap: 0.5rem;
  }

  .settings-header-mobile h1 {
    font-size: 1.25rem !important;
  }
}

@media (max-width: 768px) {
  /* Make tables horizontally scrollable */
  .settings-table-scroll {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    width: 100%;
  }

  .settings-table-scroll table {
    min-width: 600px;
  }
}
```

### Task 2: Make SettingsPage root container responsive

**File**: `packages/web/src/client/components/SettingsPage.tsx` (line 83)

Change:
```tsx
<div className="flex flex-col gap-4 p-6 max-w-5xl">
```
To:
```tsx
<div className="flex flex-col gap-4 p-4 sm:p-6 max-w-5xl mx-auto w-full">
```

### Task 3: Collapse settings header on mobile

**File**: `packages/web/src/client/components/SettingsPage.tsx` (lines 84–92)

Change the header div to stack vertically on small screens:
```tsx
<div className="flex items-center justify-between settings-header-mobile">
```

And add a class for responsive text sizing on the h1.

### Task 4: Make tab bar scrollable/wrappable on mobile

**File**: `packages/web/src/client/components/SettingsPage.tsx` (line 95)

Change:
```tsx
<div className="flex gap-1 border-b border-border">
```
To:
```tsx
<div className="flex gap-1 border-b border-border settings-tabs-wrap overflow-x-auto sm:overflow-visible">
```

This allows horizontal scrolling on very narrow screens while keeping the normal layout at `sm:` and above.

### Task 5: Fix SecretsPanel inputs — remove fixed widths, stack flex rows

**File**: `packages/web/src/client/components/SettingsPage.tsx` (lines 196–212, 222–238)

For both the LLM Keys Secret and Auth Secret sections:
- Remove `className="w-64"` from Input components → replace with `className="flex-1 min-w-0 sm:w-64"`
- Change the flex container to allow wrapping on small screens: add `flex-wrap` class

Example for LLM Keys section (line 196):
```tsx
<div className="flex gap-2 flex-wrap">
  <Input
    value={llmKeysSecret}
    onChange={(e) => setLlmKeysSecret(e.target.value)}
    placeholder="llm-keys"
    className="flex-1 min-w-0 sm:w-64"
  />
```

### Task 6: Make ManagerPanel grid responsive (2-col → 1-col on mobile)

**File**: `packages/web/src/client/components/SettingsPage.tsx` (lines 355, 365)

Change both `grid grid-cols-2 gap-4` to:
```tsx
grid grid-cols-1 sm:grid-cols-2 gap-4
```

This stacks form fields vertically below 640px and uses two columns at `sm:` and above.

### Task 7: Make RunnerPanel grid responsive (2-col → 1-col on mobile)

**File**: `packages/web/src/client/components/SettingsPage.tsx` (lines 470, 487, 500)

Same change as Task 6 — replace all three instances of `grid grid-cols-2 gap-4` with:
```tsx
grid grid-cols-1 sm:grid-cols-2 gap-4
```

### Task 8: Make OpencodePanel textarea responsive height

**File**: `packages/web/src/client/components/SettingsPage.tsx` (line 301)

Change the textarea from fixed `h-80` to a more flexible approach:
```tsx
className="w-full h-64 sm:h-80 font-mono text-sm border border-input bg-background rounded-md p-3 focus:outline-none focus:ring-2 focus:ring-ring resize-y"
```

This gives 256px height on mobile and 320px at `sm:`+.

### Task 9: Add horizontal scroll to ProjectsPage table

**File**: `packages/web/src/client/components/ProjectsPage.tsx` (line 147)

Wrap the table in a scrollable container:
```tsx
<div className="rounded-lg border border-border overflow-hidden settings-table-scroll">
```

### Task 10: Add horizontal scroll to AgentsPage table

**File**: `packages/web/src/client/components/AgentsPage.tsx` (line 146)

Same as Task 9 — wrap the table in a scrollable container:
```tsx
<div className="rounded-lg border border-border overflow-hidden settings-table-scroll">
```

### Task 11: Ensure CardFooter buttons stack on mobile

**File**: `packages/web/src/client/components/SettingsPage.tsx` (CardFooter usage)

The CardFooter component uses `flex items-center p-4 pt-0`. On very small screens, ensure the save button takes full width:
```tsx
<CardFooter className="sm:flex-row flex-col gap-2">
  <Button className="w-full sm:w-auto" ...>Save...</Button>
</CardFooter>
```

Apply this pattern to all three panel CardFooters (SecretsPanel line 246, ManagerPanel line 405, RunnerPanel line 512).

## Scope Boundaries

- **In scope**: Only the SettingsPage component and its sub-panels, plus ProjectsPage and AgentsPage tables
- **Out of scope**: Other pages in the app (RunList, RunDetail, BoardView, etc.) — those are separate tasks if needed
- **No new dependencies** added; only Tailwind utility classes and a small CSS block

## Risks / Open Questions

1. **Tailwind v4 `@import` syntax**: The project uses `@import "tailwindcss"` (v4 style). Custom CSS in `<style>` tags within the same file should work, but if there are conflicts with Tailwind's preflight, we may need to use `@layer base { ... }` instead.
2. **Table scroll UX**: Horizontal scrolling on tables is a known mobile pattern but can feel awkward. The `min-width: 600px` ensures columns don't get too squished. This is acceptable for admin settings pages used infrequently.
3. **Tab bar wrapping vs scrolling**: Wrapping tabs at 480px may cause the tab bar to take multiple lines, pushing content down. Horizontal scroll (Task 4) preserves single-line layout but requires swipe. Both are trade-offs; the plan uses a hybrid approach with `flex-wrap` + horizontal overflow fallback.
4. **Card hover effects**: The Card component has `hover:border-[#6b5948] hover:shadow-md transition-all duration-150`. On touch devices, this may cause persistent border changes after tap. This is pre-existing and not changed by this plan.

## Acceptance Criteria

1. At 320px viewport width:
   - No horizontal overflow of the page content
   - All input fields are full-width and tappable (min 44px touch target)
   - Tab bar is accessible via horizontal scroll or wrapping
   - Page header text is readable without truncation

2. At 480px viewport width:
   - Form fields in ManagerPanel and RunnerPanel stack vertically
   - SecretsPanel input + button rows wrap to vertical layout
   - Opencode textarea height reduces from 320px to ~256px

3. At 768px viewport width:
   - ProjectsPage and AgentsPage tables are horizontally scrollable without breaking the page layout
   - Two-column grids revert to normal two-column layout

4. Desktop (≥1024px):
   - No visual changes from current behavior
   - All existing interactions work identically

5. Build verification:
   - `pnpm typecheck` passes with no new errors
   - `pnpm build` succeeds without warnings related to the changed files

## BUILD Task Breakdown (for implementation)

| # | Task | File(s) | Complexity |
|---|------|---------|------------|
| 1 | Add mobile CSS overrides to index.css | `packages/web/src/client/index.css` | Low |
| 2 | Make SettingsPage root container responsive | `SettingsPage.tsx` (line 83) | Trivial |
| 3 | Collapse settings header on mobile | `SettingsPage.tsx` (lines 84–92) | Trivial |
| 4 | Make tab bar scrollable/wrappable | `SettingsPage.tsx` (line 95) | Low |
| 5 | Fix SecretsPanel inputs — remove fixed widths | `SettingsPage.tsx` (lines 196–238) | Low |
| 6 | Make ManagerPanel grid responsive | `SettingsPage.tsx` (lines 355, 365) | Trivial |
| 7 | Make RunnerPanel grid responsive | `SettingsPage.tsx` (lines 470, 487, 500) | Trivial |
| 8 | Make OpencodePanel textarea responsive height | `SettingsPage.tsx` (line 301) | Trivial |
| 9 | Add horizontal scroll to ProjectsPage table | `ProjectsPage.tsx` (line 147) | Trivial |
| 10 | Add horizontal scroll to AgentsPage table | `AgentsPage.tsx` (line 146) | Trivial |
| 11 | Ensure CardFooter buttons stack on mobile | `SettingsPage.tsx` (3 footer locations) | Low |

Total: ~11 small, independent changes. Tasks 2–8 and 9–10 can be done in parallel. Task 1 should be done first since other tasks depend on the `.settings-table-scroll` class.
