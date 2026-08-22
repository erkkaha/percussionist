# Plan: Expandable Board Task Detail View (focus mode)

## Context

`BoardView` (`packages/web/src/client/components/BoardView.tsx`) is the kanban-style board for a
project. It renders two main regions on desktop (`md:` = ≥768px, per `useIsMobile` in
`packages/web/src/client/hooks/use-mobile.tsx`):

- **Task list** (`TaskListPanel`) — `w-full`, and when a task is selected it becomes
  `md:w-2/5 md:border-r` (a fixed 40% column).
- **Task detail** (`TaskDetailPanel`) — `hidden md:flex flex-1` (the remaining 60%), including the
  **Diff** tab (`DiffContent` → `FileDiff`) and the **review findings** summary. This is where users
  review diffs and inline findings.
- An optional **Findings panel** (`FindingsPanel`) at `w-80` on the far right when toggled.

On mobile (`<768px`) the detail is rendered inside a Radix **Sheet** (`SheetContent side="right"`)
with className `w-full sm:max-w-lg` — i.e. capped at **512px** wide on `sm:` (≥640px) viewports.

### The problem
On a **foldable phone** the detail/diff view is cramped:

- When unfolded the viewport is often >640px, so the mobile Sheet hits its `sm:max-w-lg` (512px) cap
  and leaves the rest of the screen empty — the diff still only uses ~512px and lines wrap/scroll.
- When folded (<640px, or generally narrow) the 60/40 desktop split and the Sheet cap make the diff
  and finding comments very tight to read.

The request: either make the detail view **extendable** (full-screen / full-bleed) or make the task
list **collapsible**, so the diff + findings get as much room as possible.

### Key existing code
- `BoardView.tsx` L187-218 — body flex layout (list / detail / findings).
- `BoardView.tsx` L222-252 — mobile detail Sheet (`w-full sm:max-w-lg`).
- `TaskDetailPanel.tsx` L1091-1424 — `TaskDetailPanelInner` render; root at L1092 has
  `border-l border-border`. Header action row at L1146. `memo` comparison at L1426-1435.
- `FileDiff.tsx` — already has per-file expand + unified/split toggle; the tightness is the *container*
  width, not FileDiff itself.

## Approach

Introduce a single **"focus mode"** toggle on the Task Detail panel. One control satisfies both
requested options from a coherent UI-structure standpoint:

- **Desktop:** entering focus mode **collapses the task list** column, so the detail panel (Diff +
  findings) expands to full width.
- **Mobile (foldable):** entering focus mode makes the detail **Sheet full-bleed** (removes the
  `sm:max-w-lg` cap) so the diff uses the entire unfolded screen.

State lives in `BoardView` (`detailFocused`) and is passed down to `TaskDetailPanel` as
`focused` + `onToggleFocus`. The toggle button is rendered in the detail header. This keeps the
list/detail layout logic in `BoardView` (where it belongs) while the affordance lives in the panel
the user is already looking at while reviewing a diff.

This is preferred over a separate "collapse list" button because it is contextual (you collapse the
list *because* you want to read the diff), and it unifies desktop + mobile with one mental model.

## Tasks

### 1. Add focus toggle to `TaskDetailPanel`
- Add an `Expand` / `Collapse` icon button to the header action row
  (`TaskDetailPanelInner`, around `BoardView.tsx` L1146). Use `lucide-react`
  `Maximize2` / `Minimize2` (consistent with the `Expand timeline` usage in `SessionTimeline.tsx`).
- Add props to `TaskDetailPanelProps` (L103-111): `focused: boolean` and
  `onToggleFocus: () => void`.
- Render `Maximize2` when `!focused`, `Minimize2` when `focused`; `title`/`aria-label` =
  "Expand to full width" / "Collapse task list".
- On click, call `onToggleFocus()`.
- Whenever `focused` is true (desktop), the root `div` at L1092 should drop the `border-l border-border`
  so there is no orphan left border when the list is hidden: use
  `border-l border-border ${focused ? 'md:border-l-0' : ''}` (or conditionally drop it).
- Update the `memo` comparison (L1426-1435) to also compare `focused` and `onToggleFocus` so the
  panel re-renders on toggle.

### 2. Wire focus state in `BoardView`
- Add `const [detailFocused, setDetailFocused] = useState(false);`.
- Pass `focused={detailFocused}` and
  `onToggleFocus={() => setDetailFocused((f) => !f)}` into the `TaskDetailPanel` used for
  `detailPanel` (L139).
- **Desktop list collapse:** in the list container (L189-191) add `md:hidden` when
  `selectedTask && detailFocused`:
  ```tsx
  className={`flex flex-col min-h-0 w-full ${selectedTask ? 'md:w-2/5 md:border-r md:border-border' : ''} ${selectedTask && detailFocused ? 'md:hidden' : ''}`}
  ```
  The detail container (`hidden md:flex flex-1`, L208) already fills the freed space.
- **Mobile sheet full-bleed:** in the mobile detail `SheetContent` (L223-225), switch width class
  based on focus:
  ```tsx
  className={`md:hidden w-full ${detailFocused ? 'max-w-none sm:max-w-none' : 'sm:max-w-lg'} p-0 flex flex-col overflow-hidden bg-surface text-text border-border [&>button]:z-10`}
  ```
  (The `side="right"` + `inset-y-0` already gives full height; only the width cap changes.)
- **Reset on deselect:** set `setDetailFocused(false)` inside `onDeleted` (L146-149) and in
  `handleSheetClose` (L105-108) so the next selection starts un-collapsed. Also clear it in
  `handleSelectTask` is unnecessary (keeps preference while switching tasks) — leave as-is, but reset
  on close/deselect.

### 3. (Optional, low priority) Persist focus preference
- Store `detailFocused` in `localStorage` (key e.g. `percussionist.board.detailFocused`) so the
  choice survives navigation/remount within a session. Keep it simple; out of MVP scope unless
  reviewers want it. Skippable.

### 4. Tests + acceptance
- Add component tests (see Risks for the `--isolate` / global-mock caveats from
  `AGENTS.md` and `board-view.test.tsx`):
  - `TaskDetailPanel`: render with a minimal `BUILD` task + `onToggleFocus` mock; assert the
    `Maximize2` button is present and clicking it calls `onToggleFocus` once. (Mock `useTaskRuns` /
    `useTaskDiff` / `fetchPlan` so the overview tab renders without network.)
  - `BoardView` focus layout: render with a selected task; assert the list wrapper container carries
    `md:hidden` only when focus is on; assert the mobile `SheetContent` className contains
    `max-w-none` when focus is on and `sm:max-w-lg` when off. Use `bun test --isolate` (already the
    web default) so module mocks don't leak across files.
- Manual acceptance checklist:
  - Desktop ≥768px: open a task with a diff, click Expand → task list disappears, Diff tab uses full
    width; click again → list returns.
  - Foldable unfolded (>640px): open task, click Expand → Sheet goes edge-to-edge (no 512px cap).
  - Foldable folded / narrow: diff readable; toggle works.
  - Findings panel still toggleable on desktop and does not break focus mode.
  - No regressions in existing `board-view.test.tsx`, `task-detail-*.test.tsx`.

## Risks / open questions

- **Global module mocks (`mock.module` is process-global).** `AGENTS.md` and `board-view.test.tsx`
  document that `bun test --isolate` is required so stubs don't leak. New tests must run under
  `--isolate` and must not stub a module that is the subject of another suite (e.g. keep
  `TaskDetailPanel` real in the BoardView focus test, or stub it consistently). Follow the existing
  pattern in `board-view.test.tsx` (it stubs `TaskDetailPanel`/`TaskListPanel`/`Sheet` safely).
- **Findings panel interaction in focus mode.** On desktop, opening Findings (`w-80`) while focused
  shrinks the detail slightly. This is acceptable (explicit user action). If reviewers want findings
  to also hide in focus mode, that is a tiny follow-up (gate the `showFindings` block on
  `!detailFocused`). Left out of MVP to limit scope.
- **Radix Sheet portal in jsdom.** When asserting the mobile `SheetContent` className, the Sheet is
  mocked as a plain `div` in `board-view.test.tsx`; a focus-specific test that needs the real class
  should either mock `Sheet`/`SheetContent` as passthrough divs (forwarding `className`) or assert via
  a `data-testid` wrapper. Keep the assertion on forwarded className.
- **State reset edge cases.** Focus should reset when the task is deselected/closed; it intentionally
  persists across task switches (so reviewing several diffs stays expanded). Confirm this matches UX
  expectation.
- **`useIsMobile` asymmetry.** `md:` (768px) is the breakpoint used by BoardView's `hidden md:flex`;
  the Sheet is `sm:` (640px). The focus toggle behaves correctly in both because it toggles the
  *same* `detailFocused` state and each breakpoint reacts to its own class — no new breakpoint logic
  needed.

## Acceptance criteria

1. A single expand/collapse control exists in the Task Detail header.
2. Desktop: enabling it hides the task list so the detail (incl. Diff + findings) uses full board width;
   disabling restores the list.
3. Mobile / foldable: enabling it removes the `sm:max-w-lg` cap so the detail Sheet is full-bleed on
   unfolded screens.
4. Focus resets when the task is closed/deselected.
5. Existing board/detail unit tests still pass under `pnpm test` (`bun test --isolate`).

## Proposed BUILD task breakdown

- **BUILD-1 (web/ui):** Add focus toggle button + `focused`/`onToggleFocus` props + memo update to
  `TaskDetailPanel`. (Depends on nothing.)
- **BUILD-2 (web/ui):** Wire `detailFocused` state in `BoardView` — desktop list `md:hidden`, mobile
  Sheet full-bleed, reset on deselect. (Depends on BUILD-1 for prop shape; can ship in the same PR.)
- **BUILD-3 (web/test):** Add focus-mode component tests for `TaskDetailPanel` and `BoardView` layout,
  following the `--isolate` + passthrough-Sheet mocking conventions; add manual acceptance checklist.
