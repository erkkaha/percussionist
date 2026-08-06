# Plan: Add a Terminal tab to the active run on the board

Task: `percussionist-dev-plan-739a26`
Revision: 2 (retry 7/3) — fixes a gate data-source flaw found in revision 1.

## Context

The board (project detail page, `packages/web/src/client/components/BoardView.tsx` →
`board/TaskDetailPanel.tsx` → `board/TaskRunsPanel.tsx`) shows a selected task's runs with
per-run **Session / Logs** sub-tabs. There is currently **no way to attach an interactive
terminal to a live run from the board** — the only place a terminal exists is the standalone
run page. Terminal attach is only supported for the **opencode** engine (the attach bridge
execs `opencode attach` inside the pod; the claude engine's runner is a headless HTTP server
with no TUI).

Verified against `main` @ `bd11e7b` (current `origin/main`):

- **`packages/web/src/client/components/TerminalTab.tsx`** — a complete, reusable xterm.js
  attach widget. Props: `{ runName: string; active: boolean }`. Opens a WebSocket to
  `/api/runs/{runName}/attach`, sends stdin as binary and `{type:'resize'}` control messages,
  renders raw PTY output, and handles reconnect with exponential backoff plus a slow (15s)
  readiness retry for "pod not yet created / must be running / container not ready" errors.
  Currently imported **only** by `RunDetail.tsx` (the `/runs/:name` page).
  `@xterm/xterm@6.0.0` + `@xterm/addon-fit@0.11.0` are already dependencies of `packages/web`
  — no new deps needed.
- **`packages/web/src/server/attach-ws.ts`** — the server-side WebSocket bridge. It `exec`s
  **`opencode attach http://127.0.0.1:4096`** in the `runner` container (`attach-ws.ts:436`),
  so the terminal is **only meaningful for the opencode engine**. It guards: terminal-phase
  run → 410 (`run is Succeeded; pod is gone`), pod not `Running` → 400, `runner` container not
  ready → 400 (via `resolveAttachTarget`). The upgrade route is registered in
  `packages/web/src/server/index.ts` (`/api/runs/:name/attach`, WS-intercepted at
  `index.ts:140-150`).
- **`packages/web/src/client/components/RunDetail.tsx:311-333`** — the reference pattern for
  terminal gating: the Terminal card renders only when the run is active
  (`!TERMINAL_PHASES.has(phase)`), has `status.podName`, and `status.podPhase === 'Running'`
  (line 316); for `run.spec.engine === 'claude'` it renders an explanatory message instead of
  the terminal ("Interactive attach is not available for the claude engine — its runner is a
  headless server with no terminal session…"), rather than silently dropping the section
  (lines 322-327).
- **`packages/web/src/client/components/board/TaskRunsPanel.tsx`** — the target. `SubTab =
  'session' | 'logs'` (line 15); run selection resets `subTab` to `'session'` (line 110);
  sub-tab bar buttons at lines 131-152; panel ternary at lines 154-160. Each sub-panel
  (`RunSubPanel`, `LogSubPanel`) fetches the run itself via `useRun(runName, 5_000)` to
  compute `isActive` and to feed `SessionView`/`LogViewer`.
- **⚠️ CRITICAL — the run list is stripped.** `GET /api/runs` (`packages/web/src/server/
  routes/runs.ts:47-70`) returns a **subset** per run: `metadata.{name,uid,namespace,
  creationTimestamp}`, `spec.{agent,model}`, `status.{phase,message,sessionID,tokensIn,
  tokensOut,startedAt,completedAt,lastEventAt,podName}`. It does **NOT** include
  `spec.engine` nor `status.podPhase`. `useTaskRuns` (`packages/web/src/client/hooks/
  useTaskRuns.ts`) consumes this stripped list. **Therefore the Terminal-tab gate must be
  computed from a fresh `useRun(selectedRunName)` fetch (full CR, `GET /api/runs/:name`),
  never from the `selectedRun` list object.** (Revision 1 of this plan derived the gate from
  `selectedRun` — `podPhase` would have been `undefined` and the tab would never render.)
- **Types** (`packages/api/src/index.ts`): `RunSpec.engine: 'opencode' | 'claude'` optional
  (defaults to opencode via `deriveEngine`, line 189); `RunStatus.podPhase` (line 776),
  `RunStatus.podName`; `TERMINAL_PHASES = {Succeeded, Failed, Cancelled}` (line 758). The
  client re-exports these from `packages/web/src/client/lib/types.ts`.
- **Hooks**: `useRun(name, refetchInterval = 3_000)` (`hooks/useRun.ts`) stops polling once
  the run reaches a terminal phase; `useTaskRuns(taskName, refetchInterval = 5_000)` stops
  polling when **all** runs are terminal. Both are React Query (`@tanstack/react-query`) —
  repeated `useRun('x')` calls with the same name share one cache entry (`['run', name]`), so
  a parent-level gate fetch and the sub-panel fetch are deduped (no extra network traffic).
- **Test precedent**: `packages/web/tests/run-detail-terminal.test.tsx` mocks
  `TerminalTab`/`SessionView`/`LogViewer`/`useRun`/`useRunEvents` via `mock.module` and
  asserts on the engine branch. The web suite runs with `bun test --isolate` (AGENTS.md), so
  module mocks are contained per file. Board tests (`board-view.test.tsx`,
  `task-detail-pr.test.tsx`) use the same pattern (mock `lib/api`, real QueryClient).

## Approach

Reuse the existing `TerminalTab` and `/api/runs/:name/attach` endpoint unchanged; the work is
a contained change to `TaskRunsPanel` (plus a small extraction) and tests. Key decisions:

1. **Extract the selected-run section into `SelectedRunTabs`.** The sub-tab bar and the panel
   ternary (lines 128-162) move into a child component `SelectedRunTabs({ runName, subTab,
   setSubTab })`. This is required by the gate data-source fix: hooks cannot be called
   conditionally, and `TaskRunsPanel` only has a run selected sometimes, so the component
   that computes the gate must be mounted **with** a concrete `runName` and call
   `useRun(runName, 5_000)` unconditionally. This mirrors what `RunSubPanel`/`LogSubPanel`
   already do and makes the gate testable in isolation.
2. **Gate on the full run, not the stripped list.** Inside `SelectedRunTabs`:
   `const { data: run } = useRun(runName, 5_000)`, then
   `canAttach = !!run && isActive(run) && !!run.status?.podName && run.status?.podPhase ===
   'Running'` (identical expression to `RunDetail.tsx:316`). The **Terminal button renders
   only when `canAttach`**; the Session/Logs buttons render unconditionally. React Query
   dedupes this fetch with the sub-panels' fetches, so there is no extra request.
3. **Add `'terminal'` to `SubTab`** and a `TerminalSubPanel({ runName })` sibling of
   `RunSubPanel`/`LogSubPanel`: `useRun(runName, 5_000)`, compute `isActive` (same expression
   as lines 33-34), and render:
   - `run.spec.engine === 'claude'` → the explanatory `<p>` (copy the text from
     `RunDetail.tsx:322-327`, including the "Use the Session and Logs sections below." note).
     Note: `undefined` engine means opencode (matches `deriveEngine` and `RunDetail`), so only
     the explicit `'claude'` branch is special-cased.
   - otherwise → `<TerminalTab runName={runName} active={isActive} />` (import from
     `../TerminalTab`).
4. **Handle run completion while the terminal tab is open.** When the live run transitions to
   a terminal phase (or pod leaves Running) while `subTab === 'terminal'`, the button
   disappears and the panel would go blank. Add a small `useEffect` in `SelectedRunTabs`:
   `if (subTab === 'terminal' && run && !canAttach) setSubTab('session')`. Guard on `run`
   being loaded so a transient undefined doesn't yank the tab during initial fetch.
   (Alternative considered: derive an `effectiveSubTab`; the effect is simpler and also
   re-selects a sane default for the next user action.)
5. **Keep existing behavior**: selecting a run still resets `subTab` to `'session'`
   (line 110, stays in `TaskRunsPanel`); `TerminalTab`'s own unmount/`active` cleanup closes
   the exec WebSocket when the user switches tabs or runs, so no connection leaks.
6. **Tests**: new `packages/web/tests/board-task-runs-terminal.test.tsx` following the
   `run-detail-terminal.test.tsx` mock pattern (`mock.module` for `useTaskRuns`, `useRun`,
   `useRunEvents`, `TerminalTab`, `SessionView`, `LogViewer`; rendered under a real
   `QueryClientProvider`). Because `useRun` is now called by both `SelectedRunTabs` (gate)
   and the sub-panels, the `useRun` mock must resolve by run name against the same fixture
   map used for the `useTaskRuns` list. No e2e test: deterministic e2e principles assert only
   on CR status / board JSON, and xterm output is not deterministic — component tests are the
   right tier for this feature (see Risks).

## Scope boundaries

### In scope

- `packages/web/src/client/components/board/TaskRunsPanel.tsx` — extract `SelectedRunTabs`,
  add `'terminal'` sub-tab + `TerminalSubPanel`, liveness gate (from live `useRun` data),
  engine gate, tab-reset effect.
- `packages/web/tests/board-task-runs-terminal.test.tsx` — new component tests.
- Verification: `pnpm typecheck`, `pnpm lint`, `pnpm test` (web suite, `--isolate`).

### Out of scope

- **No server changes**: `attach-ws.ts`, `runs.ts` (stripped list left as-is — the fix is
  client-side), `index.ts` route registration, auth — all untouched. The endpoint already
  works and is engine-gated by the fact that it execs `opencode attach`.
- **No changes to `TerminalTab.tsx`** (connect/retry/resize behavior is battle-tested).
- **No changes to `RunDetail.tsx`** (the standalone run page already has its terminal).
- **No API/CRD changes** (`spec.engine`, `status.podPhase`, `TERMINAL_PHASES` already exist).
- **No change to `useRun`/`useTaskRuns` hook signatures** (extraction avoids conditional
  hooks; no `enabled` flag needed).
- No e2e tests, no docs changes, no new dependencies.
- Not adding a terminal for the claude engine (its runner has no TUI) — only the explanation.

## Tasks / BUILD task breakdown

All BUILD tasks target `@percussionist/web`; agent: `builder`. Each must pass
`pnpm typecheck`, `pnpm lint`, and the web `bun test` before review.

### BUILD 1 — Extract `SelectedRunTabs` and wire the Terminal sub-tab in `TaskRunsPanel`
- File: `packages/web/src/client/components/board/TaskRunsPanel.tsx`.
- Extend `SubTab` to `'session' | 'logs' | 'terminal'` (line 15).
- Extract the `{selectedRun && (…)}` block (lines 128-162) into a new component
  `SelectedRunTabs({ runName, subTab, setSubTab })`:
  - `const { data: run } = useRun(runName, 5_000);` — the **full** run CR (never derive the
    gate from the stripped `selectedRun` object).
  - Compute `isActive` (same expression as lines 33-34) and
    `canAttach = !!run && isActive && !!run.status?.podName && run.status?.podPhase ===
    'Running'`.
  - Render the sub-tab bar: Session and Logs buttons as today; a **Terminal** button (plain
    text, after Logs, same styling) **only when `canAttach`**.
  - Render the panel ternary: `subTab === 'session'` → `RunSubPanel`; `subTab === 'logs'` →
    `LogSubPanel`; `subTab === 'terminal'` → `TerminalSubPanel` (all `runName`-keyed).
  - Tab-reset effect: `useEffect(() => { if (subTab === 'terminal' && run && !canAttach)
    setSubTab('session'); }, [subTab, run, canAttach, setSubTab])`.
- In `TaskRunsPanel`, render `<SelectedRunTabs runName={selectedRunName} subTab={subTab}
  setSubTab={setSubTab} />` in place of the extracted block; keep the row-click reset
  (`setSubTab('session')`, line 110) and the "No selection" empty state.
- Add `TerminalSubPanel({ runName })` beside `RunSubPanel`/`LogSubPanel`:
  - `useRun(runName, 5_000)`; `isActive` computed as in the other sub-panels.
  - `run.spec.engine === 'claude'` → the explanation `<p>` (copy from
    `RunDetail.tsx:322-327`); otherwise → `<TerminalTab runName={runName} active={isActive}
    />` (import `../TerminalTab`).
- Acceptance: on the board, an active opencode run shows a Terminal tab that opens a live
  xterm attach; a claude-engine active run shows the explanation inside the tab; a completed
  run or a pod that isn't Running shows no Terminal tab; switching runs still defaults to
  Session; no changes to `TerminalTab`/server code/`runs.ts`.

### BUILD 2 — Component tests for the board terminal gating
- File: `packages/web/tests/board-task-runs-terminal.test.tsx` (new).
- Mock via `mock.module` at the top of the file (before SUT imports — same layout as
  `run-detail-terminal.test.tsx`):
  - `useTaskRuns` → returns a fixed run list (stripped-shape fixtures are fine; the
    component only reads `metadata.name` / `status.phase` from it).
  - `useRun` → **name-resolving**: `(name: string) => ({ data: RUNS.find(r =>
    r.metadata.name === name) ?? null, error: null, isLoading: false, isFetching: false })`
    so both the `SelectedRunTabs` gate and sub-panels see the selected run's full status.
  - `useRunEvents` → `{connected: true, eventTick: 0}`.
  - `TerminalTab` → renders `<div data-testid="terminal-tab">TERMINAL</div>`; `SessionView`
    and `LogViewer` → trivial stand-ins (as in `run-detail-terminal.test.tsx`).
- Render `TaskRunsPanel` inside `QueryClientProvider`; click a run row to select it (which
  also exercises the default-to-session reset), then assert:
  1. active opencode run (`spec.engine` unset **and** explicit `'opencode'`; `status.phase:
     'Running'`, `status.podName` set, `status.podPhase: 'Running'`) → Terminal tab button
     present; clicking it renders the `terminal-tab` stand-in;
  2. active claude run (`spec.engine: 'claude'`, same status) → Terminal tab present; clicking
     it renders the "Interactive attach is not available for the claude engine" text and
     **not** the `terminal-tab` stand-in;
  3. terminal-phase run (`status.phase: 'Succeeded'`) → no Terminal tab button at all;
  4. pod not Running (`status.podPhase: 'Pending'` or absent) → no Terminal tab button;
  5. run selection defaults to the Session tab (existing behavior pinned); switching runs
     while on the Terminal tab resets to Session.
- Acceptance: new file passes under `bun test --isolate`; no cross-file mock leakage (the
  suite's known failure mode — see AGENTS.md); existing `run-detail-terminal`,
  `board-view`, and `task-detail-pr` tests stay green.

### BUILD 3 — Verification & CI pass
- Run `pnpm typecheck`, `pnpm lint`, `pnpm test` from the repo root; confirm the new test
  file is picked up by the web suite's existing `bun test` script (no script changes
  expected) and the whole suite stays under its duration target.
- Manually smoke the UI (optional, requires a cluster): start an opencode-engine run from a
  task, open the board → task → Runs, select the run, verify the Terminal tab attaches; do
  the same for a claude-engine run and verify the explanation.
- Acceptance: green typecheck/lint/test; no flaky order-dependent tests.

## Acceptance criteria (overall)

1. On the board's task detail Runs panel, an **active opencode-engine run** (phase not in
   `TERMINAL_PHASES`, `podPhase: Running`, `podName` set) exposes a **Terminal** sub-tab next
   to Session/Logs; selecting it opens a live xterm attach to the run pod via the existing
   `/api/runs/:name/attach` endpoint.
2. An active **claude-engine** run exposes the Terminal tab but shows the "Interactive attach
   is not available for the claude engine…" explanation — no broken/flickering terminal.
3. **Terminal-phase runs** (Succeeded/Failed/Cancelled) and runs whose pod is not Running
   expose **no** Terminal tab; selecting a run still defaults to the Session tab; a run that
   completes while the Terminal tab is open falls back to the Session tab.
4. The gate is driven by the **full run CR from `useRun(selectedRunName)`** — never the
   stripped list object from `useTaskRuns` (which lacks `spec.engine`/`status.podPhase`).
5. No changes to `TerminalTab.tsx`, `attach-ws.ts`, `runs.ts`, server routes, API/CRD types,
   or hook signatures; no new dependencies.
6. `pnpm typecheck` + `pnpm lint` clean; `pnpm test` green including the new
   `board-task-runs-terminal.test.tsx` under `--isolate`.

## Risks / open questions

1. **Terminal tab visibility during pod startup** — the gate requires `podPhase ===
   'Running'`, so the tab is absent while the pod is Pending/Initializing (same behavior as
   the run page). Alternative: always show the tab for active runs and rely on
   `TerminalTab`'s built-in 15s readiness retry. Default is the strict gate for consistency
   with `RunDetail`; flag to reviewer if the flicker-on-start matters.
2. **Tab reset on run completion** — without the reset effect, a run completing while the
   terminal tab is open would leave a blank panel (tab button disappears). The effect
   mitigates this (guarded on `run` being loaded so the initial fetch doesn't trigger it);
   the test suite should pin it (BUILD 2 case 3/5 cover the neighboring behavior).
3. **Multiple concurrent exec WebSockets** — each open terminal holds one k8s exec WS to the
   pod. The board only renders one selected run's sub-panel at a time and `TerminalTab`
   closes on unmount/`active` flip, so at most one live terminal exists; no aggregate limit
   is needed for v1.
4. **`TerminalTab` fixed 600px height** (`TerminalTab.tsx:294`) — inside the board's narrow
   detail panel (and the mobile sheet) the terminal is 600px tall; acceptable for v1,
   resizing is out of scope.
5. **Claude tab-with-explanation vs hidden tab** — showing the tab with an explanation keeps
   the tab bar stable and follows the RunDetail precedent; if reviewers prefer hiding it for
   claude, that is a one-line change in BUILD 1 (drop the button when `engine === 'claude'`).
6. **No e2e coverage** — deliberately out of scope: deterministic e2e principles forbid
   asserting on terminal/xterm output; the component tests cover the gating logic that is
   the actual risk. The attach bridge itself is already exercised by
   `attach-ws.test.ts` and the run-page terminal.
7. **`useRun` mock must resolve by name (BUILD 2)** — because the gate now lives in a
   component that fetches via `useRun`, the test mock has to return per-name data; the
   single-fixed-object mock used in `run-detail-terminal.test.tsx` is insufficient. The
   name-resolving fixture map in BUILD 2 covers both gate and sub-panel consumers.
