# Plan: Fix Collapsed Sidebar Hover Tooltip Readability

**Task:** `percussionist-dev-plan-eff5c8`  
**Issue:** In collapsed sidebar mode, hover labels/tooltips are visually see-through, so underlying page content bleeds through and text is hard to read.

---

## Context

- The sidebar navigation is rendered in `packages/web/src/client/components/app-sidebar.tsx` using `SidebarMenuButton` with `tooltip={...}` for icon-only (collapsed) navigation labels.
- Tooltip rendering logic lives in `packages/web/src/client/components/ui/sidebar.tsx` (`SidebarMenuButton` around lines ~545-600), which conditionally renders `TooltipContent` when sidebar state is collapsed.
- Base tooltip styling is defined in `packages/web/src/client/components/ui/tooltip.tsx` (`TooltipContent` class list includes `bg-popover text-popover-foreground border ...`).
- The report is specific to **collapsed sidebar hover labels**, not all hover states globally.

Observed likely cause:
- The current tooltip surface token (`bg-popover`) is not producing an opaque enough surface in this context, resulting in low contrast against busy page content behind the tooltip.

---

## Scope Boundaries

### In scope
- Desktop collapsed sidebar hover labels/tooltips triggered by `SidebarMenuButton` in the app sidebar.
- Ensuring tooltip surface is opaque/readable and text contrast is acceptable.

### Out of scope
- Re-theming all tooltips across the app unless needed for consistency.
- Sidebar layout/behavior changes unrelated to visual readability.
- Mobile sheet navigation behavior (tooltips are already hidden on mobile in `SidebarMenuButton`).

---

## Approach

Use a **targeted styling fix** for collapsed sidebar tooltips so they always render on a solid, readable surface.

Preferred strategy:
1. Keep generic tooltip component behavior intact where possible.
2. Apply explicit tooltip surface classes for sidebar tooltips (via `tooltip` prop options or `SidebarMenuButton`-level default class override) to guarantee non-transparent background and matching border/text colors.
3. Verify both short labels (e.g., “Runs”) and long project names remain readable.

Design decision notes:
- Since the issue is reported for sidebar collapsed hovers specifically, a scoped fix in `sidebar.tsx` is lower risk than changing global `TooltipContent` defaults used by unrelated UI.
- Use existing sidebar color tokens (`sidebar`, `sidebar-foreground`, `sidebar-border` or equivalent classes) for visual consistency with the left nav.

---

## Tasks

1. **Confirm exact tooltip path for collapsed sidebar labels**
   - Inspect `SidebarMenuButton` in `packages/web/src/client/components/ui/sidebar.tsx` to confirm the tooltip is only shown when `state === "collapsed"` and `!isMobile`.
   - Verify `AppSidebar` entries all rely on this path (`packages/web/src/client/components/app-sidebar.tsx`).

2. **Implement scoped opaque tooltip styling for sidebar collapsed state**
   - Update sidebar tooltip usage so `TooltipContent` in `SidebarMenuButton` receives an explicit non-transparent surface class set (background, border, foreground text).
   - Ensure default string tooltips and object tooltips both inherit the readability fix without breaking custom tooltip props.

3. **Guard against visual regressions in other tooltip consumers**
   - Confirm generic `TooltipContent` usage outside sidebar is unchanged in behavior unless intentionally modified.
   - Confirm dropdown menu styles (`dropdown-menu.tsx`) are not inadvertently affected by the sidebar-specific fix.

4. **Manual UI verification checklist (desktop)**
   - Collapse sidebar and hover top nav items (Activity, Runs).
   - Hover project rows (including long project names).
   - Hover bottom nav items (Settings, Stats, Metrics, Tools).
   - Validate text remains legible over complex background content and tooltip appears visually opaque.

5. **Sanity verification**
   - Run web build/type validation relevant to touched files (at minimum workspace typecheck/build target used by repository conventions).

---

## Proposed BUILD Task Breakdown

1. **BUILD A — Sidebar tooltip styling fix**
   - Files: `packages/web/src/client/components/ui/sidebar.tsx` (primary)
   - Deliverable: collapsed sidebar tooltip content has explicit opaque background + readable foreground/border.

2. **BUILD B — Validation and regression check**
   - Files: none or minimal touch if small follow-up needed
   - Deliverable: verified no regression for non-sidebar tooltip/popover surfaces; include short QA notes in task output.

---

## Risks / Open Questions

1. **Token mismatch risk:** If `popover` tokens are globally misconfigured, a scoped sidebar fix resolves this issue but may leave similar issues elsewhere.
2. **Style precedence risk:** Existing class precedence from consumer-provided `tooltip` props may override new defaults; implementation should ensure readability defaults still apply.
3. **Theme consistency question:** Should sidebar tooltips use `popover` palette or sidebar palette? This plan assumes sidebar palette is preferred for guaranteed contrast in collapsed nav context.

---

## Acceptance Criteria

- In collapsed desktop sidebar mode, hover tooltip labels are not see-through.
- Tooltip text is clearly readable regardless of page content behind it.
- Sidebar tooltip fix is scoped and does not unintentionally alter unrelated tooltip/dropdown appearances.
- Updated behavior is implemented in the sidebar tooltip rendering path (`SidebarMenuButton`) and verified manually.
