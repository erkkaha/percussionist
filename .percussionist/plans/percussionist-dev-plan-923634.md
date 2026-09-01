# Plan: Allow promoting findings to tasks

## Context

Agents report issues outside their own task via the `report_unrelated_issue`
dispatcher MCP tool. Those findings land in the `{project}-findings` ConfigMap
and are mirrored into `Project.status.board.findings` for UI consumption.

The **manager-controller already has a full implementation** of the
`create_task_from_finding` MCP tool
(`packages/manager-controller/src/agent/tools.ts:2660`). It:

- resolves the finding by `id` or `clusterId` (triaged ConfigMap, falling back
  to board findings),
- picks a PLAN task for `security`/`debt` categories, otherwise BUILD,
- selects a default agent (planner/builder) and priority (critical → high),
- builds a Task CR titled `[Finding] …`, links it back via the
  `percussionist.dev/finding-id` / `percussionist.dev/finding-cluster`
  annotations,
- writes `taskRef` + `status: in-progress` onto the finding so it shows the
  link afterwards.

**The gap is purely on the Web side.** The dashboard's `FindingsPanel`
(`packages/web/src/client/components/board/FindingsPanel.tsx`) only offers
*Resolve / Won't Fix / Duplicate / Reopen* actions (which call the
`update_finding` proxy). There is no "Promote to Task" control, and the Web
server has no route that proxies `create_task_from_finding`. So a human looking
at a finding in the UI has **no way to turn it into actionable work** — they can
only close it out.

This plan adds the missing Web server route + client API + React hook + UI
button, mirroring two existing patterns that already work:

- `POST /api/projects/:name/board/tasks/:task/move` → `moveTask()` → the
  "Promote to Backlog" button in `TaskDetailPanel.tsx:1073` (the UI/mutation
  shape to copy).
- `PATCH /api/projects/:name/findings/:id` → `callManagerTool('update_finding')`
  in `packages/web/src/server/routes/findings.ts` (the proxy/error-mapping
  shape to copy for the new route).

No backend (manager/operator/api) changes are required — `create_task_from_finding`
is already shipped and wired.

## Approach

Add a thin, validated Web server route that proxies to the existing manager
`create_task_from_finding` tool, then expose it through the existing client
stack (`api.ts` → `useFindings` hook → `FindingsPanel` button). Keep the change
surgical: one route handler, one API function, one hook, one button, plus
tests mirroring the existing `findings-routes.test.ts` and
`findings-panel.test.tsx`.

Promotion behavior (delegate to the manager tool):

- Agent/priority are optional; when omitted the manager applies its sensible
  defaults, so the UI needs only a single button (no form).
- The created task starts in the `pending` (backlog) column, exactly like
  "Promote to Backlog" for ideas.
- After success the board query is invalidated, so `f.taskRef` appears and the
  existing "Task: <name>" link renders (already implemented at
  `FindingsPanel.tsx:278`).

UI gating: show the **Promote to Task** button only for findings that are
(a) not already closed (`!isClosedFindingStatus(f.status)`) and
(b) not already linked (`!f.taskRef`). A promoted/linked finding already shows
its task link, so the button is unnecessary there.

## Tasks

1. **Web route: `POST /api/projects/:name/findings/:id/promote`**
   In `packages/web/src/server/routes/findings.ts`, add a `router.post('/:name/findings/:id/promote', adminAuth(), …)` handler.
   - Parse an optional JSON body: `{ agent?: string; priority?: 'high'|'medium'|'low' }`.
   - Validate `priority` against a small local enum (mirror the `status`/severity
     fail-fast checks already in the PATCH handler) — manager validates too, but
     fail fast with 400 on invalid input.
   - Build `args = { project: name, id, agent?, priority? }` and call
     `callManagerTool('create_task_from_finding', args)`.
   - Reuse the existing `parseUpdateResult()` helper (it parses
     `content[0].text` JSON) to return the manager's result object
     `{ project, taskName, findingId, type, agent, priority }` as JSON.
   - Map errors exactly like the PATCH handler: `ManagerMcpHttpError` → 502,
     other errors → 500.

2. **Client API: `promoteFindingToTask()`**
   In `packages/web/src/client/lib/api.ts`, add:
   - `export interface PromoteFindingResponse { project: string; taskName: string; findingId: string; type: 'PLAN'|'BUILD'; agent: string; priority: 'high'|'medium'|'low' }`
   - `export async function promoteFindingToTask(project, id, opts?: { agent?: string; priority?: 'high'|'medium'|'low' }): Promise<PromoteFindingResponse>` using `requestJSON` against
     `/projects/${enc(project)}/findings/${enc(id)}/promote` with `method: 'POST'`
     and the JSON body.

3. **Client hook: `usePromoteFindingToTask()`**
   In `packages/web/src/client/hooks/useFindings.ts`, add a hook mirroring
   `useUpdateFinding`:
   ```ts
   export function usePromoteFindingToTask(project: string | undefined) {
     const qc = useQueryClient();
     return useMutation({
       mutationFn: ({ id, opts }: { id: string; opts?: { agent?: string; priority?: 'high'|'medium'|'low' } }) =>
         promoteFindingToTask(requireProject(project), id, opts),
       onSuccess: () => { qc.invalidateQueries({ queryKey: ['board', project] }); },
     });
   }
   ```
   Import `promoteFindingToTask` from `../lib/api`.

4. **UI button in `FindingsPanel.tsx`**
   - Import `usePromoteFindingToTask` and an icon (e.g. `Plus` or `ArrowRight`
     from `lucide-react`; `ArrowRight` is already imported in `TaskDetailPanel`).
   - Add `const promoteMutation = usePromoteFindingToTask(projectName);`.
   - In the expanded action row (currently a `flex` of close/reopen buttons at
     ~line 289), add a **Promote to Task** button rendered when
     `!isClosedFindingStatus(f.status) && !f.taskRef`:
     ```tsx
     <button
       type="button"
       disabled={promoteMutation.isPending}
       onClick={() => promoteMutation.mutate({ id: f.id })}
       className="…same styling as the existing action buttons…">
       {promoteMutation.isPending ? 'Promoting…' : 'Promote to Task'}
     </button>
     ```
   - Keep `disabled` styling consistent with the Resolve/Won't Fix/Duplicate
     buttons (already `disabled:opacity-50 disabled:cursor-not-allowed`).
   - No extra loading indicator needed: `onSuccess` already invalidates the
     board, so the finding re-renders showing its `Task: <taskRef>` link.

5. **Server route test (mirror `findings-routes.test.ts`)**
   In `packages/web/tests/findings-routes.test.ts` add a `describe` block for
   `POST …/promote`:
   - spy `callManagerTool` (already spied in `beforeAll`),
   - success: `callManagerToolSpy.mockResolvedValue({ content:[{ type:'text', text: JSON.stringify({ project:'proj', taskName:'proj-build-find-abc123', findingId:'f1', type:'BUILD', agent:'builder', priority:'medium' }) }] })` → expect 200 and that `callManagerTool` was called with
     `('create_task_from_finding', { project:'proj', id:'f1' })` (no agent/priority when body empty).
   - invalid priority → 400 (fail-fast, manager not called).
   - manager `ManagerMcpHttpError` → 502; plain `Error` → 500.

6. **Panel UI test (mirror `findings-panel.test.tsx`)**
   Extend `packages/web/tests/findings-panel.test.tsx`:
   - mock `usePromoteFindingToTask` (alongside the existing `useUpdateFinding`
     mock via `mock.module`) recording `mutate` calls,
   - assert the **Promote to Task** button appears for an open,
     not-yet-linked finding (`makeFinding({ id:'f-open', status:'triaged' })`),
   - clicking it calls the promote hook `mutate({ id:'f-open' })`,
   - assert the button is **absent** for a finding that already has
     `taskRef` (already promoted) and for a closed finding.

## Risks / open questions

- **The backend tool already exists** — verify in the running cluster it is
  reachable from the web pod (the web→manager MCP bearer auth is already
  exercised by the `update_finding` route, so no new auth concern).
- **Agent selection**: the manager picks a default planner/builder when `agent`
  is omitted. The UI intentionally does not expose agent/priority pickers to
  keep the change small; if product wants a picker later, it's a trivial
  extension of the optional body. (Open question, not blocking.)
- **Double-promotion**: promoting the same finding twice creates two tasks.
  The button hides once `taskRef` is set (handled by the manager on first
  promotion + our `!f.taskRef` gate), so in normal flow it can't be clicked
  twice. Race clicks are mitigated by `disabled` while pending.
- **`in-progress` status**: the manager sets the promoted finding to
  `in-progress` (open, not closed), so it stays visible and the link shows —
  consistent with expectations.
- No CRD / `@percussionist/api` schema changes are needed; `Finding.taskRef`
  already exists and is rendered.

## Acceptance criteria

- From the board Findings panel, expanding an open finding that is not yet
  linked to a task shows a **Promote to Task** button.
- Clicking it creates a Task CR (PLAN for security/debt, BUILD otherwise) titled
  `[Finding] …`, annotated with `percussionist.dev/finding-id` /
  `percussionist.dev/finding-cluster`, starting in the backlog.
- After promotion the finding shows its `Task: <taskRef>` link (no manual
  refresh).
- The new button is absent for closed findings and for findings already linked
  to a task.
- `pnpm typecheck`, `pnpm test` (incl. the new route + panel tests) and
  `pnpm lint` pass.

## Proposed BUILD task breakdown

- **BUILD 1 — Web route + client API**: Tasks 1–2 (server `POST …/promote`
  handler and `promoteFindingToTask` client function). Shippable and
  independently testable via the route test.
- **BUILD 2 — Hook + UI button**: Tasks 3–4 (`usePromoteFindingToTask` hook and
  the `FindingsPanel` button). Depends on BUILD 1.
- **BUILD 3 — Tests**: Tasks 5–6 (route + panel tests mirroring existing
  suites). Can land with BUILD 1/2 but called out separately so coverage is
  explicit.
