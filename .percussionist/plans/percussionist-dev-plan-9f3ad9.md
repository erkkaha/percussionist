# Plan: Expose Missing Project Settings in Web UI

**Task:** percussionist-dev-plan-9f3ad9  
**Issue:** Several `ProjectSpec` fields defined in the Zod schema are not exposed in the web UI's project settings form (`CreateProjectForm.tsx`). Users cannot configure these options through the dashboard.

---

## Context

The Project CRD schema (`packages/api/src/index.ts`, lines 754-891) defines a comprehensive set of configuration fields. The web UI form (`packages/web/src/client/components/CreateProjectForm.tsx`) exposes many but not all of them. The server-side API (`packages/web/src/server/routes/projects.ts` PUT handler at line 270) already handles all schema fields correctly via deep merge — adding UI controls requires no backend changes.

### Schema Fields Missing from UI

| Field | Type | Description | Priority |
|-------|------|-------------|----------|
| `source.local` | boolean | Toggle for local git workspace (no remote clone) | High |
| `image` | string | Project-level runner image override | Medium |
| `resources` | object | Pod resource requirements at project level | Medium |
| `phase` | enum | Active/Complete/Archived lifecycle selector | Low |
| `data.pvcName` | string | Custom PVC name override | Low |
| `data.mountPath` | string | Custom mount path (default `/data`) | Low |
| `data.storageClass` | string | Storage class override for PVC | Low |
| `gitCache.worktreeReuse` | boolean | Reuse git worktrees across runs | Medium |
| `flow.*` | object | Task lifecycle presets and overrides | High |
| `codeServer.enabled` | boolean | Enable code-server sidecar | Medium |
| `codeServer.image` | string | Code-server container image | Low |
| `codeServer.resources` | object | Code-server resource requirements | Low |

### Fields Already Exposed (for reference)

- `displayName`, `model`, `agent`, `source.git.*`, `secrets.*`, `timeoutSeconds`, `sidecars`, `injectFiles`, `initScript`, `maxParallel`, `agents` (roster), `featureBranchingEnabled`, `retryPolicy.*`, `reviewPolicy.*`, `opencodeConfig`

---

## Approach

Add the missing fields to `CreateProjectForm.tsx` in logical groupings, matching existing UI patterns (fieldsets with legends, grid layouts, toggle checkboxes). Update the client-side `CreateProjectRequest` interface (`packages/web/src/client/lib/types.ts`) to include new fields. No backend changes needed — the PUT handler already merges all spec fields.

### Grouping Strategy

1. **Source section** — Add `source.local` toggle alongside existing git URL fields (mutually exclusive)
2. **Runner section** — New fieldset for `image`, `resources` (project-level overrides)  
3. **Git Cache section** — New fieldset for `gitCache.worktreeReuse`
4. **Flow section** — New fieldset with preset selector + expandable override panels
5. **Code Server section** — New fieldset matching AGENTS.md documentation pattern
6. **Data PVC section** — New fieldset for PVC customization (advanced)

---

## Tasks

### Task 1: Update Client-Side Types

**File:** `packages/web/src/client/lib/types.ts`  
Add missing fields to `CreateProjectRequest`:
- `source.local?: boolean`
- `image?: string`
- `resources?: { requests?: Record<string, string>; limits?: Record<string, string> }`
- `phase?: "Active" | "Complete" | "Archived"`
- `data?: { pvcName?: string; mountPath?: string; storageClass?: string }`
- `gitCache?: { worktreeReuse?: boolean }`
- `flow?: FlowConfig` (full type matching schema)
- `codeServer?: { enabled?: boolean; image?: string; resources?: ResourceRequirements }`

### Task 2: Add Source.local Toggle to CreateProjectForm

**File:** `packages/web/src/client/components/CreateProjectForm.tsx`  
In the existing "Git source" fieldset (line ~368):
- Add a checkbox toggle for `source.local` 
- When checked, hide/disable git URL fields with a note: "Local workspace — no remote repository will be cloned"
- Initialize state from `initialSpec?.source?.local ?? false`
- Wire into `handleSubmit`: set `req.source = { local: true }` when toggled (no git block)

### Task 3: Add Runner Override Fieldset

**File:** `packages/web/src/client/components/CreateProjectForm.tsx`  
New fieldset after "Model + Agent" section (~line 474):
- Title: "Runner Overrides"
- Description: "Override cluster-level runner defaults for this project."
- Fields:
  - Runner Image (text input, mono font) — from `initialSpec?.image`
  - CPU Request / Memory Request (grid, like SettingsPage pattern)
  - CPU Limit / Memory Limit (grid)
- Wire into `handleSubmit`: set `req.image`, `req.resources`

### Task 4: Add Git Cache Fieldset

**File:** `packages/web/src/client/components/CreateProjectForm.tsx`  
New fieldset after Runner Overrides:
- Title: "Git Cache"
- Description: "Control how git worktrees are managed across runs."
- Fields:
  - Checkbox toggle for `worktreeReuse` (default true) — from `initialSpec?.gitCache?.worktreeReuse ?? true`
  - Help text: "When enabled, subsequent runs reuse the existing worktree instead of checking out fresh"
- Wire into `handleSubmit`: set `req.gitCache = { worktreeReuse }`

### Task 5: Add Flow Configuration Fieldset

**File:** `packages/web/src/client/components/CreateProjectForm.tsx`  
New fieldset (this is the most complex addition):
- Title: "Task Lifecycle"
- Description: "Control how tasks flow through their lifecycle."
- Fields:
  - Preset selector (dropdown): `simple`, `review`, `plan-build`, `plan-build-review-merge` — from `initialSpec?.flow?.preset ?? "plan-build-review-merge"`
  - Expandable override section when preset is not `simple`:
    - Human Approval: checkboxes for plan/build approval requirements
    - Build Success: dropdown for `onSuccess` (human-review, ai-review, done)
    - Build Approval: dropdown for `onApprove` (merge, done)
    - Merge Mode: dropdown for merge mode (auto, manual, disabled)
- Wire into `handleSubmit`: set `req.flow = { preset, ...overrides }`

### Task 6: Add Code Server Fieldset

**File:** `packages/web/src/client/components/CreateProjectForm.tsx`  
New fieldset matching AGENTS.md documentation pattern:
- Title: "Code Server"
- Description: "Enable interactive VS Code access to the workspace."
- Fields:
  - Checkbox toggle for `enabled` — from `initialSpec?.codeServer?.enabled ?? false`
  - When enabled: Image input (default `codercom/code-server:4.96.4`)
  - When enabled: Resource requests/limits grid (optional)
- Wire into `handleSubmit`: set `req.codeServer = { enabled, image, resources }`

### Task 7: Add Data PVC Fieldset (Advanced)

**File:** `packages/web/src/client/components/CreateProjectForm.tsx`  
New fieldset at bottom of form (advanced settings):
- Title: "Data PVC"
- Description: "Customize the persistent volume for workspace data."
- Fields:
  - PVC Name override (text input, optional) — from `initialSpec?.data?.pvcName`
  - Mount Path (text input, default `/data`) — from `initialSpec?.data?.mountPath ?? "/data"`
  - Storage Class (text input, optional) — from `initialSpec?.data?.storageClass`
- Wire into `handleSubmit`: set `req.data = { pvcName, mountPath, storageClass }`

### Task 8: Add Phase Selector to Edit Mode

**File:** `packages/web/src/client/components/CreateProjectForm.tsx`  
In edit mode only (after the read-only name field):
- Dropdown selector for phase: Active / Complete / Archived — from `initialSpec?.phase ?? "Active"`
- Wire into `handleSubmit`: set `req.phase`

### Task 9: Run Type Check and Build Verification

**Commands:**
```bash
pnpm typecheck
pnpm build
```
Verify no TypeScript errors are introduced. The form is large (~913 lines) so ensure all new state variables, handlers, and JSX render correctly.

---

## Risks / Open Questions

1. **Form size**: `CreateProjectForm.tsx` is already 913 lines. Adding ~6 new fieldsets will push it well past 1200 lines. Consider whether to extract some sections into sub-components (e.g., `<FlowConfigSection>`, `<CodeServerSection>`).

2. **Flow complexity**: The `flow` schema has many nested optional fields. The UI should present a simple preset selector by default, with expandable override panels. Don't expose every field at once — use progressive disclosure.

3. **Mutual exclusivity of source.local vs source.git**: Need to ensure the form prevents both from being set simultaneously and provides clear UX feedback.

4. **Resource requirements format**: The `resources` field uses K8s-style strings (e.g., "100m", "256Mi"). Should we add validation or just pass through?

5. **Backward compatibility**: Existing projects without these fields will use schema defaults. The PUT handler's merge behavior preserves existing values — no data loss risk.

---

## Acceptance Criteria

- All 12 missing schema fields are exposed in the CreateProjectForm UI
- Form submission correctly serializes all new fields into `CreateProjectRequest`
- Edit mode pre-populates all new fields from existing project spec
- TypeScript compiles without errors (`pnpm typecheck`)
- No regression in existing form behavior (sidecars, inject files, retry/review policies)
- New fieldsets follow existing UI patterns (fieldset/legend, grid layouts, mono fonts for technical values)
