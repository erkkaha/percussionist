# Settings Page Whitespace Consistency

## Context

The Layout component (`Layout.tsx`) provides `p-6` (24px) base padding on all sides for page content via `<main className="... p-6">`. Each page then handles its own internal spacing. The Settings page has several whitespace inconsistencies compared to other views:

### Current patterns across pages

| Page | Root Container | Gap/Spacing | Max Width |
|------|---------------|-------------|-----------|
| **RunList** | `space-y-4` (1rem) | 1rem between sections | full-width |
| **RunDetail** | `space-y-6` (1.5rem) | 1.5rem between sections | full-width |
| **ProjectsPage** | `space-y-4` (1rem) | 1rem between sections | full-width |
| **AgentsPage** | `space-y-4` (1rem) | 1rem between sections | full-width |
| **BoardView** | `-m-6` + custom padding | negates parent, owns layout | full-width |
| **ActivityPage** | `-m-6` + custom padding | negates parent, owns layout | full-width |
| **SettingsPage** | `gap-4 max-w-5xl mx-auto` | 1rem between sections | **constrained to 5xl** |

### Identified issues

1. **Constrained width**: SettingsPage uses `max-w-5xl mx-auto`, centering content and leaving large empty margins on wide screens. All other pages use full-width layouts. This is the most visually noticeable inconsistency.

2. **Duplicate headers in embedded tabs**: When ProjectsPage or AgentsPage render inside SettingsPage as tabs (lines 134/136), they each have their own `<h1>` header ("Projects", "Agents") plus a "+ New" button and subtitle — creating redundant UI since the parent already has a "Settings" title and tab navigation.

## Approach

Make three targeted changes to align SettingsPage with the rest of the application:

### 1. Remove `max-w-5xl mx-auto` from SettingsPage root
Change the root container from `flex flex-col gap-4 max-w-5xl mx-auto w-full` to `flex flex-col gap-4 w-full`. This gives Settings full-width content like RunList, RunDetail, and other pages.

### 2. Add `showHeader` prop to ProjectsPage
ProjectsPage is used both as a standalone route (`/projects`) and embedded in Settings tabs. When embedded, it should hide its own header (title, subtitle, "+ New Project" button) since the parent provides navigation context.

- Add optional `showHeader?: boolean` prop (default `true`) to ProjectsPage
- Conditionally render the header block based on this prop
- Pass `showHeader={false}` from SettingsPage when rendering `<ProjectsPage />` as a tab

### 3. Add `showHeader` prop to AgentsPage
Same pattern as ProjectsPage — add optional `showHeader?: boolean` prop (default `true`) and conditionally render the header block. Pass `showHeader={false}` from SettingsPage.

## Tasks

1. **Remove max-width constraint in SettingsPage** (`SettingsPage.tsx`, line 99)
   - Change `<div className="flex flex-col gap-4 max-w-5xl mx-auto w-full">` to `<div className="flex flex-col gap-4 w-full">`

2. **Add `showHeader` prop to ProjectsPage** (`ProjectsPage.tsx`)
   - Add `showHeader?: boolean` to the component props type (default `true`)
   - Wrap the header block (lines 103–123) in `{showHeader !== false && (...)}`
   - When hidden, the table/skeleton/empty-state content renders directly

3. **Add `showHeader` prop to AgentsPage** (`AgentsPage.tsx`)
   - Add `showHeader?: boolean` to the component props type (default `true`)
   - Wrap the header block (lines 106–126) in `{showHeader !== false && (...)}`

4. **Pass `showHeader={false}` from SettingsPage** (`SettingsPage.tsx`, lines 134/136)
   - Change `<ProjectsPage />` to `<ProjectsPage showHeader={false} />`
   - Change `<AgentsPage />` to `<AgentsPage showHeader={false} />`

5. **Verify standalone routes still work** — confirm that `/projects` and `/agents` direct routes (in `App.tsx`) still render full headers since they don't pass the prop.

## Risks / Open Questions

- **No risk to standalone routes**: The `showHeader` prop defaults to `true`, so `/projects` and `/agents` routes continue rendering normally.
- **"+ New" button visibility**: When embedded in Settings, the "+ New Project" / "+ New Agent" buttons are hidden along with headers. Users can still navigate to `/projects/new` or `/agents/new` via the sidebar. This is acceptable since Settings is a configuration view, not a creation workflow.
- **Gap spacing (`gap-4` vs `space-y-6`)**: SettingsPage uses `gap-4` (1rem) while RunDetail uses `space-y-6` (1.5rem). Given that Settings has its own header and tab bar above content, the tighter 1rem gap is appropriate and not changed in this plan. If further tightening or loosening is desired, it can be a follow-up task.

## Acceptance Criteria

- Settings page content spans full width on all screen sizes (no centered max-width constraint)
- ProjectsPage tab inside Settings shows no duplicate "Projects" header
- AgentsPage tab inside Settings shows no duplicate "Agents" header
- Standalone `/projects` route still shows the full header with title and "+ New Project" button
- Standalone `/agents` route still shows the full header with title and "+ New Agent" button
- All other Settings tabs (Secrets, OpenCode Config, Manager, Runner, Updates) render unchanged
