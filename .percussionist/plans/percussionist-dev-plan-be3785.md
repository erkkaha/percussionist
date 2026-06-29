# Plan: Settings Projects table horizontal scrolling on narrow layouts

## Context

- The Projects table UI is rendered in `packages/web/src/client/components/ProjectsPage.tsx`.
  - Table wrapper currently uses: `className="rounded-lg border border-border overflow-hidden settings-table-scroll"`.
  - Table has `min-w-[720px]`, which is correct for preserving columns but requires horizontal overflow handling when container width is smaller.
- The `settings-table-scroll` behavior is defined in `packages/web/src/client/index.css`.
  - `overflow-x: auto` is applied **only** inside `@media (max-width: 768px)`.
  - Above 768px, wrapper falls back to `overflow-hidden` from Tailwind utility, so the table can clip without scroll if available content width is still narrow (e.g. settings layout + sidebar, split panes, medium screens).
- Settings page renders projects via `packages/web/src/client/components/SettingsPage.tsx` with:
  - `<ProjectsPage showHeader={false} showCreateAction />`
  - So the same `ProjectsPage` table implementation is used in both `/projects` and Settings → Projects.
- Existing table patterns in this codebase (`RunList.tsx`, `StatsView.tsx`) use always-on `overflow-x-auto` wrappers rather than viewport-only media gating.

## Scope boundaries

### In scope

- Fix horizontal scrolling for the Projects table when container width is constrained, especially in Settings → Projects.
- Keep table structure/columns/actions intact.
- Keep current desktop presentation and existing min-width behavior.
- Add regression coverage (component-level) for scroll container behavior.

### Out of scope

- Redesigning the Settings page layout or tab system.
- Changing Projects table column set, copy, or CRUD behavior.
- Broad refactor of all Settings tables unless required for consistency.

## Approach

1. **Make horizontal scrolling container-based, not viewport-breakpoint-based.**
   - Ensure table wrapper always allows horizontal overflow (`overflow-x-auto`) whenever content exceeds parent width.
   - Preserve vertical clipping/rounded-border visuals as needed (`overflow-y-hidden` or equivalent wrapper layering) without suppressing x-scroll.

2. **Prefer component-local Tailwind utilities for the Projects table wrapper.**
   - Update `ProjectsPage.tsx` wrapper classes to match existing robust patterns (`overflow-x-auto` + optional touch momentum helper).
   - This avoids relying on global `.settings-table-scroll` media behavior that can miss real-world constrained widths.

3. **Decide how to handle shared `.settings-table-scroll` usage safely.**
   - `AgentsPage.tsx` also uses `settings-table-scroll`.
   - For this task, apply direct fix to `ProjectsPage` first (guaranteed scope).
   - Optional follow-up: unify `AgentsPage` to same wrapper pattern in a separate BUILD if reviewers prefer consistency.

4. **Add regression tests focused on behavior contract.**
   - Verify rendered Projects table wrapper in headerless/settings mode exposes horizontal scrolling class/behavior regardless of viewport breakpoint.
   - Include at least one non-empty projects scenario in settings mode (`showHeader={false}`).

## Tasks

1. **Audit and lock target selectors in `ProjectsPage.tsx`.**
   - Confirm current wrapper/table class names and where to add stable test hook if needed (`data-testid` on wrapper if class assertions are brittle).

2. **Update Projects table wrapper classes in `packages/web/src/client/components/ProjectsPage.tsx`.**
   - Replace breakpoint-dependent scroll reliance with always-on horizontal overflow handling.
   - Keep rounded border and visual containment.

3. **Review global CSS helper usage in `packages/web/src/client/index.css`.**
   - If `settings-table-scroll` becomes unnecessary for Projects, leave it for Agents for now or narrow usage notes in comments.
   - Avoid broad CSS churn unless required for the concrete bug fix.

4. **Add/extend frontend tests for Projects table overflow behavior.**
   - Create/extend test under `packages/web/tests/` (or existing web client test location used by this package).
   - Mock `useProjects`/`useProjectsEvents` to render deterministic rows.
   - Assert settings-mode table container includes horizontal overflow behavior (`overflow-x-auto` class or dedicated test id + computed class contract).

5. **Run targeted validation.**
   - Execute relevant test command for `@percussionist/web` (targeted test or package test suite).
   - Ensure no lint/format regressions in touched files.

6. **Manual QA checklist (builder execution).**
   - Verify Settings → Projects on narrow browser width shows horizontal scrollbar and allows reaching rightmost action column.
   - Verify `/projects` page behavior remains unchanged.

## Acceptance criteria

- In Settings → Projects, when table width exceeds available content width, a horizontal scrollbar is visible/usable and columns are not permanently clipped.
- Rightmost action buttons (e.g., Edit/Board/Delete) remain reachable via horizontal scroll on constrained widths.
- `/projects` still renders normally with the same content/actions and no layout regressions.
- Automated test(s) fail if Projects table wrapper loses horizontal overflow behavior in settings/headerless mode.

## Risks / open questions

1. **Shared class divergence risk**
   - `settings-table-scroll` is shared by `ProjectsPage` and `AgentsPage`; fixing only Projects may leave Agents with similar latent behavior.
   - Mitigation: call this out in PR and optionally create a small follow-up BUILD task for Agents parity.

2. **Test fragility risk**
   - Asserting raw class strings can be brittle if refactors change utility order.
   - Mitigation: prefer semantic test hook (`data-testid`) plus minimal class contract assertion.

3. **Cross-device scroll behavior**
   - iOS momentum scrolling may differ if touch helper class is omitted.
   - Mitigation: include `touch-pan-x`/`touch-scroll-x` style used elsewhere if needed.

## Proposed BUILD task breakdown

1. **BUILD 1 — Projects table overflow fix (core)**
   - Files: `packages/web/src/client/components/ProjectsPage.tsx`
   - Deliverable: always-on horizontal overflow handling for Projects table wrapper.

2. **BUILD 2 — Regression tests**
   - Files: web client test files under `packages/web/tests/` (new or updated)
   - Deliverable: deterministic test coverage for settings/headerless projects table scroll behavior.

3. **BUILD 3 — Optional parity cleanup (if requested during review)**
   - Files: `packages/web/src/client/components/AgentsPage.tsx`, optionally `packages/web/src/client/index.css`
   - Deliverable: align Agents table wrapper with same overflow strategy to prevent duplicate bug class.
