# Plan: stats/sessions allow opening one session

## Context

- The Stats page is rendered by `packages/web/src/client/components/StatsView.tsx` and its **Sessions** tab currently shows a flat table via `SessionsTable` with no per-row detail view.
- Session transcript rendering already exists in `packages/web/src/client/components/SessionView.tsx`, but it expects a **run name** and fetches data from `GET /api/runs/:name/session` through `useSession` (`packages/web/src/client/hooks/useSession.ts`) and `fetchSession` (`packages/web/src/client/lib/api.ts`).
- Stats session rows already contain `name` (run name) and enough metadata to identify/select a single row (`StatSession.id`, `StatSession.name`) from `GET /api/stats/sessions` (`packages/web/src/server/routes/stats.ts`).
- There is no dedicated stats-session-detail endpoint today (e.g. `/api/stats/sessions/:id`), so opening details from Stats should reuse run-session APIs and existing UI patterns.

## Scope boundaries

### In scope

- Add interaction in the Stats **Sessions** tab so a user can open a session detail view.
- Enforce that at most **one** session is open at a time (single-selection behavior).
- Reuse existing `SessionView` component and existing run/session API flow where possible.
- Add/adjust lightweight UI states for open/close/empty/loading/error behavior in Stats Sessions UX.

### Out of scope

- Backend schema/migration changes (`packages/web/src/server/schema.ts`, migrations).
- New stats database APIs unless proven necessary after implementation spikes.
- Broad redesign of Stats tabs/charts or Run detail page behavior.

## Assumptions

1. The request means: in `/stats` → `Sessions` tab, clicking a session row should open that session’s transcript, and only one row/session detail may be expanded/visible at a time.
2. It is acceptable to identify/open session details by `run.name` from stats rows.
3. Existing `SessionView` fetch behavior (`/api/runs/:name/session`) is acceptable for the Stats use case.

## Approach

1. Introduce a controlled `openSession` state in `StatsView` (prefer run name, optionally paired with session ID) and pass it into `SessionsTable`.
2. Make session rows act as toggles:
   - click unopened row → open that row,
   - click already-open row → close it,
   - opening a new row closes the previous one automatically.
3. Render a detail region (inline expandable row beneath the selected session row, or a dedicated detail panel below the table) containing `SessionView` for the selected run.
4. Keep pagination/day-filter/tab changes deterministic by resetting/clearing open state when the selected row is no longer present in current page data.
5. Add tests for core reducer/interaction behavior where feasible and retain current auth/smoke coverage unaffected.

## Tasks

1. **Define open-session state contract in `StatsView`**
   - File: `packages/web/src/client/components/StatsView.tsx`
   - Add state for currently-open session (e.g. `openRunName: string | null`).
   - Clear this state on page/day/tab transitions that invalidate the selected row.

2. **Refactor `SessionsTable` props for controlled selection**
   - File: `packages/web/src/client/components/StatsView.tsx`
   - Extend `SessionsTable` signature to receive:
     - current open run/session identifier,
     - selection callback.
   - Ensure table remains render-only for list data + selection event emission.

3. **Implement row toggle behavior (single-open invariant)**
   - File: `packages/web/src/client/components/StatsView.tsx`
   - Make each session row clickable and keyboard-accessible.
   - Apply explicit open-state visual treatment (selected row styles, aria-expanded).
   - Enforce only one open session at a time through controlled state updates.

4. **Render session detail using existing `SessionView`**
   - File: `packages/web/src/client/components/StatsView.tsx`
   - Embed `SessionView` for the selected run within Sessions tab UI.
   - Provide required props (`name`, `hasSession`, `active`, `sseConnected`, `eventTick`) with Stats-safe defaults for historical runs.
   - Show clear fallback text when a selected row cannot load session details.

5. **Stabilize behavior with pagination/filter changes**
   - File: `packages/web/src/client/components/StatsView.tsx`
   - When new page/day results no longer include the selected run, clear open state to prevent stale detail panes.
   - Verify no React key/state leakage when table data reorders.

6. **Add/adjust tests for the new interaction**
   - Candidate files:
     - `packages/web/src/client/components/StatsView.tsx` (if colocated tests are used), or
     - appropriate web client test location if existing pattern differs.
   - Cover at minimum:
     - opening one row displays detail,
     - opening another row closes previous,
     - toggling same row closes it,
     - selected session resets when not present after page/day change.

7. **Run validation checks**
   - Execute relevant repo checks (at minimum TypeScript/tests used for web changes) and record outcomes in BUILD task notes.

## Acceptance criteria

1. In `/stats` → `Sessions`, a user can open session details from a listed session row.
2. At any time, at most one session detail view is open.
3. Opening a different row automatically closes the previously opened row.
4. Clicking the currently open row closes it.
5. Changing pagination/day filter does not leave stale/open details for rows not in current data.
6. Existing stats summary/agents/models/tools tabs continue to function unchanged.

## Proposed BUILD task breakdown

1. **BUILD 1 — State + table interaction plumbing**
   - Add controlled open-session state in `StatsView`.
   - Refactor `SessionsTable` props and implement row toggle/select behavior.

2. **BUILD 2 — Session detail rendering integration**
   - Integrate `SessionView` into Sessions tab detail area.
   - Add UX polish for open row styling and empty/error states.

3. **BUILD 3 — Robustness + validation**
   - Handle pagination/day filter reset behavior for selected session.
   - Add/adjust tests for single-open invariant.
   - Run typecheck/tests and fix regressions.

## Risks / open questions

1. **Identifier mismatch risk**: stats rows are keyed by session ID but session fetching route is keyed by run name; if run names are not stable/unique in some edge case, selection mapping may be brittle.
2. **Performance risk**: rendering `SessionView` in Stats may trigger heavy data loads; ensure only the open row mounts/fetches.
3. **Historical run behavior**: some older runs may have missing/expired live session data and rely on snapshot fallback; UX copy should make this explicit.
4. **UI density**: inline expanded details can make long tables harder to scan; if this becomes noisy, follow-up may move details into a side panel while preserving single-open semantics.
