# Plan: Memory stats in Stats view (stored/used/by project)

## Context

- The Stats page is driven by `packages/web/src/server/routes/stats.ts` and `packages/web/src/client/components/StatsView.tsx`.
  - `GET /api/stats/sessions` currently returns run/session aggregates (`summary`, `agentSummaries`, `modelRows`) but no memory metrics.
  - `StatsView` only knows those shapes and renders tabs: **Overview**, **Agents**, **Models**, **Tools**.
- Project memory CRUD is proxied via `packages/web/src/server/routes/project-memories.ts` to per-project services at `http://memory-{project}.{namespace}.svc.cluster.local:4100`.
  - Memory list endpoint (`GET /memories`) already returns `{ memories, total }` from memory-service.
- Memory-service currently exposes `/memory`, `/search`, `/context`, `/memories`, `/health` in `packages/memory-service/src/index.ts`, but no dedicated aggregate stats endpoint.
- “Used memories” cannot be derived from memory-service storage alone; the most reliable existing signal is memory-tool usage recorded in web DB `tool_calls` via `stats-reporter` (`packages/web/src/server/schema.ts`, `packages/web/src/server/routes/stats.ts`), especially tools like `get_context` and `query_memory`.

## Scope boundaries

### In scope
- Add server-side stats API support for memory metrics shown under `/stats`.
- Add UI rendering in `StatsView` to surface:
  1. total stored memories,
  2. used memories (defined metric; see assumptions),
  3. per-project memory distribution.
- Add/adjust tests for new API contract and auth gating.

### Out of scope
- Reworking memory-service data model or vector schema.
- Changing dispatcher/session ingestion contracts.
- New RBAC model or project-level permission model changes.
- Large redesign of Stats page navigation.

## Assumptions

1. **“Used memories”** is interpreted as **memory retrieval tool usage**, not exact “how many memory rows were injected into prompts.”
2. Per-project memory stats should include all projects (or embedding-enabled projects), with unreachable memory services represented gracefully rather than failing the entire stats API.
3. Stats should remain read-only and best-effort: partial project failures should still return global stats.

## Approach

1. Extend web stats backend with a dedicated memory section returned by `GET /api/stats/sessions` (and optionally a dedicated endpoint if needed for separation), computed from:
   - **Stored**: sum of `total` from each project memory service `/memories?limit=1&offset=0`.
   - **Used**: DB aggregate from `tool_calls` joined with `runs`, scoped by the existing `days` filter, using memory-related tool names.
   - **Per-project division**: per-project stored counts, plus per-project usage counts from `runs.task`/tool-call correlation where possible.
2. Keep the existing endpoint as the single fetch source for `StatsView` to avoid another client query path and loading state complexity.
3. Implement tolerant aggregation semantics:
   - If one project memory service is down, mark that project row with error/unavailable and continue.
   - If all fail, return memory section with zeros + error metadata (not HTTP 500 for the whole stats payload).
4. Add a focused “Memory” section in Stats UI (under Overview or new tab) showing headline metrics and per-project table.

## Proposed API/data contract changes

Add a `memory` object to `/api/stats/sessions` response from `packages/web/src/server/routes/stats.ts`:

- `memory.storedTotal: number`
- `memory.usedTotal: number` (tool-call based)
- `memory.usedSessions: number` (distinct sessions/runs with memory tool usage)
- `memory.projects: Array<{`
  - `project: string`
  - `stored: number`
  - `usedCalls: number`
  - `usedSessions: number`
  - `available: boolean`
  - `error?: string`
  `}>`
- `memory.definition: { usedMetric: "memory-tool-calls"; tools: string[] }`

This explicit definition avoids ambiguity in UI and future reviews.

## Tasks

1. **Define canonical memory-usage metric names and tool set**
   - In `packages/web/src/server/routes/stats.ts`, decide and centralize memory tools (initially `get_context`, `query_memory`, optionally `list_memories`, `get_memory`, `store_memory`, `update_memory`, `delete_memory` depending product intent).
   - Document inclusion/exclusion rationale in code comments.

2. **Add project discovery for memory aggregation**
   - Reuse `listProjects()` from `packages/web/src/server/kube.ts` imports in `routes/stats.ts`.
   - Filter to projects relevant for memory stats (recommended: `spec.embedding.enabled === true`).

3. **Implement per-project stored-memory fetch helper**
   - Add helper in `routes/stats.ts` (or small shared server util) to call `http://memory-{project}.{NAMESPACE}.svc.cluster.local:4100/memories?limit=1&offset=0` with timeout.
   - Parse `total` only.
   - Return structured availability/error metadata per project.

4. **Implement DB aggregation for used-memory totals**
   - In `routes/stats.ts`, add SQL/Drizzle query over `tool_calls` + `runs` with same `days` cutoff logic already used by existing stats.
   - Compute:
     - global `usedTotal` (count of matching tool calls),
     - global `usedSessions` (distinct `session_id`),
     - per-project usage by deriving project identity from run/task metadata (see open question below) or fallback strategy.

5. **Resolve per-project usage attribution strategy**
   - Preferred: add deterministic project source in query (e.g., if `runs.namespace` + task/run naming allow robust mapping, use that).
   - If current schema lacks project dimension in `runs`, add a bounded follow-up within this task:
     - schema addition in `packages/web/src/server/schema.ts` (`project` column on `runs`),
     - ingestion updates in `POST/PATCH /api/stats/session` (read from payload if present),
     - migration generation (`packages/web/migrations/`),
     - then use direct grouping by `runs.project`.

6. **Augment `/api/stats/sessions` response shape**
   - Extend response JSON to include `memory` block without breaking existing fields.
   - Keep existing `summary/agentSummaries/modelRows/sessions` untouched for compatibility.

7. **Update StatsView types and fetch handling**
   - In `packages/web/src/client/components/StatsView.tsx`, extend `StatsResponse` with `memory` block.
   - Add UI components for memory metrics:
     - top-level cards for Stored / Used / Used Sessions,
     - per-project distribution table (project, stored, used, availability).

8. **Decide placement in Stats UI**
   - Option A: show memory section in Overview beneath `SummaryCards`.
   - Option B: add new `memory` tab in `TABS` for better density.
   - Choose one consistent with existing tabs and maintain mobile readability.

9. **Wire client-side formatting and empty states**
   - Reuse formatting helpers (counts/tokens style) in `StatsView.tsx`.
   - Add graceful empty/partial states when no embedding projects exist or services unreachable.

10. **Add server smoke/auth coverage**
    - Update `packages/web/tests/smoke.test.ts` stats assertions to validate presence and basic structure of `memory` block on `/api/stats/sessions`.
    - Update `packages/web/tests/auth.test.ts` only if new endpoint(s) are introduced; ensure auth coverage remains complete.

11. **Add/adjust UI tests if present, otherwise strengthen type guarantees**
    - If no component tests exist for StatsView, at minimum enforce TS interface correctness and runtime guards for nullable fields.

12. **Verification pass**
    - Run at least: `pnpm typecheck`, `pnpm test` (or package-scoped web tests if task split requires).
    - Confirm no regressions in existing Stats tabs and Tool Metrics view.

## Acceptance criteria

1. `/api/stats/sessions` includes a `memory` payload with global totals and per-project rows.
2. Stats UI shows:
   - total stored memories,
   - used memories,
   - per-project division.
3. When one or more memory services are unavailable, Stats still loads and marks affected projects as unavailable.
4. Existing Overview/Agents/Models/Tools behaviors remain functional.
5. Tests and typecheck pass with updated contract.

## Risks / open questions

1. **Project attribution for “used memories”**
   - Current `runs` schema may not reliably encode project dimension for grouping; may require schema + ingestion enhancement.
2. **Metric semantics ambiguity**
   - “Used memories” could mean calls, sessions, or count of retrieved memory rows. Plan uses “tool-call usage”; product confirmation recommended.
3. **Cross-service latency**
   - Aggregating across many project memory services can slow `/api/stats/sessions`; may need timeout caps and possibly short-lived cache.
4. **Partial failures**
   - Need deterministic response contract for degraded projects to avoid UI crashes and confusing totals.
5. **Tool inclusion scope**
   - Including write/admin tools (`store_memory`, `update_memory`, `delete_memory`) in “used” may inflate usage; default should prioritize retrieval tools.

## Proposed BUILD task breakdown

1. **BUILD 1 — Backend memory stats aggregation**
   - Implement memory block generation in `routes/stats.ts` (stored totals + used totals + per-project entries + degradation handling).
2. **BUILD 2 — (Conditional) schema/ingestion support for project attribution**
   - Only if needed: add project column/migration and ingestion updates so usage can be grouped correctly.
3. **BUILD 3 — Stats UI memory section**
   - Extend `StatsView.tsx` types/components to render memory cards and per-project division.
4. **BUILD 4 — Tests + hardening**
   - Update smoke/auth assertions, validate edge states, and run verification commands.
