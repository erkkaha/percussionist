# Plan: Dedicated Agents tab in project settings with per-agent model selection

Task: `percussionist-dev-plan-27ac8a`

## Context

### What exists today

The project roster is an ordered list of ClusterAgent names available to a
project's tasks (`Project.spec.agents`). The backend **already** models a
per-agent model override, but the web UI neither surfaces it nor lets users set it:

1. **API schema** — `AgentRefSchema = { name, model? }` in
   `packages/api/src/index.ts:418-421` (`model: z.string().optional()` — accepts
   `''`, **rejects `null`**). Project spec uses it at line 658
   (`agents: AgentRefSchema.array().max(10).optional()`). The generated CRDs
   already include `model` under `spec.agents` (`k8s/crds/project.yaml:265`,
   `k8s/crds/run.yaml:76`), so **no codegen/CRD change is needed**.

2. **Runtime model resolution already implements "agent model overrides the
   default"** — `packages/manager-controller/src/worker-builder.ts:65-82`
   (worker runs), `:357-365` (merge runs), `:665-673` (integration runs), and
   `packages/manager-controller/src/facilitator.ts:530-534`. Precedence
   (highest → lowest):
   `explicit run override (MCP tool) → project roster agent model (spec.agents[].model) → ClusterAgent spec.model → project.spec.model`.
   So the per-agent model from the roster **already overrides** the ClusterAgent
   model and the project default at run-build time. No controller changes are
   required for the override semantics.

3. **Server-side validation** — `packages/web/src/server/routes/projects.ts`
   PUT parses with `ProjectSpecSchema` (lines 427-430) and deep-merges incoming
   roster entries against existing ones by `name` via `mergeProjectPatch`
   (lines 412-425), preserving unknown fields. `mergeProjectPatch` deletes
   `null` values (lines 93-94), so an explicit `model: null` clears a model for
   an *existing* agent, but a verbatim `model: null` on a *new* agent fails
   `ProjectSpecSchema` validation (Zod `optional()` ≠ `nullable()`).

4. **Frontend gap** — the roster UI is buried in the "Advanced" tab:
   - `packages/web/src/client/components/project-form/AdvancedTab.tsx:228-280`
     renders a plain name list + a `<Select>` picker of ClusterAgents. No model.
   - `packages/web/src/client/components/project-form/useProjectForm.ts` holds
     the roster as `rosterAgents: string[]` (line 138), initializes it by
     dropping everything but the name (line 634:
     `(spec.agents ?? []).map((a) => a.name)`), and serializes it as
     `req.agents = state.rosterAgents.map((name) => ({ name }))` (line 336) —
     **the `model` field is discarded on save**.
   - `packages/web/src/client/lib/types.ts:140` types
     `CreateProjectRequest.agents?: Array<{ name: string }>` — no model.
   - `packages/web/src/client/components/CreateProjectForm.tsx` defines the
     tab list (`TABS`, lines 31-38: general, source-auth, execution,
     workspace-services, memories, advanced) — there is no dedicated tab.
     Tab id is synced to the URL via `?tab=`/`#` (`resolveTab`, lines 42-51).

5. **Existing reusable UI** — `ModelSelector` (`ModelSelector.tsx`) is the
   combobox-style model picker already used by the General tab and the Manager
   Agent panel; it degrades to a plain text input when the opencode providers
   endpoint is unreachable.

### Interpretation of the request

- "bring project agent roster to upper level settings category in project
  settings. dedicate a tab for it" → move the roster out of the Advanced tab
  into a new top-level **Agents** tab of the project settings form
  (`/projects/:name/edit` → `CreateProjectForm`).
- "Allow selecting allowed models for each agent" → per-roster-entry model
  selection. **Assumption (stated):** this is a *single model per agent* —
  matching the existing `AgentRef.model` field and the worker-builder override
  semantics. A multi-model allowlist would require a new schema field plus
  enforcement logic and is out of scope (see Open questions).
- "project agent model setting should override default setting" → the selected
  per-agent model wins over the ClusterAgent model and the project default.
  This **already works** at runtime (worker-builder precedence above); the work
  is to make it settable/editable in the UI and to lock the behavior in with
  tests.

## Approach

1. **Change the form state to carry the model.** Replace `rosterAgents:
   string[]` with `rosterAgents: RosterAgentRow[]` where
   `RosterAgentRow = { name: string; model: string }`. `createInitialState`
   preserves `spec.agents[].model`; `buildProjectRequest` emits
   `{ name, model }` per entry.
2. **Serialize cleared models as `''`, never `null`.** Because
   `AgentRefSchema.model` rejects `null` (Zod `optional()`), the UI sends an
   empty string when the model is cleared. This passes schema validation for
   both new and existing agents, overwrites a previously saved model via
   `mergeProjectPatch`, and is functionally a no-op at runtime
   (`if (agentOverride?.model)` is falsy for `''`). Cosmetic cost: a `model: ""`
   may persist in the CR — acceptable (downstream consumers check truthiness).
3. **Dedicated tab.** Add an `agents` tab (after `general`) to
   `CreateProjectForm`'s `TABS`, render a new `project-form/AgentsTab.tsx`
   there, and strip the roster fieldset + props from `AdvancedTab`.
4. **Per-agent model selector.** Each roster row gets a `ModelSelector` (with a
   hint that empty = use ClusterAgent model / project default). The ClusterAgent
   picker stays a `<Select>` of the remaining (not-yet-roster) cluster agents.
5. **No backend/schema changes.** The override semantics, CRD, and server
   validation already support `spec.agents[].model`. Only the web client
   changes (plus tests).

## Tasks

### BUILD task A — form-state plumbing for roster models (web client)

1. **`packages/web/src/client/components/project-form/useProjectForm.ts`**
   - Add and export `interface RosterAgentRow { name: string; model: string }`.
   - Change `ProjectFormState.rosterAgents` type from `string[]` to
     `RosterAgentRow[]` (line 138) and `setRosterAgents` to
     `React.Dispatch<React.SetStateAction<RosterAgentRow[]>>` (line 712).
   - `createInitialState` (line 634): map
     `(spec.agents ?? []).map((a) => ({ name: a.name, model: a.model ?? '' }))`.
   - `buildProjectRequest` (line 336): emit
     `req.agents = state.rosterAgents.map(({ name, model }) => ({ name, model: model.trim() }))`
     — always include `model` (possibly `''`; never `null`).
   - Add helpers (and expose on `ProjectFormHookReturn`):
     `addRosterAgent(name: string)` — appends `{ name, model: '' }` and resets
     the picker; `updateRosterAgentModel(name: string, model: string)`.
2. **`packages/web/src/client/lib/types.ts`** — line 140: change
   `agents?: Array<{ name: string }>` to
   `agents?: Array<{ name: string; model?: string }>`.
3. **Tests — `packages/web/tests/project-form.test.ts`**:
   - `createInitialState` round-trips `spec.agents` with models
     (`[{ name: 'builder', model: 'a/b' }]` → row `{ name, model: 'a/b' }`,
     and an agent without `model` → `model: ''`).
   - `buildProjectRequest` maps rows to `{ name, model }`; a cleared model
     (`''`) serializes as `model: ''`; a set model is trimmed.
   - Regression: existing tests that touch `rosterAgents` (none directly today)
     still compile/typecheck.

### BUILD task B — Agents tab UI (web client)

4. **New `packages/web/src/client/components/project-form/AgentsTab.tsx`** —
   move the roster UI out of `AdvancedTab`:
   - Rows: agent name (mono) + `ModelSelector` (value = row.model,
     `onChange = (m) => updateRosterAgentModel(row.name, m)`) + remove button
     (removes by name).
   - ClusterAgent picker `<Select>` — same as today, but adds
     `addRosterAgent(name)` instead of pushing a string.
   - Copy: explain that an empty model falls back to the ClusterAgent's
     `spec.model` (if set) then the project default model, and that the
     selected model overrides those defaults for this agent.
   - Optional nicety: show the ClusterAgent's configured model as a muted hint
     per row when the row's model is empty (data available from the
     `clusterAgents` prop).
   - Props: `Pick<ProjectFormHookReturn, 'rosterAgents' | 'rosterPickerValue' |
     'setRosterPickerValue'>` + the new helpers, plus
     `clusterAgents: Array<{ name: string; content: string; model?: string }>`.
5. **`packages/web/src/client/components/project-form/AdvancedTab.tsx`** —
   delete the "Agent roster" fieldset (lines 228-280) and remove
   `rosterAgents`/`rosterPickerValue`/`setRosterAgents`/`setRosterPickerValue`
   from its props type; keep sidecars/injectFiles/initScript.
6. **`packages/web/src/client/components/CreateProjectForm.tsx`**:
   - Add `'agents'` to `ProjectTabId` and `{ id: 'agents', label: 'Agents' }`
     to `TABS` (after `general`).
   - Build `agentsProps` (roster rows, picker value, helpers, `clusterAgents`).
   - Render `<TabsContent value="agents"><AgentsTab ... /></TabsContent>`.
   - Remove the roster fields from `advancedProps` (lines 265-275).
   - The `fetchAgents` query (lines 92-96) already loads ClusterAgents for the
     form — it stays (now consumed by `AgentsTab`).
7. **Component test — new `packages/web/tests/agents-tab.test.tsx`** (bun:
   test, following `board-header.test.tsx` mocking patterns):
   - renders roster rows with names; adding an agent via the picker; removing a
     row; per-row `ModelSelector` rendering (mock `useProviders`/`fetchProviders`
     or assert the input fallback since ModelSelector degrades gracefully).
8. **Verification** (run from repo root):
   - `pnpm typecheck` (pre-commit gate) and `pnpm lint`.
   - `cd packages/web && bun test` for the touched suites.
   - Optional manual check on a live cluster: edit a project, set a roster
     agent's model, create a task for that agent, confirm the resulting Run's
     `spec.model` equals the roster model (worker-builder precedence).

## Scope boundaries

- **In scope:** web client only — form state, request serialization, new
  Agents tab, per-agent ModelSelector, tests.
- **Explicitly out of scope:** changes to `AgentRefSchema`/CRDs (already
  support `model`), manager-controller worker-builder logic (already implements
  the override), ClusterAgent CR editing UI, board/run list display of
  per-agent models, multi-model allowlists.
- **No codegen** (`pnpm codegen`) needed — CRD YAML already contains
  `spec.agents[].model`.

## Risks / open questions

- **`model: ""` persisted in the CR** when cleared. Cosmetic; runtime treats
  it as "no override" (truthiness check in worker-builder/facilitator). If
  cleanliness matters later, change `AgentRefSchema.model` to
  `.optional().nullable()` and regenerate CRDs — deliberately not done here to
  avoid CRD churn.
- **Zod rejects `null`** in `AgentRefSchema.model` — the UI must never send
  `model: null` (a verbatim null on a *new* roster entry fails server
  validation). The `''`-based serialization avoids this edge case entirely;
  a test asserting `model: ''` on clear should be included.
- **Interpretation of "allowed models".** Plan assumes a single model per
  agent (matches existing `AgentRef.model`). If a multi-model allowlist
  (e.g. the run picker only offers those models) is actually wanted, it needs a
  new schema field (e.g. `allowedModels: string[]`), run-creation UI
  filtering in `CreateRunForm`/board `AddTaskForm`, and enforcement — a
  follow-up task. Flagged for the reviewer.
- **ModelSelector weight**: it fetches `/api/providers`; renders N selectors
  (one per roster row, max 10). Acceptable; rows are few.
- **Tab URL compatibility**: new tab id `agents` is validated by `resolveTab`
  automatically; no conflict with the cluster Settings "Agents" tab (different
  route/page).
- **Existing projects** saved with roster entries lacking `model` are handled
  (`a.model ?? ''`); no migration needed.

## Acceptance criteria

1. The project settings form (`/projects/:name/edit`) shows a top-level
   **Agents** tab; the roster is no longer inside the Advanced tab.
2. Each roster entry can have a model selected via `ModelSelector` (or typed
   manually); an empty model is allowed and displayed as "default".
3. Saving a project persists `spec.agents[].model` (empty string when cleared)
   — verified via `kubectl get project <name> -o yaml` or the API response.
4. Reloading the edit form repopulates each row's saved model.
5. Runtime override is confirmed: for a task using a roster agent with a model,
   the built Run's `spec.model` equals that model (beating ClusterAgent model
   and project default). No regression when no model is set (falls back as
   before).
6. `pnpm typecheck`, `pnpm lint`, and the web test suite pass.

## Proposed BUILD task breakdown

- **BUILD A** (Tasks 1-3): form-state + request plumbing + unit tests. Pure
  logic; no UI. Sizable but self-contained.
- **BUILD B** (Tasks 4-7): AgentsTab UI, tab wiring, AdvancedTab cleanup +
  component test. Depends on BUILD A's `RosterAgentRow`/helpers
  (`predecessorRef: BUILD A`).
