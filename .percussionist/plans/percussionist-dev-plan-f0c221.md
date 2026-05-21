# Plan: View Plan Artifacts in Web UI

**Task:** `percussionist-dev-plan-f0c221`  
**Type:** PLAN  
**Project:** percussionist-dev  

---

## 1. Implementation Context

### Problem
When a planner agent succeeds on a PLAN task, it writes an authoritative plan artifact to `.percussionist/plans/{task-id}.md` in the project's git workspace. This file contains implementation context, scope boundaries, risks, acceptance criteria, and BUILD task breakdowns that are critical for human reviewers and downstream BUILD tasks.

Currently, there is **no web UI mechanism** to view these plan files. Users must:
- Scroll through the entire session contents of the run pod looking for the plan file content
- Use `exec_in_workspace` MCP tool manually via the chat panel
- SSH into a workspace pod and cat the file directly

This creates friction in the review workflow — reviewers need to quickly assess whether a PLAN is well-scoped before approving it or generating BUILD tasks.

### Existing Architecture
- Plan artifacts are stored on the project's data PVC at `.percussionist/plans/{task-id}.md`
- The `execInWorkspace()` function (in `@percussionist/kube`) spawns a short-lived Alpine pod that mounts the PVC and runs shell commands, returning stdout
- The web server (`packages/web`) already has routes for board CRUD, run details, session viewing, and log reading
- The client uses React with react-router-dom, TanStack Query, and Hono on the server side
- `react-markdown` (v10) + `remark-gfm` are already installed as dependencies in `packages/web/package.json`

### What Exists Today
| Component | Status |
|-----------|--------|
| Plan file written by planner agent | ✅ Working |
| Facilitator reads plan for review | ✅ Working |
| BUILD task generator reads plan | ✅ Working |
| Web UI board view | ✅ Shows tasks, run links |
| Web UI run detail view | ✅ Shows session, logs |
| **Web UI plan artifact viewer** | ❌ Missing |

---

## 2. Scope Boundaries

### In Scope
1. **New API endpoint** — `GET /api/projects/:project/plans/:taskId` that reads the plan file from workspace via `execInWorkspace`
2. **Client API function** — `fetchPlan(project, taskId)` wrapper in the existing api.ts module
3. **Dedicated PlanView page** — Renders plan markdown with ReactMarkdown at `/projects/:name/plans/:taskId`
4. **"View Plan" link on PLAN task cards** — Shown in TaskCard for completed PLAN tasks (those with a `worker.runName`)

### Out of Scope
- Editing or modifying plan files from the web UI (read-only)
- Caching plan content in SQLite (can be added later as an optimization)
- Plan diff/history comparison across retries
- Inline plan preview within task cards (would require modal/overlay complexity)
- Streaming plan file reads for very large plans

---

## 3. Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| `execInWorkspace` pod creation takes ~2-4 seconds, making the API feel slow | Medium | Add loading state in UI; consider caching plan content in a future optimization |
| PVC not yet mounted if project was just created (workspace-init hasn't run) | Low | Handle 404/500 gracefully with "Plan not available yet" message |
| Plan files could be very large (>100KB), causing slow rendering | Low | ReactMarkdown handles this well; consider truncation in a future iteration if needed |
| Concurrent reads from multiple browser tabs spawning multiple pods | Low | Kubernetes handles pod creation fine; each is short-lived and independent |

---

## 4. Acceptance Criteria

1. **API endpoint** — `GET /api/projects/:project/plans/:taskId` returns `{ content, taskId }` for a valid plan file, or appropriate error (404 if missing, 500 on failure)
2. **PlanView page** — Navigating to `/projects/:name/plans/:taskId` renders the full plan markdown with proper formatting (headings, lists, code blocks, tables)
3. **TaskCard link** — PLAN task cards in "review" and "done" columns show a "📋 View Plan" link when the task has completed successfully
4. **Navigation** — The PlanView page includes a "Back to Board" link that returns to `/projects/:name/board`
5. **Error handling** — Missing plan files show a clear error message; network errors are handled gracefully

---

## 5. Proposed BUILD Task Breakdown

```json
[
  {
    "title": "Add GET /api/projects/:project/plans/:taskId API endpoint",
    "description": "Create packages/web/src/server/routes/plans.ts with a single route handler that reads .percussionist/plans/{taskId}.md from the workspace using execInWorkspace(). Register the routes module in app.ts. Returns { content, taskId } or appropriate error codes.",
    "agent": "builder",
    "priority": "high"
  },
  {
    "title": "Add fetchPlan client API function and PlanResponse type",
    "description": "Add fetchPlan(project: string, taskId: string) to packages/web/src/client/lib/api.ts following the existing fetchJSON pattern. Add PlanResponse interface to types.ts.",
    "agent": "builder",
    "priority": "high"
  },
  {
    "title": "Create PlanView page component with ReactMarkdown rendering",
    "description": "Create packages/web/src/client/components/PlanView.tsx that fetches plan content via useQuery, renders it with ReactMarkdown + remarkGfm, includes loading/error states and a 'Back to Board' link. Add route /projects/:name/plans/:taskId in App.tsx.",
    "agent": "builder",
    "priority": "high"
  },
  {
    "title": "Add 'View Plan' link on PLAN task cards in TaskCard component",
    "description": "Modify packages/web/src/client/components/BoardView.tsx TaskCard to show a '📋 View Plan' link for PLAN tasks that have completed (worker.runName exists). Link navigates to /projects/{project}/plans/{taskId}. Only visible when plan content is available.",
    "agent": "builder",
    "priority": "medium"
  }
]
```

---

## 6. Implementation Details

### File Changes Summary

| File | Action | Description |
|------|--------|-------------|
| `packages/web/src/server/routes/plans.ts` | **Create** | New API route module for plan file reading |
| `packages/web/src/server/app.ts` | **Modify** | Register plans routes module |
| `packages/web/src/client/lib/api.ts` | **Modify** | Add fetchPlan() function |
| `packages/web/src/client/lib/types.ts` | **Modify** | Add PlanResponse interface |
| `packages/web/src/client/components/PlanView.tsx` | **Create** | New page component for plan viewing |
| `packages/web/src/client/App.tsx` | **Modify** | Add /projects/:name/plans/:taskId route |
| `packages/web/src/client/components/BoardView.tsx` | **Modify** | Add "View Plan" link to TaskCard |

### API Endpoint Specification

```
GET /api/projects/:project/plans/:taskId
```

**Response (200):**
```json
{
  "content": "# Plan: ...\n\nImplementation context...\n",
  "taskId": "percussionist-dev-plan-f0c221"
}
```

**Error responses:**
- `404` — Plan file not found (task has no plan artifact or workspace not ready)
- `500` — Internal error (workspace exec failed, PVC issues)

### UI Flow

1. User navigates to project board: `/projects/my-project/board`
2. PLAN task card shows a "📋 View Plan" link below the run link (only for completed tasks)
3. Clicking the link opens `/projects/my-project/plans/percussionist-dev-plan-f0c221`
4. PlanView page loads, fetches plan content via API, renders markdown
5. User can read the full plan with proper formatting
6. "Back to Board" link returns to the board view

### Technical Notes

- Uses existing `execInWorkspace()` from `@percussionist/kube` — no new kube functions needed
- ReactMarkdown + remarkGfm already installed in `packages/web/package.json`
- Follows existing patterns: route modules under `routes/`, API wrappers in `api.ts`, components in `components/`
- No database changes required (plan content is read directly from workspace)
