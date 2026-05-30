# PLAN: Remove Description column from agents table

**Task:** `percussionist-dev-plan-16a91d`  
**Problem:** The agents list page shows a "Description" column that parses descriptions from the content string via regex (`/^---\ndescription:\s*(.+?)\n---/`). However, there is no dedicated `description` field in the `ClusterAgentSpecSchema`, no description input in the form, and no type-level support for it. The column is misleading — it's a derived value from an opaque content string, not a real schema field.

**Decision:** Remove the Description column from the agents table entirely. This is cleaner than adding a new schema field because:
- `ClusterAgentSpecSchema` only has `{ content }` — no description at all
- Adding description would require changes across 6+ files (API schema, backend routes, client types, hooks, form component, list page)
- The regex-based extraction is fragile and error-prone (breaks if front-matter format varies)
- Users already see the full content preview column; adding a separate description field adds complexity for marginal benefit

## Context

### Current Architecture (Agent CRUD layers)

| Layer | File(s) | What it does |
|-------|---------|--------------|
| **API Schema** | `packages/api/src/index.ts:295-298` | `ClusterAgentSpecSchema = z.object({ content: z.string().max(102400) })`. Only one field. No description. |
| **Backend Routes** | `packages/web/src/server/routes/agents.ts` | GET list returns `{ name, content }` per agent (line 22). POST/PUT validate against schema. |
| **Client Types** | `packages/web/src/client/lib/types.ts:122-125` | `CreateAgentRequest = { name?, content }`. No description. |
| **API Client** | `packages/web/src/client/lib/api.ts:148-179` | `submitAgent()`, `updateAgent()` send `CreateAgentRequest`. |
| **Form Component** | `packages/web/src/client/components/AgentForm.tsx` | Two fields: Name (text input) + Content (textarea). Description is just text inside the textarea placeholder. |
| **List Page** | `packages/web/src/client/components/AgentsPage.tsx:25-28, 50-51` | Extracts description from content via regex `/^---\ndescription:\s*(.+?)\n---/`. Shows it in a "Description" column. |
| **Hooks** | `packages/web/src/client/hooks/useAgents.ts` | `AgentListItem = { name, content }`. No description. |

### The Gap (Why Remove)

The Description column pretends there's a first-class `description` field that doesn't exist:
- Schema has no `description` — only `content`
- Form has no description input — users type it manually in the textarea
- Regex parsing is fragile — breaks if front-matter format varies (extra whitespace, different key order, etc.)
- The column shows `-` for any agent whose content doesn't match the exact regex pattern

Removing the column eliminates a misleading UI element. Users who need to see an agent's description can click Edit and read it in the content textarea, or use the Content Preview column which shows the raw content.

## Approach

Remove the Description column from `AgentsPage.tsx`. This is a single-file change with no schema, API, or type modifications needed.

### What changes
1. Remove `<th>Description</th>` header cell (line 151)
2. Remove `<td>extractDescription(...)</td>` data cell in `AgentRow` (lines 50-52)
3. Remove the `extractDescription()` helper function (lines 25-28) — no longer used anywhere
4. Update loading skeleton to remove one pulse div (line 130)

### What stays the same
- Form component (`AgentForm.tsx`) — unchanged, description remains in content textarea
- API schema (`ClusterAgentSpecSchema`) — unchanged, only `content` field
- Backend routes — unchanged
- Client types — unchanged
- Content Preview column — stays as-is (shows raw content truncated to 120 chars)

## Tasks

### Task 1: Remove Description column from AgentsPage table
- **File:** `packages/web/src/client/components/AgentsPage.tsx`
- **Changes:**
  - Remove `<th className="px-4 py-2.5 font-medium">Description</th>` at line 151
  - Remove the entire `<td>` cell containing `extractDescription(agent.content)` at lines 50-52 in `AgentRow`
  - Remove the `extractDescription()` helper function (lines 25-28) — verify it's unused elsewhere via grep
  - Update loading skeleton: remove one of the four pulse divs (line 130), keep three to match remaining columns

### Task 2: Verify no other references to extractDescription
- **File:** `packages/web/src/client/components/AgentsPage.tsx` and all other files
- **Change:** Confirm via grep that `extractDescription` is only used in this file (already confirmed — only 5 matches, all within AgentsPage.tsx)

### Task 3: Run typecheck and build
- **Command:** `pnpm typecheck && pnpm build` from workspace root
- **Verify:** No TypeScript errors, build succeeds

## Acceptance Criteria

1. ✅ Description column header removed from agents table
2. ✅ Description data cells removed from all agent rows
3. ✅ `extractDescription()` function removed (no longer referenced)
4. ✅ Loading skeleton updated to match new column count (3 pulse divs instead of 4)
5. ✅ Form component unchanged — description still in content textarea as before
6. ✅ No schema/API/type changes needed or made
7. ✅ `pnpm typecheck` passes with no errors
8. ✅ `pnpm build` succeeds

## Risks / Open Questions

- **Visual layout:** Removing one column reduces table width. Verify the remaining columns (Name, Content Preview, Age, Actions) still provide useful information at a glance. The Content Preview column already shows raw content — this partially compensates for losing Description.
- **User expectations:** Users accustomed to seeing descriptions in the list will need to click Edit to see them. This is acceptable since description was never a first-class field anyway.
- **No data migration needed:** Since we're removing UI, not changing schema, no migration or backward compatibility concerns exist.

## BUILD Task Breakdown

1. **BUILD 1** — Remove Description column from AgentsPage (Task 1): Edit `AgentsPage.tsx` to remove header cell, data cell, helper function, and update skeleton
2. **BUILD 2** — Verify + typecheck (Tasks 2-3): Confirm no orphaned references, run `pnpm typecheck && pnpm build`

## Files Changed Summary

| File | Change Type |
|------|-------------|
| `packages/web/src/client/components/AgentsPage.tsx` | Remove Description column header, data cell, `extractDescription()` helper, update skeleton pulse count |
