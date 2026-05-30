# PLAN: Add description field to agent form UI

**Task:** `percussionist-dev-plan-16a91d`  
**Problem:** The agent creation/edit form in the web UI is missing a dedicated `description` field. Currently, descriptions are embedded as YAML front-matter inside the content textarea (`---\ndescription: ...\n---`), which users must manually type. The agents list page already displays a "Description" column by parsing this front-matter via regex, but there's no proper UI input for it.

## Context

### Current Architecture (Agent CRUD layers)

| Layer | File(s) | What it does |
|-------|---------|--------------|
| **API Schema** | `packages/api/src/index.ts:295-298` | `ClusterAgentSpecSchema` — Zod schema defining `{ content }` only. No `description`. |
| **Backend Routes** | `packages/web/src/server/routes/agents.ts` | POST/PUT validate body against `ClusterAgentSpecSchema`; GET list returns `{ name, content }` per agent. |
| **Client Types** | `packages/web/src/client/lib/types.ts:122-125` | `CreateAgentRequest` interface — only `{ name?, content }`. |
| **API Client** | `packages/web/src/client/lib/api.ts:148-179` | `submitAgent()`, `updateAgent()` send `CreateAgentRequest` to backend. |
| **Form Component** | `packages/web/src/client/components/AgentForm.tsx` | Two fields: Name (text input) + Content (textarea with YAML front-matter placeholder). No description field. |
| **List Page** | `packages/web/src/client/components/AgentsPage.tsx:25-28` | Extracts description from content via regex `/^---\ndescription:\s*(.+?)\n---/`. Shows it in a "Description" column. |
| **Hooks** | `packages/web/src/client/hooks/useAgents.ts` | `AgentListItem` interface — `{ name, content }`. No description. |

### The Gap

The agents list page already has a "Description" column and parses descriptions from the content front-matter. But users creating/editing agents have no dedicated UI field for it — they must manually type YAML front-matter inside the content textarea. This is error-prone and unintuitive.

## Approach

Add `description` as an **optional top-level field** in the `ClusterAgentSpecSchema`. This requires changes across all layers:

1. **API schema**: Add `description: z.string().max(8192).optional()` to `ClusterAgentSpecSchema`
2. **Backend routes**: Zod validation auto-accepts new field; update GET list endpoint to return description
3. **Client types**: Add `description?: string` to `CreateAgentRequest`
4. **Form component**: Add a description `<input>` field, load it on edit, send it on create/update
5. **List page & hooks**: Update interfaces to include description; use the new field instead of regex parsing

### Design Decisions

- **Optional field** — existing agents without `description` will show `-` (same as current fallback)
- **Max 8192 chars** — consistent with other optional string fields in the codebase (e.g., Task description)
- **Backward compatible** — old agents stored without `spec.description` continue to work; list page falls back to regex parsing if field is absent
- **No K8s CRD changes needed** — ClusterAgent is a custom resource; adding an optional spec field doesn't require CRD regeneration since the K8s API accepts arbitrary object fields

## Tasks

### Task 1: Add `description` to `ClusterAgentSpecSchema` (API layer)
- **File:** `packages/api/src/index.ts` lines 295-298
- **Change:** Add `description: z.string().max(8192).optional()` to the Zod object
- **Impact:** All downstream layers that use this schema will accept/validate description

### Task 2: Update client type `CreateAgentRequest`
- **File:** `packages/web/src/client/lib/types.ts` lines 122-125
- **Change:** Add `description?: string;` to the interface
- **Impact:** TypeScript compilation will enforce description field in form submissions

### Task 3: Update backend GET list endpoint to return description
- **File:** `packages/web/src/server/routes/agents.ts` line 22
- **Change:** Map `{ name, content }` → `{ name, content, description }` from `a.spec.description`
- **Impact:** Frontend receives description in agent list responses

### Task 4: Update `AgentListItem` interface and hooks
- **File:** `packages/web/src/client/hooks/useAgents.ts` lines 4-7
- **Change:** Add `description?: string;` to the local `AgentListItem` interface
- **Impact:** TypeScript types flow through to AgentsPage

### Task 5: Update `extractDescription` fallback in AgentsPage
- **File:** `packages/web/src/client/components/AgentsPage.tsx` lines 25-28, 50-52
- **Change:** Modify `AgentRow` to use `agent.description ?? extractDescription(agent.content)` — prefer the new field, fall back to regex parsing for legacy agents
- **Impact:** Existing agents continue showing descriptions; new agents show their description directly

### Task 6: Add description input field to AgentForm component
- **File:** `packages/web/src/client/components/AgentForm.tsx`
- **Changes:**
  - Add `const [description, setDescription] = useState("");` state variable (line ~14)
  - Load description from API response in the edit useEffect: `setDescription(data.spec?.description ?? "")` (lines 20-26)
  - Insert a new `<input>` field between Name and Content fields with label "Description"
  - Update `handleSave` to pass `{ name, description, content }` on create/update
  - Add placeholder text: `"Brief description of this agent's role"`
- **Impact:** Users can now enter descriptions in a dedicated UI field

### Task 7: Regenerate CRD YAML (if needed)
- Run `pnpm codegen` to regenerate any CRD YAML from updated Zod schemas
- Verify no breaking changes to existing ClusterAgent CRD structure

## Acceptance Criteria

1. ✅ New agent form has a "Description" input field between Name and Content
2. ✅ Creating an agent with description saves it correctly (verified via API response)
3. ✅ Editing an existing agent loads the description into the field
4. ✅ Agents list page shows descriptions from the new field for newly-created agents
5. ✅ Legacy agents (without `spec.description`) still show their description via regex fallback
6. ✅ `pnpm build` succeeds with no type errors
7. ✅ `pnpm codegen` produces valid CRD YAML

## Risks / Open Questions

- **K8s API compatibility:** Adding an optional field to ClusterAgentSpec is backward compatible — the K8s API ignores unknown fields in objects, and existing agents without `description` will simply have `undefined` for that field.
- **CRD regeneration:** The Zod schema change may affect CRD YAML generation. Need to verify with `pnpm codegen`. If it adds a new required field or changes validation constraints, this could cause issues during rollout.
- **Existing agents:** All existing ClusterAgent resources in the cluster will have `spec.description` as undefined. The fallback regex parsing ensures no visual regression.

## BUILD Task Breakdown

1. **BUILD 1** — API schema + client types (Tasks 1-2): Add description to Zod schema and CreateAgentRequest
2. **BUILD 2** — Backend routes + hooks (Tasks 3-4): Update GET list endpoint, update AgentListItem interface
3. **BUILD 3** — UI form component (Task 6): Add description input field with load/save logic
4. **BUILD 4** — AgentsPage updates + CRD regen (Tasks 5, 7): Update list page fallback, regenerate CRDs

## Files Changed Summary

| File | Change Type |
|------|-------------|
| `packages/api/src/index.ts` | Add `description` to `ClusterAgentSpecSchema` |
| `packages/web/src/client/lib/types.ts` | Add `description` to `CreateAgentRequest` |
| `packages/web/src/server/routes/agents.ts` | Return description in GET list response |
| `packages/web/src/client/hooks/useAgents.ts` | Add `description` to `AgentListItem` interface |
| `packages/web/src/client/components/AgentForm.tsx` | Add description input field, load/save logic |
| `packages/web/src/client/components/AgentsPage.tsx` | Use new description field with regex fallback |

