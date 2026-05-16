# Plan: Shadcn Collapsible Sidebar

## Goal
Replace the custom sidebar in Layout.tsx with the shadcn sidebar compound component (`collapsible="icon"`), so it collapses to icons with smooth animation, tooltips, hover rail, and keyboard shortcut.

## Changes

### 1. `index.css` — Replace sidebar CSS variables with percussionist dark theme
Remove the light-theme `.dark` block and update `:root` to match the existing dark palette:
```css
--sidebar: #1a1410;              /* = surface-raised */
--sidebar-foreground: #faf5f0;   /* = text */
--sidebar-primary: #d97706;      /* = accent */
--sidebar-primary-foreground: #fff;
--sidebar-accent: #2a2018;       /* = surface-overlay */
--sidebar-accent-foreground: #faf5f0;
--sidebar-border: #5c4a3a;       /* = border */
--sidebar-ring: #d97706;         /* = accent */
```

### 2. `app-sidebar.tsx` (NEW) — Sidebar component with nav data
Located at `src/client/components/app-sidebar.tsx`. Uses:
- `SidebarHeader` with `DrumLogo` + branding text (text hides when collapsed)
- `SidebarContent` with nav items:
  - **Runs** — flat `SidebarMenuButton asChild` wrapping `NavLink` to `/`
  - **Projects** — `Collapsible` section using `useProjects()` for dynamic list; uses `SidebarMenuSub` with per-project `NavLink`
  - **Agents** — flat `NavLink` to `/agents`
  - **Stats** — flat `NavLink` to `/stats`
  - **Metrics** — flat `NavLink` to `/metrics`
- `SidebarFooter` with manager status dot + version
- `SidebarRail` for hover-to-expand strip

### 3. `Layout.tsx` — Rewrite to use shadcn sidebar
Replace the custom `<aside>` block with:
```tsx
<SidebarProvider>
  <AppSidebar playing={hasInProgress} managerAvailable={managerAvailable} />
  <SidebarInset>
    <header className="flex h-11 items-center justify-between px-4 border-b border-border bg-surface-raised">
      <SidebarTrigger className="-ml-1" />
      <NotificationBell />
    </header>
    <main className="flex-1 p-6"><Outlet /></main>
  </SidebarInset>
</SidebarProvider>
```
Removes: `SidebarLink`, `Chevron`, `ProjectNav` functions entirely.

### 4. Shadcn components already installed
- `sidebar.tsx` (main compound component)
- `tooltip.tsx`, `collapsible.tsx`, `separator.tsx`
- `sheet.tsx`, `dropdown-menu.tsx`
- `skeleton.tsx`, `input.tsx`

### Files Changed
| File | Action |
|---|---|
| `src/client/index.css` | Edit — replace sidebar CSS vars |
| `src/client/components/app-sidebar.tsx` | Create — sidebar component |
| `src/client/components/Layout.tsx` | Edit — use sidebar system |
