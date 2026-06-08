# Plan: sidebar should close on mobile after menu item click

## Context

Relevant existing code paths:

- `packages/web/src/client/components/Layout.tsx`
  - Wraps the app in `SidebarProvider`.
  - Renders `AppSidebar` and `SidebarInset`.
- `packages/web/src/client/components/ui/sidebar.tsx`
  - `SidebarProvider` owns mobile drawer state via `openMobile` / `setOpenMobile`.
  - `Sidebar` renders a Radix `Sheet` on mobile (`isMobile === true`), controlled by `openMobile`.
  - `useSidebar()` exposes `{ isMobile, openMobile, setOpenMobile, ... }` to descendants.
- `packages/web/src/client/components/app-sidebar.tsx`
  - Defines all sidebar navigation links (`NavLink`) for top items, project items, and bottom items.
  - Currently does not call `setOpenMobile(false)` on link activation.

Observed gap:

- On mobile, clicking a menu item navigates but can leave the sheet open because no explicit close action is triggered from navigation links.

## Scope boundaries

In scope:

- Mobile-only close-on-selection behavior for sidebar navigation links in `app-sidebar.tsx`.
- Any minimal wiring needed to access sidebar context in `AppSidebar`.

Out of scope:

- Desktop collapse behavior (`open`, `state`, `SidebarTrigger`, rail).
- Route definitions, data loading hooks, API/server logic.
- Visual redesign, new navigation groups, or broader sidebar refactors.

## Approach

Primary strategy (recommended):

1. Consume `useSidebar()` inside `AppSidebar`.
2. Add a single handler (e.g. `handleSidebarNavClick`) that closes the drawer only when `isMobile` is true by calling `setOpenMobile(false)`.
3. Attach this handler to every sidebar `NavLink` rendered in `AppSidebar`:
   - top items (`Activity`, `Runs`)
   - project items (or `New project` fallback)
   - bottom items (`Settings`, `Stats`, `Metrics`)
4. Keep all current active-state (`isActive`) and tooltip behavior unchanged.

Why this approach (retry refinement):

- A route-change listener could miss same-route clicks (no navigation event), while click-based handling guarantees close behavior for the user action itself.
- Implementing in `AppSidebar` keeps behavior localized to navigation semantics and avoids side effects in shared primitives like `SidebarMenuButton` used elsewhere.

## Acceptance criteria

1. At mobile widths (`< md`, matching current sidebar mobile mode), selecting any sidebar menu item closes the sheet.
2. Navigation still occurs correctly for each link target.
3. Desktop behavior is unchanged (no forced close side effect).
4. Existing sidebar sections still render and behave as before (top/project-or-new/bottom).
5. Clicking an already-active link on mobile also closes the drawer.

## Proposed BUILD task breakdown

1. **Integrate sidebar context in AppSidebar**
   - File: `packages/web/src/client/components/app-sidebar.tsx`
   - Import and call `useSidebar()`.
   - Extract `isMobile` and `setOpenMobile`.

2. **Create shared nav-click close handler**
   - Add `handleSidebarNavClick` in `AppSidebar`.
   - Handler closes only for mobile (`if (isMobile) setOpenMobile(false)`).

3. **Apply handler consistently to all `NavLink`s**
   - Top nav map block.
   - Project list map block.
   - New-project fallback link.
   - Bottom nav map block.

4. **Manual behavior verification**
   - Mobile viewport:
     - open sidebar via trigger,
     - click at least one item from each section,
     - verify sheet closes and route updates.
   - Desktop viewport:
     - click sidebar items,
     - verify no unintended close/collapse behavior.

5. **Optional hardening (only if needed during implementation)**
   - If modified-click behavior (Ctrl/Cmd/open-in-new-tab) should not close the drawer, conditionally ignore non-primary or modified clicks.

## Risks / open questions

- **Modified clicks:** Decide whether Ctrl/Cmd/middle-click should keep the drawer open on mobile.
- **Keyboard activation:** Ensure Enter/Space activation on focused links still closes drawer (typically synthesized click).
- **Future link additions:** Any newly added sidebar link in `AppSidebar` must also use the shared handler.

## Assumptions

- “Menu item click” refers to the navigation links rendered in `AppSidebar`.
- Desired behavior is immediate mobile drawer close on user selection, even when selecting the currently active route.
