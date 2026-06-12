# Plan: Move Sessions from Stats tab to Sidebar with dedicated Session pages

**Task:** `percussionist-dev-plan-d7ad04`  
**Request:** Move session browsing out of `Stats` → `Sessions` tab into first-class sidebar navigation, and open selected sessions in a dedicated page with back navigation (similar to Runs list/detail UX).

---

## Context

- Routing is centralized in `packages/web/src/client/App.tsx`.
  - Current routes include `/stats` (rendering `StatsView`) and `/runs` + `/runs/:name`.
  - There is no standalone `/sessions` or `/sessions/:name` route today.
- Sidebar navigation lives in `packages/web/src/client/components/app-sidebar.tsx`.
  - Current nav includes `Activity`, `Runs`, and bottom items `Settings`, `Stats`, `Metrics`.
  - Sessions are not a sidebar destination.
- Session browsing is currently embedded inside `packages/web/src/client/components/StatsView.tsx`:
  - `TABS` includes `{ id: "sessions", label: "Sessions" }`.
  - `SessionsTable` is defined in this file and toggles inline expansion via `openRunName`.
  - Clicking a row opens `SessionView` inline on the same page (`openRunName` state + render block around lines ~977-1001).
- Raw session message rendering is handled by `packages/web/src/client/components/SessionView.tsx`, which is already reusable and used by `RunDetail`.
- Session data source for list/analytics is `/api/stats/sessions` (queried directly in `StatsView`), while conversation detail is loaded through `useSession()` (`/api/runs/:name/session`).

---

## Scope boundaries

### In scope
- Introduce dedicated session navigation from sidebar.
- Add a sessions list page and a session detail page with explicit back navigation.
- Remove inline “open session in Stats page” behavior.
- Keep existing backend APIs unless a hard blocker appears.

### Out of scope
- Reworking server-side stats aggregation endpoints (`/api/stats/sessions`, `/api/stats/trends`) beyond what is required for UI wiring.
- Redesigning `SessionView` rendering internals.
- Broader IA changes unrelated to sessions/stats split.

---

## Approach

1. **Promote Sessions to first-class route(s)**
   - Add `/sessions` for list and `/sessions/:name` for detail, mirroring the Runs pattern.
2. **Extract and reuse current Stats sessions-table logic**
   - Move list/table/pagination behavior out of `StatsView` into a dedicated sessions page component.
   - Replace row toggle behavior with route navigation to `/sessions/:name`.
3. **Create dedicated session detail page**
   - Build a page component that renders a back link to `/sessions` and embeds `SessionView` for the selected run/session.
   - Use existing hooks (`useRun`, `useRunEvents`) where needed to provide accurate `hasSession`, `active`, and SSE state (same pattern as `RunDetail`).
4. **Simplify StatsView**
   - Remove the Sessions tab and all inline session expansion state.
   - Keep overview/agents/models/tools stats functionality intact.

**Assumption:** session detail URL will key by run name (`/sessions/:name`), consistent with existing session fetch endpoint `/api/runs/:name/session`.

---

## Tasks

1. **Add new session routes in app router**
   - File: `packages/web/src/client/App.tsx`
   - Register:
     - `Route path="/sessions"` → new sessions list component.
     - `Route path="/sessions/:name"` → new session detail component.
   - Keep existing `/runs` routes unchanged.

2. **Add Sessions entry to sidebar navigation**
   - File: `packages/web/src/client/components/app-sidebar.tsx`
   - Add a nav item for `/sessions` (icon choice consistent with current design system, e.g. `List`/`MessageSquare`).
   - Ensure active state logic works for both `/sessions` and `/sessions/:name` (likely `startsWith` handling similar to project board links).

3. **Create dedicated sessions list page component**
   - New file (suggested): `packages/web/src/client/components/SessionList.tsx` (or `SessionsPage.tsx`, align with existing naming style).
   - Migrate relevant logic from `StatsView.tsx`:
     - `StatSession`/`SessionsResponse` typings (or shared extracted typings).
     - Fetch of `/api/stats/sessions` with `days`, `limit`, `offset`.
     - Sessions table columns (`Name`, `Phase`, `Model`, `Tokens`, `Cost`, `Duration`, `Age`).
     - Pagination UI.
   - Replace row click/keyboard toggle callback with `<Link to={`/sessions/${encodeURIComponent(s.name)}`}>` style navigation or equivalent click navigation.

4. **Create dedicated session detail page component**
   - New file (suggested): `packages/web/src/client/components/SessionDetail.tsx`.
   - Pattern after `RunDetail` / `PlanView` navigation:
     - back link text like “All sessions” (or “Back to sessions”) linking to `/sessions`.
   - Use `useParams<{ name: string }>()` to resolve run name.
   - Use `useRun(name)` + `useRunEvents(name, isActive)` (or a minimal variant) to pass accurate props into `SessionView`:
     - `name`
     - `hasSession={!!run.status?.sessionID}`
     - `active={isActive}`
     - `sseConnected`, `eventTick`
   - Handle loading/error/not-found states with existing app patterns (cards/banners).

5. **Refactor StatsView to remove embedded sessions mode**
   - File: `packages/web/src/client/components/StatsView.tsx`
   - Remove:
     - `sessions` tab from `TABS`.
     - `openRunName` state and reset effect.
     - Inline `<SessionView ... />` block and row-toggle behavior.
     - Session-tab-specific pagination rendering.
   - Preserve:
     - `overview`, `agents`, `models`, `tools` tabs and existing API queries.
   - Clean up imports now unused (`SessionView`, `List` icon, etc.).

6. **Decide shared-vs-duplicated session helper placement**
   - If duplication appears between new Sessions list and `StatsView`, extract shared helpers/types (e.g., formatting and response types) into a client utility module (suggested: `packages/web/src/client/lib/session-stats.ts`).
   - Keep extraction minimal and pragmatic to avoid scope creep.

7. **Verification pass**
   - Run typecheck and tests for web package/repo (`pnpm typecheck`, `pnpm test` as appropriate to repo workflow).
   - Manual UX sanity checks:
     - Sidebar has Sessions item.
     - `/sessions` shows paginated list.
     - Clicking a session opens `/sessions/:name`.
     - Detail page shows back navigation and session content.
     - `/stats` no longer contains a Sessions tab.

---

## Acceptance criteria

- Sidebar contains a **Sessions** navigation entry.
- A dedicated **Sessions list page** exists at `/sessions`.
- Selecting a session navigates to a dedicated **Session detail page** at `/sessions/:name`.
- Session detail page includes a back link/navigation to `/sessions`.
- `StatsView` no longer contains an embedded Sessions tab or inline session expansion panel.
- Existing Runs list/detail behavior remains unchanged.

---

## Risks / open questions

1. **Route keying by run name vs session ID**
   - Current session fetch endpoint is run-name-based (`/api/runs/:name/session`), so `/sessions/:name` is the natural fit.
   - If historical rows exist without a currently resolvable run CR, detail page may fail; decide whether this is acceptable for this change.

2. **Active-state highlighting in sidebar**
   - Current top/bottom item active checks use strict equality for some routes; sessions may need prefix-based matching for detail subroutes.

3. **Stats data coupling**
   - Sessions list currently depends on `/api/stats/sessions`; if this endpoint semantics change later, both Stats and Sessions pages may require coordinated updates.

4. **Naming consistency**
   - Existing codebase uses both `Page` and non-`Page` suffixes (e.g., `ProjectsPage`, `RunDetail`). Keep naming aligned with nearby conventions in implementation PR.

---

## Proposed BUILD task breakdown

1. **BUILD 1 — Routing + sidebar navigation**
   - Add `/sessions` and `/sessions/:name` routes and sidebar Sessions item with correct active behavior.

2. **BUILD 2 — Sessions list/detail components**
   - Implement dedicated list and detail pages, wire table row navigation and back link UX.

3. **BUILD 3 — Stats cleanup + verification**
   - Remove embedded Sessions mode from `StatsView`, clean imports/state, and run validation checks.
