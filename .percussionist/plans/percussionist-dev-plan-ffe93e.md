# Plan: Bring `spec.runner.packages` to Project Execution settings

**Task:** `percussionist-dev-plan-ffe93e`  
**Project:** `percussionist-dev`

## Context

`spec.runner.packages` is already supported end-to-end in backend/runtime layers, but it is not exposed in the project form under the web UI's **Execution** settings.

Relevant existing paths:

- **Schema support exists**
  - `packages/api/src/index.ts`
    - `RunnerPackagesSchema` (lines ~68-73)
    - `ProjectSpecSchema.runner` uses `RunnerPackagesSchema` (line ~1022)
    - `RunSpecSchema.runner` also supports per-run override (line ~573)
- **Runtime support exists**
  - `packages/operator/src/pod-builder.ts`: installs runner packages and injects `RUNNER_PACKAGES` env when `spec.runner?.packages` exists
  - `packages/manager-controller/src/facilitator.ts`: includes runner package list in worker prompt context (`RUNNER PACKAGES: ...`)
  - `packages/manager-controller/src/agent/tools.ts`: exposes package-related MCP tools and reads project `spec.runner?.packages`
- **Project create/update API already accepts it**
  - `packages/web/src/server/routes/projects.ts`: validates with `ProjectSpecSchema` and persists merged spec; no special handling required for `runner` object
- **Missing UI wiring is in project form execution tab**
  - `packages/web/src/client/components/project-form/ExecutionTab.tsx`: currently exposes runner image/resources/git cache/flow, but no runner packages field
  - `packages/web/src/client/components/project-form/useProjectForm.ts`: execution state currently has `runnerImage`, resources, etc., but no `runnerPackages`
  - `packages/web/src/client/lib/types.ts`: `CreateProjectRequest` includes `image` and `resources`, but no `runner?: { packages?: string[] }`
  - `packages/web/src/client/components/CreateProjectForm.tsx`: execution prop mapping does not pass package state

## Scope boundaries

### In scope

1. Add project-form state and request serialization for `runner.packages`.
2. Expose `runner.packages` in the **Execution** tab UI.
3. Ensure edit mode pre-populates existing package list from `initialSpec.runner.packages`.
4. Keep schema-aligned payload shape (`{ runner: { packages: string[] } }`) and avoid sending empty arrays.

### Out of scope

1. Changes to operator/manager runtime behavior for package installation.
2. Cluster Settings “Runner Defaults” (`SettingsPage.tsx` runner tab) changes.
3. New backend endpoints or CRD/schema changes.
4. Per-run package override UI on run creation forms.

## Approach

Implement this as a targeted web-form plumbing change in the same pattern used by existing execution fields:

1. Extend the client request type (`CreateProjectRequest`) with optional `runner.packages`.
2. Add `runnerPackages` string state in `useProjectForm.ts` (stored as comma-separated input for UX consistency with sidecar ports style).
3. Parse/normalize this state in `buildProjectRequest()` into `runner: { packages: string[] }` with trim + dedupe + empty filtering.
4. Add a new **Runner Packages** fieldset in `ExecutionTab.tsx` and wire props through `CreateProjectForm.tsx`.
5. Pre-fill state from `spec.runner?.packages` in `createInitialState()`.

Normalization decisions:

- Accept comma-separated input in UI (e.g. `ripgrep, jq, tree`).
- Split by comma, trim whitespace, drop empties.
- De-duplicate while preserving first-seen order.
- If result is empty, omit `req.runner` entirely to preserve current behavior.

## Tasks

1. **Extend client request type for runner packages**
   - File: `packages/web/src/client/lib/types.ts`
   - Add optional:
     - `runner?: { packages?: string[] }`
   - Keep this aligned with `ProjectSpecSchema.runner` (`RunnerPackagesSchema`) in `@percussionist/api`.

2. **Add form state field in `ProjectFormState`**
   - File: `packages/web/src/client/components/project-form/useProjectForm.ts`
   - Add `runnerPackages: string` under Execution fields.
   - Add setter signature `setRunnerPackages` in `ProjectFormHookReturn`.

3. **Pre-populate state from existing project spec**
   - File: `packages/web/src/client/components/project-form/useProjectForm.ts`
   - In `createInitialState()`, map:
     - `runnerPackages: (spec.runner?.packages ?? []).join(', ')`
   - Keep empty string default when absent.

4. **Serialize form state into request payload**
   - File: `packages/web/src/client/components/project-form/useProjectForm.ts`
   - In `buildProjectRequest()`:
     - Parse `state.runnerPackages` to normalized array.
     - If non-empty, set `req.runner = { packages: parsed }`.
     - If empty, do not set `req.runner`.

5. **Wire hook state/setter lifecycle**
   - File: `packages/web/src/client/components/project-form/useProjectForm.ts`
   - Initialize `useState(initialState.runnerPackages)`.
   - Include `runnerPackages` + `setRunnerPackages` in returned object.

6. **Expose runner packages input in execution tab API**
   - File: `packages/web/src/client/components/project-form/ExecutionTab.tsx`
   - Extend `ExecutionTabProps` picks to include:
     - `runnerPackages`
     - `setRunnerPackages`
   - Add a new fieldset (or subsection within Runner Overrides) titled **Runner Packages** with helper text and a text input.

7. **Pass props through top-level form composition**
   - File: `packages/web/src/client/components/CreateProjectForm.tsx`
   - Add `runnerPackages` and `setRunnerPackages` in `executionProps.form` mapping.

8. **Validation and UX details**
   - Ensure helper copy clarifies it installs Alpine packages at pod init and references comma-separated format.
   - Ensure no invalid payload is sent for blank input.

9. **Verification**
   - Run targeted checks:
     - `pnpm typecheck`
     - `pnpm lint` (or at minimum package-level lint if full run is too costly)
   - Manual sanity checks (UI):
     - Create project with packages → inspect submitted payload includes `runner.packages`.
     - Edit existing project with packages → field pre-populates and round-trips.

## Risks / open questions

1. **Input format ambiguity**
   - Comma-separated format is simple but might conflict with package names containing commas (unlikely for apk). Assumption: package names never contain commas.

2. **Duplicate package handling**
   - Need deterministic dedupe behavior. Plan assumes first occurrence wins.

3. **Validation strictness**
   - No strict regex validation planned in UI (passes through to backend/schema/runtime). Could optionally add a lightweight pattern guard later.

4. **Field placement in Execution tab**
   - Decide whether packages belong inside existing “Runner Overrides” block or separate fieldset; either is acceptable as long as discoverable and consistent.

## Acceptance criteria

1. Project Execution UI contains a visible editable field for runner packages.
2. Submitting project create/edit with non-empty value sends `runner: { packages: [...] }` in request body.
3. Editing an existing project with `spec.runner.packages` pre-fills the field correctly.
4. Blank/whitespace-only input does not emit `runner` in request payload.
5. Typecheck and lint pass for touched web files.

## Proposed BUILD task breakdown

1. **BUILD A — Type + form-state plumbing**
   - Update `CreateProjectRequest` and `useProjectForm.ts` state/initialization/serialization.
   - Deliverable: request payload includes normalized `runner.packages`.

2. **BUILD B — Execution tab UI exposure**
   - Update `ExecutionTab.tsx` and `CreateProjectForm.tsx` prop wiring.
   - Deliverable: user can input/edit runner packages in Execution settings.

3. **BUILD C — Verification and polish**
   - Run checks, adjust helper text/formatting, and confirm edit/create round-trip behavior.
   - Deliverable: green checks + UX copy clarity.
