# Plan: mobile sessions table header columns misaligned with body

## Context

- The sessions page is rendered by `packages/web/src/client/components/SessionList.tsx` and mounted at `/sessions` via `packages/web/src/client/App.tsx`.
- The sessions table container already uses horizontal scrolling (`overflow-x-auto`), but the table itself is `w-full` with no explicit minimum width.
- In `SessionList.tsx`, each `<tbody>` entry is currently rendered as:
  - `<Link className="block ...">`
  - containing `<tr>...</tr>`
- This is invalid table structure (a `<tbody>` should contain `<tr>` elements directly). Browsers repair this differently, and on narrow/mobile viewports this can desynchronize header/body layout calculations.
- Comparable tables (`RunList.tsx`, `ProjectsPage.tsx`) keep valid structure (`<tbody> -> <tr>`) and place links inside cells rather than around table rows.

## Scope boundaries

### In scope

- Fix column alignment behavior for the sessions table on mobile by correcting markup/layout in `SessionList.tsx`.
- Add/adjust targeted tests around sessions table structure and responsive overflow behavior.

### Out of scope

- Redesigning the sessions page visual style.
- Changing backend session APIs (`/api/stats/sessions`) or query behavior.
- Broad refactors across unrelated table components.

## Approach

1. **Normalize table semantics first**: ensure `<tbody>` children are `<tr>` elements only.
2. **Preserve row navigation UX** while staying semantically valid:
   - Preferred: render `<tr>` directly and place a `<Link>` in the name cell (matching existing patterns in `RunList.tsx`), or
   - Alternative: use `onClick` + `useNavigate` on `<tr>` with keyboard/accessibility support.
3. **Harden narrow-screen layout** by adding a stable minimum table width (similar to other list tables) so columns do not collapse unpredictably.
4. **Lock behavior with tests** so regressions in DOM structure/overflow classes are caught.

## Tasks

1. Inspect and refactor `packages/web/src/client/components/SessionList.tsx` table row rendering so each session row is a direct `<tr>` under `<tbody>` (remove `<Link>` wrappers around `<tr>`).
2. Re-implement row navigation in a semantically valid way (prefer in-cell link in the Name column) while keeping current route target: ``/sessions/${encodeURIComponent(s.name)}``.
3. Keep existing hover/visual affordances for row discoverability after link placement changes.
4. Add a table minimum width in `SessionList.tsx` (e.g., consistent with `RunList`/`ProjectsPage` conventions) to stabilize mobile column geometry inside `overflow-x-auto`.
5. Add a new test file for sessions list component behavior (e.g., `packages/web/tests/session-list.test.tsx`) with hook/API mocks analogous to current component tests.
6. Add assertions that:
   - the table wrapper keeps horizontal overflow behavior,
   - session rows render as `<tr>` elements in `<tbody>` (no `<a>` as direct tbody child),
   - the Name cell includes a link to the expected session detail route.
7. Run focused web tests for the new/updated specs, then run the standard project checks required for the BUILD task.

## Acceptance criteria

- On mobile viewport widths, sessions table headers and body cells stay aligned column-for-column.
- `SessionList` renders valid table DOM hierarchy (`thead/tr/th`, `tbody/tr/td`).
- Row-to-detail navigation remains available and points to `/sessions/:name` (URL-encoded).
- Automated tests cover the regression condition (invalid tbody/link structure) and pass.

## Risks / open questions

- **Clickable row UX tradeoff**: moving from full-row anchor wrapper to in-cell link may slightly reduce click target size; if full-row click is required, implement accessible row click semantics intentionally.
- **Test coverage gap**: there are currently no sessions list component tests; initial test harness setup may take extra effort (mocking `useQuery` fetch path and router context).
- **Width tuning**: chosen `min-w` value should avoid unnecessary horizontal scrolling on medium screens while still preventing column collapse on very narrow devices.

## Proposed BUILD task breakdown

1. **BUILD A — SessionList table semantics + mobile alignment fix**
   - Update `SessionList.tsx` markup/navigation/width classes.
   - Verify manually in responsive mode and with lint/type checks.

2. **BUILD B — Regression tests for sessions table structure/overflow**
   - Add `packages/web/tests/session-list.test.tsx`.
   - Assert valid DOM structure, route links, and overflow class behavior.
   - Run relevant test command(s) and ensure passing.
