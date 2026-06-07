# Plan: Close sidebar on mobile after menu item click

## Context

The web app layout mounts the sidebar via `SidebarProvider` in `packages/web/src/client/components/Layout.tsx`, and the navigation items are rendered in `packages/web/src/client/components/app-sidebar.tsx`.

Mobile behavior is implemented in `packages/web/src/client/components/ui/sidebar.tsx`:
- `Sidebar` renders a Radix `Sheet` when `isMobile` is true.
- Open state is tracked as `openMobile` in `SidebarProvider` context.
- `setOpenMobile` is available from `useSidebar()`.

Today, menu links (`NavLink`) in `AppSidebar` navigate correctly but do not explicitly close the mobile sheet after selection, so the drawer can remain open after route changes.

## Scope boundaries

In scope:
- Client-side sidebar navigation behavior for mobile in `packages/web/src/client/components/app-sidebar.tsx` (and only minimal shared sidebar surface if needed).

Out of scope:
- Desktop collapse/expand behavior.
- Route definitions, data fetching, or server APIs.
- Visual redesign of sidebar or menu structure.

## Approach

Use existing sidebar context (`useSidebar`) inside `AppSidebar` to close the mobile drawer on menu item activation:

1. Read `isMobile` and `setOpenMobile` from sidebar context.
2. Add a shared click handler for sidebar `NavLink` items that calls `setOpenMobile(false)` only on mobile.
3. Attach the handler to all navigation links rendered in `AppSidebar` (top nav, project entries/new project, bottom nav).
4. Keep desktop behavior unchanged by guarding on `isMobile`.

Key decision:
- Implement closure in `AppSidebar` (where navigation links are authored) rather than in low-level `SidebarMenuButton`, to avoid side effects for other consumers of sidebar UI primitives.

## Acceptance criteria

1. On viewport widths `< 768px`, opening the sidebar and selecting any menu item closes the drawer immediately.
2. Navigation still occurs correctly to the selected route.
3. On desktop widths (`>= 768px`), current sidebar behavior remains unchanged.
4. No regressions to existing sidebar rendering (top nav, project links/new project, bottom nav).

## Proposed BUILD task breakdown

1. **Wire mobile-close helper in AppSidebar**
   - Update `packages/web/src/client/components/app-sidebar.tsx` to use `useSidebar()`.
   - Add a single `handleNavClick` callback that closes mobile sheet with `setOpenMobile(false)` when `isMobile` is true.

2. **Attach handler to all sidebar links**
   - Apply `onClick={handleNavClick}` to each `NavLink` in top nav, project/new-project section, and bottom nav.
   - Ensure active-state and tooltip behavior are untouched.

3. **Validate behavior manually**
   - Mobile width: open sidebar → click each menu class of item (top/project/bottom) → confirm close + navigation.
   - Desktop width: verify no close-on-click side effect is introduced.

4. **(Optional hardening if needed during build)**
   - If edge cases appear (modified-click/new-tab interactions), narrow closure logic to primary unmodified clicks while preserving expected browser behavior.

## Risks / open questions

- **Modified click behavior:** If closing on every click is undesirable for cmd/ctrl-click open-in-new-tab flows, handler may need to inspect event modifiers.
- **Non-click navigation activation:** Keyboard activation on links should still trigger close via click synthesis; verify in manual QA.
- **Future reuse:** If additional sidebar link groups are added later, they must also use the close handler to preserve consistency.

## Assumptions

- “Menu item click” refers to navigation links rendered by `AppSidebar`.
- Desired behavior is to close mobile sidebar for any item selection, including clicking the currently active route link.
