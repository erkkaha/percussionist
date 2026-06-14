# Plan: Board “waiting for” and “from” should be human-readable

## Context

The board currently renders task relationships using CR names (`metadata.name`), which are stable IDs like `percussionist-dev-build-abc123`:

- `packages/web/src/server/routes/board.ts`
  - In `GET /api/projects/:project/board`, blocked predecessor text is set as:
    - `task.status.blockedReason = "Waiting for: ${predRef}"`
  - `predRef` comes from `task.spec.predecessorRef` (a task CR name).
- `packages/web/src/client/components/board/TaskRow.tsx`
  - Bottom metadata shows `from: {task.spec.parentTaskRef}`.
- `packages/web/src/client/components/board/TaskDetailPanel.tsx`
  - Child list under `awaiting-children` shows raw `childRefs` values (task names).
- `packages/web/src/client/components/AgentChatPanel.tsx`
  - Task context injection includes `Parent: ${task.spec.parentTaskRef}`.

All of these are technically correct but not human-friendly in the board UX.

## Scope boundaries

In scope:

- Board API response shaping in `packages/web/src/server/routes/board.ts`.
- Board list/detail rendering in `packages/web/src/client/components/board/*`.
- Task context text in `AgentChatPanel` if we can do so without extra API calls.

Out of scope (unless trivial):

- Changing CRD schema fields (`parentTaskRef`, `predecessorRef`) away from task IDs.
- Changing manager-controller orchestration semantics.
- Broad renaming across unrelated pages (Runs/Activity/Stats).

## Approach

Prefer server-side enrichment with display labels while preserving canonical IDs:

1. Build an in-memory task lookup (`Map<taskName, task>`) in `board.ts` during board response assembly.
2. Derive a small helper for display names:
   - Preferred: task title (`task.spec.title`)
   - Optional disambiguation: include short ID suffix or full ID in parentheses when useful.
   - Fallback: original task ID if lookup is missing/stale.
3. Keep status semantics untouched (still blocked by predecessor ID), but change human-facing strings to include friendly labels.
4. Include additive fields in response objects where needed (e.g., computed display refs) so client components don’t have to re-resolve IDs.
5. Update board UI components to render friendly labels and optionally keep raw IDs in `title` tooltip.

This keeps orchestration deterministic (IDs remain canonical) while improving readability.

## Tasks

1. **Add board response reference-display helpers in server route**
   - File: `packages/web/src/server/routes/board.ts`
   - Add helper(s) to resolve `taskName -> displayLabel` from in-memory `tasks` list.
   - Define fallback behavior when referenced task is absent.

2. **Make blocked predecessor reason human-readable**
   - File: `packages/web/src/server/routes/board.ts`
   - Replace `Waiting for: ${predRef}` with a display-oriented string based on resolved task title.
   - Preserve or include canonical ID when needed for traceability (e.g., tooltip text or `(task-id)` suffix).

3. **Enrich board task payload with computed display references (additive)**
   - File: `packages/web/src/server/routes/board.ts`
   - For each task, add optional computed fields (example naming):
     - `displayRefs.parentTask`
     - `displayRefs.predecessorTask`
     - `childProgress.childDisplayRefs` (aligned with existing `childRefs` ordering)
   - Keep existing `childRefs` and spec refs unchanged for backward compatibility.

4. **Extend client Task type for additive display refs**
   - File: `packages/web/src/client/lib/types.ts`
   - Extend the local `Task` interface with optional display-ref fields returned by board API.
   - Ensure compatibility with existing consumers.

5. **Update task row “from” label to friendly text**
   - File: `packages/web/src/client/components/board/TaskRow.tsx`
   - Replace direct `task.spec.parentTaskRef` rendering with display ref when available.
   - Keep raw ID as fallback and optionally in tooltip.

6. **Update blocked badge text rendering**
   - File: `packages/web/src/client/components/board/TaskRow.tsx`
   - Ensure blocked text remains readable and not overlong (truncate + tooltip if needed).
   - Confirm it still works when server fallback returns raw IDs.

7. **Update child task list display in detail panel**
   - File: `packages/web/src/client/components/board/TaskDetailPanel.tsx`
   - Render friendly child labels in the `awaiting-children` section.
   - Keep navigation by canonical child task name (query param remains ID-based).

8. **Update chat injection parent line**
   - File: `packages/web/src/client/components/AgentChatPanel.tsx`
   - Use friendly parent reference text when present on the selected task object.
   - Fallback to existing ID string.

9. **Add/adjust server route tests for board response shaping**
   - Target test location: `packages/web/tests/` (add focused unit coverage around board response payload construction).
   - Validate that:
     - predecessor blocked reason prefers title,
     - missing references fall back to ID,
     - additive fields are present and aligned.

10. **Add/adjust client component tests (if present) or focused render assertions**
    - Validate TaskRow/TaskDetailPanel rendering uses display refs and gracefully falls back to IDs.

11. **Validation pass**
    - Run relevant checks for touched package(s):
      - `pnpm test --filter @percussionist/web` (or repo-standard test command subset)
      - optionally `pnpm typecheck` if change surface expands.

## Risks / open questions

1. **Ambiguity of duplicate titles**
   - Multiple tasks can share `spec.title`; pure-title display may confuse users.
   - Mitigation: append short ID or keep full ID in tooltip.

2. **API shape evolution**
   - Adding display fields to `Task` objects in board response is safe but should remain optional and non-breaking.

3. **Where to format blocked reason**
   - If blocked reason is meant to be machine-readable in future, embedding prose in `status.blockedReason` may be limiting.
   - Current path is acceptable because this route already overlays blocked reason for UI.

4. **Reference existence drift**
   - Deleted/missing predecessor or parent tasks will occur; fallback-to-ID behavior must be explicit.

## Acceptance criteria

- In board task rows, `from:` displays human-friendly task names (title-first) instead of raw IDs when resolvable.
- Blocked cards show `Waiting for:` with human-friendly task names when resolvable.
- Child task list in detail panel shows friendly labels while still opening the correct child task by ID.
- All updated displays fall back cleanly to original IDs when referenced task metadata is unavailable.
- Existing orchestration behavior (predecessor checks, parent linkage, URLs/query params) remains unchanged.
- Tests cover happy path + fallback path for reference display resolution.

## Proposed BUILD task breakdown

1. **BUILD A — Server-side board display-ref enrichment**
   - Implement lookup helpers + blocked reason formatting + additive response fields in `board.ts`.
   - Add server tests for payload shaping and fallback behavior.

2. **BUILD B — Board UI consumption of display refs**
   - Update `TaskRow.tsx` and `TaskDetailPanel.tsx` to render friendly labels with tooltips/fallbacks.
   - Update/extend UI tests if present.

3. **BUILD C — Chat context + type plumbing + polish**
   - Extend `Task` type in `lib/types.ts`, update `AgentChatPanel.tsx`, and run final type/test verification.
   - Handle any final truncation/UX polish discovered during implementation.
