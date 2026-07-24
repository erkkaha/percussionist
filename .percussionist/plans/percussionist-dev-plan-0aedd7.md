# Plan: project settings default model input is text box instead of dropdown

## Context

- The project create/edit UI is composed in `packages/web/src/client/components/CreateProjectForm.tsx`, with the **General** tab implemented in `packages/web/src/client/components/project-form/GeneralTab.tsx`.
- In `GeneralTab.tsx`, the **Default Model** field currently uses a plain `<Input type="text" ...>` bound to `form.model` / `form.setModel`.
- The app already has a reusable model picker component, `packages/web/src/client/components/ModelSelector.tsx`, which provides:
  - a text input (manual entry still possible), and
  - a dropdown browser populated from `/api/providers` via `useProviders()`.
- `ModelSelector` is already used in comparable settings surfaces:
  - `packages/web/src/client/components/CreateRunForm.tsx`
  - `packages/web/src/client/components/AgentForm.tsx`
  - `packages/web/src/client/components/SettingsPage.tsx` (Manager panel)
- `useProjectForm` (`packages/web/src/client/components/project-form/useProjectForm.ts`) already exposes the needed `model` string state and `setModel` setter, so no form-state contract change is required.

## Scope boundaries

### In scope

- Replace the **Default Model** plain text input in the project General tab with the shared `ModelSelector` UI so it behaves like other model selectors in the app.
- Keep the existing data flow (`form.model` / `form.setModel`) intact for create and edit modes.
- Preserve manual model entry behavior (typing arbitrary model IDs).

### Out of scope

- Any backend/API/provider route changes (`/api/providers` already exists).
- Changing semantics of project `spec.model` persistence.
- Redesigning `ModelSelector` behavior globally.
- Updating unrelated model fields elsewhere.

## Approach

1. **Adopt the shared selector in `GeneralTab`.**
   - Import `ModelSelector` into `GeneralTab.tsx`.
   - Replace the current `<Input>` for Default Model with `<ModelSelector value={form.model} onChange={form.setModel} ...>`.

2. **Preserve UX parity with existing model fields.**
   - Use the same placeholder pattern used elsewhere (`e.g. anthropic/claude-sonnet-4-20250514`) unless a tab-specific placeholder is preferred.
   - Keep layout classes compatible with the existing two-column grid (`Model + Agent` row).

3. **Validate create/edit behavior and graceful fallback.**
   - Confirm the field still submits via existing `buildProjectRequest()` path without extra mapping changes.
   - Confirm `ModelSelector` fallback remains acceptable when provider list fails (input still usable as plain text).

## Acceptance criteria

- In Project **General** tab, **Default Model** renders with dropdown affordance (same interaction model as other model selectors).
- Users can still type a model string manually.
- Selecting a model from the dropdown updates `form.model` and is persisted on create and edit saves.
- No regressions to **Default Agent** field or the surrounding grid layout.
- Typecheck/lint for touched files pass.

## Proposed BUILD task breakdown

1. **UI swap in General tab**
   - File: `packages/web/src/client/components/project-form/GeneralTab.tsx`
   - Import `ModelSelector` and replace the Default Model `Input` control.

2. **Form behavior verification (create + edit)**
   - Files to validate flow (no structural changes expected):
     - `packages/web/src/client/components/CreateProjectForm.tsx`
     - `packages/web/src/client/components/project-form/useProjectForm.ts`
   - Ensure selected/typed value flows unchanged into `buildProjectRequest()` and API calls.

3. **Quality checks**
   - Run targeted checks (or project-standard checks for touched package) to ensure no TS/lint regressions.

## Risks / open questions

- **Provider availability:** If `/api/providers` is unavailable, `ModelSelector` hides dropdown and behaves like input; this is expected, but should be explicitly verified so UX isn’t perceived as broken.
- **Visual fit in compact widths:** The selector includes an extra trigger button; confirm no clipping in the two-column layout at supported breakpoints.
- **Expectation of strict dropdown-only behavior:** Current `ModelSelector` intentionally allows arbitrary typed IDs. Assumption: this is desired for parity with "any other model selector" in this codebase.

## Assumptions

- “input should be like any other model selector” means using the existing shared `ModelSelector` component (combobox-style), not a strict closed list select.
- No migration or API contract updates are needed because `spec.model` remains a string.
