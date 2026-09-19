# Plan: Start an interactive run from a work-in-progress Task

Task: `percussionist-dev-plan-6b7ffa`

## Context

Interactive runs already work end-to-end; the missing piece is a way to start
one that is attached to a board Task and works on that task's branch.

What exists today:

- **Run schema** (`packages/api/src/index.ts:651-749`): `spec.interactive`
  (default `false`), `spec.boardTask` (links a Run to a Task), and the refine
  `spec.task is required unless spec.interactive is true` (line 744).
- **Operator** (`packages/operator/src/pod-builder.ts:1155-1156`): sets
  `RUN_INTERACTIVE=1` for interactive runs and suppresses `RUN_TASK`; sets
  `RUN_BOARD_TASK` from `spec.boardTask` (line 1169) and `RUN_GIT_BRANCH` from
  `spec.source.git.ref` (line 1175). `activeDeadlineSeconds` defaults to
  `spec.timeoutSeconds ?? 3600` (line 942).
- **Dispatcher** (`packages/dispatcher/src/index.ts:51-52`, `polling.ts:467-637`):
  in interactive mode it does not auto-prompt; it waits for an attach/web
  session, snapshots periodically, and ends on SIGTERM (pod deadline /
  `kubectl delete run`). It never publishes the branch on its own except in the
  fatal-error path (`index.ts:280`).
- **Web UI**: `TaskRunsPanel.tsx` lists runs by `spec.boardTask` (server filter
  `routes/runs.ts:22-24`) and already renders a **Terminal** sub-tab (WS attach,
  `attach-ws.ts`) for active opencode runs. `TaskDetailPanel.tsx:1153-1242` has
  Approve / Request Changes / Abandon / Retry actions, all of which write Task
  annotations.
- **Manager reconciler**: `buildWorkerRun` (`worker-builder.ts:82-324`) is the
  single Run builder, but it hardcodes `interactive: false` (line 307) and
  always sets `boardTask`. Task actions are consumed from annotations in
  `observe`/`decide`; the manager is the only component that creates Runs.
- **Cleanup**: the operator's run-delete informer spawns a worktree cleanup Job
  for any git-source run (`operator/src/index.ts:57-68`); the task-`done`
  transition additionally cleans every run worktree that carries the
  `percussionist.dev/task-id` label (`reconciler/effects.ts:566-604`).

What is missing:

1. No code path creates a Run for a Task with `interactive: true`.
2. No code path checks out the task's feature branch for an interactive run.
3. No board/CLI/MCP affordance to request one.
4. Committed work in an interactive run is not published to
   `refs/percussionist/<branch>` on graceful shutdown, so it can be lost when the
   worktree is cleaned.

## Scope boundaries

### In scope

- A manager-owned interactive-Run builder that reuses the worker builder's
  config/branch resolution.
- An annotation-driven request flow (`percussionist.dev/action-interactive`) so
  the web UI, CLI, and MCP tool all funnel through the reconciler (the single
  Run-creation authority).
- A board action + REST route + client button to start an interactive run.
- A manager MCP tool `start_interactive_run`.
- Best-effort branch publish when an interactive run ends gracefully.
- Unit tests for the builder, the reconcile pass, the HTTP route, and the client
  action; one deterministic extended E2E test.

### Out of scope

- Changing the Task phase/transition table. An interactive run is an **auxiliary**
  run: it does not modify `Task.status.phase` or `Task.status.worker.runName`,
  and the reconciler's phase decisions ignore it.
- Embedding a live terminal inline in the task detail panel (the existing
  `TaskRunsPanel` Terminal tab already covers attach).
- Multi-user/session arbitration (one interactive run per click; concurrent
  sessions on the same task are the user's responsibility).
- The `claude` engine (no TUI to attach to; the existing Terminal gate already
  explains this).

## Approach

### Key decisions

1. **Auxiliary run, phase untouched.** Starting an interactive run must not move
   the task through the pipeline. If we wrote the interactive run into
   `worker.runName`, the reconciler would route the task on the interactive run's
   phase (which ends only via pod deletion/deadline) and could falsely mark the
   task `succeeded` or `failed`. Keeping the task's phase/worker intact also lets
   the user investigate a `failed`/`running`/`blocked` task without disturbing
   it. The run is linked by `spec.boardTask` + the `percussionist.dev/task-id`
   label, which is exactly what the task Runs list and cleanup already use.

2. **Annotation → reconciler, not web-side Run creation.** All other task actions
   write annotations consumed by the manager, and `buildWorkerRun` lives in
   `manager-controller` (the web package does not depend on it). A dedicated
   reconcile pass reads the annotation and creates the Run. This keeps one Run
   builder and one config-resolution path.

3. **Reuse `buildWorkerRun` via an options object.** Add an optional
   `WorkerRunOptions` argument (`interactive`, `agent`, `model`,
   `timeoutSeconds`) with defaults that preserve current callers exactly. In
   interactive mode the prompt is skipped and `spec.task` is omitted (the
   operator ignores it anyway).

4. **Idempotent, deterministic run naming per request.** The annotation payload
   carries a writer-generated random `id`; the run name is derived from it
   (`interactiveRunName(project, task, id)`), so a retry after a partial failure
   recreates the same name and the `createRun` 409 is adopted instead of
   duplicating the run.

5. **Publish on graceful interactive shutdown.** Add a best-effort
   `gitPublish.publishWorkerBranch()` to the interactive teardown so committed
   HEAD is durable as `refs/percussionist/<branch>` (the human still has to
   `git commit`; uncommitted changes are not published).

### Request flow

```
Board button / CLI / MCP tool
  -> generates id, writes Task annotation percussionist.dev/action-interactive
     JSON: { id, agent?, model?, timeoutSeconds? }
  -> Task informer enqueues the project
  -> reconcileProject() runs processInteractiveRequests() over all tasks
       - skip done/idea (clear annotation)
       - parse + validate payload
       - buildWorkerRun(..., { interactive: true, agent, model, timeoutSeconds })
           source.git.ref = task.status.worker.gitBranch ?? resolveTaskBranch(...)
           source.git.parentRef = task.status.worker.parentBranch ?? resolveParentBranch(...)
       - createRun (adopt AlreadyExists)
       - clear the annotation
  -> operator creates the pod; dispatcher idles in interactive mode
  -> TaskRunsPanel polls /runs?task=<name>; run appears; user attaches (Terminal)
  -> user fixes + commits in the worktree
  -> user deletes the Run (or pod deadline fires) -> dispatcher SIGTERM teardown
       publishes HEAD to refs/percussionist/<branch>
  -> normal task actions (Retry / Request Changes) move the task forward
```

## Files and changes

### 1. Shared contract — `packages/api/src/index.ts`

- Export `INTERACTIVE_RUN_ANNOTATION = 'percussionist.dev/action-interactive'`.
- Export `InteractiveRunRequestSchema = z.object({ id: z.string().regex(/^[a-z0-9]{4,16}$/), agent: z.string().min(1).optional(), model: z.string().min(1).optional(), timeoutSeconds: z.number().int().positive().max(86_400).optional() })` and
  `type InteractiveRunRequest`.
- Export `interactiveRunName(projectName, taskName, requestId)`: DNS-1123 label
  ≤63 chars, `{project}-interactive-{mid}-{requestId}` (pure string ops only —
  the api package must stay browser-safe, so no `node:crypto`).
- Reuse the existing `parseGitHubUrl`-style pure-helper precedent.

### 2. Interactive run builder — `packages/manager-controller/src/worker-builder.ts`

- Add `export interface WorkerRunOptions { interactive?: boolean; agent?: string; model?: string; timeoutSeconds?: number }`.
- Extend `buildWorkerRun(project, task, runName, retryCount, reworkFeedback?, allTasks?, options?)`:
  - `effectiveAgent = options?.agent ?? task.spec.agent`.
  - Model precedence: `options?.model` → `resolveAgentModel(project, effectiveAgent)` → project default; re-run `validateModelAuth` on the final model.
  - When `options?.interactive`: skip all `promptLines` construction and omit
    `spec.task`; set `spec.interactive = true`.
  - Branch override (interactive only, or existing feature-branching condition):
    `task.status?.worker?.gitBranch ?? resolveTaskBranch(task, project, allTasks)` for
    `ref`; `task.status?.worker?.parentBranch ?? resolveParentBranch(...)` for
    `parentRef`. This is important because `resolveTaskBranch` returns
    `undefined` when `featureBranchingEnabled` is false, even if the task has a
    recorded branch — the recorded branch must win for interactive runs.
  - `timeoutSeconds: options?.timeoutSeconds ?? resolved.timeoutSeconds`.
  - Keep labels (`managedBy`, `projectName`, `taskId`), owner reference, and
    `boardTask: taskName` unchanged.
- No change to existing callers (defaults preserve behavior).

### 3. Reconcile pass — new `packages/manager-controller/src/reconciler/interactive-requests.ts`

- `export async function processInteractiveRequests(project: Project, tasks: Task[], namespace: string): Promise<void>`.
- For each task with `metadata.annotations[INTERACTIVE_RUN_ANNOTATION]`:
  - `done`/`idea` → clear the annotation and continue (defensive; the writers
    also reject them).
  - Parse with `InteractiveRunRequestSchema`; on invalid payload log and clear
    the annotation.
  - `runName = interactiveRunName(project.metadata.name, task.metadata.name, req.id)`.
  - `buildWorkerRun(project, task, runName, 0, undefined, tasks, { interactive: true, agent: req.agent, model: req.model, timeoutSeconds: req.timeoutSeconds })`.
  - `createRun(run, namespace)`; swallow `AlreadyExists` (adopt the existing run).
  - Clear the annotation with a `null` merge-patch value — per the repo rule,
    `undefined` is dropped by `JSON.stringify`, so only `null` removes it
    (see AGENTS.md "`undefined` in merge-patches is silently dropped").
  - Best-effort audit event (`persistEvent`/`emitEvent`) describing the created
    `runName`; never fail the pass because of audit.
  - Per-task try/catch: one bad task must not abort the others; on failure leave
    the annotation so the next cycle retries (deterministic name makes this
    idempotent).

### 4. Wire the pass — `packages/manager-controller/src/reconciler/index.ts`

- After the `refreshedTasks` fetch and before the active-task loop, call
  `processInteractiveRequests(project, refreshedTasks, namespace)` inside a
  try/catch so a failure logs and does not abort reconciliation.
- Placing it before the loop means blocked tasks (skipped at line 54) can still
  get an interactive run, which is desirable for debugging a stuck task.

### 5. Manager MCP tool — `packages/manager-controller/src/agent/tools.ts`

- Register `start_interactive_run` in the `TOOLS` array (near `create_run`).
- Handler: require `project` + `task`; optional `agent`/`model`/`timeoutSeconds`;
  resolve namespace; load project/task; reject `done`/`idea`; generate
  `id = randomBytes(4).toString('hex')`; `patchTask` writing the annotation
  (preserving existing annotations) with the same `null`-safe conventions;
  return `{ project, task, runName: interactiveRunName(...), note: 'run will be created by the reconciler on its next reconcile cycle' }`.
- Mirror `create_run`'s style (phase-independent, does not create the Run
  itself).

### 6. Web REST route — `packages/web/src/server/routes/board.ts`

- Add `POST /:project/board/tasks/:taskName/interactive-run` (`adminAuth()`).
- Body: optional `{ agent?, model?, timeoutSeconds? }`.
- Use `getProjectTask(project, taskName)`; reject `done`/`idea` with 400.
- Generate `id` with `randomBytes(4).toString('hex')`, validate the full payload
  with `InteractiveRunRequestSchema`.
- `patchTask` preserving existing annotations, then
  `appendTaskEvent(project, taskName, task.spec.type, 'interactive-run-requested', { runName })`.
- Return `{ success: true, runName }` where `runName` is computed with the shared
  `interactiveRunName` helper.
- Mirror the annotation-writing style of the existing `approve`/`answer` routes.

### 7. Web client action — `packages/web/src/client/lib/api.ts` + `TaskDetailPanel.tsx`

- `api.ts`: `export async function startInteractiveRun(project, taskName, opts?)`
  → `POST /api/projects/:project/board/tasks/:taskName/interactive-run`.
- `TaskDetailPanel.tsx`:
  - Add `startInteractiveRunMutation` (invalidate `['board', projectName]` and
    the task-runs query key; on success switch `tab` to `'runs'`).
  - Add a **Start Interactive Run** button in the action row (import an
    appropriate lucide icon, e.g. `Terminal`), shown for any task whose phase is
    not `idea`/`done`; disabled while pending; label
    `Starting…` → `Start Interactive Run`.
  - Optional: a small timeout preset (e.g. keep project default) — not required
    for acceptance.
- The existing `TaskRunsPanel` polling (5 s) surfaces the new run and the
  Terminal tab appears once `status.podPhase === 'Running'`.

### 8. Publish branch on interactive shutdown — `packages/dispatcher/src/polling.ts`

- In `runInteractive`'s teardown (after the final snapshot and before it
  returns), call `gitPublish.publishWorkerBranch()` (best-effort `.catch`),
  matching the existing fatal-path behavior in `index.ts:280`.
- `RUN_GIT_BRANCH` is already exported as an env var by the operator
  (`pod-builder.ts:1175`) from `spec.source.git.ref`, so no operator change is
  needed; it no-ops when unset (local-git / no-source runs).

### 9. CLI (optional, useful for humans without the board)

- `packages/cli/src/board.ts` + `packages/cli/src/index.ts`: add
  `beatctl board task interactive --task-name <name> [--agent <a>] [--model <m>]`
  writing the same annotation and printing the expected run name. Reuse the
  shared helper; unit-test the arg handling.

### 10. Docs

- Update the task-actions list in `AGENTS.md` (board actions / MCP tool table)
  and the `TaskDetailPanel.tsx` header comment to mention the interactive action.

## Tasks

1. Add `INTERACTIVE_RUN_ANNOTATION`, `InteractiveRunRequestSchema`, and
   `interactiveRunName` to `packages/api/src/index.ts` with focused unit tests
   (name length/sanitization, schema rejects bad ids/negative timeouts).
2. Extend `buildWorkerRun` with `WorkerRunOptions` (interactive/agent/model/
   timeout) and the interactive branch override; add unit tests asserting
   `spec.interactive === true`, no `spec.task`, agent/model override, task branch
   in `source.git.ref`, `boardTask` + `task-id` label, and that the default call
   path is byte-for-byte unchanged.
3. Create `reconciler/interactive-requests.ts` and call it from
   `reconciler/index.ts`; add unit tests for create + annotation clear, idempotent
   re-run on `AlreadyExists`, invalid payload handling, `done`/`idea` clearing,
   and per-task failure isolation.
4. Add the `start_interactive_run` MCP tool in `tools.ts`; unit-test the handler
   (writes annotation, rejects terminal phases, returns the deterministic run
   name).
5. Add the `POST .../tasks/:taskName/interactive-run` route in `board.ts` and the
   `startInteractiveRun` client wrapper; test the route (writes annotation,
   rejects `done`/`idea`, returns `runName`) and the client button behavior.
6. Add the **Start Interactive Run** button to `TaskDetailPanel.tsx`; test that
   it calls the API and switches to the Runs tab.
7. Add the interactive-shutdown publish in `packages/dispatcher/src/polling.ts`;
   unit-test that `publishWorkerBranch` is invoked on interactive teardown and
   that a publish failure is swallowed.
8. Add `beatctl board task interactive` (optional) and update `AGENTS.md` /
   `TaskDetailPanel.tsx` docs.
9. Add a deterministic extended E2E test: apply a Task, invoke the manager MCP
   `start_interactive_run`, assert a Run CR appears with `spec.interactive: true`,
   `spec.boardTask` = the task, and the `percussionist.dev/task-id` label, then
   delete the run and assert cleanup. Register it in `e2e:extended`.

## Acceptance criteria

- From the board task detail, clicking **Start Interactive Run** results in a Run
  CR within a reconcile cycle, with:
  - `spec.interactive: true`,
  - `spec.boardTask` = the task name,
  - label `percussionist.dev/task-id` = the task name,
  - `spec.agent` = the task's agent (or the requested override),
  - `spec.source.git.ref` = the task's branch (`worker.gitBranch` when present,
    otherwise the resolved feature branch / project default),
  - `spec.timeoutSeconds` = requested override or project default.
- The task's `status.phase` and `status.worker.runName` are unchanged by starting
  the run; the reconciler does not observe the interactive run.
- The run appears in the task's Runs tab, reaches `Running`, and the Terminal tab
  becomes available for attach.
- Deleting the interactive run cleans up its worktree (operator delete hook) and,
  on graceful shutdown, committed HEAD was published to
  `refs/percussionist/<branch>`.
- The manager MCP tool `start_interactive_run` produces the same result and
  returns the deterministic run name.
- `pnpm typecheck && pnpm test` pass; the new extended E2E test passes on a live
  cluster.

## Risks / open questions

- **Concurrent worker + interactive run on the same branch.** A hung worker may
  still be running while the human attaches; both worktrees share the branch ref
  in the mirror. Commits can diverge. Mitigation: the interactive run is
  auxiliary and its publish is soft-fail; document that the user should stop a
  live worker run before making conflicting changes. A future enhancement could
  warn when `workerRunPhase` is non-terminal.
- **Uncommitted work is lost.** Branch publish only pushes HEAD. The interactive
  terminal is a real shell, so the user must `git add/commit` (this is normal);
  the plan should add this to the UI helper text.
- **Annotation left behind on repeated reconcile failure.** The deterministic
  run name prevents duplicate Runs, but a writer could write a fresh `id` before
  the previous one is consumed, producing two runs. The writers are single-shot
  so this is unlikely; the reconcile pass clears the annotation on success.
- **`decide`/`buildWorkerRun` regression risk.** The options parameter defaults
  to `{}`, but the builder is the critical worker path. Budget for the full
  existing `worker-builder` test suite plus targeted new tests.
- **Browser-safety of `@percussionist/api`.** `interactiveRunName` must use pure
  string operations; do not add `node:crypto` to the api package (the web client
  imports it).
- **`blocked` tasks.** The dedicated pass runs before the per-task loop, so
  blocked tasks can get an interactive run. Confirm this is desired; if not,
  filter `task.status?.blocked` and document it.
- **Run naming collisions.** `requestId` is 4 random bytes (8 hex chars); if a
  project name plus task name is already near the 63-char limit, the helper must
  truncate the middle segment without producing an invalid label (covered by
  tests).

## Proposed BUILD task breakdown

1. **BUILD A — Shared contract + interactive builder** (agent: `builder`)
   - `packages/api/src/index.ts`: annotation constant, request schema,
     `interactiveRunName` + tests.
   - `packages/manager-controller/src/worker-builder.ts`: `WorkerRunOptions`,
     interactive branch/timeout/prompt handling + tests.

2. **BUILD B — Reconciler interactive pass** (agent: `builder`, depends on A)
   - New `reconciler/interactive-requests.ts`, wire into `reconciler/index.ts`,
     annotation clear with `null`, idempotent `createRun`, per-task isolation +
     tests.

3. **BUILD C — Manager MCP tool** (agent: `builder`, depends on B)
   - `start_interactive_run` in `agent/tools.ts` + tests.

4. **BUILD D — Web API route + client wrapper** (agent: `builder`, depends on A)
   - `board.ts` route, `appendTaskEvent`, `api.ts` `startInteractiveRun`, route
     tests.

5. **BUILD E — Board UI button** (agent: `builder`, depends on D)
   - `TaskDetailPanel.tsx` mutation/button/tab switch + client test; update the
     header comment.

6. **BUILD F — Publish branch on interactive shutdown** (agent: `builder`, independent)
   - `packages/dispatcher/src/polling.ts` teardown publish + tests.

7. **BUILD G — Optional CLI + docs** (agent: `builder`, depends on A)
   - `beatctl board task interactive`, `AGENTS.md` update.

8. **BUILD H — Deterministic extended E2E** (agent: `builder`, depends on C and E)
   - New test file under `tests/e2e/`, add to `e2e:extended`.
