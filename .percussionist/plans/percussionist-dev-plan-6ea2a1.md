# Plan: Dashboard notifications should have links to the content they are relevant to

Task: `percussionist-dev-plan-6ea2a1`
Branch: `feature/percussionist-dev-plan-6ea2a1`

## Context

The web dashboard (`packages/web`) has four notification surfaces, and only the
server-side Web Push path currently carries a destination link:

1. **In-tab browser OS notifications** — `notify()` in
   `packages/web/src/client/lib/notifications.ts`. `NotifyOptions` and the
   in-memory `NotificationEntry` history type have **no URL field**. The OS
   `Notification` is constructed with `{ body, tag, icon }` only — no
   `data.url` and no click handler, so clicking a notification does nothing.
   Entries are recorded in a module-level `_history` array (cap 50, newest
   first) and broadcast via a `percussionist:notification` CustomEvent.
2. **Notification bell dropdown** — `packages/web/src/client/components/NotificationBell.tsx`.
   `NotificationItem` renders a colored dot, title, body, and relative time as
   a plain `<div>` row. Not clickable; no links.
3. **Producers**:
   - `useBoardNotifications.ts` (used by `BoardView`) fires on task worker
     status transitions (Succeeded / Failed / Escalated / Running) with
     `notify({ key, title, body, sound })` — no URL.
   - `useRunNotifications.ts` (used by `Layout`) fires on run terminal phases
     (Succeeded / Failed / Cancelled) — no URL.
4. **Server-side Web Push** — `packages/web/src/server/lib/push-triggers.ts`
   already builds `PushPayload` with `url`:
   - `taskPush` → `/projects/{project}/board` (generic board, does not
     deep-link to the task)
   - `runPush` → `/runs/{name}` (correct destination)
   `packages/web/src/client/public/sw.js` handles `notificationclick` by
   navigating to `data.url`. Tests in `packages/web/tests/push-triggers.test.ts`
   assert these URLs.

**Existing deep-link targets** (from `packages/web/src/client/App.tsx` and
`BoardView.tsx`):
- `/runs/:name` → `RunDetail`
- `/projects/:name/board?task={taskName}` → `BoardView` reads the `task`
  search param (`searchParams.get('task')`) and opens the `TaskDetailPanel`
  for that task — this is the canonical task deep link.

## Approach

Thread an optional app-relative `url` through the entire in-tab notification
pipeline so every notification carries a destination:

1. Add `url?: string` to `NotifyOptions` and `NotificationEntry` (forward
   compatible — existing callers and persisted entries without `url` remain
   valid; UI renders non-clickable rows for entries without a URL).
2. `notify()` persists `url` into the history entry (so the bell dropdown can
   link), passes `data: { url }` to the OS `Notification`, and attaches a page
   `onclick` handler that focuses the window and navigates to the URL.
3. Producers emit the correct deep link:
   - `useBoardNotifications` → `/projects/{projectName}/board?task={taskName}`
   - `useRunNotifications` → `/runs/{name}`
4. The bell dropdown renders entries with a `url` as `Link`s (react-router)
   and closes the panel on click.
5. Bring the server-side push task link up to the same standard:
   `taskPush` deep-links to `?task={name}` instead of the bare board URL.

All URLs must be app-relative and `encodeURIComponent`-escaped, matching the
existing push payload convention.

## Tasks

### A. Notification core (`packages/web/src/client/lib/notifications.ts`)

1. Add `url?: string` to the `NotifyOptions` interface (after `key`, before
   `sound` or at the end — any position, it's optional).
2. Add `url?: string` to the `NotificationEntry` interface.
3. In `notify()`: copy `url` into the history `entry` object so the bell
   dropdown and `useNotificationHistory` consumers see it.
4. In `notify()`: pass `data: { url }` into the OS `Notification` constructor
   options (only when `url` is set, or unconditionally with `undefined`
   tolerated — prefer including it only when defined for cleanliness).
5. In `notify()`: when a `Notification` is actually constructed and `url` is
   set, attach `n.onclick = () => { window.focus(); window.location.assign(url); }`.
   Guard the whole block in the existing `try/catch` (non-fatal on error).
6. Keep the existing behavior for entries without `url` — no click handler
   needed, bell row stays non-clickable.

### B. Producers emit deep links

7. `packages/web/src/client/hooks/useBoardNotifications.ts` — add
   `url: \`/projects/${encodeURIComponent(projectName)}/board?task=${encodeURIComponent(taskName)}\``
   to all four `notify()` calls (Succeeded, Failed, Escalated, Running).
8. `packages/web/src/client/hooks/useRunNotifications.ts` — add
   `url: \`/runs/${encodeURIComponent(name)}\`` to all three `notify()` calls
   (Succeeded, Failed, Cancelled).

### C. Bell dropdown links (`packages/web/src/client/components/NotificationBell.tsx`)

9. Render `NotificationItem` as a react-router `Link` when `entry.url` is
   present: wrap the existing row content in `<Link to={entry.url}>` with the
   same styling, plus `hover` affordance (e.g. `text-text` title emphasis or a
   subtle chevron/arrow icon on the right). Keep the plain `<div>` row for
   entries without a URL.
10. Close the dropdown when a notification link is clicked: pass an
    `onClick` (from `NotificationBell`) into `NotificationItem` that calls
    `setOpen(false)` (and optionally `markAllRead()`), so navigation happens on
    a closed panel.
11. Keep the existing `formatRelative` / dot colors / 30s re-render timer
    untouched.

### D. Server-side push deep link (`packages/web/src/server/lib/push-triggers.ts`)

12. In `taskPush`, change `url` from `/projects/{project}/board` to
    `/projects/${encodeURIComponent(project)}/board?task=${encodeURIComponent(name)}`
    so push notifications land on the specific task's detail panel.
13. Update `packages/web/tests/push-triggers.test.ts` — the `taskPush` test
    expectation for `payload?.url` becomes `/projects/proj/board?task=t1`
    (runPush URL `/runs/r1` is unchanged).

### E. Tests

14. Add `packages/web/tests/notifications.test.ts` (unit, happy-dom):
    - Stub `Notification` (happy-dom has none) with a capture object before
      importing `notify`.
    - `notify({ ..., url: '/runs/r1' })` records an entry whose `url` is
      `/runs/r1` (assert via `getNotificationHistory()`).
    - The constructed OS Notification carries `data.url` and a click handler;
      simulate `onclick()` and assert `window.location` (or a navigator stub)
      is assigned the URL.
    - Entries without `url` produce no `data.url` / handler.
    - Beware module-level `_shown`/`_history` state — use unique `key` values
      per test.
15. Add `packages/web/tests/notification-bell.test.tsx` (component, happy-dom):
    - Render `NotificationBell` inside a real `MemoryRouter` (per AGENTS.md,
      do **not** stub `Link`/react-router — a stub leaks process-globally and
      breaks other tests' `link` role queries).
    - Seed history by calling `notify()` with a unique key and `url`, then open
      the panel (click the bell) and assert a `link` with the expected `href`
      is rendered.
    - Click the link and assert navigation (MemoryRouter location changed or
      panel closed).
    - Assert entries without `url` are not rendered as links.

### F. Verification

16. Run `pnpm typecheck` and `pnpm test` (root; or `pnpm --filter @percussionist/web test`)
    and `pnpm lint` — all must pass (pre-commit hook enforces typecheck+test).
17. Manually smoke-test in dev (`pnpm web`): start a run / move a task and
    confirm (a) bell entries are clickable and navigate, (b) clicking an OS
    notification navigates, (c) push notification opens the task detail panel.

## Scope boundaries

- **In scope**: in-tab OS notifications, bell dropdown, both producer hooks,
  server-side `taskPush` deep link, and tests.
- **Out of scope**: ActivityPage event feed (already links to the board),
  `NotificationsPanel.tsx` settings UI, `sw.js` (already navigates via
  `data.url`; no change needed), `useNotificationHistory.ts` (no change needed —
  it forwards entries unchanged), persistence of notification history beyond
  the in-memory page-load store.
- Notification history remains in-memory per page load (existing design); only
  the shape gains an optional `url`.

## Acceptance criteria

- Every in-tab notification (bell entry and OS notification) produced by
  `useBoardNotifications` / `useRunNotifications` carries a working deep link:
  tasks → `/projects/{project}/board?task={task}` (opens the task detail
  panel), runs → `/runs/{name}`.
- Clicking a bell notification navigates to the linked content and closes the
  panel; entries without a URL remain plain rows.
- Clicking an in-tab OS notification focuses/navigates the app window to the
  URL (no-op safely when permission denied or `Notification` unavailable).
- Server-side push for a task awaiting a human lands on the task's detail
  panel, not just the board.
- `pnpm typecheck`, `pnpm test`, `pnpm lint` pass; existing
  `push-triggers.test.ts` updated to match the new task URL.

## Risks / open questions

- **`Notification` availability**: `notify()` already guards
  (`typeof Notification === 'undefined'`); the click handler must live inside
  that same guard. happy-dom has no `Notification` — tests must stub it
  before calling `notify`.
- **Full page reload on OS-notification click**: `window.location.assign`
  reloads the SPA rather than doing client-side routing. Acceptable (matches
  what `sw.js` does for push); a fancier alternative (router-level event) adds
  coupling to React internals for little gain. If reviewers prefer SPA
  navigation, emit a custom event that `Layout`/`App` listens for — noted as a
  follow-up option, not part of this plan.
- **Auto-close race**: OS notifications auto-close after 6 s; a click after
  close cannot navigate. Acceptable (short window, existing behavior).
- **Module state in tests**: `_history` and `_shown` are module-level and
  persist within a test file — use unique `key`s and reset via
  `_history.splice(0)` if needed; keep `--isolate` in the web test script
  (already configured) so mocks never leak across files.
- **Task names in URLs**: names are k8s object names (safe chars) but
  `encodeURIComponent` is applied for consistency with push payloads.
- **`board-view.test.tsx` mock**: it mocks `useBoardNotifications` to a no-op;
  no change needed there, but new bell tests must not mock react-router.
