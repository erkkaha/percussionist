# Plan: memory stats in Stats view (stored / used / by project)

## Context (checked against current main)

- Stats data is still assembled in `packages/web/src/server/routes/stats.ts` via `GET /api/stats/sessions`.
  - Current payload includes `sessions`, `summary`, `agentSummaries`, and `modelRows`.
  - There is still no `memory` section in this response.
- Stats UI is still rendered by `packages/web/src/client/components/StatsView.tsx`.
  - Tabs remain: `overview`, `agents`, `models`, `tools`.
  - `StatsResponse` type currently has no memory metrics.
- Memory records are still project-scoped and available through memory-service `GET /memories` (`packages/memory-service/src/index.ts`) and proxied in web via `packages/web/src/server/routes/project-memories.ts`.
  - `GET /memories` returns `{ memories, total }`, so `total` is usable as stored-memory count.
- Usage telemetry is still written into SQLite `tool_calls` joined to `runs` (`packages/web/src/server/schema.ts`, `packages/web/src/server/routes/stats.ts`).
  - This is the best existing signal for “used memories”.
- Since the prior plan, no native project column has been added to `runs`; per-project attribution still needs explicit handling.

## Scope boundaries

### In scope
- Add memory stats to `/api/stats/sessions` for:
  1. total stored memories,
  2. total used memories,
  3. per-project division.
- Render those memory stats under `/stats` in `StatsView`.
- Add/update tests for the API contract and auth behavior.

### Out of scope
- Changing memory-service schema/storage model.
- Redesigning the whole Stats page information architecture.
- Introducing new permissions/RBAC behavior.

## Key assumptions

1. “Used memories” means **memory retrieval tool usage** (tool-call based), not exact prompt-injected memory-row count.
2. “Division per project” should be best-effort and should not fail the full stats page when one project memory service is unavailable.
3. Memory stats should prefer embedding-enabled projects (`project.spec.embedding?.enabled === true`) for stored-memory polling.

## Approach

1. Extend `GET /api/stats/sessions` response with a new `memory` block.
2. Compute `stored` by querying each embedding-enabled project memory service endpoint:
   - `http://memory-{project}.{NAMESPACE}.svc.cluster.local:4100/memories?limit=1&offset=0`
   - extract `total` only.
3. Compute `used` from `tool_calls` + `runs` with the same days cutoff logic already used by stats routes.
4. Use a clearly documented tool allowlist for memory usage metrics, with retrieval-focused defaults.
5. Keep failure semantics tolerant:
   - per-project failure should annotate that project row as unavailable,
   - global stats route should still return `200` with partial data.
6. Update `StatsView` to show memory metrics in the Overview section (below existing summary cards) to minimize tab churn.

## Proposed API contract changes

Add `memory` to `/api/stats/sessions` response:

```ts
memory: {
  storedTotal: number;
  usedTotal: number;
  usedSessions: number;
  definition: {
    usedMetric: "memory-tool-calls";
    tools: string[];
  };
  projects: Array<{
    project: string;
    stored: number;
    usedCalls: number;
    usedSessions: number;
    available: boolean;
    error?: string;
  }>;
}
```

Notes:
- `usedTotal` = count of matching tool calls in filtered window.
- `usedSessions` = distinct `tool_calls.session_id` for matching tools.
- `definition` must be returned so metric semantics are explicit in UI.

## Per-project usage attribution strategy

- Primary strategy for this task: derive project from `runs.task` naming convention (`{project}-plan-*` / `{project}-build-*`) for worker runs.
- Handle non-task/system sessions (e.g. manager synthetic sessions) as unassigned and exclude from per-project rows while still counting in global `usedTotal`/`usedSessions` if they use memory tools.
- If attribution quality proves insufficient during implementation, add a follow-up BUILD task to persist an explicit `project` column in `runs` plus ingestion updates.

## Implementation tasks

1. **Add memory stat helpers in `routes/stats.ts`**
   - Define memory-tool allowlist constant (retrieval-first).
   - Add helper to list embedding-enabled projects using `listProjects()` from `server/kube.ts`.
   - Add helper to fetch per-project stored totals with timeout + structured error result.

2. **Add used-memory aggregations in `routes/stats.ts`**
   - Query `tool_calls` joined to `runs` with existing `days` cutoff.
   - Compute global `usedTotal` and `usedSessions`.
   - Compute per-project `usedCalls` + `usedSessions` with task-name-based attribution.

3. **Assemble and return `memory` block in `/api/stats/sessions`**
   - Merge stored + used metrics per project.
   - Return degraded rows (`available: false`, `error`) when memory-service call fails.
   - Preserve existing response fields unchanged.

4. **Update `StatsView.tsx` response types and rendering**
   - Extend `StatsResponse` with `memory` block.
   - Add memory metric cards (Stored, Used, Used Sessions).
   - Add per-project table (project, stored, used calls, used sessions, availability/error).
   - Add empty-state messaging when no embedding-enabled projects exist.

5. **Update tests**
   - `packages/web/tests/smoke.test.ts`: assert `memory` block exists on `/api/stats/sessions` and has expected shape.
   - `packages/web/tests/auth.test.ts`: no new route expected; update only if route surface changes.

6. **Verification**
   - Run `pnpm typecheck`.
   - Run `pnpm test` (or at minimum web test suite in the BUILD task if split).

## Acceptance criteria

1. `/api/stats/sessions` returns a `memory` object with global totals and per-project rows.
2. Stats page shows stored memories, used memories, and division by project.
3. One failing memory service does not break stats page load; affected project is marked unavailable.
4. Existing Stats tabs (Overview/Agents/Models/Tools) remain functional.
5. Tests and typecheck pass after implementation.

## Risks / open questions

1. **Attribution accuracy risk**
   - Task-name parsing may miss edge cases; explicit `runs.project` storage may be needed later.
2. **Metric interpretation risk**
   - Stakeholders may expect “used memories” to mean retrieved rows rather than tool calls.
3. **Latency risk**
   - Polling many project memory services during stats requests can add response latency; strict per-request timeout is required.

## Proposed BUILD task breakdown

1. **BUILD A — Backend memory stats block**
   - Implement stored/used aggregations and degraded-service handling in `routes/stats.ts`.
2. **BUILD B — Stats UI memory section**
   - Extend `StatsView.tsx` types + Overview rendering for memory metrics and per-project table.
3. **BUILD C — Tests and contract hardening**
   - Update smoke assertions, confirm auth behavior unchanged, and validate fallback states.
4. **BUILD D (conditional) — explicit project attribution in runs table**
   - Only if task-name attribution is insufficient during implementation.
