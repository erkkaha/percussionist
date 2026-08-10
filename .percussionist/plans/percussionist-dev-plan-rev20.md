# Dashboard bug sweep: log tail corruption, reconnect hammering, chat message loss, dead session links, form focus loss

Task: `percussionist-dev-plan-rev20`
Scope: `packages/web/src/client` (client-side dashboard fixes). Zero API/CRD changes.

## Context

Eight confirmed client-side bugs live in the web dashboard. All are render/poll
lifecycle bugs in `packages/web/src/client`. Root causes and the exact code we
need to touch are verified below against the checked-in source.

| # | Bug | File(s) | Root cause |
|---|-----|---------|-----------|
| 1 | Log tail corruption / dropped output | `components/LogViewer.tsx:201-205` | Append-by-character-offset on a server tail-N response. Data is NOT append-only once the log exceeds the window. |
| 2 | Reconnect backoff never grows | `components/TerminalTab.tsx:108-109,72-73` | `retryCountRef` reset to `0` on every `connect()`, so `500 * 2^0` forever. |
| 3 | Chat drops repeated messages; auto-scroll never fires | `components/AgentChatPanel.tsx:70-72,133-138,255-258` | Identity = role+text; auto-scroll effect runs once with empty deps while panel closed. |
| 4 | Session links dead for runs older than TTL | `components/SessionList.tsx:255-259`, `components/SessionDetail.tsx:80` | List from stats DB (30d), detail fetches the Run CR (deleted after `runTTLDays`, default 7). |
| 5 | CreateRunForm agent row focus loss | `components/CreateRunForm.tsx:337-338` | Row React keyed by the name being typed; empty-name rows collide on `key=""`. |
| 6 | SessionView can blank the whole run page | `components/SessionView.tsx:334-352` | Unguarded `part.state.input.todos` on an unvalidated proxied payload; no error boundary. |
| 7 | Activity "Load more" prepends older events | `pages/ActivityPage.tsx:245-251` | Backwards pagination merges with prepend, breaking date grouping. |
| 8a | "Default notification sound" persisted but never used | `components/NotificationsPanel.tsx:140-154`, `lib/notifications.ts:267-277`, `stores/settingsStore.ts` | `notify()` always calls `playDrum(opts.sound)`; `selectedSound` is never read. |
| 8b | Push toggle permanently "Unavailable" (SW race) | `components/NotificationsPanel.tsx:26-34`, `lib/pwa.ts:17-36` | `isPushSupported()`/`getPushSubscription()` read a module var populated only after `window.load` + async `.then`. |

## Approach

Eight small, isolated client-only fixes. Each is confined to a single component
(and, for 8a/8b, the notifications store / pwa module). We keep behavior
changes minimal and non-breaking.

1. **LogViewer** — replace character-offset slicing with two robust strategies
   (chosen by the implementer, both described below): either (a) diff by
   content-overlap (drop a shared prefix, append the remainder), or (b) a
   periodic reset+rewrite. Recommendation is content-overlap diff with a
   "payload shrank" fallback to reset+rewrite. Reset `writtenLenRef` on any
   tail/container switch as today.

2. **TerminalTab** — move `retryCountRef.current = 0` from `connect()` into
   `ws.onopen`. Reset it in the mount/cleanup and in the manual "Reconnect"
   button only (that path is an intentional fresh attempt where resetting is
   fine, since the user asked for an immediate retry). Back off on every
   `onclose`-scheduled retry so a failed attach stops hammering the server.

3. **AgentChatPanel** — introduce a stable per-instance message identity:
   - Keep `msg.id` when the server/SSE supplies one.
   - For locally-created messages (optimistic user send, system/error bubbles),
     assign a monotonically increasing `clientSeq` and key on
     `msg.id ?? clientSeq`, so "yes" twice renders twice without duplicate keys.
   - Change the auto-scroll effect dependency array to `[messages, open]` and
     guard on `open`.

4. **SessionDetail** — render the detail from the stats DB record and treat the
   live Run CR as enrichment:
   - Add a `fetchSessionStat(name)` client API hitting a (slight) server change:
     extend `GET /api/stats/sessions` filtering, or add `GET /api/stats/sessions/:name`
     returning a single `StatSession`. The plan proposes the server adds a
     name-filtered lookup so the DB row (which always outlives the Run CR) is the
     source of truth.
   - `SessionDetail` uses the stat for phase/model/tokens/duration/costs and the
     Run CR (when present) for pod/spec details + session messages. When the Run CR
     is gone, the page must still render from the DB record and reach the session
     snapshot/DB messages — never "Failed to load session".
   - The heavy session-conversation `SessionView` requires the Run CR to resolve
     the service name today. For a deleted run we must fall back to the DB-persisted
     messages or the archived snapshot ConfigMap. This is the riskiest part — see
     Risks/Open questions.

5. **CreateRunForm** — mirror the `nextSidecarId()` pattern from
   `components/project-form/useProjectForm.ts`: module-level `_agentRowIdSeq` +
   `nextAgentRowId()`, add a stable `id` to each inline-agent row in state, key
   the row `div` on that id, and update `updateAgent`/`removeAgent` to address by
   id. `addAgent` assigns `nextAgentRowId()`.

6. **SessionView** — use optional chaining on the `todowrite` tool state:
   `part.state?.input?.todos` with an `Array.isArray` guard (already present).
   Additionally add a small reusable `ErrorBoundary` (React class component) and
   wrap `SessionView`/`SessionDetail` content so one malformed part cannot blank
   the whole page. The boundary is new, reused by the session pages.

7. **ActivityPage** — when paginating backwards (`before` set), append fetched
   older events to the tail (`[...prev, ...fresh]`) instead of prepending. Keep
   the prepend behaviour for polling/refresh (`replace` or periodic poll), since
   polling returns the newest page sorted newest-first. This keeps date grouping
   monotonic (newest at top, older appended below).

8a. **Notification sound** — the per-event drum design is clearly intentional
   (`NOTIFICATION_SOUNDS` descriptions tie each sound to an event). Two options:
   - **Remove** (recommended) the persisted-but-unused `selectedSound` select and
     the `selectedSound`/`setSelectedSound` store members, keeping the per-event
     drum + `playDrum` preview. Low risk, removes a dead control.
   - **Honor** it by consulting `selectedSound` in `notify()` and playing that one
     sound for every event type. This contradicts the existing per-event
     descriptions/preview and is more misleading.
   Plan recommends **remove**. Keep `soundEnabled` (it IS read).
8b. **Push toggle race** — `isPushSupported()` and `getPushSubscription()` read
   `_registration` which is only set after `window.load` + async register.
   Replace the module-var late-write with an async `navigator.serviceWorker.ready`
   await: expose an async `waitForServiceWorkerRegistration()` (or make
   `getPushSubscription`/`subscribeToPush` `await navigator.serviceWorker.ready`
   then re-check registration), and make `PushSection` resolve push state
   asynchronously rather than synchronously on mount. Remove reliance on the
   timing of `pwa.ts::_registration` for correctness (it becomes a cache only).

## Tasks

Numbered BUILD steps, each independently committable. Order matters only where a
later step touches a file an earlier one owns.

### BUILD 1 — LogViewer tail correction
`packages/web/src/client/components/LogViewer.tsx` (+ tests `tests/log-viewer.test.tsx`)
- Implement content-overlap diff in `writeData()`:
  1. If `lastKeyRef` changed (container/tail switch) → `term.reset()`, `writtenLenRef=0`, write full payload.
  2. Else compute the longest overlapping suffix-prefix between the previously written content and the new payload; write only the new remainder; set `writtenLenRef` to the new payload length.
  3. If no overlap is found OR the new payload is shorter than what we already wrote (log window dropped lines we'd already shown), fall back to `term.reset()` + full rewrite so the terminal stays consistent.
- Keep mirrors (`dataRef`, `keyRef`, `autoScrollRef`) and the loading/error sentinel behaviour intact so the mount effect and existing tests keep passing.
- Add regression tests: (a) short payload followed by longer payload appends correctly; (b) once payload exceeds a small tail window, no garbling/duplication (payload that "moves forward" without overlap forces a reset); (c) container/tail switch triggers full reset.

### BUILD 2 — TerminalTab backoff
`packages/web/src/client/components/TerminalTab.tsx` (+ existing `tests/run-detail-terminal.test.tsx` if it asserts backoff)
- Remove `retryCountRef.current = 0;` from inside `connect()` (line ~109).
- Add `retryCountRef.current = 0;` inside the `ws.onopen` handler (in addition to `readinessRef.current = false;`).
- Keep the reset in the mount `useEffect` cleanup and in the "Reconnect" button handler (intentional manual fresh start).
- Add/adjust a test asserting that after a failed attach (`onclose` without onopen) the backoff increases (second scheduled retry delay > first), i.e. the counter was not reset.

### BUILD 3 — AgentChatPanel identity + auto-scroll
`packages/web/src/client/components/AgentChatPanel.tsx`
- Add `let _clientSeq = 0` module counter + a helper that returns a stable key for a message: `msg.id ?? \`client-\${++_clientSeq}\``.
- Replace `messageKey()` (role+text) as the dedup/identity: seed `seenKeysRef` from loaded history using server `id`s when present (fall back to role+seq for history items lacking id so they render); dedup new incoming SSE/response messages by the same stable key.
- `sendText()` optimistic user bubble gets a `clientSeq` so two identical "yes" renders; identical assistant replies from the server with distinct `id`s render.
- Change the auto-scroll effect deps to `[messages, open]`, and move the `scrollIntoView` behind an `open` guard so it fires when new messages arrive while visible (not once at mount while closed).
- Ensure no duplicate React keys remain across render.

### BUILD 4 — Dead session links
`packages/web/src/server/routes/stats.ts`, `packages/web/src/server/routes/session.ts`, `packages/web/src/client/lib/api.ts`, `packages/web/src/client/components/SessionDetail.tsx`, `packages/web/src/client/components/SessionList.tsx`
- Server: add a name-filtered session lookup. Either extend the sessions query to accept `name=` (exact match) or add `GET /api/stats/sessions/:name`. Return the existing `StatSession` shape. Minimal change: filter the same select by `eq(runs.name, name)` and return the single row (or 404).
- Client `lib/api.ts`: add `fetchSessionStat(name)`.
- `SessionDetail`: fetch the stat first; render header/cards from it (phase, model, tokens, duration, ages, error). Fetch the Run CR as enrichment only for pod/service/spec fields and to drive live session polling. If the Run CR is missing (deleted after TTL), do NOT show "Failed to load session"; still render the stat and attempt to load the session conversation.
- Session conversation for a deleted run: the web server's session route currently needs the Run CR for serviceName/sessionID. Wire `hasSession`/`SessionView` to use the stat's persisted messages when the run pod is gone. Since messages are persisted in the `messages` DB table per session, consider a server fallback route that returns stored messages by run name when live + snapshot are unavailable (Risk/Open Q — see below for the bounded recommendation).
- `SessionList`: keep linking to `/sessions/:name`; no change needed if detail now self-heals.

### BUILD 5 — CreateRunForm stable agent row keys
`packages/web/src/client/components/CreateRunForm.tsx`
- Add module-level `let _agentRowIdSeq = 0; function nextAgentRowId(){ return ++_agentRowIdSeq; }` (mirror `nextSidecarId`).
- Change `agents` state to `Array<{ id: number; name: string; content: string }>`.
- `addAgent` pushes `{ id: nextAgentRowId(), name: '', content: '' }`.
- `updateAgent(index, ...)` → `updateAgent(id, ...)`; `removeAgent(index)` → `removeAgent(id)`.
- Row `div` keyed on `a.id` (not `a.name`). Two fresh empty rows now have distinct keys; typing a name no longer remounts/loses focus.

### BUILD 6 — SessionView guard + error boundary
`packages/web/src/client/components/SessionView.tsx`, new `packages/web/src/client/components/ErrorBoundary.tsx`, `packages/web/src/client/components/SessionDetail.tsx`
- In the `todowrite` render block use `part.state?.input?.todos` (optional chains on `state` and `input`), keeping the existing `Array.isArray` check.
- Add a small class `ErrorBoundary` (props: `fallback?: ReactNode`) with `componentDidCatch`/`getDerivedStateFromError`. Wrap each `SessionView` message bubble render OR the `SessionDetail` session card so a single malformed part renders an inline fallback instead of unmounting the page. Prefer a boundary that catches the whole `SessionView` and falls back to a message, while still letting the header/cards render.
- Add a regression test: a `todowrite` part whose `state.input` is missing does not throw and page still renders.

### BUILD 7 — Activity "Load more" ordering
`packages/web/src/client/pages/ActivityPage.tsx`
- In the `setEvents` merge: when `before` is set (backwards pagination), return `[...prev, ...fresh]` (append). When `replace` OR a periodic poll (no `before`), keep prepend (`[...fresh, ...prev]`).
- `oldestId` tracking stays; dedup by id stays.
- Add/verify a test: loading older events appends them below existing events; date grouping stays monotonic.

### BUILD 8a — Notification sound control
`packages/web/src/client/stores/settingsStore.ts`, `packages/web/src/client/components/NotificationsPanel.tsx`, `packages/web/src/client/lib/notifications.ts`
- Recommended: remove `selectedSound` + `setSelectedSound` from `NOTIFICATION_SETTINGS`/store/`NotificationSettings`. Remove the "Default notification sound" select block from `NotificationsPanel` (lines ~140-154). Keep `NOTIFICATION_SOUNDS`, the per-event `playDrum`, `soundEnabled`, and the "Preview sounds" list.
- Update `tests/notifications.test.ts` if it asserts on `selectedSound`.
- (Alternative, if reviewer prefers honoring: read `prefs.selectedSound` in `notify()` and play that single sound regardless of `opts.sound`. Plan recommendation is removal.)

### BUILD 8b — Push service-worker race
`packages/web/src/client/lib/pwa.ts`, `packages/web/src/client/lib/push.ts`, `packages/web/src/client/components/NotificationsPanel.tsx`
- Add `waitForServiceWorkerRegistration(): Promise<ServiceWorkerRegistration | null>` that awaits `navigator.serviceWorker.ready` (with `ready` being the reliable "at least one active worker" signal) and returns `navigator.serviceWorker.getRegistration('/sw.js')`.
- Update `isPushSupported()` to remain a cheap sync check (guard), but update `getPushSubscription()`, `subscribeToPush()`, and `PushSection` to `await waitForServiceWorkerRegistration()` before reading `pushManager`, instead of trusting `getServiceWorkerRegistration()` timing.
- `PushSection` initial effect becomes async: await registration before deciding `unsupported` vs `ready`, so the toggle no longer permanently shows "Unavailable" when the SW is still registering after `load`.
- Update `tests/push.test.ts` / `tests/push-triggers.test.ts` / `notification-bell.test.tsx` as needed (they may mock `pwa`).

## Scope boundaries

- **In scope:** the 8 dashboard bugs above, plus tests that assert the fixed
  behaviour in `packages/web` (`bun test` under `packages/web`; `pnpm test`
  root for the full gate).
- **Out of scope:** server metrics pipeline, CRD/Run reconciler changes, the
  `runTTLDays` default itself, and OpenCode/dispatcher internals. Bug 4 requires
  a *small* additive `stats.ts` / `session.ts` change to serve persisted session
  data for deleted runs; that server work is in scope because the client fix
  cannot work without it, but it should be additive and not alter existing
  endpoints' shapes.
- **Not changing:** the terminal/`xterm` integration beyond the tail-window
  write logic; no CSS/design changes; no store-layout refactors beyond
  removing the dead `selectedSound`.

## Risks / open questions

1. **Bug 4 death-links is the highest-risk item.** `SessionView`/session route
   require the Run CR + live service or snapshot ConfigMap to show the
   conversation. Once the Run CR is TTL-deleted, the session snapshot ConfigMap
   may also be gone, so the only durable source is the `messages` DB table
   persisted by the dispatcher's stats POST. Recommendation: add a server route
   to replay stored messages from the DB by run name (bounded by what the DB
   has), and have `SessionDetail` fall back to it. This is additive; the 
   implementer should confirm the `messages` table columns suffice (role, text/
   content, tool state JSON) to reconstruct `SessionView`-compatible parts. If
   reconstruction fidelity is poor, an acceptable interim is: show header/cards
   from the stat + a clear "session conversation archived" note. Flag for the
   reviewer which level is delivered.
2. **LogViewer overlap diff** can be O(n) with `endsWith`/`indexOf` on growing
   strings; at 500–1000 tail lines this is fine. Guard against pathological
   non-termination by capping the overlap search and falling back to reset.
3. **8a removal vs honor** is a product decision; I flagged **remove** as the
   default because the per-event design is explicit. If the reviewer prefers a
   user-selectable default, that changes `lib/notifications.ts:notify()` only and
   reuses existing store plumbing.
4. **ErrorBoundary** is a new shared component; keep it tiny and route-default
   so it does not over-catch (it should show a fallback + console.error, not
   swallow). Existing tests use `--isolate`; ensure the new class component
   doesn't introduce TestID/mocking surprises (see AGENTS.md web test notes).
5. **TerminalTab test infrastructure** — the onopen/backoff assertion needs to
   drive the real `connect()`/`scheduleRetry` path; if `run-detail-terminal`
   mocks WebSocket, extend it to simulate `onclose` without `onopen`.

## Acceptance criteria

- **LogViewer:** long-running run (tail payload > window) shows continuous,
  non-duplicated output; no mid-line garbling after the window slides; switching
  container/tail resets cleanly; existing auto-scroll/container-label tests pass.
- **TerminalTab:** retry delay grows on repeated failed attaches (500ms → 1s →
  … up to 10s capped); reset to 500ms only after a successful `onopen` or a
  manual "Reconnect".
- **AgentChatPanel:** sending "yes" twice renders two bubbles; identical
  assistant replies render; no duplicate-key React warning; auto-scroll fires on
  each new message while the panel is open.
- **SessionDetail:** clicking any past **session row** renders a detail page
  (header/cards from DB stat); runs beyond `runTTLDays` do NOT show "Failed to
  load session"; conversation either loads from the DB replay or shows an
  explicit archived notice (per Risk 1).
- **CreateRunForm:** typing an inline-agent name keeps focus in that row; two
  empty rows render with distinct row identities; `agents.length` cap still
  applies.
- **SessionView:** a `todowrite` part missing `state.input` renders gracefully;
  a single malformed part does not unmount the run/session page (error boundary).
- **ActivityPage:** "Load more" appends older events below today's; date groups
  remain in descending chronological order; polling prepend still works.
- **8a:** `selectedSound` no longer advertised as a control (removed) OR honored
  by `notify()`; `soundEnabled` still controls audio.
- **8b:** on a supported origin the push toggle resolves to a live switch (not a
  permanent "Unavailable") even when the service worker finishes registering
  after initial render.
- `cd packages/web && bun test` passes; root `pnpm typecheck && pnpm lint && pnpm test` pass.

## Proposed BUILD task breakdown

This is a single PLAN producing eight independent BUILD tasks (one per bug
area). Order of BUILD generation/execution:

1. `BUILD: session-view-todowrite-guard` — Bug 6 (smallest, unblocks page stability) — also introduces `ErrorBoundary`.
2. `BUILD: create-run-form-stable-agent-keys` — Bug 5 (isolated).
3. `BUILD: activity-load-more-appends` — Bug 7 (isolated).
4. `BUILD: terminal-tab-backoff` — Bug 2 (isolated).
5. `BUILD: agent-chat-panel-message-identity` — Bug 3 (isolated but interacts with SSE shape).
6. `BUILD: log-viewer-tail-diff` — Bug 1 (isolated, lowest regression risk).
7. `BUILD: push-service-worker-race` — Bug 8b (isolated).
8. `BUILD: notification-sound-control` — Bug 8a (isolated; small).
9. `BUILD: session-detail-dead-links` — Bug 4 (largest; touches server `stats.ts`/`session.ts` and client `SessionDetail`; recommend last so it can build on the `ErrorBoundary` and DB-replay work).

Each BUILD commits independently; all land on the feature branch and are
reviewed+merged incrementally. `BUILD` tasks 1–8 are fully parallelizable;
task 9 has a soft dependency on task 1 (`ErrorBoundary`) and Risk 1's server
fallback decision.