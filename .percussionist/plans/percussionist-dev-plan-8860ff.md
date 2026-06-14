# Plan: Fix mobile horizontal scrolling for project tabs

## Context

- The reported issue is: **project tabs cannot be horizontally scrolled on mobile**.
- Project create/edit uses the custom tabs UI in:
  - `packages/web/src/client/components/CreateProjectForm.tsx`
  - `packages/web/src/client/components/ui/tabs.tsx`
- In `CreateProjectForm.tsx`, the tab strip is rendered as:
  - `<TabsList className="mb-4"> ... </TabsList>`
  - with six tabs (`general`, `source-auth`, `execution`, `workspace-services`, `memories`, `advanced`).
- `TabsList` base styles in `ui/tabs.tsx` are currently:
  - `inline-flex items-center justify-center ...`
  - no built-in horizontal overflow handling.
- App layout (`packages/web/src/client/components/Layout.tsx`) sets main content to `overflow-x-hidden`, which prevents page-level horizontal panning and makes **local overflow containers mandatory** for horizontal scrolling UX.
- By comparison, `SettingsPage.tsx` already implements a horizontally scrollable tab bar using `overflow-x-auto`, indicating the expected pattern.

## Assumptions

- “project tab component” refers to the tab strip in **Create/Edit Project** (`CreateProjectForm`) rather than the top-level Settings tabs.
- Desired behavior: on narrow viewports, users can swipe left/right on the tab strip itself without breaking desktop layout.

## Scope boundaries

### In scope
- Mobile horizontal-scroll behavior for project form tabs.
- Minor accessibility/UX hardening for touch scrolling (e.g., no wrap, shrink prevention, optional touch momentum class usage).

### Out of scope
- Reworking the shared tabs system across all pages.
- Desktop visual redesign of tabs.
- Changing routes, form logic, or submit behavior.

## Approach

Implement a **local scroll container** around the project tab strip and ensure tabs maintain intrinsic width so overflow can occur naturally on small screens.

Key decisions:

1. **Fix at usage site first** (`CreateProjectForm.tsx`) to minimize blast radius.
2. Keep `TabsList` primitive generic; only add class-level tweaks if needed for robustness.
3. Match existing project conventions already used elsewhere (`overflow-x-auto`, touch-friendly behavior).

Likely implementation shape:

- Wrap `TabsList` in a full-width horizontal scroller (`w-full overflow-x-auto`) with touch momentum support.
- Ensure tab row does not wrap and can exceed viewport width (`whitespace-nowrap` and/or `w-max min-w-max` on `TabsList`).
- Prevent trigger shrinking when space is tight (e.g., `shrink-0` via class on `TabsTrigger` instances in `CreateProjectForm` only).
- Keep desktop appearance unchanged (mobile-first overflow classes naturally no-op on wide screens).

## Tasks

1. **Confirm and document the failing path in code comments/PR notes**
   - Validate that the affected UI is `CreateProjectForm` tab strip rendered by `TabsList`/`TabsTrigger`.
   - Note that `Layout` uses `overflow-x-hidden`, requiring inner scroll containers.

2. **Update project form tab container for mobile overflow**
   - File: `packages/web/src/client/components/CreateProjectForm.tsx`
   - Add a wrapper around `<TabsList>` with horizontal scrolling classes (`w-full overflow-x-auto`, optional `-webkit-overflow-scrolling: touch` utility/class if already available).
   - Ensure the list itself sizes to content (e.g., `w-max min-w-max`) and preserves existing spacing (`mb-4`).

3. **Prevent tab trigger collapse/wrapping under constrained width**
   - File: `packages/web/src/client/components/CreateProjectForm.tsx`
   - Add per-trigger class(es) (e.g., `shrink-0`) to keep labels readable and maintain predictable horizontal overflow.

4. **(If needed) lightly harden shared TabsList primitive without changing global behavior**
   - File: `packages/web/src/client/components/ui/tabs.tsx`
   - Only if step 2–3 reveals fragility, add neutral class support guidance (e.g., preserve `inline-flex` and allow `className` to override width/overflow cleanly).
   - Avoid introducing default overflow styles globally unless justified by regression risk analysis.

5. **Add/adjust mobile CSS utility only if Tailwind utilities are insufficient**
   - File: `packages/web/src/client/index.css` (optional)
   - Prefer utility classes first; add custom CSS only when necessary for consistent iOS/Android touch scrolling.

6. **Verification**
   - Run web checks relevant to this UI change (at minimum package-level lint/typecheck expectations used in repo workflow).
   - Manually verify in mobile viewport (DevTools):
     - Create Project page (`/projects/new`): can horizontally swipe tab strip.
     - Edit Project page (`/projects/:name/edit`): same behavior.
     - Desktop/tab behavior unchanged.

7. **Regression check against similar tab UX**
   - Compare behavior with `SettingsPage` tab strip to keep interaction consistent (scrollability, focus styles, active tab clarity).

## Acceptance criteria

- On narrow/mobile viewport, users can horizontally scroll/swipe the Create/Edit Project tab strip.
- Tab labels do not wrap into multi-line broken layout.
- Active/inactive tab styling and keyboard navigation still work.
- No desktop regression in project form tabs.
- No unrelated routing/form submission behavior changed.

## Risks / open questions

- **Ambiguity risk:** The request may have meant Settings top tabs, not project form tabs. If so, apply the same overflow strategy to `SettingsPage.tsx` tab bar after confirming reproduction.
- **Touch behavior variance:** iOS momentum scrolling can differ; may require explicit touch-scrolling styles if utility classes alone are insufficient.
- **Shared component risk:** Changing `ui/tabs.tsx` defaults could unintentionally affect other tab consumers; prefer local fix first.

## Proposed BUILD task breakdown

1. **BUILD A — Implement local mobile overflow fix in project form tabs**
   - Edit `CreateProjectForm.tsx` tab markup/classes to enable horizontal scrolling and non-shrinking triggers.
   - Include brief inline comment explaining why local overflow is required.

2. **BUILD B — Verify and harden only if needed**
   - If issues persist, add minimal, backward-compatible adjustment in `ui/tabs.tsx` or `index.css`.
   - Keep change narrowly scoped to avoid broad UI regressions.

3. **BUILD C — Validation pass**
   - Run checks and manually confirm behavior on `/projects/new` and `/projects/:name/edit` in mobile viewport.
   - Document observed before/after behavior in task notes.
