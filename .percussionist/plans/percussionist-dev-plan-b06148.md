# Plan: Findings panel super narrow when no task selected

Task: `percussionist-dev-plan-b06148` — project `percussionist-dev`

## Context

The board's desktop layout lives in `packages/web/src/client/components/BoardView.tsx`.
The body is a single flex row (line 194, `flex flex-1 min-h-0`) with three children:

1. **Task list wrapper** (lines 196–212): `flex flex-col min-h-0 w-full …`, plus
   `md:w-2/5 md:border-r` only when a task is selected.
2. **Desktop detail wrapper** (lines 214–217): `hidden md:flex flex-col flex-1 min-h-0`,
   rendering `detailPanel ?? <TaskDetailEmpty />`.
3. **Desktop findings wrapper** (lines 219–224), rendered only when `showFindings`:
   `hidden md:flex flex-col w-80 border-l border-border bg-surface overflow-hidden`.

`FindingsPanel` itself (`packages/web/src/client/components/board/FindingsPanel.tsx`)
already handles internal truncation and scrolling, so the narrow-panel symptom is a
BoardView layout problem, not a panel-content problem.

There is already a full BoardView harness in
`packages/web/tests/board-view-focus.test.tsx` (real `BoardView`, real `BoardHeader`,
stubbed `FindingsPanel`/`TaskListPanel`/`Sheet`, `data-testid="task-list-panel"` on the
list panel) that is a good host for the regression tests.

## Root cause

The findings wrapper is the **only shrinkable** flex item in the row:

- It has `overflow-hidden`, so its automatic minimum size (`min-width: auto`) resolves
  to `0` — flexbox is free to shrink it to nothing.
- The task-list wrapper has `w-full` (flex-basis = 100%). When no task is selected it
  claims the entire row width.
- The detail wrapper is `flex-1` (basis `0`) but contains `TaskDetailEmpty`
  (`p-8` + centered text), whose content-based `min-width` clamps the wrapper to the
  placeholder's min-content width instead of collapsing to zero.

With no task selected, the row is over-subscribed by (task list 100% + empty-detail
min-content + findings `w-80`). The negative free space is distributed by scaled
shrink factors; the empty detail wrapper's scaled factor is `0` (basis `0`), and the
findings panel's min-width is `0`, so the findings panel absorbs nearly the whole
deficit and collapses well below the intended `20rem` (320px). When a task *is*
selected the bases (40% + 0 + 320px) fit, which is why the bug only reproduces with no
task selected.

## Approach

1. **Pin the findings panel** to its designed width by adding `shrink-0` to the
   desktop findings wrapper. `w-80 shrink-0` makes it a fixed side panel.
2. **Let the task list yield** by adding `min-w-0` to the task-list wrapper, so it
   shrinks below its content's min-content and its internal column scrolls, instead of
   forcing overflow or squeezing the findings panel.
3. **Remove the competing placeholder**. When no task is selected and the findings
   panel is open, the empty "Select a task to view details" wrapper should not be
   rendered at all — it exists to fill the right-hand region when there is nothing else
   to show, and the findings panel now occupies that region. Render the detail wrapper
   only when `selectedTask` is set **or** the findings panel is closed. Behaviour with
   a task selected (detail + optional findings side-by-side) and with findings closed
   (empty placeholder visible) is unchanged.
4. **Add stable test hooks** (`data-testid`) and a class-level regression test, in the
   style already used by `board-view.test.tsx` / `board-view-focus.test.tsx`.

This is a presentation-only change; no API, CRD, manager, or backend code is touched,
and the mobile path (findings/detail rendered in `<Sheet>`) is unaffected.

## Tasks (proposed BUILD breakdown)

The change is small and cohesive; a **single BUILD task** on the `builder` agent is
appropriate (the project roster only has `planner` and `builder`). If the orchestrator
prefers, it can be split into "implement" and "add regression test", but the test is
cheap and tightly coupled to the markup, so one task is recommended.

### BUILD task — Fix BoardView findings panel width and add regression test

**File: `packages/web/src/client/components/BoardView.tsx`**

1. **Give the task-list wrapper `min-w-0`.** Change line 197 from:

   ```tsx
   className={`flex flex-col min-h-0 w-full ${selectedTask ? 'md:w-2/5 md:border-r md:border-border' : ''} ${selectedTask && detailFocused ? 'md:hidden' : ''}`}
   ```

   to add `min-w-0` to the base utilities:

   ```tsx
   className={`flex flex-col min-h-0 min-w-0 w-full ${selectedTask ? 'md:w-2/5 md:border-r md:border-border' : ''} ${selectedTask && detailFocused ? 'md:hidden' : ''}`}
   ```

   (Do not remove `w-full`: it is what makes the list full width on mobile and, on
   desktop with no findings, in the no-selection case. `min-w-0` only allows it to
   shrink when the findings panel is present.)

2. **Conditionally render the desktop detail wrapper** (lines 214–217). Replace:

   ```tsx
   {/* Desktop detail panel — hidden on mobile */}
   <div className="hidden md:flex flex-col flex-1 min-h-0">
     {detailPanel ?? <TaskDetailEmpty />}
   </div>
   ```

   with:

   ```tsx
   {/* Desktop detail panel — hidden on mobile. When no task is selected and the
       findings panel is open, the findings panel owns the right-hand region so the
       empty detail placeholder does not compete with it for width. */}
   {(!showFindings || selectedTask) && (
     <div
       data-testid="desktop-detail-panel"
       className="hidden md:flex flex-col flex-1 min-h-0"
     >
       {detailPanel ?? <TaskDetailEmpty />}
     </div>
   )}
   ```

   Note the mobile detail Sheet (line ~235) still uses `detailPanel ?? <TaskDetailEmpty />`
   independently and must not be changed.

3. **Pin the findings wrapper and tag it for tests** (lines 219–224). Add `shrink-0`
   and `data-testid`:

   ```tsx
   {/* Desktop findings panel — fixed-width side panel shown when toggled */}
   {showFindings && (
     <div
       data-testid="desktop-findings-panel"
       className="hidden md:flex flex-col w-80 shrink-0 border-l border-border bg-surface overflow-hidden"
     >
       <FindingsPanel findings={status.findings ?? []} projectName={projectName} />
     </div>
   )}
   ```

**File: `packages/web/tests/board-view-focus.test.tsx`** (extend — do not duplicate the
harness)

4. Generalise the render helper so the board can be rendered without a selected task.
   Add an optional parameter, e.g.:

   ```tsx
   async function renderBoard(opts: { taskName?: string } = {}) {
     const { default: BoardView } = await import('../src/client/components/BoardView');
     const { MemoryRouter, Route, Routes } = await import('react-router-dom');
     const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
     const path = opts.taskName
       ? `/projects/test-project/board?task=${opts.taskName}`
       : '/projects/test-project/board';
     return render(/* … existing MemoryRouter/QueryClientProvider/Routes tree … */);
   }
   ```

   Keep `renderBoardWithSelection()` as a thin wrapper (or update its call sites) so the
   existing focus-mode tests keep passing unchanged.

5. Add a `describe('BoardView findings panel layout', …)` block with these cases:

   - **No task selected, findings open:** render with no `?task=`, click the header
     Findings button (`screen.findByRole('button', { name: /Findings/ })`), then:
     - `screen.getByTestId('desktop-findings-panel').className` contains `w-80` and
       `shrink-0`;
     - the task-list wrapper (`screen.getByTestId('task-list-panel').parentElement`)
       contains `min-w-0`;
     - `screen.queryByTestId('desktop-detail-panel')` is `null` (the empty placeholder
       is not competing for width).
   - **No task selected, findings closed (baseline):**
     `screen.getByTestId('desktop-detail-panel')` exists.
   - **Task selected, findings open:** render with `?task=`, click Findings, and assert
     both `desktop-detail-panel` and `desktop-findings-panel` are present (findings is
     an additional fixed side column, not a replacement for the detail panel).

   The `sheet` mock already forwards nothing that matters, and `FindingsPanel` is
   already stubbed, so no new module mocks are needed. Tests assert only on class
   names / testid presence — never on rendered pixel widths — consistent with the
   existing layout suites.

6. **Verify** (in the run pod):
   - `cd packages/web && bun test --isolate --preload ./tests/setup.ts tests/board-view-focus.test.tsx tests/board-view.test.tsx` (fast loop)
   - `cd packages/web && bun test --isolate --preload ./tests/setup.ts tests/` (full web suite; `--isolate` is required — see `AGENTS.md`)
   - `pnpm typecheck`
   - `pnpm lint`
   - Manual sanity check via `pnpm web` / `pnpm web:client` on a project board: toggle
     Findings with no task selected and confirm the panel is ~320px and the task list
     takes the remaining width; select a task and confirm detail + findings coexist.

7. **Commit** with a Conventional Commit message, e.g.
   `fix(web): keep findings panel width when no task is selected`.

## Acceptance criteria

- With no task selected and the Findings panel toggled open on desktop, the panel
  renders at its intended `w-80` (20rem) width and is not squeezed by the task list or
  the empty detail placeholder.
- The task list occupies the remaining width (it shrinks; the page does not overflow
  horizontally) and the empty "Select a task to view details" placeholder is not shown
  alongside the findings panel when no task is selected.
- With a task selected, the detail panel and the fixed-width findings side panel render
  side by side exactly as before.
- With findings closed, the no-selection empty state behaves as before.
- Mobile behaviour (findings/detail in `<Sheet>`) is unchanged.
- New regression test passes under `bun test --isolate`; full `pnpm test`,
  `pnpm typecheck`, and `pnpm lint` pass.

## Scope boundaries

- **In scope:** `BoardView.tsx` desktop flex layout and its regression test.
- **Out of scope:** `FindingsPanel` content/behaviour, `BoardHeader` toggle behaviour,
  mobile `<Sheet>` layout, and any server/API/CRD code. Do not restyle the board or
  change the task-list/detail widths when a task is selected.
- No new dependencies.

## Risks / open questions

- **`data-testid` additions:** purely additive and consistent with existing board
  testids (`board-color-strip`, `board-header-container`, `task-list-panel`); no
  runtime impact.
- **Narrow desktop with a task selected:** pinning findings with `shrink-0` means, at
  `md` widths (~768px) with a task *and* findings open, the task list absorbs the
  deficit and gets narrower instead of the findings panel. This is the intended
  behaviour (the findings panel is a fixed side rail; the list is the flexible
  region), but if a reviewer prefers the old graceful degradation, the alternative is
  to scope `shrink-0` to the no-task case only
  (`${selectedTask ? '' : 'shrink-0'}`) — noted here as a fallback, not the
  recommendation.
- **jsdom/happy-dom do not perform layout**, so the regression test asserts the
  *classes* that encode the fix rather than computed pixel widths. This matches the
  existing `board-view.test.tsx` / `board-view-focus.test.tsx` approach. The manual
  browser sanity check in step 6 covers the actual visual result.
- **`min-w-0` on the task list:** the inner `TaskListPanel` scroll container already
  computes `overflow-x: auto` (because `overflow-y-auto` forces the other axis to
  `auto`), so it scrolls rather than overflowing when the wrapper shrinks. If the
  FilterBar ever introduces an unshrinkable min-content width, the wrapper will still
  be able to shrink because of the explicit `min-w-0`; the inner panel handles the
  overflow.
