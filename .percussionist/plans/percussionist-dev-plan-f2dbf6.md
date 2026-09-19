# Plan: Run page redesign — tabbed, viewport-constrained

## Context

`RunDetail` (`packages/web/src/client/components/RunDetail.tsx`, 466 lines) is the
route at `/runs/:name` (`App.tsx` line 64). It currently renders as a single
vertically-stacked page: back link → header → error banner → info grid (Status /
Spec cards) → Task card → Conditions table → Review verdict → Session card →
Terminal card → Logs card. The parent layout
(`Layout.tsx` line 58) wraps the route in `<div className="flex-1 min-w-0
overflow-y-auto p-6">`, so the whole page grows unbounded and the user scrolls
through everything — session transcript, 600px logs terminal, and metadata — in
one endless column.

The rest of the dashboard already has a full-height pattern we should match:
- `BoardView.tsx` line 162: `<div className="-m-6 flex flex-col" style={{ height: 'calc(100svh - 3.5rem)' }}>` — pulls out of the parent `p-6` padding and pins to `100svh` minus the 3.5rem (`h-14`) header.
- `ActivityPage.tsx` line 293 uses the identical idiom.
- `TaskDetailPanel.tsx` (lines 1401–1445) has a tab bar with `activeTab` state and `overflow-y-auto` content, and `TaskRunsPanel.tsx` (lines 116–178) has a sub-tab bar for Session / Logs / Terminal.

There is a ready-made `Tabs` primitive at `packages/web/src/client/components/ui/tabs.tsx`
(`Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`; controlled or uncontrolled;
ARIA `role="tab"`/`tabpanel`; arrow-key navigation). It is currently used only by
`CreateProjectForm.tsx`. `TabsContent` returns `null` when inactive — meaning
inactive tab panels unmount, which is important for the xterm/WS-heavy children
below.

The heavy children on this page are:
- `SessionView` — polls/paginates the session; `useSession`.
- `LogViewer` — an xterm.js terminal in a fixed `height: 600px` box (`LogViewer.tsx` line 333), auto-refreshing.
- `TerminalTab` — an xterm.js terminal + WebSocket attach in a fixed `height: 600px` box (`TerminalTab.tsx` line 296), connected while the run is active.

All three create their own xterm instances / network connections. Keeping all of
them mounted simultaneously (as today) means a live WS attach and two terminals
all running at once.

### Why this matters

The task is explicitly "make run page tabbed and contain element in 100vh …
ground work for managing more interactive runs through the page." The intent is:
1. A fixed-height, no-page-scroll shell.
2. A tab bar so the user chooses Session vs Logs vs Terminal vs Overview rather than scrolling.
3. A structure that later tabs (diff, plan artifact, interactive controls) can slot into.

## Scope boundaries

### In scope
- Restructure `RunDetail.tsx` into a full-height, tabbed layout matching the
  `BoardView`/`ActivityPage` `100svh` idiom.
- Tabs: **Overview**, **Session**, **Logs**, and conditionally **Terminal**.
- Move the existing content into tab panels without changing what data is shown
  in each (Status/Spec/Task/Conditions/Review verdict → Overview).
- Gate the Terminal tab exactly as the current inline section does (active run,
  pod Running, engine not `claude`) and keep the claude explanation visible.
- Keep header actions (Copy, Cancel/Delete, TokenCounter, StatusBadge, refresh
  indicator) and the failed-run error banner accessible in the fixed shell.
- Preserve deep-linkable tab state via a `?tab=` search param (so the board's
  `TaskRunsPanel` / future links can target a tab) and default sanely per run state.
- Update the existing `run-detail-terminal.test.tsx` so it still asserts the
  engine gating under the new structure, and add a focused tab-behavior test.

### Out of scope
- Any server/API/CRD/schema change. This is purely `packages/web` client UI.
- Rewriting `SessionView`, `LogViewer`, or `TerminalTab` internals (e.g. making
  their heights responsive) — see "Risks" for a small, contained exception.
- `SessionDetail.tsx` (the `/sessions/:name` archived-session page). It has a
  similar stacked shape but is a different route with different data semantics;
  changing it is not required by this task.
- `TaskRunsPanel.tsx` sub-tabs (already tabbed and scoped).
- `docs/dashboard.md` prose/screenshot refresh (optional follow-up, not required).

## Assumptions

1. "100vh" is satisfied by the established `calc(100svh - 3.5rem)` idiom used by
   `BoardView`/`ActivityPage`; `svh` is preferred over `vh` for mobile browser
   chrome. No new global CSS is needed.
2. Four tabs is the right granularity. "Overview" absorbs Status, Spec, Task,
   Conditions, and Review verdict; the terminal/log/session stay as peer tabs.
3. Terminal remains conditional (not always present) — the existing engine and
   pod-running gates are correct and tested, and must not regress.
4. The tab choice should survive a refresh and be linkable; `?tab=` is the
   lightest mechanism and matches the board's use of `useSearchParams` for
   `?task=`.
5. The mobile experience is "tabs are horizontally scrollable, panels fill
   remaining height" — not a separate mobile layout.
6. Inactive tab panels must not keep xterm instances / WS attaches mounted;
   `TabsContent`'s unmount-on-inactive behavior is acceptable and desirable.

## Approach

### 1. Shell
Replace the outer `space-y-6` wrapper with the full-height idiom:

```tsx
<div className="-m-6 flex flex-col" style={{ height: 'calc(100svh - 3.5rem)' }}>
```

Structure (all children `shrink-0` except the tab panel region):

```
[ color strip / accent? ]            (optional — see open question 1)
Header row (name, badge, tokens, actions)   shrink-0
Failed-run error banner (conditional)       shrink-0
Tab bar (scrollable horizontally)           shrink-0
Tab panel region  flex-1 min-h-0            ← owns scrolling
```

Only the tab-panel region scrolls; the page itself never does. The `-m-6`
cancels the parent's `p-6`, and `3.5rem` matches the `h-14` header in
`Layout.tsx`.

### 2. Tabs
Use the existing `ui/tabs.tsx` primitive with controlled state derived from the
`?tab=` search param:

```tsx
type RunTab = 'overview' | 'session' | 'logs' | 'terminal';
const [searchParams, setSearchParams] = useSearchParams();
const requested = searchParams.get('tab') as RunTab | null;
```

Compute `availableTabs` from run state (mirroring `TaskDetailPanel.tsx`
lines 1086–1095) and clamp the active tab to a valid one when the requested tab
is unavailable (e.g. Terminal requested but the run just completed) — same
"reset to a safe default" pattern as `TaskDetailPanel` line 1095 and
`SelectedRunTabs`' `useEffect` fallback in `TaskRunsPanel.tsx` lines 126–128.

Tab order: **Overview → Session → Logs → Terminal**. Default: `session` for an
active run with a session, else `overview` (see open question 2).

Each `TabsContent` gets `className="flex-1 min-h-0 overflow-y-auto"` (or a
wrapper with those classes) so its content scrolls internally.

### 3. Content mapping
- **Overview** — the existing info grid, Task card, Conditions table, and
  ReviewVerdictCard, wrapped in a padded scroll container (`p-4`/`space-y-4`).
- **Session** — the existing `SessionView`, wrapped so it fills and scrolls.
- **Logs** — the existing `LogViewer`. Its terminal box is hardcoded to
  `height: 600px`; inside a fixed-height tab this will be tall but still
  scrollable. Make it fill available height *only if* trivial (see Risks #2);
  otherwise leave as-is and accept internal scroll. Do not change LogViewer
  behavior for other consumers.
- **Terminal** — the existing `TerminalTab` / claude explanation, gated
  identically to today (`isActive && podName && podPhase === 'Running'`).

### 4. State ownership
Keep all hooks in `RunDetail` (`useRun`, `useRunEvents`, delete mutation) as-is.
Because `TabsContent` unmounts inactive panels, `TerminalTab` will only open its
WebSocket while the Terminal tab is selected — a behavior improvement, but it
also means the existing `run-detail-terminal.test.tsx` render flow must select
the tab before asserting.

## Tasks

1. **Extract the existing Overview content into a `RunOverview` sub-component**
   in `RunDetail.tsx` (Status card, Spec card, Task card, Conditions table,
   `ReviewVerdictCard`). Pure move, no markup/behavior change. Keep `Field`,
   `formatTime`, `duration`, `DetailSkeleton`, `reviewVerdict`,
   `ReviewVerdictCard` where they are.

2. **Add tab state + `availableTabs` derivation** in `RunDetail`:
   define `type RunTab`, read `?tab=` via `useSearchParams`, build the available
   list from `isActive`/`podPhase`/`run.spec.engine`, and clamp invalid/absent
   values to the default.

3. **Replace the outer wrapper** with `-m-6 flex flex-col` +
   `height: calc(100svh - 3.5rem)`; make the header row and error banner
   `shrink-0`.

4. **Insert the `Tabs` / `TabsList` / `TabsTrigger` bar** between the error
   banner and the panel region. Give `TabsList` `w-max min-w-max` and wrap it in
   `overflow-x-auto` (the primitive documents this requirement at
   `tabs.tsx` lines 75–80) so narrow viewports scroll rather than clip.

5. **Render `TabsContent` panels** for overview/session/logs/terminal with
   `flex-1 min-h-0 overflow-y-auto`; move `SessionView`, `LogViewer`,
   `TerminalTab` into their respective panels; preserve the claude-engine
   explanation text verbatim (the existing test matches
   `/Interactive attach is not available/`).

6. **Tab-switch handler** that writes `?tab=` via `setSearchParams` (using
   `{ replace: true }` when only the tab changes, so the back button does not
   fill with tab toggles — matches `BoardView.handleSheetClose`).

7. **Reset the tab when it becomes unavailable**: a small `useEffect` that, when
   the active tab is `terminal` and the run is no longer attachable (or
   `session` when no session exists), falls back to `overview` — mirroring
   `TaskRunsPanel.tsx` lines 126–128.

8. **Loading/error states** (`DetailSkeleton`, error card) keep the full-height
   wrapper so the shell does not jump between states; the skeleton can stay as
   the existing grid inside a scroll container.

9. **Update `packages/web/tests/run-detail-terminal.test.tsx`**: after
   `renderRunDetail()`, click the Terminal tab (`fireEvent.click` on
   `screen.getByRole('tab', { name: 'Terminal' })`) before asserting the
   `terminal-tab` testid; keep the three engine-gating cases and the
   absence-explanation case. Note the existing test's warning about
   `--isolate` and `mock.module` ordering (`AGENTS.md`) — keep mocks above the
   SUT import.

10. **Add `packages/web/tests/run-detail-tabs.test.tsx`**: a focused test that
    (a) defaults to the expected tab, (b) switching to Logs renders the mocked
    `LogViewer` and hides Session, (c) the Terminal tab is absent for a
    non-running/terminal-phase run, (d) `?tab=logs` deep link selects Logs on
    first render, (e) an unavailable `?tab=terminal` clamps to the fallback.
    Mock `useRun`, `useRunEvents`, and the heavy children exactly as the
    existing run-detail test does.

11. **Run `pnpm --filter @percussionist/web typecheck` and
    `pnpm --filter @percussionist/web test`**; then `pnpm lint`. Fix any Biome
    formatting complaints (the repo's pre-commit gate enforces both).

12. **Manual/visual verification** (documented in the BUILD task, not automated):
    on desktop and a narrow viewport, confirm the page itself does not scroll,
    the tab bar scrolls horizontally when needed, each panel scrolls internally,
    the terminal connects only when its tab is open, and the failed-run banner
    remains visible above the tabs.

## Acceptance criteria

1. Navigating to `/runs/:name` yields a page whose outer container is exactly
   `calc(100svh - 3.5rem)` tall with no document-level vertical scroll.
2. The page presents a tab bar; the body is organized into tabs and only the
   active panel scrolls.
3. Overview tab shows the same Status / Spec / Task / Conditions / Review
   verdict content as today (no field dropped).
4. Session tab shows the session conversation; Logs tab shows the log terminal.
5. Terminal tab is present only for an active opencode-engine run whose pod is
   `Running`; a claude-engine run shows the existing explanation; a terminal-phase
   run shows no Terminal tab.
6. `?tab=<id>` selects a tab on load; an unavailable value falls back to a valid
   tab without a crash.
7. Header actions (Copy, Cancel/Delete with confirm, TokenCounter, StatusBadge,
   refreshing indicator) and the failed-run error banner still render and work.
8. `pnpm typecheck`, `pnpm lint`, and `pnpm test` pass; the updated and new web
   tests pass under `bun test --isolate`.
9. No change to any non-web package.

## Proposed BUILD task breakdown

This is a single-file UI refactor plus tests; it is small enough for one BUILD
task, but two independent tasks give a cleaner review boundary.

1. **BUILD A — RunDetail full-height tabbed shell** (primary)
   - Extract `RunOverview`; add tab state + `?tab=` param; replace the outer
     wrapper with the `100svh` idiom; add the tab bar and the four panels;
     move `SessionView`/`LogViewer`/`TerminalTab` into panels with identical
     gating; add the unavailable-tab reset effect.
   - Deliverable: `packages/web/src/client/components/RunDetail.tsx`.
   - Acceptance: criteria 1–7; typecheck + lint clean.

2. **BUILD B — tests for the tabbed run page**
   - Update `run-detail-terminal.test.tsx` for the tab-selection flow; add
     `run-detail-tabs.test.tsx` covering default/deep-link/clamp/panel-swap.
   - Deliverable: `packages/web/tests/run-detail-terminal.test.tsx`,
     `packages/web/tests/run-detail-tabs.test.tsx`.
   - Depends on BUILD A (predecessorRef) so the tab testids/roles exist.
   - Acceptance: criterion 8.

> If the facilitator prefers one task, merge A+B; the test file additions are
> the only ordering constraint.

## Risks / open questions

1. **`TabsContent` unmounts inactive panels.** This is what we want for
   xterm/WS, but it means `SessionView`'s scroll position and `LogViewer`'s
   accumulated terminal buffer are lost on every tab switch. Today they persist
   (all mounted). If preserving scroll/buffer matters, wrap panels in a
   `hidden`-when-inactive div instead of `TabsContent` (the `TaskDetailPanel`
   plan/diff tabs use exactly this `className={active ? '' : 'hidden'}`
   pattern at lines 1436–1444) — but then the terminal WS stays connected while
   hidden. **Recommendation:** use unmount (`TabsContent`) for Terminal only,
   or accept the reset. Confirm with reviewer; call it out in the BUILD task.

2. **Fixed 600px heights in `LogViewer`/`TerminalTab`.** Inside a shorter
   viewport the 600px box overflows and scrolls; inside a tall one it wastes
   space. The clean fix is a `height: '100%'`/`min-h-[400px]` variant, but both
   components are shared with `TaskRunsPanel`. Options: (a) leave as-is (safe,
   no shared-component risk); (b) add an optional `fillHeight?: boolean` prop
   that defaults to today's 600px. **Recommendation:** (a) for this task; file a
   follow-up if the fixed height looks wrong after the shell lands. Do not
   change the shared default.

3. **Deep-link default.** Choosing `session` vs `overview` as the default when
   `?tab=` is absent changes what the user sees on arrival. `overview` is the
   more conservative default and matches `TaskDetailPanel`; `session` is more
   useful for an active run. **Recommendation:** `session` when the run is
   active and has a session, else `overview`. Confirm.

4. **`svh` support.** The repo already relies on `100svh` in `BoardView` and
   `ActivityPage`, so this is consistent, but very old browsers would fall back
   to no height. Not a new risk; no action.

5. **Accent color strip.** `BoardView` has a project color strip at the top. The
   run CR carries `spec.project`, so a matching strip is possible, but it
   requires a project fetch or color lookup. **Recommendation:** skip it in this
   task (not requested) — note as a follow-up.

6. **Docs/screenshot drift.** `docs/dashboard.md` line 37 embeds
   `/images/run-detail.png` and describes the single-page view. The image and
   prose become stale. **Recommendation:** optional follow-up BUILD; out of
   scope here.
