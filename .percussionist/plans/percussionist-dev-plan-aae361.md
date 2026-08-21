# Plan: Allow closing/triaging findings from the UI

## Task
`percussionist-dev-plan-aae361` — Findings cannot be closed from the UI when they are
fixed or not relevant. Add a UI affordance to change a finding's status (resolve,
mark won't-fix / duplicate, reopen) for the board-level findings surfaced via the
`report_unrelated_issue` MCP tool.

---

## Context

### Where findings come from
- Agents call the dispatcher's `report_unrelated_issue` MCP tool. The dispatcher writes
  each report into the per-project `{project}-findings` ConfigMap inbox.
- The manager reconciler (`packages/manager-controller/src/reconciler/findings-ingestion.ts`)
  reads the inbox, deduplicates (exact `dedupKey`, file+snippet hash, optional semantic),
  and writes a curated, deduplicated view into `Project.status.board.findings`
  (capped at `MAX_BOARD_FINDINGS = 100`, newest-first by `triagedAt`).
- The curated view is the source of truth the UI renders.

### Backend capability already exists
- The manager MCP server (`packages/manager-controller/src/agent/tools.ts`) already
  exposes `update_finding` (schema ~line 822, handler ~line 2598). It accepts
  `project`, `id` (matching `f.id` or `clusterId`), and optional `status`,
  `severity`, `category`. It patches the triaged ConfigMap entry **and** rebuilds
  `board.status.findings`. So the ability to "close" a finding is already present
  server-side — only the web UI path is missing.
- Status enum (`packages/api/src/index.ts`, `FindingStatus`):
  `new | triaged | in-progress | resolved | duplicate | wontfix`.
  "Closed" = `resolved` / `duplicate` / `wontfix`. "Reopen" = back to `triaged`.

### UI today (read-only)
- `packages/web/src/client/components/board/FindingsPanel.tsx` renders
  `status.findings` (passed from `BoardView.tsx`, which loads `fetchBoard` into the
  `['board', projectName]` react-query key). It shows severity/category/status badges
  and an expandable detail view, but offers **no control** to change a finding's status.
- The web server already proxies to the manager MCP server for other features via
  `callManagerTool` (`packages/web/src/server/lib/manager-mcp.ts`), e.g. `plans.ts`,
  `upgrade.ts`, `project-memories.ts`. The pattern for a new findings route is
  well established.

### Durability of a close
- `findings-ingestion.ts` merges new inbox items against the existing triaged set and
  **preserves** `canonical.status` (it only bumps `occurrences`/`triagedAt` on a
  duplicate match; it never resets status). So a finding closed via `update_finding`
  stays closed across reconcile cycles. Acceptable minor quirk: a duplicate re-report
  moves `triagedAt` forward, so a closed item may re-sort to the top — noted as low risk.

---

## Approach

Add a thin web API route that proxies `PATCH` to the manager's `update_finding` MCP
tool, a typed client wrapper + react-query mutation that invalidates the board query,
and action controls in `FindingsPanel` to set terminal statuses and reopen. No changes
to the manager or the CRD schema are required.

### Files to add / modify
1. **Add** `packages/web/src/server/routes/findings.ts`
   - `PATCH /api/projects/:name/findings/:id`
   - Parses a JSON body `{ status?, severity?, category? }`; rejects with `400` if no
     field is supplied or values are non-empty but invalid (the manager validates too,
     but fail fast client-side).
   - Calls `callManagerTool('update_finding', { project: name, id, ...body })`.
   - Error mapping (mirror `plans.ts` / `project-memories.ts`):
     `ManagerMcpHttpError` → `502`; JSON-RPC / transport errors → `500`.
   - Returns the tool result (`{ project, finding, updated }`) as JSON.
   - Guard with `adminAuth()` (any human session is admin; API keys get 403 — same
     posture as other mutating endpoints like `project-memories.ts`).
   - Register in `packages/web/src/server/app.ts`:
     `import findings from './routes/findings.js';` and
     `app.route('/api/projects', findings);` (distinct subpath; no clash with
     `:name/memories`, `:name/plans`, `:name/board`).

2. **Add** request type in `packages/web/src/client/lib/types.ts`
   - `export interface UpdateFindingRequest { status?: Finding['status']; severity?: Finding['severity']; category?: Finding['category']; }`
   - (import `Finding` is already available in that file).

3. **Add** client wrapper in `packages/web/src/client/lib/api.ts`
   - `export async function updateFinding(project: string, id: string, req: UpdateFindingRequest): Promise<{ project: string; finding: Finding; updated: boolean }>`
   - Implementation: `requestJSON(... /projects/${project}/findings/${id} ..., { method: 'PATCH', body: JSON.stringify(req) })` (mirrors `updateProjectMemory`).

4. **Add** hook `packages/web/src/client/hooks/useFindings.ts`
   - `useUpdateFinding(project: string | undefined)` returning a `useMutation` whose
     `mutationFn` calls `updateFinding` and whose `onSuccess` invalidates
     `['board', project]` (mirrors `useProjectMemories.ts`). This is what makes the
     panel refresh after a status change.

5. **Modify** `packages/web/src/client/components/board/FindingsPanel.tsx`
   - Import `useUpdateFinding` and `Finding` status helpers.
   - In the expanded detail block (currently lines ~238-261), add an actions row:
     - When status is not terminal (`new`/`triaged`/`in-progress`): buttons
       **Resolve**, **Won't Fix**, **Duplicate** → each calls the mutation with the
       corresponding `status`.
     - When status is terminal (`resolved`/`duplicate`/`wontfix`): a **Reopen**
       button → mutation with `status: triaged`.
     - Optional **Change severity** could be added later; out of scope for the close
       action (but the route/handler already supports it if desired).
   - Style buttons using the existing small-border button classes already used for the
     severity filter chips (consistent with the file's current design language).
   - Disable buttons while the mutation is pending; reflect the new status from the
     invalidated board query.
   - Optional (recommended small enhancement, keep separate if risky): a
     **"Hide closed"** toggle in the panel header that filters out
     `resolved`/`duplicate`/`wontfix` findings from the list (closed findings remain
     retrievable by clearing the toggle). This is the natural way to keep the panel
     uncluttered once closing is possible.

---

## Proposed BUILD task breakdown

The facilitator / reviewer should split implementation into independently testable units:

1. **BUILD: web findings route + manager proxy**
   - New `routes/findings.ts` (PATCH handler, validation, error mapping) and
     registration in `app.ts`. Acceptance: route returns 502 on manager HTTP error,
     400 on empty body, and the tool result JSON on success.

2. **BUILD: client API + mutation hook**
   - `UpdateFindingRequest` type, `updateFinding` wrapper, `useUpdateFinding` hook that
     invalidates `['board', project]`.

3. **BUILD: FindingsPanel close/reopen controls**
   - Action buttons in the expanded finding view; wire to `useUpdateFinding`; reflect
     updated status; add optional "Hide closed" toggle.

4. **BUILD: tests**
   - `tests/findings-routes.test.ts` (route proxy + error mapping), mirroring
     `tests/agent-keys.test.ts`.
   - `tests/findings-panel.test.tsx` for the new action buttons + hide-closed toggle
     (happy-dom + react-query, mirroring `tests/board-header.test.tsx`), using the
     `--isolate` harness already configured in `package.json`'s `test` script.

---

## Risks / open questions

- **Route path collision** — `/api/projects/:name/findings/:id` is a new distinct
  subpath; no existing `projects` sub-route uses `findings`. Low risk. Verify at
  registration that Hono matches it before any catch-all.
- **Auth posture** — Using `adminAuth()` matches other mutating endpoints; API keys are
  deliberately blocked (403). Confirm this is acceptable for a manual triage action
  (any authenticated human session is treated as admin today, so functionally identical
  to `auth()`).
- **Dedup re-surfacing** — As noted, a duplicate re-report updates `triagedAt`, which
  can move a closed finding to the top of the sorted list. Not a correctness bug; the
  status stays `resolved`/`wontfix`/`duplicate`. Mitigated by the optional "Hide closed"
  toggle.
- **100-item cap** — `board.status.findings` is capped at 100. Closing only updates the
  curated view + ConfigMap; inbox entries are removed on ingest. A finding older than
  the 100-cap window that is re-reported will re-enter as `triaged` (new clusterId).
  Edge case, acceptable.
- **The `update_finding` tool requires `clusterId` on the curated finding.** Existing
  ingestion always sets `clusterId` (= original `finding.id` for new findings). Verified
  the handler throws if `clusterId` is missing, but in practice every curated finding
  has one. Low risk.

---

## Acceptance criteria

1. From the board Findings panel, a user can mark any open finding as **Resolved**,
   **Won't Fix**, or **Duplicate**, and can **Reopen** a closed one.
2. After the action, the finding's status badge updates in the panel without a manual
   refresh (board query invalidated).
3. The change is durable: it survives manager reconcile cycles (persisted in the
   triaged ConfigMap and `board.status.findings`).
4. Closing a finding does not delete it; it remains visible (and optionally hidden via
   the "Hide closed" toggle).
5. `pnpm typecheck`, `pnpm lint`, and `pnpm test` (web package) pass.
