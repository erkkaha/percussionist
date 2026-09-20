# Plan: Concise run summaries for the run list and run detail pages

Task: `percussionist-dev-plan-6a05a6`

## Context

Operator feedback: the run surface exposes plenty of technical metadata but no
concise, human-readable answer to "what is this run for, and what is it doing
right now?" — especially for interactive runs whose `spec.task` is empty.

Relevant existing code:

- **Run CR** (`packages/api/src/index.ts`, `RunSpecSchema`):
  - `spec.project` (required)
  - `spec.boardTask` — Task CR name, set by the manager for every task-backed run
  - `spec.task` — the full worker prompt (board runs) or the operator's prompt text
    (ad-hoc runs); **absent for interactive runs** (`buildWorkerRun` omits it when
    `interactive: true`)
  - `spec.interactive` — authoritative interactive/automated flag
  - `spec.runContext` — `plan-worker | build-worker | review-facilitator |
    merge-worker | facilitator` when set
  - `spec.agent`, `spec.model`
  - `RunStatusSchema`: `phase`, `message`, `sessionID`, `startedAt`,
    `completedAt`, `lastEventAt`, `tokensIn/Out`, `podName`, `serviceName`
- **Run labels** (`worker-builder.ts:330`, `facilitator.ts:582`):
  `LABELS.projectName` (`percussionist.dev/project`) and `LABELS.taskId`
  (`percussionist.dev/task-id`, truncated to 63 chars). `spec.boardTask` is the
  authoritative, untruncated task reference — use it, not the label.
- **Task CR** (`TaskSpecSchema` / `TaskStatusSchema`):
  `spec.projectRef`, `spec.type` (`PLAN`/`BUILD`), `spec.title` (≤256),
  `spec.description`, `status.phase`.
- **Run list API** (`packages/web/src/server/routes/runs.ts`, `GET /api/runs`):
  returns a **stripped** projection — metadata `{name,uid,namespace,creationTimestamp}`,
  `spec.{agent,model}`, `status.{phase,message,sessionID,tokensIn,tokensOut,startedAt,completedAt,lastEventAt,podName}`.
  It does **not** expose `spec.project`, `spec.boardTask`, `spec.interactive`,
  `spec.task`, or any task title, so the UI cannot currently render a purpose.
  Sorting/pagination happen server-side in this route.
- **Run detail API** (`GET /api/runs/:name`): returns the full Run CR.
- **Run list UI** (`packages/web/src/client/components/RunList.tsx`): table with
  Name / Phase / Agent / Model / **Session** / Tokens / Age / actions. Failed
  runs already print `status.message` under the name.
- **Run detail UI** (`packages/web/src/client/components/RunDetail.tsx`): a slim
  sticky header (name, `StatusBadge`, live dot, tokens, actions, `status.message`
  subtitle) plus four views (`conversation`, `logs`, `status`, `shell`). The
  `status` view (`RunOverview`) is purely technical: Status card, Spec card, Task
  text, Conditions, Review verdict.
- **Board route pattern** (`packages/web/src/server/routes/board.ts:150`): already
  joins runs to tasks server-side via `listRuns(ns, undefined, labelSelector)` and
  a `Map`, returning computed view fields (`workerRunPhase`, `childProgress`) —
  precedent for server-side enrichment on a list response.
- **Session data**: `GET /api/runs/:name/session` (`routes/session.ts`) returns
  structured `SessionMessage[]` with `parts[].type === 'tool'` and
  `state.status`, `state.input`, `state.title`. `SessionTimeline.tsx` already does
  a deterministic projection of these parts (`extractTimelineItems`). The client
  hook `useSession(name, enabled, refetchInterval)` is shared by
  `TerminalTranscript` under query key `['session', name]`, so a summary can reuse
  the same cache for free.
- **Stats DB** (`packages/web/src/server/schema.ts`): the `runs` table stores
  `task` = the **full prompt** (`dispatcher/src/stats-reporter.ts` reads
  `RUN_TASK` = `spec.task`) and has **no** `interactive`/`boardTask` column. So the
  DB is a poor primary source for purpose; it only helps for the last line of the
  fallback chain (extracting the `TASK: <name> — <title>` first line of a stored
  prompt).

### Design principles this plan follows

1. **A summary is a derived view, not persisted state.** No new tables, columns,
   or ConfigMap entries. Recomputing on read guarantees the text can never go
   stale or disagree with the CR it describes.
2. **Deterministic derivation only.** No LLM calls, no raw model prose. All text
   is assembled from structured facts (`spec.boardTask` + Task title/type, first
   prompt line, `status.phase`/`message`, and structured tool names/inputs from
   session messages). This matches the repo's deterministic-testing principle and
   keeps output reproducible.
3. **Every activity claim carries its timestamp.** Staleness is shown, never
   hidden.
4. **Explicit unknown.** When there is genuinely no purpose source, render an
   honest "No summary available" state rather than a blank or invented string.

## Approach

### UX

**Run list (`RunList.tsx`)**

Replace the low-value **Session** column with a **Summary** column. The Session ID
is technical metadata and is already available on the detail page; the summary is
what operators asked for. Each summary cell shows, in one compact block:

- **Purpose line** — `[PLAN|BUILD] <task title>` when a Task resolves; otherwise
  the first line of the operator prompt (truncated); otherwise "Interactive
  session"; otherwise the explicit no-summary state.
- **Mode badge** — `INTERACTIVE` or `AUTOMATED` (small, neutral styling; distinct
  from `StatusBadge` variants).
- **Activity line** — a deterministic "<verb> <object>" plus a relative age
  ("last activity 42s ago"). For terminal runs: "Completed in 12m" /
  "Failed — <reason>" / "Cancelled". For an active run with no event inside the
  freshness window: "No activity for 7m".
- Purpose is a link to `/projects/{project}/board?task={boardTask}` when a task
  resolves (the board already reads `?task=` — see `BoardView.tsx:49`).
- The existing failed-run `status.message` under the name stays, but is deduped if
  the summary already carries the same failure reason.

Example rows:

```
run-…-build-a1b2   [BUILD] Add run summary API   AUTOMATED   Editing run-summary.ts · 42s ago
run-…-interactive-x9   [BUILD] Add run summary API   INTERACTIVE   Reading RunDetail.tsx · 3m ago
run-4f3c           Add retry policy to importer   AUTOMATED   Completed in 6m
run-9d21           No summary available            AUTOMATED   Failed — OOMKilled
```

**Run detail (`RunDetail.tsx`)**

- Add a **summary strip** immediately under the sticky header's first row
  (replacing/augmenting today's bare `status.message` subtitle): purpose (task
  link when available) + mode badge + latest activity + "as of" time. The
  existing failed-run banner is unchanged.
- Add a **Summary card at the top of the `status` view** (`RunOverview`) with:
  purpose, linked task (type/title/phase + board link), mode, and latest activity.
  Everything below it stays as-is.
- No-summary state renders muted text, e.g. "No summary available — this run has
  no linked task or prompt." with a `title` explaining it (so it is
  self-explanatory, not just empty).

### Data flow / where things are computed

```
GET /api/runs            → facts: spec.project, spec.boardTask, spec.interactive,
                           spec.runContext, spec.taskPreview, status.*, relatedTask
GET /api/runs/:name      → raw Run + relatedTask
GET /api/runs/:name/session → structured messages (already exists)

client lib/run-summary.ts (pure)  →  RunSummary view model
        ↑ run + relatedTask + sessionMessages + now
```

- The server never renders prose. It exposes the **facts** needed for a purpose
  (`relatedTask`, bounded `taskPreview`, `interactive`) and the existing status
  fields.
- The client's pure `deriveRunSummary()` turns facts into the view model. Being
  pure and framework-free, it is exhaustively unit-testable and identical for
  active, terminal, and deleted runs.

### Purpose derivation (priority order)

1. `relatedTask` present → `${relatedTask.type} · ${relatedTask.title}`
   (`purposeKind: 'task'`).
2. `spec.task` non-empty → first non-empty line, strip a leading `TASK: ` prefix,
   collapse whitespace, truncate to ~120 chars (`purposeKind: 'prompt'`).
3. `spec.interactive === true` → `Interactive session` (`purposeKind: 'interactive'`).
4. Otherwise → `hasSummary: false`, purpose `null` (`purposeKind: 'none'`).

`relatedTask` is the projection `{ name, title, type, phase }` resolved from
`run.spec.boardTask`. When the Task CR is gone (deleted), fall through to (2)/(3)/(4).

### Activity derivation (deterministic)

Inputs: `run.status.{phase,message,startedAt,completedAt,lastEventAt}`,
`sessionMessages`, `now`.

1. **Terminal** (`Succeeded`/`Failed`/`Cancelled`):
   - `Failed` → `Failed — ${truncate(status.message, 80)}` (or "Failed" when no
     message). Timestamp = `completedAt`/`lastEventAt`.
   - `Succeeded` → `Completed in ${duration(startedAt, completedAt)}`.
   - `Cancelled` → `Cancelled` (+ age).
   No in-progress verbs for terminal runs.
2. **Active** (`Pending`/`Initializing`/`Running`/`WaitingForInput`):
   - Scan the newest session message and its parts backwards for the last `tool`
     part. Map `tool` + structured input to a short phrase using a fixed table
     (handles both opencode and claude tool names; unknown tools →
     `Using <tool>`):
     - read / read_file → `Reading <basename>`
     - edit / write / patch / apply_patch → `Editing <basename>`
     - bash / shell → `Running <first token + …>` (e.g. "Running pnpm …")
     - grep / glob / search / codebase_search → `Searching the workspace`
     - write_plan / read_plan → `Working on the plan`
     - todowrite / task → `Updating the task list`
     - fetch / webfetch → `Fetching a URL`
     - default → `Using <tool>`
     Prefer structured `state.input` fields (file path, command); **do not** use
     `state.title` (runner-generated text) as the primary source.
   - No tool part but newest message is an assistant message → `Thinking…`.
   - No tool part but newest message is a user message → `Awaiting agent response`.
   - No session messages:
     - `WaitingForInput` → `Waiting for your input`
     - else use `status.message` **only if** it is a short, non-monospace,
       non-technical phrase (heuristic: no path separators / no `=`, ≤80 chars);
       otherwise fall back to a phase verb (`Starting up` / `Initializing
       workspace` / `Working`).
   - Timestamp = newest message time, else `lastEventAt`, else `startedAt`.
3. **Staleness**: for active runs, if `now - activityAt > 5 min`, append
   `(no activity for Xm)` or, when there is no activity at all, render
   `No activity for Xm`. `activityIsStale` is exposed so the UI can mute it.
4. All activity strings are single-line, ≤~100 chars, newline-stripped, and always
   paired with `activityAt`.

### Refresh / lifecycle

- **List**: `useRunsEvents()` already invalidates `['runs']` on the SSE
  `runs.updated` event, with 5s polling fallback. The summary derives from the
  same query data, so it refreshes for free. Relative ages re-render with the list.
- **Detail**: `useRun` polls every 3s while active and stops on terminal phases;
  `useSession` (shared cache key `['session', name]`) polls at 5s. The summary
  subscribes to both and updates automatically. Gate the session query on
  `hasSession` so runs without a session do not issue a doomed request.
- **Historical**: terminal runs have no polling (`useRun` returns `false`), so the
  summary is computed once and stays fixed — correct, since the underlying data is
  immutable.
- **Deleted runs**: the Run CR disappears after `runTTLDays`; `RunList`/`RunDetail`
  already 404/fall back to the stats DB for sessions. The summary must not throw
  on a missing `relatedTask`; it degrades to the prompt/DB-derived purpose or the
  explicit no-summary state. (List rows only exist while the CR exists, so this is
  mainly a detail-page concern.)

### Persistence decision

**No new persistence.** Rationale: (a) any stored summary can drift from the CR
after a retry, rework, or task rename; (b) the deterministic sources are cheap to
read; (c) avoiding persistence keeps the change small and avoids migration risk.
LLM-generated narrative summaries are explicitly **out of scope**; if wanted
later, they should be persisted with `generatedAt` + `basedOnResourceVersion` and
clearly labelled as generated, which is a separate design.

## Tasks (BUILD breakdown)

Proposed independent BUILD tasks. T1 and T2 can land first; T4/T5 depend on T1–T3.

1. **T1 — Server: expose run purpose facts + related-task enrichment**
   (`packages/web/src/server/routes/runs.ts`)
   - Extend the stripped list projection with `spec.project`, `spec.boardTask`,
     `spec.interactive`, `spec.runContext`, and a bounded `spec.taskPreview`
     (first line, whitespace-collapsed, ≤200 chars; do **not** send the full
     `spec.task`).
   - Build a `Map<taskName, RelatedTask>` from one `listTasks()` call (mirrors
     `board.ts`). Short-circuit the call when no listed run has `boardTask`.
     Wrap in try/catch and degrade to no `relatedTask` on failure (log once).
   - Attach `relatedTask: { name, title, type, phase }` to each item when it
     resolves `spec.boardTask`; omit otherwise.
   - Enrich `GET /api/runs/:name` with the same optional `relatedTask` via
     `getTask(run.spec.boardTask, ns)` when present; omit on 404/error.
   - Do **not** add `listTasks` to the `/api/runs/events` signature (it runs every
     few seconds).
   - Tests in `packages/web/tests/runs-upgrade-routes.test.ts`: relatedTask
     attached when the task resolves; omitted when it does not; list still excludes
     `serviceName` and the full `task`; enrichment failure degrades gracefully;
     detail response still exposes raw run fields.

2. **T2 — Client API types + fetch typing**
   (`packages/web/src/client/lib/types.ts`, `packages/web/src/client/lib/api.ts`)
   - Add `RelatedTask` (`{ name; title; type: 'PLAN' | 'BUILD'; phase?: string }`)
     and `RunListItem = Run & { relatedTask?: RelatedTask }`.
   - Change `fetchRun` / `useRun` to return `RunDetail = Run & { relatedTask?: RelatedTask }`.
   - Change `fetchRunsPaginated` / `fetchRuns` / `fetchTaskRuns` to `RunListItem`.
   - Ensure the stripped spec fields (`project`, `boardTask`, `interactive`,
     `runContext`, `taskPreview`) are declared on the client-facing spec type
     (a `RunSummarySpec` extension) so components type-check.

3. **T3 — Pure summary derivation + unit tests**
   (new `packages/web/src/client/lib/run-summary.ts`, new
   `packages/web/tests/run-summary.test.ts`)
   - Export `deriveRunSummary({ run, relatedTask, sessionMessages, now })`
     returning `{ hasSummary, purpose, purposeKind, mode, activity, activityAt,
     activityIsStale }`.
   - Implement the purpose and activity algorithms above as small exported,
     individually testable helpers (`deriveRunPurpose`, `deriveLatestActivity`,
     `summarizeToolPart`).
   - Unit-test the branch matrix:
     - purpose: task / prompt / interactive / none;
     - mode: interactive true/false;
     - activity: terminal Succeeded/Failed/Cancelled; active with tool part for
       each mapped tool class; assistant vs user newest message; no session;
       `WaitingForInput`; stale boundary at 5 min; deleted-task fallback;
     - guarantee: an assistant text-only message never becomes activity text.

4. **T4 — `ModeBadge` component**
   (new `packages/web/src/client/components/ModeBadge.tsx`)
   - Small badge rendering `Interactive` / `Automated`, reusing the
     `ui/badge.tsx` primitives like `StatusBadge` does. Add an `aria-label`/`title`.

5. **T5 — Run list summary column**
   (`packages/web/src/client/components/RunList.tsx`)
   - Replace the **Session** column with **Summary**.
   - New `RunSummaryCell` using `deriveRunSummary` (no session messages here — the
     list uses purpose + phase/status activity only).
   - Render purpose (board link when `relatedTask`), `ModeBadge`, activity + age,
     and the explicit no-summary state.
   - Update `TableSkeleton` and the mobile `min-w-[…]` width.
   - Optional (confirm with reviewer): an "Interactive" quick filter alongside the
     phase filters.
   - Component test (new `packages/web/tests/run-list-summary.test.tsx`, respecting
     the `--isolate`/`mock.module` rules in `AGENTS.md`): task-linked row shows type
     + title + AUTOMATED; interactive row shows INTERACTIVE; no-source row shows the
     no-summary state; failed row shows the failure reason.

6. **T6 — Run detail summary strip + overview card**
   (`packages/web/src/client/components/RunDetail.tsx`)
   - Add the summary strip under the header; keep the failed banner.
   - Add the Summary card at the top of `RunOverview`.
   - Reuse `useSession(name, hasSession)` for session-derived activity in the
     strip/card (react-query dedupes with `TerminalTranscript`).
   - Link the task to `/projects/{run.spec.project}/board?task={relatedTask.name}`.
   - Component test (new `packages/web/tests/run-detail-summary.test.tsx`): strip
     shows purpose/mode/activity; no-summary state; task link href.

7. **T7 — Docs**
   (`docs/dashboard.md`)
   - Update the "Run Detail" section to describe the summary strip and the new
     Summary card, and add a short "Run list" note (Summary column replaces
     Session; Session ID remains on the detail page).
   - Note that screenshots for the docs are regenerated by the separate pipeline
     (there is already an explicit follow-up callout in that file).

8. **T8 — Verification**
   - `pnpm typecheck`, `pnpm lint`, `pnpm test`.
   - If a live cluster is available, `pnpm e2e:core` (or confirm the run-list /
     run-detail smoke coverage is unaffected). No new E2E fixture is required
     because the feature is deterministic and covered by unit/component tests;
     if one is added, follow `docs/testing-strategy.md` (CRITICAL OVERRIDE fixture,
     assert only CR status/board JSON, never model prose).

## Acceptance criteria

1. Run list rows show a Summary column with purpose, mode badge, and latest
   activity + relative age.
2. Run detail shows the same summary in the header strip and in a Summary card at
   the top of the `status` view.
3. Purpose resolves from the linked Task (`<TYPE> · <title>`) when
   `spec.boardTask` resolves, else the first prompt line, else "Interactive
   session"; a task-linked purpose links to the project board task.
4. Interactive and automated runs are visually distinguishable in both list and
   detail.
5. A run with neither a resolvable task nor a prompt renders an explicit, muted
   "No summary available" state — never blank or fabricated text.
6. Activity text is deterministic, derived only from structured fields; raw model
   prose is never used as activity. Each activity string is accompanied by its
   source timestamp.
7. Active runs with no event in >5 minutes show visible staleness ("No activity
   for Xm"), not a stale in-progress claim.
8. Terminal runs show a completion summary, never an in-progress verb.
9. Runs whose Task CR has been deleted still render (falling back to prompt /
   interactive / no-summary) without errors.
10. `GET /api/runs` adds at most one `listTasks()` call and degrades gracefully
    when it fails; `/api/runs/events` is unchanged.
11. No new database tables, columns, or migrations.
12. `pnpm typecheck` and `pnpm test` pass; new unit/component tests cover the
    purpose and activity branch matrix; existing `runs-upgrade-routes.test.ts`
    still passes.
13. `docs/dashboard.md` reflects the new list column and detail strip.

## Risks / open questions

- **List enrichment cost.** `GET /api/runs` is global (all projects). One
  `listTasks()` per request is the same order as `GET /api/attention` and the
  board route, but if task counts grow large this should become a cached lookup.
  Mitigation now: short-circuit when no row has `boardTask`, and build only a
  minimal projection. Confirm whether a short TTL cache is desired.
- **Task title lookups on deleted tasks.** `relatedTask` is omitted when the Task
  CR is gone; the UI must treat that as normal, not an error.
- **Tool-name vocabulary drift.** opencode and the claude runner use different
  tool names; the mapper must default to `Using <tool>` for unknown names and be
  covered by a test per engine family.
- **`state.title` is runner-generated.** It is deliberately not the primary
  activity source; revisit only if reviewers prefer richer (slightly
  model-influenced) labels.
- **`status.message` is mixed quality** (sometimes technical, e.g.
  "init container …"). The heuristic to only surface short, non-technical
  messages needs a test, and the fallback must never print monospace internals in
  the list.
- **`useSession` on the status view** adds a session fetch for runs that would not
  otherwise need it. Gate on `hasSession` and rely on react-query caching; confirm
  this is acceptable versus deriving activity from logs (rejected: log parsing is
  brittle and not structured).
- **Interactive runs with no task.** A standalone `POST /api/runs` with
  `interactive: true` and no `boardTask` has no purpose source at all; it renders
  the no-summary state. Open question: should the web/CLI create-run form require
  a short purpose/title for ad-hoc interactive runs so a summary always exists?
  (Product decision; not required for this plan.)
- **Mobile/table width.** Replacing Session with Summary keeps the table near its
  current width, but the summary cell must truncate with a `title` tooltip for long
  task titles.
- **CLI/API consumers.** This plan does not add summaries to `beatctl runs` or the
  stats DB API. If parity is desired, reuse the pure helper or expose a server-side
  projection later.
- **`Run` type reuse.** The stripped list object is cast to `Run` today; T2
  introduces `RunListItem` to make the stripped shape explicit and avoid future
  accidental access to fields the list route omits.

## Scope boundaries

- In scope: `GET /api/runs` + `GET /api/runs/:name` enrichment, client types, a
  pure derivation helper, `ModeBadge`, the run list Summary column, the run detail
  summary strip + Summary card, unit/component tests, docs.
- Out of scope: LLM-generated narrative summaries and any persistence for them;
  new DB tables/migrations; CLI output changes; stats-db backfill; board/task UI
  changes beyond the deep link.
