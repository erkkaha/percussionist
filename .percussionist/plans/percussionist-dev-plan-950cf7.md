# Plan: Board Add Task — Migrate Task Type Selector to shadcn UI

**Task:** `percussionist-dev-plan-950cf7`  
**Issue:** The **Add Task** form in the board uses native `<input type="radio">` controls for task type (`PLAN`/`BUILD`) instead of the project’s shadcn component set.

---

## Context

- The board add-task form is implemented in `packages/web/src/client/components/board/TaskListPanel.tsx` inside `AddTaskForm`.
- Task type state is tracked with:
  - `const [taskType, setTaskType] = useState<"PLAN" | "BUILD">("PLAN")`
- The current selector UI is a manual radio block (lines ~49–63) that maps over `["PLAN", "BUILD"]` and renders native `<input type="radio">` elements.
- The same form already uses shadcn components for other controls (`Select`, `Input`, `Textarea`, `Button`), so the type selector is the outlier.
- The repository already contains a shadcn-compatible radio primitive in `packages/web/src/client/components/ui/radio-group.tsx` exporting `RadioGroup` and `RadioGroupItem`.

---

## Scope Boundaries

### In scope

- Replace only the **task type selector** in `AddTaskForm` with shadcn radio-group components.
- Preserve existing behavior and payload shape for task creation (`addMutation.mutate({ type: taskType, ... })`).
- Keep the same available options (`PLAN`, `BUILD`) and default (`PLAN`).

### Out of scope

- Changes to board workflow logic, API routes, task validation, or backend schemas.
- Restyling unrelated controls (agent/priority selectors, buttons, filters, etc.).
- Broad form layout redesign beyond what is needed for consistent shadcn usage.

---

## Approach

Adopt `RadioGroup`/`RadioGroupItem` from `../ui/radio-group` for the task type field and keep state typed as `"PLAN" | "BUILD"`.

Key decisions:

1. **Use existing shadcn wrapper** (`radio-group.tsx`) instead of custom CSS or native inputs.
2. **Keep options explicit and typed** so TypeScript preserves strong typing and avoids accidental value drift.
3. **Keep interaction behavior unchanged** (single-selection PLAN vs BUILD, same default and mutation payload).
4. **Add accessible labels** tied to radio items (via `htmlFor` + `id`) so keyboard/screen-reader behavior is at least as good as current implementation.

---

## Tasks

1. **Locate and isolate the current task type selector block**
   - File: `packages/web/src/client/components/board/TaskListPanel.tsx`
   - Confirm the exact JSX block using native `<input type="radio">` in `AddTaskForm`.

2. **Import shadcn radio components**
   - Add imports from `../ui/radio-group`:
     - `RadioGroup`
     - `RadioGroupItem`

3. **Replace native radio inputs with shadcn radio group**
   - Convert the type block to a controlled `RadioGroup` with:
     - `value={taskType}`
     - `onValueChange={(v) => setTaskType(v as "PLAN" | "BUILD")}` (or typed option narrowing helper)
   - Render one `RadioGroupItem` each for `PLAN` and `BUILD` with associated text labels.

4. **Preserve semantic clarity and accessibility**
   - Ensure each item has a stable `id` and corresponding `<label htmlFor="...">`.
   - Keep visual grouping/spacing consistent with the surrounding form.

5. **Verify no behavior regressions in AddTaskForm**
   - Confirm `taskType` remains default `PLAN`.
   - Confirm selection updates UI state and is forwarded unchanged as `type` in `addMutation.mutate(...)`.
   - Confirm both “Add Task to Backlog” and “Add Task to Ideas” entry points still render and behave identically.

6. **Run targeted validation**
   - Execute type-level and/or package-level checks relevant to touched UI code (at minimum repo-standard typecheck for confidence).

---

## Risks / Open Questions

1. **Type narrowing on `onValueChange`**
   - `RadioGroup` emits `string`; careless handling could weaken typing.
   - Mitigation: use constrained option list and explicit narrowing/cast at one boundary.

2. **Styling drift risk**
   - Replacing native radios may slightly change alignment/spacing.
   - Mitigation: keep layout classes minimal and follow existing form spacing conventions.

3. **Accessibility parity**
   - If labels are not wired correctly, click targets and SR output can regress.
   - Mitigation: ensure `id`/`htmlFor` pairings and keyboard navigability are preserved.

---

## Acceptance Criteria

- The board add-task **task type selector** no longer uses native `<input type="radio">` elements.
- `AddTaskForm` uses shadcn radio components from `packages/web/src/client/components/ui/radio-group.tsx`.
- Users can still choose exactly one type (`PLAN` or `BUILD`), with default `PLAN`.
- Selected type is sent unchanged in the create-task mutation payload.
- No functional regression in either add-task entry point (header add task and ideas add task form).

---

## Proposed BUILD Task Breakdown

1. **BUILD 1 — UI migration for task type selector**
   - Update `packages/web/src/client/components/board/TaskListPanel.tsx`
   - Replace native task-type radios with shadcn `RadioGroup`/`RadioGroupItem`
   - Preserve behavior, defaults, and payload contract.

2. **BUILD 2 — Validation + polish**
   - Perform targeted typecheck/build verification for web package/repo
   - Confirm add-task flows (backlog + ideas) and accessibility labeling
   - Apply minor class adjustments only if needed for visual consistency.
