# Plan: HITL "Needs attention" inbox (percussionist-dev-plan-269786)

## Context

**Problem.** Web Push already tells the operator "Task needs your decision" when a
board task enters a human gate, but once that notification is dismissed there is no
quick place *inside the app* to see everything that is waiting on a human. The
operator has to open each project, find the **review** column, and visually pick out
the tasks that are genuinely parked on them.

**Why the in-app surfaces don't cover it today.**

- `packages/web/src/server/lib/push-triggers.ts` fires only on *transitions* into
  `awaiting-human`, `waiting-for-input`, and `failed` (see `PUSHED_TASK_PHASES`),
  and deep-links to `/projects/{project}/board?task={taskName}`. This is
  server-side and works with no tab open.
- The only in-app notification surface is `NotificationBell.tsx` +
  `useNotificationHistory.ts`, backed by the module-level `_history` array in
  `packages/web/src/client/lib/notifications.ts`. That history is **in-memory,
  page-load scoped, and only populated by transitions the client actually
  watched** (`useBoardNotifications.ts` / `useRunNotifications.ts`). Reload the
  page and every pending decision disappears from the bell. A push that fired
  while no tab was open never lands in it at all.
- `awaiting-human`, `waiting-for-input`, and `failed` all map to the single
  **review** board column (`computeBoardColumn` in `packages/api/src/index.ts`
  line 894), mixed in with `succeeded` / `reviewing` tasks that are progressing
  automatically. There is no project-level or global filter for "parked on a
  human".
- There is no cross-project aggregate. `listTasks()` (in `packages/kube/src/index.ts`
  line 662) already returns every Task in a namespace, but the only consumer is the
  push poller.

**Goal.** Add a first-class, server-authoritative **Needs attention** surface so the
operator can answer "what is waiting on me right now?" from within the app, across
all projects, with one click straight to the task (and, where cheap, the action).

## Existing building blocks to reuse

| Concern | Existing code |
|---|---|
| Human-gate phase set | `PUSHED_TASK_PHASES` in `packages/web/src/server/lib/push-triggers.ts` |
| Cross-project task list | `listTasks()` in `packages/kube/src/index.ts` (already used by the push poller) |
| Deep link used by push | `/projects/{project}/board?task={name}`; `BoardView.tsx` reads the `task` search param and selects it |
| Task quick actions | `approveTask`, `requestChangesTask`, `retryEscalatedTask`, `answerTask`, `replyToRun` in `packages/web/src/client/lib/api.ts`; server endpoints in `packages/web/src/server/routes/board.ts` |
| Per-project board worker-run enrichment | `GET /api/projects/:project/board` computes `workerRunPhase` / `workerRunMessage` (board.ts lines 146-285) |
| Nav + route registration | `AppSidebar` (`app-sidebar.tsx`), `App.tsx` route table |
| Auth middleware | `auth()` in `packages/web/src/server/auth.ts` |
| Test conventions | `packages/web/tests/push-triggers.test.ts` (pure logic), `board-move.test.ts` (route + `spyOn(kube)` + `AUTH_DISABLED=1`), `notification-bell.test.tsx` (RTL + MemoryRouter), `app-sidebar.test.tsx` |

## Approach

Build a **global, pull-based HITL inbox** driven by authoritative Task phases, and
make the persistent surfaces (sidebar badge, bell dropdown) read from it so they
agree with what push reported.

Key decisions:

1. **Phase predicate is the source of truth**, matching `push-triggers.ts` exactly:
   `awaiting-human`, `waiting-for-input`, `failed`. Keep one shared constant so the
   push policy and the inbox can never drift.
   - `awaiting-feature-merge` with an open PR (`worker.prNumber` set,
     `!worker.mergedAt`) also needs a human (merge on GitHub) but push deliberately
     does not fire for it and it currently maps to the *in-progress* column. Include
     it as an **opt-in extension** (last BUILD task, low risk), not in the core set.
2. **Pure filter logic in a testable server module**
   (`packages/web/src/server/lib/attention.ts`), mirroring the `push-triggers.ts`
   shape: `isAttentionPhase(phase)`, `attentionReason(task)`, and
   `collectAttention(tasks, runPhaseByRun)`. The route stays a thin adapter.
3. **One new global endpoint** `GET /api/attention` returning
   `{ items, count, generatedAt }`, sorted oldest-waiting-first so stale gates
   surface. No new DB tables, no writes.
4. **One new client page** at `/attention` ("Needs attention") that lists the items
   grouped by urgency, with a deep link to the existing task detail, and inline
   quick actions for the common cases.
5. **Make the bell honest**: add a server-backed "Needs attention (N)" header/link
   at the top of the bell dropdown and fold the count into the bell badge, while
   *keeping* the existing ephemeral event list below it. This is the piece that
   directly answers the complaint ("push said it needs me, but the app shows
   nothing").
6. **Determinism**: assert only on Task phases and known structured fields
   (`lastFailureReason`, `worker.mergeError`, `worker.completedAt`). Never parse
   agent prose. No extra pushes are introduced (the inbox is pull-based), so
   notification fatigue does not increase.

### Scope boundaries

- **In scope:** a read-only aggregation endpoint, a client page, sidebar + bell
  integration, and inline quick actions that call existing endpoints.
- **Out of scope:** changing push delivery/trigger policy; new notification
  sounds; persisting notification history to SQLite; per-user read/unread state;
  cross-namespace aggregation beyond what `listTasks()` already covers; any change
  to the manager/reconciler; mobile-specific redesign beyond responsive reuse.
- **Not touched:** `packages/manager-controller`, `packages/operator`,
  `packages/dispatcher`, CRDs, schemas.

## Proposed BUILD task breakdown

> The orchestrator generates BUILD tasks from this plan. Suggested split, ordered by
> dependency. Each is independently reviewable/testable.

1. **Server attention selection logic** — new `packages/web/src/server/lib/attention.ts`
   exporting `ATTENTION_PHASES`, `isAttentionPhase`, `attentionReason`,
   `attentionDetail`, and `collectAttention(tasks, runPhaseByRun?)`. Unit tests in
   `packages/web/tests/attention.test.ts`. Depends on: none.
2. **`GET /api/attention` route** — new `packages/web/src/server/routes/attention.ts`,
   mounted in `app.ts`; uses `auth()`, `listTasks()`, returns the sorted payload.
   Route tests in `packages/web/tests/attention-routes.test.ts`. Depends on: 1.
3. **Client API + hook** — `fetchAttention()` in `lib/api.ts`, `AttentionItem` /
   `AttentionResponse` types in `lib/types.ts`, `useAttention()` hook (react-query,
   poll + window-focus refetch). Depends on: 2.
4. **Needs attention page** — `packages/web/src/client/pages/AttentionPage.tsx`
   + `/attention` route in `App.tsx`, list rows, reason badges, deep links, loading
   and empty states. Component test `packages/web/tests/attention-page.test.tsx`.
   Depends on: 3.
5. **Sidebar nav + live count badge** — add "Needs attention" to `topNavItems` in
   `app-sidebar.tsx` (icon, active state, collapsed tooltip, count badge from
   `useAttention`). Update `app-sidebar.test.tsx`. Depends on: 3, 4.
6. **Server-backed bell section** — `NotificationBell.tsx` shows
   "Needs attention (N)" linking to `/attention` above the event history; badge
   reflects server count ∪ unread events. Update `notification-bell.test.tsx`.
   Depends on: 3.
7. **Inline quick actions** — approve / request-changes / answer / retry directly
   from `AttentionPage` rows, reusing `approveTask`, `requestChangesTask`,
   `answerTask` + `replyToRun`, `retryEscalatedTask`; optimistic invalidation of
   `['attention']` and `['board', project]`. Tests extend `attention-page.test.tsx`.
   Depends on: 4.
8. **(Optional / stretch) Open-PR attention items** — include
   `awaiting-feature-merge` tasks with `worker.prNumber && !worker.mergedAt`, reason
   "Merge PR #N on GitHub", `detail` from `worker.mergeError` when present. Extend
   `attention.ts` + tests + page badge. Depends on: 1, 4.

## Implementation detail for each task

### 1. `packages/web/src/server/lib/attention.ts`

- Export `ATTENTION_PHASES = ['awaiting-human', 'waiting-for-input', 'failed'] as const`.
- `isAttentionPhase(phase: string | undefined): boolean`.
- `attentionReason(task: Task): string`:
  - `waiting-for-input` → `'Answer agent question'`
  - `awaiting-human` + `task.spec.type === 'PLAN'` → `'Review plan and approve'`
  - `awaiting-human` + `BUILD` → `'Review and approve'`
  - `failed` → `'Failed — retry or abandon'`
- `attentionDetail(task)` (best-effort, never throws):
  - `waiting-for-input` → `task.status?.workerRunMessage`
  - `failed` → `task.status?.lastFailureReason ?? task.status?.worker?.mergeError`
  - `awaiting-human` → undefined (question text needs a session read; out of scope v1)
- `attentionSince(task)` → `worker.completedAt ?? worker.startedAt ?? metadata.creationTimestamp`.
- `collectAttention(tasks, runPhaseByRun?)`:
  - filter with `isAttentionPhase(task.status?.phase)`;
  - optional promotion parity with the board: when `runPhaseByRun` maps the task's
    `worker.runName` to `WaitingForInput`, treat it as `waiting-for-input` even if
    the Task phase is still `running` (the board does this; keeps the inbox
    consistent during reconciler lag);
  - map to `AttentionItem` with `url` = `/projects/${encodeURIComponent(project)}/board?task=${encodeURIComponent(name)}`;
  - sort ascending by `since` (oldest first), then by project/task for stability.

### 2. `GET /api/attention`

- Register `app.route('/api/attention', attention)` in `app.ts` (next to the other
  authed routes; after the usage-lock middleware is fine).
- Handler: `attention.get('/', auth(), async (c) => { const tasks = await listTasks(); ... })`.
  Optionally `listRuns()` to build `runPhaseByRun` for the waiting-for-input
  promotion; if omitted, phase-only is acceptable (matches push policy).
- Response: `{ items, count: items.length, generatedAt: new Date().toISOString() }`.
- Error shape consistent with `board.ts` (`{ error }`, 500 on kube errors).
- Namespace note: `listTasks()` with no `ns` returns the default namespace only.
  This matches the push poller; document it in a comment.

### 3. Client API + hook

- `packages/web/src/client/lib/types.ts`: add `AttentionItem` and `AttentionResponse`
  (client-only view models, alongside `Task` extensions).
- `lib/api.ts`: `fetchAttention(): Promise<AttentionResponse>` via `fetchJSON('/attention')`.
- `hooks/useAttention.ts`: `useQuery({ queryKey: ['attention'], queryFn: fetchAttention,
  refetchInterval: 15_000, refetchOnWindowFocus: true })`. Optionally accept an
  external `eventTick` to invalidate, consistent with existing SSE hooks.

### 4. `AttentionPage.tsx`

- React-query `useAttention()`; render:
  - Header: title + count, short helper text.
  - Loading / error states matching `BoardView` conventions.
  - Empty state: "Nothing needs your attention."
  - Rows grouped by project (or flat oldest-first; group headers by project name with
    a link to that project's board). Each row: PLAN/BUILD icon, title, project chip
    (`projectColor`), reason badge (`text-amber-400` for questions, `text-phase-failed`
    for failed, `text-accent` for awaiting approval), relative age (reuse the `age()`
    helper pattern from `TaskRow.tsx`), agent, and a deep link to the task.
- Deep link uses the exact same URL shape as push so behaviour is identical.
- Register `<Route path="/attention" element={<AttentionPage />} />` in `App.tsx`
  inside the `Layout` outlet.

### 5. Sidebar integration

- `app-sidebar.tsx`: add `{ title: 'Needs attention', url: '/attention', icon: <Inbox/AlertCircle> }`
  to `topNavItems`; active when `location.pathname === '/attention'`; show a count
  pill when `useAttention().data.count > 0`; ensure it collapses correctly
  (`group-data-[collapsible=icon]`) and only fetches when authenticated.
- Add a test in `tests/app-sidebar.test.tsx` asserting the nav item renders and the
  badge shows the count (mock `useAttention`, following the existing module-mock
  pattern).

### 6. Bell integration

- `NotificationBell.tsx`: above the ephemeral list, render a persistent row
  "Needs attention" with the server count and a `Link` to `/attention`. The badge
  should reflect `max(unreadEventCount, attentionCount)` (or a combined count) so a
  push seen while the tab was closed is represented.
- Keep the existing history list and clear-all semantics unchanged.
- Extend `tests/notification-bell.test.tsx`: attention row renders and links to
  `/attention`; existing event-link tests must still pass.

### 7. Inline quick actions

- For each row, conditionally render:
  - `awaiting-human` BUILD → **Approve** (`approveTask`), **Request changes**
    (small inline textarea → `requestChangesTask`), **Open**.
  - `awaiting-human` PLAN → **Approve** (drives buildgen) and **Open**.
  - `waiting-for-input` → **Answer** (inline textarea → `replyToRun` when
    `worker.runName` exists, then `answerTask`), **Open**.
  - `failed` → **Retry** (`retryEscalatedTask`), **Open**.
- On success, invalidate `['attention']` and `['board', project]`.
- Reuse the existing mutation patterns from `TaskDetailPanel.tsx`; do not duplicate
  validation logic beyond requiring non-empty feedback/answer.
- Guard against accidental destructive actions (request-changes and answer require
  typed text; approve/retry are single click as in the detail panel).

## Risks / open questions

1. **Namespace coverage.** `listTasks()` without a namespace only returns Tasks in
   the server's default namespace (`NAMESPACE`, default `percussionist`). Projects in
   other namespaces would be invisible in the inbox — the same gap the push poller
   already has. Options: (a) accept and document for v1; (b) iterate the project list
   and query each distinct namespace. Board routes resolve per-project namespaces, so
   (b) is more correct but N+1. Recommend (a) for v1 with a follow-up issue.
2. **Question text.** The actual agent question is not on the Task CR; surfacing it
   would require reading the run's session snapshot/ConfigMap per item, which is
   expensive. v1 shows a generic reason plus `workerRunMessage`; a full question
   preview is a possible follow-up.
3. **Reconciler lag.** A run can be `WaitingForInput` while the Task phase is still
   `running`; the board compensates with `workerRunPhase`. The inbox should do the
   same via the optional run map, otherwise an item can briefly be missing.
4. **Cost / fan-out.** Polling `GET /api/attention` every ~15 s lists all Tasks in
   the namespace. Acceptable at current scale; revisit with a label selector or a
   manager-maintained aggregate if clusters grow.
5. **Concept overlap.** The bell's event history and the server attention count are
   different concepts; label them clearly ("Needs attention" vs "Recent") to avoid
   double-count confusion. Do not persist the ephemeral history in this change.
6. **`awaiting-feature-merge` (open PR)** genuinely needs a human in `pr` integration
   mode. Including it changes the count vs. what push reports; if included, make it
   visually distinct ("waiting on GitHub") and update `push-triggers` docs in the
   same PR so the two lists are understood to differ. Last task, opt-in.
7. **Auth/ACL.** All authenticated users see all tasks in the namespace; this matches
   existing board behaviour (no per-project ACLs today). No new exposure.

## Acceptance criteria

- [ ] `GET /api/attention` returns every Task in `awaiting-human`,
      `waiting-for-input`, or `failed` with `project`, `taskName`, `title`, `phase`,
      `reason`, optional `detail`, `since`, and a `url` identical to the push deep
      link; `count` matches `items.length`.
- [ ] The endpoint requires a human session (`auth()`) and returns `{ error }` with a
      5xx on Kube errors.
- [ ] `/attention` page lists the items oldest-first, shows loading/error/empty
      states, and each item links to the correct board task.
- [ ] Sidebar shows a "Needs attention" nav item with a live count badge (hidden/zero
      when empty) that collapses correctly.
- [ ] The notification bell shows a persistent "Needs attention (N)" entry linking to
      `/attention`, in addition to the existing event history.
- [ ] Inline quick actions (approve / request changes / answer / retry as applicable)
      update the task and refresh the inbox; failures surface an inline error.
- [ ] Pure filter logic and route are covered by unit/route tests; page, sidebar, and
      bell by component tests under `bun test --isolate`.
- [ ] `pnpm typecheck`, `pnpm lint`, and `pnpm test` pass.
- [ ] No assertion depends on model-generated text.

## Verification

- `pnpm typecheck` and `pnpm lint` at the repo root.
- `pnpm test` (web suite runs `bun test --isolate --preload ./tests/setup.ts tests/`).
- Manual: with a project that has a task in `awaiting-human`, load `/attention`, see
  the item, click through to the board task, and confirm the sidebar/bell counts.
- E2E is not required: the change is read-only aggregation over CR status plus
  existing action endpoints; no new Run/Task lifecycle path is introduced.
