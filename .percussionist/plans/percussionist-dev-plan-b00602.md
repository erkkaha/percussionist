# Plan: board add task should be full screen on mobile

## Context

- Board page composition lives in `packages/web/src/client/components/BoardView.tsx`.
  - `showAddTask` is currently a single boolean that toggles add-task UI.
  - The selected-task detail already uses a mobile `Sheet` and desktop split-pane pattern.
- The add-task UI is currently inline in `packages/web/src/client/components/board/TaskListPanel.tsx`:
  - `AddTaskForm` is rendered inside the list column when `showAddTask` is true.
  - On small screens this appears as an in-flow card (`rounded-md ... mx-2`), not a full-screen experience.
  - The same inline pattern is used for “Add idea” in the `ideas` column via `showAddIdea`.
- Header trigger is in `packages/web/src/client/components/board/BoardHeader.tsx` (`+ Add Task` button), which currently only toggles the shared inline flag.
- Existing shared mobile overlay primitive is `Sheet` (`packages/web/src/client/components/ui/sheet.tsx`), already used on this page for task details.

## Scope boundaries

### In scope
- Make **board add task** open as a **full-screen mobile overlay** (viewport `< 768px`).
- Keep desktop behavior usable and familiar (inline form may remain desktop-only).
- Ensure create/cancel flows close mobile overlay cleanly and refresh board data.
- Cover both main Add Task entrypoint and add-from-ideas behavior, or explicitly align behavior if product decision is to only full-screen the header action.

### Out of scope
- Changing backend task creation API (`addBoardTask`) or board route contracts.
- Redesigning task form fields/validation semantics.
- Broad visual redesign of board layout beyond add-task presentation.

## Approach

Use a responsive split behavior instead of one shared inline toggle:

1. **Desktop (`md+`)**: keep inline add-task rendering in task list panel for low-friction workflow.
2. **Mobile (`< md`)**: render add-task form in a dedicated full-screen `Sheet`/overlay container (`w-screen`, `h-svh`, no max-width cap, internal scroll region).
3. Lift or separate state so mobile and desktop presentations don’t fight each other (e.g., `showAddTaskDesktop`, `showAddTaskMobile`, optionally `mobileDefaultColumn`).
4. Reuse existing `AddTaskForm` logic for mutation/validation to minimize risk; only change presentation and state wiring.

This is intentionally different from a minimal class-only tweak: it introduces explicit mobile/desktop state flow so retries won’t regress by rendering an inline form that still consumes partial height on phones.

## Acceptance criteria

1. On mobile viewport (`<768px`), tapping `+ Add Task` opens add-task UI in a full-screen overlay (no partial card inside board list).
2. Mobile add-task overlay is dismissible via explicit cancel/close control and by standard sheet close interactions.
3. Submitting add task from mobile closes the overlay and board list reflects new task after query invalidation.
4. Desktop behavior remains functional (existing inline flow preserved or intentionally replaced, with parity in create/cancel behavior).
5. No regression to task-detail mobile sheet behavior in `BoardView`.

## Tasks

1. **Refactor add-task visibility state in `BoardView.tsx`**
   - Replace single `showAddTask` toggle with responsive-aware state strategy.
   - Add handlers for open/close actions used by header and list panel.

2. **Introduce mobile full-screen add-task container in `BoardView.tsx`**
   - Reuse `Sheet` primitive with mobile-only rendering.
   - Apply full-screen classes (`w-screen`, `max-w-none`, `h-svh`, `p-0`) and a scrollable inner column.
   - Wire close behavior to clear mobile add-task state.

3. **Make `TaskListPanel` presentation-aware**
   - Add prop(s) to control whether inline add-task form is rendered.
   - Keep inline form for desktop only.
   - Ensure existing list scrolling/collapsible sections remain intact.

4. **Extract/reuse `AddTaskForm` where needed**
   - If easiest, keep `AddTaskForm` in `TaskListPanel.tsx` and expose via prop-based render path.
   - If needed for clean composition, move `AddTaskForm` to a dedicated file under `components/board/` and import from both panel and mobile sheet container.
   - Preserve current mutation contract and required-field validation.

5. **Handle mobile default column behavior**
   - Decide whether header-triggered mobile form defaults to backlog and ideas-triggered form defaults to ideas.
   - Keep the chosen behavior explicit in props/state (`defaultColumn`).

6. **Accessibility + UX checks**
   - Ensure mobile overlay has clear title, close affordance, and no trapped background interactions.
   - Confirm keyboard/focus behavior is acceptable for Radix sheet and form controls.

7. **Verification**
   - Run targeted web tests (`packages/web/tests/smoke.test.ts`) and relevant package checks.
   - Manual viewport validation in browser devtools for `<768px` and `>=768px`.

## Proposed BUILD task breakdown

1. **BUILD 1 — State and mobile container wiring**
   - Implement responsive state split in `BoardView.tsx`.
   - Add mobile full-screen sheet for Add Task and hook up header trigger.

2. **BUILD 2 — TaskListPanel integration + AddTaskForm reuse**
   - Update `TaskListPanel.tsx` props and inline render conditions.
   - Share/rehome `AddTaskForm` if needed to avoid duplication.

3. **BUILD 3 — Polish + validation**
   - Tune mobile classes and close behaviors.
   - Validate add-from-ideas behavior, run tests/checks, and confirm no board-detail regressions.

## Risks / open questions

1. **Ambiguity: scope of “board add task”**
   - It may refer only to header `+ Add Task`, or also include inline `+` in Ideas. Assumption: both should remain coherent; header is mandatory.

2. **Potential state coupling bugs**
   - If desktop and mobile share one boolean, breakpoint changes can cause stale open/closed states. The plan mitigates this with explicit responsive state.

3. **Overlay stacking interactions**
   - Board already uses a mobile detail `Sheet`; opening add-task overlay while detail sheet is active could create layered modals. Implementation should enforce single active mobile overlay path.

4. **Retry context uncertainty**
   - Previous failure details were not provided in this task payload; this plan assumes prior attempt was insufficiently structural (styling-only) and intentionally proposes a clearer responsive architecture.
