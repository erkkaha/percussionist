# Plan: Add a Terminal tab to the active run on the board

Task: `percussionist-dev-plan-739a26`

## Context

The board (project detail page, `packages/web/src/client/components/BoardView.tsx` →
`board/TaskDetailPanel.tsx` → `board/TaskRunsPanel.tsx`) shows a selected task's runs with
per-run **Session / Logs** sub-tabs. There is currently **no way to attach an interactive
terminal to a live run from the board** — the only place a terminal exists is the standalone
run page.

What already exists (verified against `main` @ `bd11e7b`):

- **`packages/web/src/client/components/TerminalTab.tsx`** — a complete, reusable xterm.js
  attach widget. Props: `{ runName: string; active: boolean }`. It opens a WebSocket to
  `/api/runs/{runName}/attach`, sends stdin as binary and `{type:'resize'}` control messages,
  renders raw PTY output, and handles reconnect with exponential backoff plus a slow
  (15s) readiness retry for "pod not yet created / must be running / container not ready"
  errors. It is currently imported **only** by `RunDetail.tsx` (the `/runs/:name` page).
  `@xterm/xterm@6.0.0` + `@xterm/addon-fit@0.11.0` are already dependencies of
  `packages/web` — no new deps needed.
- **`packages/web/src/server/attach-ws.ts`** — the server-side WebSocket bridge. It
  `exec`s **`opencode attach http://127.0.0.1:4096`** in the `runner` container
  (`attach-ws.ts:436`), so the terminal is **only meaningful for the opencode engine**; the
  claude engine's runner is a headless HTTP server with no TUI to attach to. It also guards:
  terminal-phase run → 410 (`run is Succeeded; pod is gone`), pod not `Running` → 400,
  `runner` container not ready → 400. The upgrade route is registered in
  `packages/web/src/server/index.ts` (`/api/runs/:name/attach`).
- **`packages/web/src/client/components/RunDetail.tsx:316-333`** — the reference pattern for
  terminal gating: the Terminal card renders only when the run is active
  (`!TERMINAL_PHASES.has(phase)`), has `status.podName`, and `status.podPhase === 'Running'`;
  for `run.spec.engine === 'claude'` it renders an explanatory message instead of the
  terminal ("Interactive attach is not available for the claude engine — its runner is a
  headless server with no terminal session…"), rather than silently dropping the section.
- **`packages/web/src/client/components/board/TaskRunsPanel.tsx`** — the target. `SubTab =
  'session' | 'logs'` (line 15); run selection resets `subTab` to `'session'` (line 110);
  sub-tab bar buttons at lines 131-152; panel ternary at lines 154-160. Each sub-panel
  (`RunSubPanel`, `LogSubPanel`) fetches the run itself via `useRun(runName, 5_000)` to
  compute `isActive` and to feed `SessionView`/`LogViewer`.
- **Types** (`packages/api/src/index.ts`): `RunSpec.engine: 'opencode' | 'claude'` optional
  (defaults to opencode, `deriveEngine`); `RunStatus.podPhase`, `RunStatus.podName`;
  `TERMINAL_PHASES = {Succeeded, Failed, Cancelled}` (line 758). The client re-exports all of
  these from `packages/web/src/client/lib/types.ts`.
- **Test precedent**: `packages/web/tests/run-detail-terminal.test.tsx` mocks
  `TerminalTab`/`SessionView`/`LogViewer`/`useRun`/`useRunEvents` via `mock.module` and
  asserts on the engine branch. The web suite runs with `bun test --isolate` (AGENTS.md), so
  module mocks are contained per file.

## Approach

Reuse the existing `TerminalTab` and `/api/runs/:name/attach` endpoint unchanged; the work is
a small, contained addition to `TaskRunsPanel` plus tests. Key decisions:

1. **Add a third sub-tab** `'terminal'` to `SubTab` and a "Terminal" button in the sub-tab bar
   (plain-text label, matching the existing Session/Logs buttons — no icon needed for parity).
2. **Reuse `TerminalTab` directly** in a new `TerminalSubPanel` (`{ runName }`) that follows
   the exact shape of `RunSubPanel`/`LogSubPanel`: fetch the run via
   `useRun(runName, 5_000)`, compute `isActive` from `TERMINAL_PHASES`, and render
   `<TerminalTab runName={runName} active={isActive} />`. No changes to `TerminalTab`.
3. **Gate the tab on run liveness** (mirror `RunDetail.tsx:316`): the Terminal tab button is
   rendered only when the selected run is active (`!TERMINAL_PHASES.has(phase)`) **and** has
   `status.podName` **and** `status.podPhase === 'Running'`. Completed runs get no terminal
   tab (attach would 410). The Session/Logs tabs remain available for every run.
4. **Gate the content on engine** (mirror `RunDetail.tsx:322-327`): for
   `run.spec.engine === 'claude'` render the same "Interactive attach is not available for
   the claude engine…" explanation inside the terminal tab content instead of `TerminalTab`;
   otherwise (`undefined` or `'opencode'`) render `TerminalTab`. This keeps the tab bar
   position stable across engines and follows the repo's "explain the absence rather than
   silently dropping the section" precedent.
5. **Handle run completion while the terminal tab is open**: if the run transitions to a
   terminal phase while `subTab === 'terminal'`, the tab button disappears (gate #3) and the
   terminal would otherwise leave the panel blank. Add a small `useEffect` in
   `TaskRunsPanel` that resets `subTab` to `'session'` when the selected run stops satisfying
   the terminal gate. (Alternatively derive an `effectiveSubTab`; the effect is simpler and
   also re-selects a sane default for the next user action.)
6. **Keep existing behavior**: selecting a run still resets to `'session'` (line 110);
   `TerminalTab`'s own unmount/`active` cleanup closes the exec WebSocket when the user
   switches tabs or runs, so no connection leaks.
7. **Tests**: new `packages/web/tests/board-task-runs-terminal.test.tsx` following the
   `run-detail-terminal.test.tsx` mock pattern (`mock.module` for `useTaskRuns`, `useRun`,
   `useRunEvents`, `TerminalTab`, `SessionView`, `LogViewer`; rendered under
   `QueryClientProvider`). Assert on the presence/absence of the Terminal tab and the
   rendered stand-in for each gate branch. No e2e test: the deterministic e2e principles
   assert only on CR status / board JSON, and xterm output is not deterministic — component
   tests are the right tier for this feature (see Risks).

## Scope boundaries

### In scope

- `packages/web/src/client/components/board/TaskRunsPanel.tsx` — new `'terminal'` sub-tab,
  `TerminalSubPanel`, liveness gate, engine gate, tab-reset effect.
- `packages/web/tests/board-task-runs-terminal.test.tsx` — new component tests.
- Verification: `pnpm typecheck`, `pnpm lint`, `pnpm test` (web suite, `--isolate`).

### Out of scope

- **No server changes**: `attach-ws.ts`, `index.ts` route registration, and auth are
  untouched — the endpoint already works and is engine-gated by the fact that it execs
  `opencode attach`.
- **No changes to `TerminalTab.tsx`** (connect/retry/resize behavior is already battle-tested).
- **No changes to `RunDetail.tsx`** (the standalone run page already has its terminal).
- **No API/CRD changes** (`spec.engine`, `status.podPhase`, `TERMINAL_PHASES` already exist).
- No e2e tests, no docs changes, no new dependencies.
- Not adding a terminal for the claude engine (its runner has no TUI) — only the explanation.

## Tasks / BUILD task breakdown

All BUILD tasks target `@percussionist/web`; agent: `builder`. Each must pass
`pnpm typecheck`, `pnpm lint`, and the web `bun test` before review.

### BUILD 1 — Terminal sub-tab wiring in `TaskRunsPanel`
- File: `packages/web/src/client/components/board/TaskRunsPanel.tsx`.
- Extend `SubTab` to `'session' | 'logs' | 'terminal'` (line 15).
- Add `TerminalSubPanel({ runName })` beside `RunSubPanel`/`LogSubPanel`: `useRun(runName,
  5_000)`, compute `isActive` (same expression as lines 33-34), and render:
  - `run.spec.engine === 'claude'` → the explanatory `<p>` (copy the text from
    `RunDetail.tsx:323-327`, including the "Use the Session and Logs sections below." note);
  - otherwise → `<TerminalTab runName={runName} active={isActive} />`
    (import from `../TerminalTab`).
- Add a `Terminal` button to the sub-tab bar (after Logs, lines 142-151) **only when the
  selected run satisfies the liveness gate**: `isActive && run.status?.podName &&
  run.status?.podPhase === 'Running'`. Compute this from `selectedRun` (the run object from
  `useTaskRuns`) or, for freshness, from `useRun` data inside the panel body — either is
  fine; prefer deriving from `selectedRun` since `useTaskRuns` already refetches every 5s
  while any run is active.
- Render the terminal panel in the ternary (lines 154-160): `subTab === 'terminal'` →
  `TerminalSubPanel`; keep the existing session/logs branches.
- Add the tab-reset effect: when the selected run changes or its phase becomes terminal
  while `subTab === 'terminal'`, `setSubTab('session')`.
- Acceptance: on the board, an active opencode run shows a Terminal tab that opens a live
  xterm attach; a claude-engine active run shows the explanation inside the tab; a completed
  run has no Terminal tab; switching runs still defaults to Session; no changes to
  `TerminalTab`/server code.

### BUILD 2 — Component tests for the board terminal gating
- File: `packages/web/tests/board-task-runs-terminal.test.tsx` (new).
- Mock via `mock.module` (top of file, before imports of the SUT — same layout as
  `run-detail-terminal.test.tsx`): `useTaskRuns` (returns a fixed run list), `useRun`
  (returns the currently selected run), `useRunEvents` (`{connected: true, eventTick: 0}`),
  `TerminalTab` (renders `<div data-testid="terminal-tab">TERMINAL</div>`),
  `SessionView` and `LogViewer` (trivial stand-ins).
- Render `TaskRunsPanel` inside `QueryClientProvider`; click the run row to select it (which
  also exercises the default-to-session reset), then assert:
  1. active opencode run (`spec.engine` unset **and** explicit `'opencode'`, `status.phase:
     'Running'`, `status.podPhase: 'Running'`) → Terminal tab button present; clicking it
     renders the `terminal-tab` stand-in;
  2. active claude run (`spec.engine: 'claude'`, same status) → Terminal tab present;
     clicking it renders the "Interactive attach is not available for the claude engine"
     text and **not** the `terminal-tab` stand-in;
  3. terminal-phase run (`status.phase: 'Succeeded'`) → no Terminal tab button at all;
  4. pod not Running (`status.podPhase: 'Pending'` or absent) → no Terminal tab button;
  5. run selection defaults to the Session tab (existing behavior pinned).
- Acceptance: new file passes under `bun test --isolate`; no cross-file mock leakage (the
  suite's known failure mode — see AGENTS.md); existing `run-detail-terminal` tests stay
  green.

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
   expose **no** Terminal tab; selecting a run still defaults to the Session tab.
4. No changes to `TerminalTab.tsx`, `attach-ws.ts`, server routes, or API/CRD types; no new
   dependencies.
5. `pnpm typecheck` + `pnpm lint` clean; `pnpm test` green including the new
   `board-task-runs-terminal.test.tsx` under `--isolate`.

## Risks / open questions

1. **Terminal tab visibility during pod startup** — the gate requires `podPhase ===
   'Running'`, so the tab is absent while the pod is Pending/Initializing (same behavior as
   the run page). Alternative: always show the tab for active runs and rely on
   `TerminalTab`'s built-in 15s readiness retry. Default is the strict gate for consistency
   with `RunDetail`; flag to reviewer if the flicker-on-start matters.
2. **Tab reset on run completion** — without the reset effect, a run completing while the
   terminal tab is open would leave a blank panel (tab button disappears). The effect
   mitigates this; the test suite should pin it (BUILD 2 case 3/5 cover the neighboring
   behavior).
3. **Multiple concurrent exec WebSockets** — each open terminal holds one k8s exec WS to the
   pod. The board only renders one selected run's sub-panel at a time and `TerminalTab`
   closes on unmount/`active` flip, so at most one live terminal exists; no aggregate limit
   is needed for v1.
4. **`TerminalTab` fixed 600px height** — inside the board's narrow detail panel (and the
   mobile sheet) the terminal is 600px tall; acceptable for v1, resizing is out of scope.
5. **Claude tab-with-explanation vs hidden tab** — showing the tab with an explanation keeps
   the tab bar stable and follows the RunDetail precedent; if reviewers prefer hiding it for
   claude, that is a one-line change in BUILD 1 (drop the button when `engine === 'claude'`).
6. **No e2e coverage** — deliberately out of scope: deterministic e2e principles forbid
   asserting on terminal/xterm output; the component tests cover the gating logic that is
   the actual risk. The attach bridge itself is already exercised by
   `attach-ws.test.ts` and the run-page terminal.
