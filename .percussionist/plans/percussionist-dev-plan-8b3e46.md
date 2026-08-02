# Plan: Fix vertical table scrolling on medium screens and audit all table views

## Context

- The reported issue is on the Agents table in settings (`packages/web/src/client/components/AgentsPage.tsx`).
- Agents currently uses a custom class: `settings-table-scroll` + `overflow-hidden` on the wrapper.
  - `settings-table-scroll` is defined in `packages/web/src/client/index.css` only inside `@media (max-width: 768px)` and only sets horizontal scrolling (`overflow-x: auto`).
  - On medium+ widths, that class does nothing, leaving only `overflow-hidden` on the table wrapper.
- Other primary table-based views use mixed patterns, mostly horizontal-only wrappers and no consistent vertical overflow strategy:
  - `ProjectsPage.tsx`
  - `RunList.tsx`
  - `SessionList.tsx`
  - `StatsView.tsx` (Model breakdown + Agent detail table)
  - `ToolMetricsView.tsx`
  - `MetricsView.tsx` (Pod table)
  - `RunDetail.tsx` (Conditions table)
- Existing tests verify horizontal overflow for Projects/Sessions wrappers, but there is no regression coverage for vertical table scrolling behavior.

## Scope boundaries

### In scope

- Fix Agents table scrolling behavior so long row sets remain scrollable on medium screens.
- Standardize table container behavior for all app-level data tables listed above so vertical overflow works consistently when content exceeds available viewport space.
- Add/update tests for wrapper behavior and the specific Agents regression.

### Out of scope

- Redesigning table visuals, typography, columns, sticky headers, or pagination semantics.
- Changing markdown-rendered ad-hoc tables inside session/task markdown content (`SessionView.tsx`, `TaskDetailPanel.tsx`) unless needed for parity in a follow-up.
- Backend/API changes.

## Approach

1. **Unify table scroll container pattern**
   - Replace the Agents-specific breakpoint CSS dependency (`settings-table-scroll`) with an always-applicable table wrapper pattern.
   - Use a single reusable utility/class pattern that enables:
     - horizontal scroll when columns overflow,
     - vertical scroll when rows exceed visible space,
     - a bounded height (via responsive max-height) so vertical overflow can actually occur.

2. **Apply pattern consistently to all route-level table views**
   - Update each table wrapper in the files listed in Context to use the same overflow and max-height behavior.
   - Keep per-table min-widths and existing structure intact.

3. **Keep behavior safe and predictable**
   - Preserve current table content and data loading states.
   - Avoid changing query/pagination logic; only wrapper/scroll mechanics should change.
   - Ensure wrappers still support small-screen horizontal panning.

4. **Add focused regression coverage**
   - Extend existing table wrapper tests (Projects/Sessions) to assert vertical-scroll-enabling classes/attributes.
   - Add an AgentsPage test file (or extend an existing one) to verify wrapper class behavior is not breakpoint-gated and includes vertical scrolling semantics.

## Tasks

1. **Inventory and normalize table wrappers**
   - Audit all `<table>` usages in `packages/web/src/client/components/**`.
   - Record which wrappers currently lack vertical overflow and/or height constraints.

2. **Define a single table scroll utility pattern**
   - Implement either:
     - a reusable CSS utility in `packages/web/src/client/index.css`, or
     - a consistent Tailwind class bundle applied directly in JSX.
   - Pattern must include both axis overflow and a bounded height for vertical scroll activation.

3. **Fix AgentsPage regression first**
   - File: `packages/web/src/client/components/AgentsPage.tsx`.
   - Remove reliance on `settings-table-scroll` breakpoint behavior.
   - Ensure wrapper supports medium-screen vertical overflow.

4. **Apply the same wrapper behavior to remaining route tables**
   - Files:
     - `packages/web/src/client/components/ProjectsPage.tsx`
     - `packages/web/src/client/components/RunList.tsx`
     - `packages/web/src/client/components/SessionList.tsx`
     - `packages/web/src/client/components/StatsView.tsx`
     - `packages/web/src/client/components/ToolMetricsView.tsx`
     - `packages/web/src/client/components/MetricsView.tsx`
     - `packages/web/src/client/components/RunDetail.tsx`
   - Preserve existing `data-testid` selectors used by tests.

5. **Clean up obsolete CSS**
   - File: `packages/web/src/client/index.css`.
   - Remove or repurpose `settings-table-scroll` if no longer needed.
   - Ensure comments reflect actual usage.

6. **Add regression tests for scroll wrapper behavior**
   - Extend:
     - `packages/web/tests/projects-page.test.tsx`
     - `packages/web/tests/session-list.test.tsx`
   - Add Agents coverage (new `packages/web/tests/agents-page.test.tsx` or equivalent).
   - Assert wrapper classes indicate both horizontal and vertical scroll support and remain present in headerless/settings embedding.

7. **Run targeted verification**
   - Run web test targets covering changed test files.
   - Run formatting/lint only if needed for touched files.

## Acceptance criteria

- Agents table is scrollable vertically on medium screens when row count exceeds available viewport area.
- All primary route-level table views use a consistent scroll-container behavior that supports vertical overflow when needed.
- Horizontal overflow behavior remains intact for narrow widths.
- Existing table wrapper test IDs (e.g. `projects-table-wrapper`, `sessions-table-wrapper`) remain valid.
- Regression tests cover the Agents issue and class-level overflow expectations for table wrappers.

## Risks / open questions

1. **UX expectation ambiguity**
   - Clarify whether desired behavior is **page-level vertical scroll** or **table-internal vertical scroll**. This plan assumes table-internal scroll is desired when content exceeds screen height.

2. **Height cap tuning**
   - A too-small max-height can feel cramped; too-large may not trigger internal scroll in some layouts. Responsive cap values should be validated in actual Settings and full-page routes.

3. **Consistency vs. context-specific needs**
   - Some views (e.g. RunDetail Conditions) may not need aggressive height caps. If blanket standardization hurts readability, allow controlled exceptions while preserving baseline vertical overflow support.

## Proposed BUILD task breakdown

1. **BUILD A — Agents regression + shared table scroll utility**
   - Fix `AgentsPage` and introduce the reusable table scroll wrapper pattern.

2. **BUILD B — Roll out wrapper consistency across remaining table pages**
   - Apply the utility/pattern to other route-level table components listed above.

3. **BUILD C — Regression tests and verification**
   - Add/extend table wrapper tests (including Agents), run targeted tests, and finalize polish.
