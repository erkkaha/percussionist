# Plan: Run page redesign — immersive cloud terminal with slash commands

Task: `percussionist-dev-plan-a7c295`

## Context

### What exists today

The run page is `/runs/:name`, routed in
`packages/web/src/client/App.tsx:66` to
`packages/web/src/client/components/RunDetail.tsx` (555 lines). The prior
redesign (`percussionist-dev-plan-f2dbf6`) turned it into a full-height tabbed
shell:

- Outer wrapper: `-m-6 flex flex-col` with `height: calc(100svh - 3.5rem)`
  (`RunDetail.tsx:156`) — pulls out of `Layout.tsx`'s `p-6` and pins to the
  `h-14` app header. This idiom is shared with `BoardView.tsx:162` and
  `ActivityPage.tsx:293`.
- A header (name, `StatusBadge`, `TokenCounter`, Copy, Cancel/Delete with a
  two-step confirm) and a failed-run banner.
- A `Tabs` bar (Overview / Session / Logs / Terminal) driven by the `?tab=`
  search param (`RunDetail.tsx:77-120`).
- Panels: `RunOverview` (`RunDetail.tsx:308`), `SessionView`, `LogViewer`,
  `TerminalTab`.

The heavy children:

- `SessionView.tsx` (656 lines) renders the OpenCode session transcript as
  chat-style **message bubbles**, with markdown (react-markdown + katex + gfm),
  `ToolCall` `<details>` accordions, todo lists (`TaskList`), file diffs
  (`FileDiff`), token/cost footers, and an `ErrorBoundary` around the whole
  view. It is consumed by three routes/panels: `RunDetail`, `SessionDetail`
  (`/sessions/:name`), and `board/TaskRunsPanel.tsx`.
- `LogViewer.tsx` (339 lines) is an xterm.js read-only log pane; writes bytes
  diffed against the previous tail payload. Its box is hardcoded to
  `height: 600px` (`LogViewer.tsx:333`).
- `TerminalTab.tsx` (302 lines) is an xterm.js **interactive attach** over a
  WebSocket to `/api/runs/:name/attach`, exec'ing `opencode attach` in the pod.
  Hardcoded `height: 600px` (`TerminalTab.tsx:296`). Only the `opencode` engine
  has a TUI; the claude engine shows an explanation
  (`RunDetail.tsx:289-295`).
- `SessionComposer.tsx` (150 lines) is the run page's interactive control:
  start-session for interactive runs, Enter-to-send replies, Stop
  (interrupt). Its only consumer is `RunDetail.tsx:268`. Its behavior is
  covered by `tests/session-composer.test.tsx`.

Client data plumbing (all existing, no server changes needed):

- `useRun(name)` — 3 s poll, stops on terminal phase (`hooks/useRun.ts`).
- `useRunEvents(name, active)` — SSE (`/api/runs/:name/session/events`),
  invalidates `['session', name]` and `['logs', name]`
  (`hooks/useRunEvents.ts`).
- `useSession(name, hasSession, interval)` — `GET /api/runs/:name/session`
  (`hooks/useSession.ts`). Server route in `server/routes/session.ts:23`
  already falls back live → snapshot ConfigMap → stats DB, so no data loss on
  reload.
- `useLogs(name, container, tailLines, …)` — `GET /api/runs/:name/logs`
  (`hooks/useLogs.ts`).
- Mutations in `lib/api.ts`: `replyToRun` (:196), `startRunSession` (:205),
  `interruptRun` (:212), `deleteRun` (:190).
- Server routes in `server/routes/runs.ts`: `POST /:name/reply` (:179),
  `POST /:name/session` (:228), `POST /:name/interrupt` (:273),
  `DELETE /:name` (:165). The WebSocket attach is in
  `server/attach-ws.ts`.

### The gap

The task: *"Make the run page immersive cloud terminal. Group functionality to
the terminal with slash command, like /logs /status /cancel etc. Some commands
can be UI some server. Assistant user conversation should feel like terminal,
but don't lose data, this is still web, so accordions or similar allowed."*

Today the run page is a **tabbed dashboard**: functionality is split across a
tab bar, the conversation is rendered as web chat bubbles, and the composer is
a separate textarea. There is no command surface at all — `slash`,
`CommandPalette`, and `cmdk` have zero matches in the client. The redesign is:

1. Turn the page into a single full-viewport, dark, monospace **cloud terminal
   shell** (one persistent stage + one persistent prompt), not a tab bar.
2. Replace the tab bar with **slash commands typed into that prompt** —
   `/logs`, `/status`, `/cancel`, etc. UI commands change the stage; server
   commands call the existing REST mutations.
3. Render the agent conversation **terminal-style** (line-oriented, mono,
   prompt prefixes) while keeping every structured part (markdown, tool calls,
   diffs, todos) reachable behind accordions — no data is dropped.

## Scope boundaries

### In scope

- `packages/web` client UI only. No CRD, operator, manager, dispatcher, or web
  server/API changes. Slash commands are parsed client-side and reuse the
  existing endpoints listed above.
- Rewrite `RunDetail.tsx` into an immersive terminal shell: slim header, a
  single stage, a persistent command bar.
- New slash-command registry + parser (`components/run-terminal/commands.ts`).
- New command bar (`components/run-terminal/RunCommandBar.tsx`), evolved from
  `SessionComposer.tsx`, with a `/` autocomplete menu. It preserves every
  existing composer behavior: start-session, Enter-to-send, Shift+Enter
  newline, Stop, error surfacing, disabled states.
- New terminal transcript (`components/run-terminal/TerminalTranscript.tsx`)
  that renders session messages as terminal entries; text inline, structured
  parts as `<details>` accordions.
- Extract the reusable rich-part renderers out of `SessionView.tsx` into a
  shared module so `TerminalTranscript` and `SessionView` do not diverge. Refactor
  `SessionView` to consume them with **no behavior change** for its other two
  consumers (`SessionDetail`, `TaskRunsPanel`).
- View-mode deep links: `?view=conversation|logs|status|shell`, with legacy
  `?tab=` values mapped for backward compatibility (`overview→status`,
  `session→conversation`, `logs→logs`, `terminal→shell`).
- Optional `fillHeight` prop on `LogViewer`/`TerminalTab` (defaulting to today's
  600px) so the embedded panes fill the terminal stage instead of leaving a
  fixed-height box inside it.
- Tests for the parser, the command bar, the transcript, and the shell;
  update/replace the existing run-page tests.
- Update the `Run Detail` section of `docs/dashboard.md` (it currently describes
  a "single-page view", `docs/dashboard.md:33-38`).

### Out of scope

- No server/API/CRD/schema change. Do not add a "command" wire protocol — the
  registry executes existing client mutations.
- No generic app-wide command palette; slash commands are scoped to the run
  page's command bar.
- No visual redesign of `SessionView` for `SessionDetail`/`TaskRunsPanel`,
  `SessionList`, `RunList`, or the board. The extraction is structural only.
- No change to the xterm attach protocol or to `LogViewer`'s diffing behavior.
- No new dependencies (no `cmdk`, no terminal emulator beyond existing xterm).
- `/sessions/:name` (`SessionDetail`) is untouched behaviorally.

## Assumptions

1. "Immersive cloud terminal" means the run page occupies the full viewport
   below the app header (`calc(100svh - 3.5rem)`, the established idiom), uses
   the existing dark surface palette and `font-mono`, and keeps only a slim
   header plus a persistent prompt — not a literal PTY emulator.
2. The **slash command surface is the run conversation terminal**, not the raw
   xterm attach. Once attached (`/shell`), keystrokes go to the pod's PTY and
   cannot be intercepted by the browser; slash commands are only interpreted in
   `conversation`, `logs`, and `status` views. This is stated in `/help` and in
   the plan's risks.
3. Slash commands are client-parsed. "Some commands can be UI some server"
   means: UI commands mutate local view state (stage, scrollback, clipboard,
   query cache); server commands call `replyToRun`/`interruptRun`/`startRunSession`/
   `deleteRun`.
4. The session transcript is already durable server-side (live → snapshot →
   stats DB), so this is presentation-only; "don't lose data" is satisfied by
   never hiding a part without an accordion (and `/clear` clears only local
   command output, never the conversation).
5. `?tab=` is only produced and consumed inside `RunDetail` (no other component
   links with `?tab=` — verified by grep), so the rename to `?view=` is safe as
   long as legacy values keep working.
6. Native `<details>`/`<summary>` is the accordion primitive — it is already the
   pattern used by `ToolCall` in `SessionView.tsx:536` and needs no JS.
7. Four view modes are the right granularity: `conversation` (default),
   `logs`, `status`, `shell`. A future diff/plan view can be added as another
   command without re-architecture.

## Approach

### 1. Command model — `components/run-terminal/commands.ts`

A pure, testable module with no React imports:

```ts
export type CommandKind = 'ui' | 'server';

export interface SlashCommand {
  name: string;              // 'logs'
  aliases?: string[];        // ['log']
  usage: string;             // '/logs [bootstrap|engine|dispatcher]'
  description: string;       // 'Show pod logs'
  kind: CommandKind;         // 'ui' | 'server'
  argsHint?: string;         // '[container]'
}

export const COMMANDS: readonly SlashCommand[] = [ … ];

/** Split '/logs engine --tail 200' → { command: 'logs', args: ['engine','--tail','200'], raw: … } | null */
export function parseSlashInput(input: string): ParsedCommand | null;

/** Resolve a name/alias to a command; case-insensitive. */
export function resolveCommand(name: string): SlashCommand | undefined;
```

The registry is metadata only; execution lives in the shell/command bar so the
module stays unit-testable. Command set (final):

| Command | Aliases | Kind | Effect |
|---|---|---|---|
| `/help` | `?` | ui | Print the command list into the local output tail |
| `/status` | | ui | Switch stage to `status`; print a one-line phase summary |
| `/logs` | `/log` | ui | Switch stage to `logs`; optional container arg |
| `/conversation` | `/chat`, `/conv`, `/back` | ui | Switch stage to `conversation` |
| `/shell` | `/attach`, `/terminal` | ui | Switch stage to `shell` (opencode + pod Running only; otherwise print why) |
| `/clear` | | ui | Clear local command-output tail (not session messages) |
| `/copy` | | ui | Copy the run name to the clipboard and confirm in the tail |
| `/refresh` | | ui | Invalidate `['run',name]`, `['session',name]`, `['logs',name]` |
| `/stop` | | server | `interruptRun` (stop the current turn; session stays) |
| `/start` | | server | `startRunSession` (interactive runs with no session) |
| `/reply <text>` | | server | `replyToRun` (same as typing plain text) |
| `/cancel` | `/delete` | server | Confirm, then `deleteRun` and navigate to `/runs` |

Plain (non-`/`) input is implicitly `/reply`. An unknown `/foo` prints
`unknown command: /foo — try /help` and is **not** forwarded to the agent.

### 2. View model and deep links

```ts
type RunView = 'conversation' | 'logs' | 'status' | 'shell';
```

- Read `?view=`; if absent, translate legacy `?tab=`
  (`overview→status`, `session→conversation`, `logs→logs`, `terminal→shell`).
- `availableViews(view)`: `shell` is available only when
  `isActive && podName && podPhase === 'Running' && engine !== 'claude'`;
  `status`/`logs`/`conversation` are always available. Clamp an unavailable
  value to `conversation` (mirrors the existing effect at
  `RunDetail.tsx:95-108` and `TaskRunsPanel.tsx:126-128`).
- Write `?view=<id>` with `{ replace: true }` so the back button does not fill
  with view toggles. Keep the "rewrite an unavailable param to the fallback"
  effect so a refresh never asks for a panel that cannot render.
- Default: `conversation`.

### 3. Layout — `RunDetail.tsx` rewrite

```
┌───────────────────────────────────────────────────────────────┐
│ slim header: name · StatusBadge · live dot · tokens · actions │ shrink-0
│ failed-run banner (conditional)                               │ shrink-0
├───────────────────────────────────────────────────────────────┤
│ STAGE  flex-1 min-h-0                                        │
│   conversation → TerminalTranscript (scrolls internally)     │
│   logs         → LogViewer (fillHeight)                      │
│   status       → RunOverview (terminal-styled section headers)│
│   shell        → TerminalTab (fillHeight) / claude explainer  │
├───────────────────────────────────────────────────────────────┤
│ COMMAND BAR: ❯ [input]                       Stop · Send     │ shrink-0
└───────────────────────────────────────────────────────────────┘
```

- Root stays `-m-6 flex flex-col` / `calc(100svh - 3.5rem)`, add
  `bg-surface-container-lowest font-mono`.
- Header is slimmed but keeps: run name, `StatusBadge`, an SSE connection
  indicator, `TokenCounter`, and compact icon actions for Copy / Cancel /
  Refresh. Cancellation still requires the existing two-step confirm.
- `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent` imports are removed.
- `RunOverview` is kept (moved to a small module or left in `RunDetail.tsx`),
  rendered under `/status`.
- The command bar is hidden in `shell` view (raw PTY owns stdin); a small
  `⌨ attached — press Ctrl-] …` hint plus a `/conversation` affordance is shown
  instead. In `shell` view, `Stop` still maps to interrupt.

### 4. Terminal transcript — `TerminalTranscript.tsx`

Inputs: `name`, `hasSession`, `active`, `sseConnected`, `eventTick`,
`localEntries`, `onNoSession`. Data from `useSession` (unchanged hook).

Rendering:
- Wrap the whole view in `ErrorBoundary` (reuse the `SessionView` fallback) so
  one malformed proxied part cannot blank the page — this is the same guard
  the prior plan's review called out (rev20 finding on `SessionView`).
- One entry per `SessionMessage`:
  - Header line (mono, dim): `user ▸ 12:04:03` or
    `assistant ▸ provider/model · 123 in / 45 out · $0.0012`.
  - **User text**: rendered inline with a `❯ ` prompt prefix, `whitespace-pre-wrap`.
  - **Assistant text**: rendered inline with the existing markdown config
    (gfm + math + katex), restyled for the dark mono surface.
  - **Structured parts** are collapsed into one-line `<details>` summaries:
    - tool → `▸ bash — completed · 1.2 s` (expanded: full `ToolCall` view).
    - file diff → `▸ diff src/foo.ts (+12 −3)` (expanded: `FileDiff`).
    - subtask/todos → `▸ todos 3/7` / `▸ subagent explore` (expanded: `TaskList`/`SubagentRow`).
    - reasoning → `▸ reasoning (N chars)` collapsed by default.
    - unknown part types → `▸ [type]` (never silently dropped).
  - Long text/tool output keeps the existing 50-line truncation + "show more"
    behavior (`SessionView.tsx:528-534`, `:614-621`).
- A **local output tail** is appended after the messages for command results
  (`/help`, `/status` summary, errors, confirmations). Entry shape:
  `{ id, kind: 'command' | 'output' | 'error', text, at }`. `/clear` empties
  only this tail.
- Snapshot/live source banners from `SessionView.tsx:131-138` are preserved.
- Memoize `MessageEntry` with `React.memo` keyed on message id + expand state so
  typing in the command bar does not re-render a large history.

### 5. Shared part renderers — `components/session/session-parts.tsx`

`SessionView`'s rich part renderers are private. To avoid a second, divergent
implementation, extract into a new module:

- `ToolCall` (currently `SessionView.tsx:457`), `SubagentRow` (:444),
  `formatToolInput` (:640), `TaskList`/`FileDiff` re-exports as needed, and a
  `MessageText` component wrapping the `<ReactMarkdown>` component map
  (:241-339).
- `SessionView.tsx` imports these instead of declaring them; **no markup or
  behavior change** — `SessionDetail` and `TaskRunsPanel` must be unaffected.
- `TerminalTranscript.tsx` imports the same, wrapping each in a `<details>`
  summary.

This keeps markdown/math/gfm/diff/todo support identical in both places.

### 6. Command bar — `RunCommandBar.tsx`

Evolved from `SessionComposer.tsx`, preserving every existing behavior:

- Interactive run with no session + pod Running → offers `/start` and a
  `Start session` button; parks after success (existing behavior,
  `SessionComposer.tsx:47`).
- Run with a session → prompt + Send/Stop, Enter sends trimmed text via
  `replyToRun`, Shift+Enter newline, disabled while empty/pending, errors
  surfaced via `role="alert"`, text retained on failure.
- Terminal styling: `❯` prompt glyph, mono input, single logical line (textarea
  grows to a max height for multi-line messages).
- **Slash menu**: when the trimmed value starts with `/` and has no whitespace
  after the command token, show an absolutely-positioned listbox of matching
  `COMMANDS` (prefix match on name + aliases) with `usage` and `description`.
  Keyboard: ArrowUp/Down move, Tab/Enter complete, Escape closes. ARIA:
  `role="listbox"` / `role="option"`, `aria-activedescendant`, and an
  `aria-live="polite"` region that announces command results.
- **Execution**: on Enter, `parseSlashInput` → if a command resolves, invoke its
  handler with a context `{ runName, run, setView, setLogContainer, appendEntry,
  invalidate, navigate, confirmCancel }`. If not a command, treat as `/reply`.
- **`/cancel` confirmation**: first invocation prints
  `Cancel run <name>? This deletes the run and its pods. Re-run /cancel to confirm.`
  and sets a `pendingCancel` flag; a second `/cancel` within the same input
  session executes `deleteRun` and navigates to `/runs`. Any other input clears
  the flag. This keeps destructive action behind a terminal-style two-step
  confirm without a modal.
- The `aria-label` on the input changes to `Command or message to the agent`
  (test churn is explicit; see tasks).

### 7. `LogViewer` / `TerminalTab` fill-height

Add an optional `fillHeight?: boolean` prop (default `false`, preserving the
600px box for `TaskRunsPanel`). When true, render the xterm container as
`height: 100%` inside a `min-h-0` flex parent and call `fit()` on resize (both
components already observe resize). `RunDetail` passes `fillHeight` for the
`logs`/`shell` stages. This is a contained, default-off change to two shared
components.

### 8. Docs

Update `docs/dashboard.md:33-38` to describe the immersive terminal, the
command bar, the slash commands, and the view modes. The embedded screenshot
(`/images/run-detail.png`) becomes stale; note it as a follow-up rather than
blocking (screenshots are generated separately).

## Tasks

> The numbered implementation steps below map to the BUILD breakdown further
> down. Each step is independently reviewable where noted.

1. **Create `components/run-terminal/commands.ts`** — `CommandKind`,
   `SlashCommand`, `COMMANDS`, `parseSlashInput`, `resolveCommand`. Pure module,
   no React. Include `usage`/`description`/`kind`/`aliases` for every command in
   the table above. Handle: leading/trailing whitespace, only-first-token
   matching, alias resolution (case-insensitive), empty input → `null`, plain
   sentence → `null`, `'/'` alone → `null` (falls back to reply text).
2. **Add `tests/slash-commands.test.ts`** — table-driven coverage for parse,
   alias resolution, unknown command, and metadata invariants (unique names,
   aliases don't collide with names, every command has a usage string).
3. **Extract `components/session/session-parts.tsx`** — move `ToolCall`,
   `SubagentRow`, `formatToolInput`, and the markdown `MessageText` renderer out
   of `SessionView.tsx` verbatim (including the biome-ignore comments and the
   `useShiki` usage). Export them.
4. **Refactor `SessionView.tsx` to consume `session-parts.tsx`** — no markup or
   behavior change; `SessionDetail` and `TaskRunsPanel` must render identically.
   Run the existing `session-view-subtask`, `session-view-todowrite`,
   `session-fallback`, and `log-viewer` tests to confirm.
5. **Create `components/run-terminal/TerminalTranscript.tsx`** — props
   `{ name, hasSession, active, sseConnected, eventTick, localEntries,
   onNoSession? }`; `useSession` internally; `ErrorBoundary` wrapper; inline text
   for user/assistant; `<details>` accordions for tool/file/subtask/reasoning/
   unknown parts; snapshot banner; memoized entries; the 50-line truncation.
6. **Add `tests/terminal-transcript.test.tsx`** — fixture `SessionMessage[]`
   (user text, assistant markdown, one tool call, one file diff, one malformed
   part) asserting: text is visible, a tool call renders as a collapsed summary
   and expands to its output, a malformed part does not blank the page (boundary
   fallback), and the snapshot banner appears when `source === 'snapshot'`.
7. **Create `components/run-terminal/RunCommandBar.tsx`** by evolving
   `SessionComposer.tsx` — retain start/reply/stop behavior and port the
   component's comments; add slash parsing, the autocomplete listbox, execution
   handlers, the `/cancel` two-step confirm, and the `aria-live` result region.
   Delete `SessionComposer.tsx` once `RunDetail` no longer imports it.
8. **Add `tests/run-command-bar.test.tsx`** — port every case in
   `tests/session-composer.test.tsx` (start, no-op for prompt-mode without
   session, pod-pending no-op, Enter/Shift+Enter, failure surfacing, disabled
   send, Stop, parked-on-answer copy, finished no-op) against the new
   `aria-label`; add: typing `/` opens the menu and filters, Enter on a plain
   message calls `replyToRun`, `/help` does not call the API, `/stop` calls
   `interruptRun`, `/cancel` requires a second confirmation before `deleteRun`,
   and an unknown `/foo` is not forwarded.
9. **Add `fillHeight?: boolean` to `LogViewer` and `TerminalTab`** (default
   `false`) and pass `true` from the new `RunDetail` stages. Verify
   `TaskRunsPanel` and the existing `board-task-runs-terminal.test.tsx` /
   `terminal-tab-backoff.test.tsx` / `log-viewer.test.tsx` still pass.
10. **Rewrite `RunDetail.tsx`** into the immersive shell: root surface + slim
    header + failed banner + stage switch (`conversation`/`logs`/`status`/
    `shell`) + `RunCommandBar` + local output tail state. Remove the `Tabs`
    imports. Implement `RunView`, the `?view=` read/write with legacy `?tab=`
    mapping, the unavailable-view clamp effect, and the command context
    (`setView`, `setLogContainer`, `appendEntry`, `invalidate`, `navigate`,
    confirm-cancel). Keep `RunOverview`, `Field`, `formatTime`, `duration`,
    `DetailSkeleton`, `reviewVerdict`, `ReviewVerdictCard`.
11. **Replace the run-page tests** — delete `tests/run-detail-tabs.test.tsx`
    (tab semantics no longer exist) and write `tests/run-detail-shell.test.tsx`
    covering: default `conversation`; `/status` switches to the status view;
    `?view=logs` deep link; legacy `?tab=session` maps to `conversation`;
    unavailable `?view=shell` clamps; shell tab absent for claude / non-Running;
    header actions (Copy/Cancel confirm) still render; failed banner visible.
    Update `tests/run-detail-terminal.test.tsx` to reach the attach via
    `/shell` (command) instead of a tab click, keeping the claude explanation
    assertions. Keep the `--isolate` + `mock.module`-before-SUT ordering
    documented in `AGENTS.md`.
12. **Documentation** — rewrite the `Run Detail` section of `docs/dashboard.md`
    to describe the terminal shell, view modes, and slash commands, with the
    command table. Note the stale screenshot as a follow-up.
13. **Gate** — run `pnpm --filter @percussionist/web typecheck`,
    `pnpm --filter @percussionist/web test`, `pnpm typecheck`, `pnpm lint`; fix
    Biome complaints (pre-commit enforces both).
14. **Manual verification (documented in the BUILD task, not automated)** — on
    desktop and a narrow viewport: the page itself never scrolls; the stage
    fills the viewport; `/` opens the menu; `/logs`, `/status`, `/shell`,
    `/conversation` switch stages and the `?view=` param updates; `/stop`,
    `/start`, `/reply`, `/cancel` hit the right endpoints; the transcript keeps
    tool calls/diffs/markdown behind accordions; a malformed message part does
    not blank the page.

## Acceptance criteria

1. `/runs/:name` renders a full-height terminal shell
   (`calc(100svh - 3.5rem)`, no document-level scroll) with a slim header and a
   persistent command bar in `conversation`, `logs`, and `status` views.
2. Functionality is reachable by slash command: `/help`, `/status`, `/logs`,
   `/conversation`, `/shell`, `/clear`, `/copy`, `/refresh` are UI commands;
   `/stop`, `/start`, `/reply`, `/cancel` are server commands backed by the
   existing endpoints. `/help` lists them.
3. Typing `/` opens an autocomplete listbox with keyboard navigation; plain
   text (no leading `/`) still sends an agent message exactly as
   `SessionComposer` does today (Enter sends, Shift+Enter newline, errors
   surfaced, text retained on failure).
4. The conversation renders terminal-style (mono, prompt prefixes, per-message
   header lines) while **every** structured part remains reachable: markdown
   (gfm/math/katex), tool calls with input/output, file diffs, todo lists,
   subagents, reasoning, and unknown part types are all present — collapsed behind
   `<details>` accordions, never dropped. `/clear` clears only local command
   output.
5. View modes are deep-linkable via `?view=conversation|logs|status|shell`;
   legacy `?tab=overview|session|logs|terminal` maps to the equivalent view;
   an unavailable view (`shell` without an opencode TTY pod) clamps to
   `conversation` without crashing.
6. `shell` view is available only for an active, Running, non-claude run; a
   claude run shows the existing explanation text
   (`/Interactive attach is not available/`), reachable via `/shell`.
7. Destructive `/cancel` requires a second confirmation before `deleteRun`
   fires; the two-step header Cancel/Delete confirm still works.
8. `SessionView` behavior is unchanged for `SessionDetail` and
   `TaskRunsPanel` after the shared-renderer extraction.
9. `pnpm typecheck`, `pnpm lint`, and `pnpm test` pass; the new and updated web
   tests pass under `bun test --isolate`.
10. No changes outside `packages/web` (plus `docs/dashboard.md`).

## Proposed BUILD task breakdown

Seven small tasks, in dependency order. Tasks A and B are independent and can
run in parallel; C needs B; D needs A; E needs A, C, D; F and G need E. Where
feature branching is on, set `spec.predecessorRef` as noted so dependent work
sees its predecessor's changes.

1. **BUILD A — Slash command core** (no deps)
   - Deliverable: `packages/web/src/client/components/run-terminal/commands.ts`,
     `packages/web/tests/slash-commands.test.ts`.
   - Acceptance: parser/registry unit tests pass; module has no React import.
   - Steps: plan tasks 1–2.

2. **BUILD B — Shared session-part renderers** (no deps)
   - Deliverable: `packages/web/src/client/components/session/session-parts.tsx`;
     `SessionView.tsx` refactored to consume it.
   - Acceptance: existing session/log tests pass unchanged; no visual
     difference in `SessionDetail`/`TaskRunsPanel`.
   - Steps: plan tasks 3–4.

3. **BUILD C — Terminal transcript** (predecessor: BUILD B)
   - Deliverable: `components/run-terminal/TerminalTranscript.tsx`,
     `tests/terminal-transcript.test.tsx`.
   - Acceptance: text inline, structured parts in expanding accordions,
     malformed part contained by the boundary, snapshot banner preserved.
   - Steps: plan tasks 5–6.

4. **BUILD D — Command bar** (predecessor: BUILD A)
   - Deliverable: `components/run-terminal/RunCommandBar.tsx`;
     `SessionComposer.tsx` removed; `tests/run-command-bar.test.tsx`.
   - Acceptance: all ported composer behaviors + slash menu + command
     execution + `/cancel` two-step confirm.
   - Steps: plan tasks 7–8.

5. **BUILD E — Immersive shell wiring** (predecessor: BUILD C, BUILD D)
   - Deliverable: rewritten `RunDetail.tsx`; `fillHeight` prop on
     `LogViewer`/`TerminalTab`.
   - Acceptance: criteria 1–7; `?view=`/legacy mapping; clamps; header actions.
   - Steps: plan tasks 9–10 (and 12 if grouped).

6. **BUILD F — Run-page tests** (predecessor: BUILD E)
   - Deliverable: `tests/run-detail-shell.test.tsx` (new),
     `run-detail-terminal.test.tsx` (updated), `run-detail-tabs.test.tsx`
     (removed).
   - Acceptance: criterion 9 for the shell; mocks follow the `--isolate`
     ordering rule.
   - Steps: plan task 11.

7. **BUILD G — Docs** (predecessor: BUILD E)
   - Deliverable: `docs/dashboard.md` Run Detail section.
   - Acceptance: documents view modes and the command table.
   - Steps: plan task 12.

> BUILD E is the integration point; if a reviewer prefers fewer tasks, F can be
> folded into E and G into E. A and B are safely parallel.

## Risks / open questions

1. **Slash commands cannot apply inside the raw attach.** The xterm attach is a
   live PTY; the browser forwards keystrokes and cannot intercept `/logs`.
   Slash commands therefore live in the command bar (`conversation`/`logs`/
   `status`), and `/shell` is presented as a mode switch, not a command
   interpreter. `/help` must say this so the behavior is not read as a bug.
2. **`?tab=` → `?view=` is a user-visible URL change.** Deep links with
   `?tab=` must keep working via the legacy map. No other component emits
   `?tab=` (verified), so only external bookmarks are at risk. Ask the reviewer
   whether to keep accepting `?tab=` indefinitely or drop it after one release.
3. **Default collapse policy for assistant text.** Rendering every assistant
   message as a collapsed accordion would hide the conversation; rendering all
   text inline keeps the thread readable but is less "compact terminal". This
   plan collapses only *structured* parts and leaves text inline. If the
   reviewer wants a fully collapsed stream, add an `/expand` command later —
   flagging as an open design question.
4. **`/cancel` semantics.** `DELETE /api/runs/:name` both cancels an active run
   and deletes a finished one; the header button already conflates them
   (`RunDetail.tsx:185`). Keeping one command with a two-step confirm preserves
   current behavior. If cancel-vs-delete need distinct treatment, that is a
   server concern and out of scope.
5. **Shared-component risk (`LogViewer`/`TerminalTab` `fillHeight`).** Both are
   used by `TaskRunsPanel`; the prop must default to `false` so the board is
   unchanged. The alternative (leave the 600px boxes) wastes viewport inside an
   immersive shell. Chosen: additive optional prop, default off.
6. **`SessionView` extraction regression.** Three consumers depend on it; the
   extraction must be verbatim. Mitigation: do it as its own BUILD task (B)
   with the existing test files as the gate, before any terminal transcript
   work.
7. **Command menu accessibility.** A custom listbox must not trap focus or break
   the existing Enter-to-send flow. Mitigation: `aria-activedescendant` with the
   textarea focused (no focus movement), Escape closes, and the menu only opens
   for a leading `/` token with no space.
8. **Performance.** The transcript can be large; a controlled input that
   re-renders the whole message list on each keystroke would be janky.
   Mitigation: `React.memo` on `MessageEntry`, stable keys, and no derived work
   over `messages` in the command bar.
9. **Screenshot drift.** `docs/dashboard.md` embeds `/images/run-detail.png`,
   which will no longer match. Regenerating screenshots is a separate pipeline;
   note it as a follow-up rather than blocking this task.
