# Plan: UI consistency review and shadcn alignment

## Context

The web client already has a local shadcn-style component layer in `packages/web/src/client/components/ui/` (notably `button.tsx`, `input.tsx`, `select.tsx`, `card.tsx`, `tabs.tsx`, `badge.tsx`, `sheet.tsx`, `switch.tsx`, `separator.tsx`, etc.) and global design tokens in `packages/web/src/client/index.css` (`--text-headline-*`, `--text-body-*`, `--text-label-md`, color roles, radius tokens).

However, component usage is inconsistent across feature pages:

- Heavy native element usage (raw `<button>`, `<input>`, `<select>`, `<textarea>`) with hand-authored classes is widespread in:
  - `CreateRunForm.tsx`
  - `CreateProjectForm.tsx` + `project-form/*Tab.tsx`
  - `SettingsPage.tsx`
  - `AgentForm.tsx`
  - board components (`board/TaskListPanel.tsx`, `board/TaskDetailPanel.tsx`, `board/FilterBar.tsx`, `board/BoardHeader.tsx`, `board/TaskRow.tsx`)
  - list/detail views (`RunList.tsx`, `RunDetail.tsx`, `ProjectsPage.tsx`, `AgentsPage.tsx`, `ActivityPage.tsx`, `ModelSelector.tsx`)
- Typography is mixed between tokenized classes (`text-label-md`, `text-body-lg`) and ad hoc sizing (`text-xs`, `text-sm`, `text-xl`, direct `font-semibold`), creating inconsistent visual rhythm.
- Styling patterns are duplicated in many places (same button/input class strings repeated with slight variations).
- Some components still use direct utility colors (e.g. red/green text classes) instead of semantic palette roles.

This indicates the design system exists but is not consistently applied.

## Scope boundaries

### In scope
- Frontend-only refactor for visual and component consistency in `packages/web/src/client`.
- Replacing applicable raw controls with existing shadcn wrappers.
- Adding missing shadcn-style wrappers only where needed to remove repeated native control styling (e.g. `Textarea`, optional `Checkbox`/`RadioGroup` wrappers).
- Standardizing typography usage on existing tokens and a small, explicit style hierarchy.

### Out of scope
- API/server behavior changes (`packages/web/src/server/**`).
- Functional workflow changes (task transitions, retries, board logic).
- Major layout redesign or information architecture changes.
- Theme palette redesign in `index.css` (only usage normalization).

## Approach

1. **Define a lightweight UI consistency contract first**
   - Establish explicit mapping for common UI roles (page title, section title, field label, helper text, table header/cell, badge label, action buttons) to classes/components.
   - Document “when to use shadcn component vs native element.”

2. **Strengthen base primitives before large migrations**
   - Reuse existing `Button`, `Input`, `Card`, `Tabs`, `Switch`, `Select`, `Separator`.
   - Add missing wrappers where current code repeatedly hand-styles native controls:
     - `ui/textarea.tsx` (high priority)
     - `ui/checkbox.tsx` and `ui/radio-group.tsx` (if migration requires them)
   - Ensure primitives use project tokens (`text-body-sm`, semantic colors) and consistent focus/disabled states.

3. **Migrate by feature verticals to reduce risk**
   - Forms first (highest concentration of duplicated controls), then board/list surfaces, then detail/secondary pages.
   - Keep behavior/state logic unchanged; only swap rendering primitives and class usage.

4. **Enforce consistency with repeatable checks**
   - Run targeted grep checks to reduce newly introduced raw controls in migrated files.
   - Manual QA pass for interactive states (hover/focus/disabled/loading), keyboard navigation, and small-screen behavior.

## Acceptance criteria

1. **Component usage consistency**
   - In migrated files, new/updated interactive controls use shadcn wrappers (`Button`, `Input`, `Select`, `Textarea`, etc.) where applicable.
   - Raw elements remain only where justified (e.g. low-level primitives or specific semantic cases) and are documented inline or in a short style note.

2. **Typography consistency**
   - Page/section/label/body/meta text follows a documented class hierarchy based on existing tokens (`text-headline-*`, `text-body-*`, `text-label-md`, etc.).
   - Avoid mixed ad hoc heading scales within the same page section.

3. **Styling consistency**
   - Primary/secondary/destructive/link-like actions use standardized button variants instead of per-file custom class strings.
   - Form inputs/selects/textareas share consistent height, border, focus ring, placeholder treatment, and disabled styling.

4. **Behavior and accessibility preserved**
   - No regressions in form submission, task actions, table interactions, or tabs.
   - Keyboard interaction remains intact for migrated controls (especially tabs/selects/dialog-like interactions).

5. **Verification completed**
   - `pnpm typecheck` passes.
   - `pnpm build` passes.
   - Manual smoke pass covers Settings, Projects, Agents, Runs, Board, and Activity pages in desktop + narrow viewport.

## Tasks (implementation steps)

1. **Create a short UI consistency guide (code-local reference)**
   - Add a concise markdown doc under `packages/web/src/client/components/ui/` (or project docs) defining:
     - typography role mapping,
     - preferred components per control type,
     - allowed exceptions for native elements.

2. **Audit and classify raw control usage by file**
   - Baseline current usage in `packages/web/src/client/components/**` (excluding `components/ui/**`), grouped by:
     - forms,
     - list/table actions,
     - board interactions,
     - custom widgets (e.g. `ModelSelector`).

3. **Add missing shadcn-style primitives**
   - Implement `ui/textarea.tsx` first.
   - Add `ui/checkbox.tsx` and/or `ui/radio-group.tsx` if needed for current native control patterns.
   - Align these with existing tokenized styles and component conventions used in `ui/input.tsx` and `ui/button.tsx`.

4. **Normalize button variants and shared control semantics**
   - Review `ui/button.tsx` variants (`default`, `secondary`, `outline`, `ghost`, `link`) and add a destructive variant if needed to remove custom destructive button class duplication.
   - Ensure consistent loading/disabled styling patterns used across pages.

5. **Migrate Create/Edit Project flows to shared components**
   - Files:
     - `CreateProjectForm.tsx`
     - `project-form/GeneralTab.tsx`
     - `project-form/SourceAuthTab.tsx`
     - `project-form/ExecutionTab.tsx`
     - `project-form/WorkspaceServicesTab.tsx`
     - `project-form/AdvancedTab.tsx`
   - Replace raw controls with `Input`, `Textarea`, `Select`/`Switch`/`Checkbox`/`Button` as applicable.
   - Remove duplicated `inputClass`/`monoInputClass` strings if primitives cover these patterns.

6. **Migrate Create Run and Agent forms**
   - Files:
     - `CreateRunForm.tsx`
     - `AgentForm.tsx`
     - `ModelSelector.tsx` (shared combobox-like control)
   - Standardize labels/helper text and control spacing.
   - Keep existing behavior for inline agent editing and provider/model browsing.

7. **Migrate Settings page tab shell + panel forms**
   - File: `SettingsPage.tsx`
   - Replace custom tab button bar with `ui/tabs` where practical.
   - Replace remaining raw form controls (not already using `Input`/`Button`) with shared components.
   - Preserve mobile behavior currently driven by `.settings-*` classes in `index.css`; simplify CSS if obsolete after migration.

8. **Migrate board UI action surfaces**
   - Files:
     - `board/BoardHeader.tsx`
     - `board/FilterBar.tsx`
     - `board/TaskListPanel.tsx`
     - `board/TaskDetailPanel.tsx`
     - `board/TaskRow.tsx`
     - `board/TaskRunsPanel.tsx`
   - Standardize action buttons/chips/filters with shared button variants.
   - Keep quick interactions (select task, promote, approve/request changes, add task) behaviorally identical.

9. **Migrate table/list/detail page actions for consistency**
   - Files:
     - `RunList.tsx`, `RunDetail.tsx`
     - `ProjectsPage.tsx`, `AgentsPage.tsx`
     - `ActivityPage.tsx`
     - `LogViewer.tsx`, `ToolMetricsView.tsx`, `StatsView.tsx` (where applicable)
   - Unify CTA styles (`+ New ...`, Edit/Delete/Copy/Attach, refresh buttons).

10. **Typography normalization pass**
    - Apply consistent heading/body/meta classes across migrated files.
    - Reduce mixed use of arbitrary `text-*` sizes where token classes already exist.
    - Ensure status/meta chips use a consistent label style (`text-label-md`, uppercase, mono where appropriate).

11. **Semantic color token cleanup**
    - Replace direct utility color classes (e.g. hardcoded green/red where possible) with semantic theme roles (`phase-*`, `text-*`, etc.) to keep dark theme coherence.

12. **Regression verification and cleanup**
    - Run `pnpm typecheck` and `pnpm build`.
    - Execute focused manual QA scenarios:
      - create/edit project,
      - create run,
      - board add/review actions,
      - settings tabs and forms,
      - run detail session/log panels,
      - responsiveness around 320–768px.
    - Remove obsolete duplicated class constants and dead CSS overrides.

## Proposed BUILD task breakdown

1. **BUILD A — Foundation primitives + style contract**
   - Deliverables: UI consistency guide, `Textarea` (and optional `Checkbox`/`RadioGroup`) primitives, any `Button` variant additions.
   - Acceptance: primitives compile, documented usage contract exists.

2. **BUILD B — Form-heavy pages migration**
   - Deliverables: `CreateProjectForm`, project-form tabs, `CreateRunForm`, `AgentForm`, `ModelSelector`, `SettingsPage` form controls migrated.
   - Acceptance: no behavior regressions in create/edit workflows.

3. **BUILD C — Board and list surface migration**
   - Deliverables: board header/filter/list/detail actions and list/table pages (`RunList`, `ProjectsPage`, `AgentsPage`, `ActivityPage`) normalized.
   - Acceptance: interaction parity + consistent action styling.

4. **BUILD D — Typography + final QA hardening**
   - Deliverables: typography normalization sweep, semantic color cleanup, dead-style removal, verification run (`pnpm typecheck`, `pnpm build`, manual smoke report).
   - Acceptance: consistency criteria met and checks pass.

## Risks / open questions

1. **Radix `Select` migration risk**
   - Replacing native `<select>` with `ui/select` can change keyboard behavior, form semantics, and controlled value handling. Some fields may intentionally remain native if complexity outweighs benefit.

2. **Missing primitive decisions**
   - There is currently no `ui/textarea` (and likely no `ui/checkbox`/`ui/radio-group`) in this project. Confirm whether to add these wrappers or keep specific native controls.

3. **Tabs migration compatibility**
   - `SettingsPage` and `TaskDetailPanel` currently use custom tab implementations/buttons. Need to confirm whether to standardize on existing `ui/tabs` everywhere or allow explicit exceptions for lightweight internal tab bars.

4. **Token adoption depth**
   - Typography tokens exist in CSS, but not all are currently used consistently. Decide whether to fully enforce token classes now or do incremental alignment to avoid large visual shifts.

5. **Scope size / regression surface**
   - This is a broad refactor touching many screens. Splitting into sequenced BUILD tasks is necessary to keep reviewable diffs and reduce merge risk.
