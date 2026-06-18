# Plan: Fix missing “Add Project” UI after first project is created

## Context

- The project list UI is implemented in `packages/web/src/client/components/ProjectsPage.tsx`.
  - The “+ New Project” button is currently rendered **only** inside the header block guarded by `showHeader`.
  - `ProjectsPage` also shows a “Create one” link in the empty-state view (`projects.length === 0`).
- In settings, `packages/web/src/client/components/SettingsPage.tsx` renders:
  - `activeTab === 'projects' && <ProjectsPage showHeader={false} />`
- This creates the regression described in the task:
  - Before any projects exist, the empty-state link allows creation.
  - After the first project exists, the empty-state disappears and header is hidden, so there is no visible “add project” affordance in Settings → Projects.
- A similar `showHeader={false}` usage exists for `AgentsPage`, but this task is specifically about project creation UI.

## Scope boundaries

### In scope

- Restore a visible project-creation CTA when viewing projects in contexts where `showHeader={false}` (notably Settings → Projects).
- Preserve existing behavior on `/projects` where full header + “+ New Project” button is expected.
- Add/adjust frontend tests for this behavior.

### Out of scope

- Reworking the full Settings layout/tabs UX.
- Backend/API changes for projects.
- Refactoring `AgentsPage` unless required for shared helper extraction (optional, non-blocking).

## Approach

1. **Decouple create-action visibility from header visibility** in `ProjectsPage`.
   - Introduce a dedicated prop (e.g. `showCreateAction`, default `true`) so create CTA can be rendered even when `showHeader` is `false`.
   - Keep existing default behavior for routes already using `<ProjectsPage />`.
2. **Render an explicit create CTA for the no-header layout** used by settings.
   - For `showHeader=false`, render a compact top-row action (or equivalent inline action container) that includes a link/button to `/projects/new`.
   - Keep table/empty-state behavior unchanged.
3. **Wire Settings tab usage intentionally**.
   - Ensure Settings `projects` tab uses the new prop combination so add-project remains accessible with non-empty project list.
4. **Add regression tests** (component-level) that assert create CTA presence in both:
   - default header mode
   - no-header mode with non-empty projects

## Tasks

1. **Update `ProjectsPage` component API**
   - File: `packages/web/src/client/components/ProjectsPage.tsx`
   - Add a second visibility prop for create action (name to be finalized during implementation).
   - Keep defaults backward-compatible.

2. **Refactor render structure in `ProjectsPage`**
   - Split header and create-action concerns so CTA is not implicitly tied to `showHeader`.
   - Ensure `/projects/new` link/button is visible when:
     - `showHeader=true` (existing behavior), and
     - `showHeader=false` + projects list exists (new behavior).

3. **Adjust settings usage**
   - File: `packages/web/src/client/components/SettingsPage.tsx`
   - Update `<ProjectsPage showHeader={false} />` call-site to pass the new prop explicitly (if needed by chosen defaults) to make intent clear.

4. **Add/extend client tests for regression coverage**
   - Add a new test file under `packages/web/tests/` (likely `projects-page.test.tsx`) using `@testing-library/react` and mocked hooks.
   - Cover at minimum:
     1. header mode includes “+ New Project” CTA,
     2. headerless mode still includes an add/create project CTA,
     3. headerless + empty list still keeps create path accessible.

5. **Validate locally**
   - Run targeted web tests and/or package test command for the new test file.
   - Run formatting/lint fixes only if required by changed files.

## Acceptance criteria

- In Settings → Projects (`ProjectsPage` rendered with hidden header), users can still navigate to `/projects/new` even when at least one project already exists.
- Existing `/projects` page still shows the standard header and “+ New Project” control.
- Empty-state creation path still works.
- Automated tests cover the regression and fail if the add-project CTA disappears again in headerless mode.

## Risks / open questions

1. **UX consistency risk**
   - Need to choose compact CTA placement for headerless mode so it doesn’t look visually detached from settings tabs.

2. **Test harness complexity**
   - `ProjectsPage` depends on `useProjects` and `useProjectsEvents`; tests should mock both to avoid SSE/query timing flakiness.

3. **Prop design decision**
   - Option A: `showCreateAction` prop (most explicit).
   - Option B: infer from `showHeader` (simpler but less flexible).
   - Preferred: Option A for future reuse and clearer call-site intent.

## Proposed BUILD task breakdown

1. **BUILD A — ProjectsPage CTA decoupling**
   - Implement prop/API + render changes in `ProjectsPage.tsx`.
   - Ensure both header and headerless modes expose add-project CTA.

2. **BUILD B — Settings integration**
   - Update `SettingsPage.tsx` call-site for explicit behavior.
   - Verify settings projects tab UX remains coherent.

3. **BUILD C — Regression tests**
   - Add component tests for headerless-mode add-project availability.
   - Run relevant test command(s) and ensure green.
