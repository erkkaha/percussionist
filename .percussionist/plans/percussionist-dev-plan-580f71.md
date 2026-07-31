# Plan: Project identity in the sidebar (color) — percussionist-dev-plan-580f71

**Task:** Different projects share the same icon on the sidebar. Bring identifying factors to the sidebar — needed especially when collapsed. Project color could be ideal for the board view as well: a subtle line on top of the view, below the top nav.

## Context

- **Sidebar** — `packages/web/src/client/components/app-sidebar.tsx`. Every project renders an identical lucide `<Folder />` icon (line 202) inside a `SidebarMenuButton`. The sidebar is shadcn's `collapsible="icon"` variant (`ui/sidebar.tsx`, `SIDEBAR_WIDTH_ICON = '3rem'`); when collapsed, only the icon is visible and the label survives as a tooltip (`tooltip={p.spec.displayName || name}`, line 198). `SidebarMenuButton` forces `[&>svg]:size-4` on direct svg children — a custom chip must be a sized `span` (or match that constraint).
- **Project model** — the Project CRD spec is defined zod-first as `ProjectSpecSchema` in `packages/api/src/index.ts:1041` (`displayName` at 1043). There is **no `color` or `icon` field anywhere today**. The CRD YAML `k8s/crds/project.yaml` is *generated* from zod via `pnpm codegen` (`codegen/gen-crds.mjs`); the structural schema prunes unknown fields, so clusters must re-apply the regenerated CRD.
- **API routes** — `packages/web/src/server/routes/projects.ts`: `GET /` spreads the whole CR, so a new spec field reaches the client with no change; `GET /events` (SSE) signature is a field whitelist (~line 209, includes `displayName`) that should list `color` explicitly; `POST /` and `PUT /:name` validate through `ProjectSpecSchema.safeParse`, so the zod change is a hard prerequisite. `mergeProjectPatch` (line 87) deletes keys on `null` — a nullable `color` becomes resettable for free (matches commit b7f626a "make project edits resettable").
- **Project form** — `CreateProjectForm.tsx` (tab shell) → `project-form/GeneralTab.tsx` (Display Name input, lines 64–71) → `project-form/useProjectForm.ts` (`ProjectFormState` line 65, `buildProjectRequest` line 232 with the `state.x.trim() || null` reset idiom, `createInitialState` line 534).
- **Board view** — `BoardView.tsx` pulls out of the layout padding (`-m-6`, line 182) directly under the 3.5rem top nav (`Layout.tsx:51`); the header container div (lines 184–187, `data-testid="board-header-container"`) is the natural place for a color strip above it. The board API (`packages/web/src/server/routes/board.ts:196`) builds `settings` as an explicit whitelist (`maxParallel`, `agents`, `phase`) — `color` must be added there for BoardView to receive it without a second query.
- **Theme** — `packages/web/src/client/index.css` already defines a 5-color categorical palette (`--chart-1…5`, hex values at lines 259–263, exposed as `--color-chart-*` Tailwind tokens) that works in both light and dark themes. There is no avatar/initials component and no hash-to-color helper; existing helpers live in `src/client/lib/` (`utils.ts` has `cn`).
- **Tests** — `packages/web/tests/`: `project-form.test.ts` covers `buildProjectRequest` resettability; `board-view.test.tsx` and `board-header.test.tsx` exist; no test for `app-sidebar.tsx` yet.

## Approach

Introduce an optional **`spec.color`** on the Project CRD plus a **deterministic fallback color** derived from the project name, then render that color in the sidebar and as a strip on the board view.

Key decisions:

1. **`color` is an optional hex string** (`z.string().regex(/^#[0-9a-fA-F]{6}$/).optional()`) on `ProjectSpecSchema`, with a comment. Nullable in the update path so it's resettable via the existing `mergeProjectPatch` semantics.
2. **Deterministic fallback, not a required field.** A shared client helper `projectColor(name, specColor?)` returns `specColor` if set, otherwise hashes `metadata.name` into the existing `--chart-1…5` palette (cheap `charCodeAt` sum → modulo). This solves "projects look identical" immediately for all existing projects with zero user action, and the explicit field lets users override collisions.
3. **Sidebar rendering: colored initial chip instead of `<Folder />`.** Replace the folder icon with a `size-4 shrink-0 rounded-[4px]` `span` tinted with the project color and showing the first letter of the display name (uppercase, ~10px, readable foreground). Color + letter together identify projects even for color-blind users and when two projects hash to the same palette slot; the existing tooltip stays as the third signal when collapsed. Non-project nav items keep their lucide icons.
4. **Board view: 2px color strip.** In `BoardView.tsx`, insert `<div className="h-0.5 shrink-0" style={{ backgroundColor: color }} aria-hidden />` as the first child of the `-m-6` wrapper (immediately above the `board-header-container` div), so it sits flush under the top nav. Subtle, no layout shift.
5. **Form: preset swatches + clear.** Add a "Color" control to `GeneralTab.tsx`: a row of preset swatch buttons (the 5 chart-palette hexes plus a native `<input type="color">` for custom values) and a "None (auto)" option. Follows the existing reset idiom: `buildProjectRequest` emits `color: null` on edit when cleared.

**Scope boundaries (out of scope):** per-project custom *icons* (lucide icon picker) — the color+initial chip covers the identification need with far less surface; coloring `ProjectsPage` rows / run pickers (nice-to-have, listed as optional task); color strips on non-board project views (plans page, code-server); any persistence outside the Project CR.

## Tasks

1. **API schema:** add `color` to `ProjectSpecSchema` in `packages/api/src/index.ts` (optional, `#rrggbb` regex, doc comment "Accent color for UI identification (hex). Falls back to a name-derived color.").
2. **Codegen:** run `pnpm codegen` and commit the regenerated `k8s/crds/project.yaml`.
3. **Server routes:** in `packages/web/src/server/routes/projects.ts`, add `color` to the SSE event-signature whitelist in `GET /events`. Confirm `POST`/`PUT` need no change beyond the schema (they parse via `ProjectSpecSchema`) and that clearing works through `mergeProjectPatch` with `color: null`.
4. **Board route:** add `color: project.spec.color` (and it may as well include `displayName`) to the `settings` object in `packages/web/src/server/routes/board.ts:196`.
5. **Color helper:** create `packages/web/src/client/lib/project-color.ts` exporting `PROJECT_COLOR_PRESETS` (the 5 chart hexes from `index.css`) and `projectColor(name: string, specColor?: string): string` (explicit color wins; otherwise deterministic hash of `name` into the presets). Pure function, unit-testable.
6. **Client types:** add `color?: string | null` to `CreateProjectRequest` in `packages/web/src/client/lib/types.ts` (the `Project` type flows from `@percussionist/api`).
7. **Sidebar chip:** in `app-sidebar.tsx`, replace `<Folder />` (line 202) with a small `ProjectColorChip` (inline in the file or a tiny component) — colored rounded square with the first character of `displayName || name`; use `projectColor(...)`. Verify collapsed (icon-mode) centering and sizing against `SidebarMenuButton`'s `[&>svg]:size-4` / `!size-8 !p-2` collapsed styles; drop the now-unused `Folder` import.
8. **Board strip:** in `BoardView.tsx`, compute `projectColor(projectName, settings.color)` and render the 2px strip as the first child of the `-m-6` wrapper.
9. **Form state:** in `project-form/useProjectForm.ts`, add `color: string` (empty = auto) to `ProjectFormState`, seed it in `createInitialState` from `spec.color ?? ''`, and emit `req.color = state.color || null` (edit) / only-when-set (create) in `buildProjectRequest`, matching the `displayName` idiom.
10. **Form UI:** add the Color control to `project-form/GeneralTab.tsx` below Display Name — preset swatches from `PROJECT_COLOR_PRESETS`, a custom `<input type="color">`, and an "Auto" clear option; extend the tab's `Pick<>` prop types accordingly.
11. **Tests:** extend `packages/web/tests/project-form.test.ts` (color set / cleared → `null` on edit / omitted on create); add unit tests for `projectColor` determinism and explicit-color precedence; extend `board-view.test.tsx` to assert the strip renders with the settings color; optionally add a first `app-sidebar` test asserting distinct chip colors/initials for two projects.
12. **Docs:** add `color` to the Project spec table in `docs/reference/crds.md` and note the CRD re-apply requirement in the changelog/PR description.
13. **(Optional, cheap wins):** reuse the chip in `ProjectsPage.tsx` `ProjectRow` (line 34) and in `CreateRunForm.tsx`'s project picker for consistency.

Tasks 1–2 must land first; 3–4 depend on 1; 5–6 are independent of the server work; 7–10 depend on 5–6; 11–13 last.

## Risks / open questions

- **CRD upgrade ordering:** until a cluster re-applies the regenerated `project.yaml`, the API server prunes `spec.color` on write. The UI degrades gracefully (fallback hash color), but a user's explicit color choice would silently not persist on stale clusters — worth a release-note line.
- **Hash collisions:** 5 palette slots means projects will collide once a user has ~4+ projects. The initial-letter in the chip plus the explicit override keeps this acceptable; expanding the preset palette beyond the chart tokens is possible later but adds theme-maintenance burden (each color needs light/dark contrast checking).
- **Contrast of the initial letter:** the chip letter needs a readable foreground over arbitrary user-picked hexes. Simplest robust approach: compute luminance and pick black/white text; or render the letter in the chip color on a transparent/10%-tint background instead of a solid fill (avoids the contrast computation entirely — decide during implementation, favor the tinted variant since it matches the app's muted aesthetic per `DESIGN.md`).
- **Assumption:** the "subtle line below top nav" is scoped to the **board view only** (as the task states); the plans page and code-server view are untouched. If a global per-project accent is wanted later, `Layout.tsx:51` is the hook point.
- **`input type="color"` styling** is inconsistent across browsers; if it clashes with the form aesthetic, presets-only is an acceptable v1 (the field accepts any hex via API regardless).

## Acceptance criteria

- Two projects with no configured color show visibly different sidebar chips (different color and/or initial), in both expanded and collapsed sidebar states.
- Collapsed sidebar still shows the project-name tooltip on hover.
- A user can pick a color on project create and edit; clearing it on edit reverts to the automatic color (verified by `PUT` sending `color: null` and the CR losing the field).
- The board view shows a 2px strip in the project's color directly below the top nav; no layout shift versus today.
- `pnpm typecheck`, `pnpm lint`, and `pnpm --filter @percussionist/web test` pass; `k8s/crds/project.yaml` diff contains only the new `color` property.

## Proposed BUILD task breakdown

- **BUILD 1 — Backend field:** tasks 1–4 (zod schema, codegen, projects SSE whitelist, board settings) + doc row (task 12). Independently shippable; no visible UI change.
- **BUILD 2 — Sidebar + board rendering:** tasks 5–8 + related tests (color helper, sidebar chip, board strip). Works with fallback colors even before BUILD 3.
- **BUILD 3 — Form support:** tasks 9–11 (form state, GeneralTab UI, form tests) + optional task 13.
