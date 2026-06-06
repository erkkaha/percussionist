# Plan: Split Project Settings into Tabbed Groups + Refactor Form Structure

**Task:** `percussionist-dev-plan-ad3f4d`  
**Project:** `percussionist-dev`  
**Plan artifact:** `.percussionist/plans/percussionist-dev-plan-ad3f4d.md`

## Context

The project-level settings/edit experience currently lives in one large component:

- `packages/web/src/client/components/CreateProjectForm.tsx` (~1500 lines)
- Used for both create and edit modes (`mode: "create" | "edit"`)
- Routed from:
  - `/projects/new` in `packages/web/src/client/App.tsx`
  - `/projects/:name/edit` via `packages/web/src/client/components/EditProjectPage.tsx`

Current behavior is functionally rich but hard to scan and maintain:

- The form renders many fieldsets in one long vertical page (git, flow, runner overrides, memory, code server, PVC, sidecars, injected files, etc.)
- Most state, validation, and serialization logic is colocated in one file/component
- Existing links navigate from settings pages to this edit form (`/settings?tab=projects` → Edit)

There is already a tab pattern in the codebase that can be reused conceptually:

- `packages/web/src/client/components/SettingsPage.tsx` (manual tab buttons)
- `packages/web/src/client/components/board/TaskDetailPanel.tsx` (compact manual tabs)

## Scope boundaries

### In scope

1. Restructure **project form UI** (`CreateProjectForm.tsx`) into tabbed groups to reduce page length and improve discoverability.
2. Refactor internals to make the form easier to maintain (extract subcomponents/hooks/helpers where useful).
3. Preserve existing create/edit behavior, request payload shape, and validations.
4. Keep existing navigation compatibility (`/settings?tab=projects`, edit/create routes).

### Out of scope

1. Redesigning global cluster settings page (`SettingsPage.tsx`) tab taxonomy.
2. Backend/API schema changes in `packages/web/src/server/routes/projects.ts` or `@percussionist/api` unless strictly required by UI bugs found during refactor.
3. Broad visual redesign/theming changes unrelated to tabbed grouping.

## Approach

Implement a **progressive refactor** that separates concerns while preserving behavior:

1. **Introduce tabbed groups in CreateProjectForm**
   - Add top-level tab state (and optional `?tab=` sync) for project form sections.
   - Replace long continuous rendering with grouped tab panels.

2. **Group fields into clear domains**
   - Suggested tabs (exact labels can be adjusted during build):
     - **General** (name/display, phase, model/agent, maxParallel/timeout, feature branching)
     - **Source & Auth** (git/local source, git auth, secrets, opencodeConfig)
     - **Execution** (runner overrides, git cache, task lifecycle/flow, retry/review policy)
     - **Workspace & Services** (code-server, data PVC, memory/embeddings)
     - **Advanced** (sidecars, injected files, init script, roster)
   - Keep a deterministic tab order and short helper copy under each tab.

3. **Refactor component internals**
   - Extract presentational sections into subcomponents under `packages/web/src/client/components/project-form/` (or similar), e.g.:
     - `GeneralTab.tsx`
     - `SourceAuthTab.tsx`
     - `ExecutionTab.tsx`
     - `WorkspaceServicesTab.tsx`
     - `AdvancedTab.tsx`
   - Extract serialization + validation helpers from JSX-heavy component:
     - `buildProjectRequest.ts` (form state → `CreateProjectRequest`)
     - `projectFormValidation.ts` (sidecar/injected-file/git-author/opencode JSON validation)
   - Keep mutation + submission orchestration in parent form component for easier control flow.

4. **Preserve backward-compatible navigation and deep links**
   - Continue supporting existing return links to `/settings?tab=projects`.
   - Add optional query param sync (`/projects/:name/edit?tab=execution`) so users can share/bookmark specific sections.
   - Gracefully fallback to default tab if unknown tab is provided.

5. **Ensure parity and regression safety**
   - Same fields, defaults, disabled states, and submit behavior as current form.
   - Validation messages remain visible even when fields are inside non-active tabs (e.g., show tab-level error indicators/counts or summary banner).

## Tasks

1. **Map current form sections to target tab groups**
   - Inventory all fieldsets/state in `CreateProjectForm.tsx` and assign each to a tab.
   - Decide any fields that should stay always visible (e.g., submit bar, global error banner).

2. **Define tab model and routing contract**
   - Introduce tab ID union type and metadata list.
   - Decide whether to sync with URL search params (recommended for deep links).
   - Implement fallback behavior for invalid/missing tab values.

3. **Create tab shell in `CreateProjectForm.tsx`**
   - Add tab header UI (reuse existing button style patterns from `SettingsPage.tsx`).
   - Render one panel at a time while keeping form context and submit behavior intact.

4. **Extract “General” tab component**
   - Move name/display/phase/model/agent/maxParallel/timeout/featureBranching sections.
   - Pass controlled props/state handlers from parent.

5. **Extract “Source & Auth” tab component**
   - Move Git source fieldset (including `source.local` toggle), git auth fields, secret refs, and project OpenCode config.
   - Keep existing inline JSON validation behavior for `opencodeConfig`.

6. **Extract “Execution” tab component**
   - Move runner overrides, git cache, task lifecycle flow config, retry policy, review policy.
   - Preserve all current conditional rendering logic and defaults.

7. **Extract “Workspace & Services” tab component**
   - Move code-server, data PVC, embedding/memory settings.
   - Preserve enable/disable toggles and optional nested resources.

8. **Extract “Advanced” tab component**
   - Move sidecars, injected files, init script, and agent roster UI.
   - Keep add/remove/update row helpers functioning exactly as before.

9. **Move request-building logic to helper(s)**
   - Extract submission payload assembly into a helper module.
   - Keep current payload semantics for create/edit unchanged.

10. **Move validation derivations to helper(s)**
    - Extract computed validation logic (`sidecarErrors`, `injectFileErrors`, `gitAuthorIncomplete`, `configJsonError`).
    - Provide per-tab error signals for tab badges or summary.

11. **Add UX safeguards for tabbed form**
    - Ensure mutation errors and save/create buttons are consistently visible.
    - Optionally add lightweight unsaved-change cue or “invalid fields in X tab” indicator.

12. **Update related links/tests/docs as needed**
    - Verify links from `ProjectsPage.tsx`, `EditProjectPage.tsx`, and `/settings?tab=projects` flows remain correct.
    - If query-param tab deep linking is added, include link examples where useful.

13. **Verification**
    - Run `pnpm typecheck` and `pnpm build`.
    - Manual UI checks:
      - Create mode: all fields accessible across tabs and payload is correct.
      - Edit mode: prepopulation parity with existing project specs.
      - Validation + mutation errors are visible and actionable.
      - Mobile behavior remains usable with tab bar wrapping/scroll.

## Risks / open questions

1. **Validation discoverability across hidden tabs**
   - Risk: user clicks submit from one tab but errors exist elsewhere.
   - Mitigation: add tab-level error badges and/or a summary banner linking to tabs with invalid fields.

2. **Refactor size and regression risk**
   - `CreateProjectForm.tsx` currently contains intertwined state and rendering; extraction can accidentally change behavior.
   - Mitigation: keep parent-owned state first, extract presentational layers incrementally, verify each extracted tab.

3. **URL tab sync decision**
   - If URL-sync is added, ensure no conflicts with existing query params and no extra history noise.
   - Assumption: using `replace: true` for tab changes is preferable to avoid polluting history.

4. **Mobile ergonomics**
   - Existing CSS contains settings tab responsiveness in `packages/web/src/client/index.css` (`.settings-tabs-wrap`).
   - Open question: reuse existing class names vs introduce project-form-specific tab classes.

5. **Potential over-splitting**
   - Too many extracted files may increase prop drilling complexity.
   - Mitigation: introduce a small typed form-state interface and shared handlers to keep component contracts predictable.

## Acceptance criteria

1. Project form is organized into clearly labeled tabs instead of one long continuous page.
2. All existing project settings fields remain available and functionally equivalent.
3. Create and edit flows preserve current payload semantics and defaults.
4. Form code is meaningfully refactored (reduced monolith size; section/helper extraction completed).
5. Validation/errors remain usable in a multi-tab context.
6. `pnpm typecheck` and `pnpm build` pass.

## Proposed BUILD task breakdown

1. **BUILD A — Tab shell + grouping foundation**
   - Add tab state, UI shell, and initial grouping in `CreateProjectForm.tsx`.
   - Keep logic inline initially for safer transition.

2. **BUILD B — Component extraction pass**
   - Extract tab panels into `components/project-form/*Tab.tsx` subcomponents.
   - Preserve parent-owned state/mutations.

3. **BUILD C — Logic extraction + validation UX**
   - Extract request builder and validation helpers.
   - Add tab-level validation indicators / summary behavior.

4. **BUILD D — Integration polish + verification**
   - Optional URL tab sync (`?tab=`), final styling/accessibility polish, and full verification (`typecheck`, `build`, manual flow checks).
