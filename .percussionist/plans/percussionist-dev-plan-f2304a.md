# Plan: user session tracking per project (planning/reviewing)

## Context

- Current usage tracking is global-per-day only:
  - Client stores local counters in `localStorage` via `packages/web/src/client/lib/usage-settings.ts` (`readTodayUsage`, `getTodayKey`) with three categories: `reviewing`, `planning`, `other`.
  - Route classification in `packages/web/src/client/hooks/useUsageTracker.ts` maps:
    - `/projects/:name/board*` → `reviewing`
    - `/projects/:name/plans/*` → `planning`
    - `/sessions/:name` → `reviewing`
    - everything else → `other`
  - Heartbeats send only aggregate category totals to `POST /api/usage/heartbeat`.
- Server persistence in `packages/web/src/server/routes/usage.ts` and `packages/web/src/server/schema.ts` uses table `usage_daily(date, reviewing, planning, other)` and returns global totals from `GET /api/usage/today`.
- UI (`UsageBar`, `UsageLockOverlay`) renders only global totals; no project breakdown exists.

## Scope boundaries

### In scope

- Track planning/reviewing usage per project (daily granularity) while preserving existing global behavior.
- Extend usage heartbeat payload, DB schema, API responses, and client cache types for per-project data.
- Keep existing usage bar UX focused on total progress (no new per-project UI breakdown requirement).
- Add/adjust tests for server usage routes and client usage tracking behavior.

### Out of scope

- Reworking stats/session analytics (`/api/stats/*`) or run persistence.
- Changing core lock policy semantics beyond what is needed to remain compatible.
- Historical backfill of old usage rows.

## Assumptions

1. “Track … by project” means per-project counters for **planning** and **reviewing** categories, keyed by project name.
2. Locking remains based on global total time unless explicitly changed by product direction.
3. Non-project routes remain in global `other` (and optionally unscoped planning/reviewing if future routes require it).
4. Session detail routes (`/sessions/:name`) may not always map to a project reliably; they can remain global `reviewing` unless a robust project mapping is added.

## Approach

1. **Introduce a per-project daily usage table** (normalized) instead of trying to encode dynamic project keys in `usage_daily` columns.
2. **Make heartbeat/project data explicit in the API**:
   - keep top-level totals for backward compatibility,
   - add project-scoped deltas/totals in request/response payloads.
3. **Update client tracker to infer project from route** and send project-aware heartbeat data.
4. **Do not expand UI surface area for this change**; keep current total progress bar behavior and lock UX.
5. **Keep idempotent semantics** (`max()` style upserts) for both global and per-project counters.

## Data/API design proposal

- New table (example): `usage_daily_project`
  - `date` (text, PK part)
  - `project` (text, PK part)
  - `reviewing` (int default 0)
  - `planning` (int default 0)
- Keep existing `usage_daily` for global totals to avoid breaking consumers.
- Extend heartbeat payload and response:
  - Request: existing `{ reviewing, planning, other }` + optional project payload (e.g. `{ projectUsage: { [project]: { reviewing, planning } } }` or explicit `project`, `projectReviewing`, `projectPlanning`).
  - Response: existing totals/settings + project breakdown map/list.
- Preserve compatibility: if project data is absent, server behavior remains unchanged.

## Tasks

1. **Define final request/response contract for project-scoped usage**
   - Update shared TypeScript shapes in:
     - `packages/web/src/server/routes/usage.ts` (`UsageResponse` + request parsing)
     - `packages/web/src/client/lib/usage-settings.ts` (`UsageServerResponse`)
   - Choose explicit and stable JSON shape for project breakdown.

2. **Add DB schema for per-project usage**
   - Edit `packages/web/src/server/schema.ts` to add `usageDailyProject` table with composite PK (`date`, `project`).
   - Generate migration in `packages/web/migrations/` via drizzle-kit (BUILD task).

3. **Implement server upsert/read logic for project usage**
   - In `packages/web/src/server/routes/usage.ts`:
     - Extend `POST /heartbeat` to upsert both global and per-project rows using `max()` semantics.
     - Extend `GET /today` to return per-project breakdown alongside global totals.
     - Keep `buildResponse()` as compatibility layer for global fields and add project payload.

4. **Update client storage model to track per-project counters locally**
   - In `packages/web/src/client/lib/usage-settings.ts`:
     - Extend local usage type to include project map (e.g. `projects: Record<string, { reviewing: number; planning: number }>`).
     - Add migration-safe reader that tolerates old localStorage shape.

5. **Update route categorization to include project context**
   - In `packages/web/src/client/hooks/useUsageTracker.ts`:
     - Parse project from `/projects/:name/board` and `/projects/:name/plans/:taskId`.
     - Increment both global category counters and matching per-project counters.
     - Keep `/sessions/:name` behavior explicit (global reviewing unless project can be resolved safely).

6. **Send project-aware heartbeat payload**
   - Update `reportHeartbeat()` usage contract and payload in `usage-settings.ts` + `useUsageTracker.ts`.
   - Ensure backward compatibility if server ignores unknown project fields during rollout.

7. **Server test coverage for usage routes**
   - Add/extend tests in `packages/web/tests/` for:
      - heartbeat with project payload,
      - idempotent max-upsert semantics for same day/project,
      - today endpoint returning expected project breakdown,
      - backward compatibility with old payload shape.

8. **Client behavior tests (targeted)**
   - Add targeted tests for route categorization + local storage migration-safe parsing (if existing client test harness is available).

9. **Verification and compatibility checks**
    - Validate type alignment across server/client usage payloads.
    - Run `pnpm --filter @percussionist/web typecheck` and relevant web tests during BUILD.

## Acceptance criteria

1. Visiting project board/plan routes increments planning/reviewing counters tied to that project for the current day.
2. `/api/usage/heartbeat` persists per-project planning/reviewing usage idempotently (no double-count regressions on repeated heartbeats).
3. `/api/usage/today` returns global totals and per-project planning/reviewing breakdown.
4. Existing global UsageBar/lock UX continues to show total progress correctly (no regression from project-scoped tracking additions).
5. Existing clients that send only old heartbeat payload still work.

## Proposed BUILD task breakdown

1. **BUILD A — Data contract + persistence**
   - Add schema/migration and server route updates for per-project usage persistence/read APIs.

2. **BUILD B — Client tracking + heartbeat integration**
   - Add route-based project extraction, local model updates, and project-aware heartbeat payload.

3. **BUILD C — Tests + hardening**
   - Complete regression coverage and compatibility hardening without adding new per-project usage UI.

## Risks / open questions

1. **Ambiguous project attribution for `/sessions/:name`**
   - Without a reliable run→project lookup in the usage tracker, session pages may remain globally attributed.

2. **Payload versioning during rollout**
   - Mixed old/new clients can coexist; server must tolerate missing project fields.

3. **Cardinality growth**
   - Many projects can increase per-day rows; acceptable for SQLite scale here, but should be monitored.

4. **Local storage shape migration**
   - Existing `Record<Category, number>` data must remain readable when moving to a project-aware local shape.
