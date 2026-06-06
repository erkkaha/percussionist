# Plan: Prevent limbo tasks with missing `status.phase`

**Task:** `percussionist-dev-plan-d76fa7`  
**Bug:** Some Task CRs are created without `status.phase`, leaving them effectively invisible to scheduling and hard to reason about in tooling.

---

## Context

- Task CR creation currently happens in multiple code paths, all via `buildTask(...)` + `createTask(...)` from `@percussionist/kube`:
  - Dispatcher MCP `create_task`: `packages/dispatcher/src/mcp-server.ts` (`handleCreateTask`, lines ~510-563)
  - Manager MCP `create_task`: `packages/manager-controller/src/agent/tools.ts` (lines ~987-1039)
  - Web board API `POST /api/projects/:project/board/tasks`: `packages/web/src/server/routes/board.ts` (lines ~223-273)
  - CLI board task create: `packages/cli/src/board.ts` (lines ~153-179)
- `buildTask(...)` in `packages/kube/src/index.ts` currently returns `{ apiVersion, kind, metadata, spec }` and does **not** set `status`.
- The API schema allows missing status: `TaskStatusSchema` is partial and `TaskSchema.status` is optional (`packages/api/src/index.ts`, lines ~1037-1091). So Kubernetes accepts tasks with no `status.phase`.
- The reconciler mostly treats missing phase as pending via `task.status?.phase ?? "pending"` (`packages/manager-controller/src/reconciler/index.ts`, `decision.ts`, `effects.ts`).
- However, there is still a correctness gap:
  - creation is non-atomic in several paths (create object, then patch status),
  - some paths never patch phase at all (dispatcher/web),
  - and external/manual Task creation can bypass defaults entirely.
- This combination makes it possible to accumulate orphan/limbo tasks with absent `status.phase`.

---

## Scope boundaries

### In scope
- Ensure every newly created Task has a deterministic starting phase (`pending` unless explicitly set otherwise).
- Add an auto-heal path so existing tasks with missing `status.phase` are repaired within one reconcile cycle.
- Cover all first-party task creation entry points.
- Add tests for creation defaults and reconciler healing behavior.

### Out of scope
- Redesigning the full phase/state machine.
- Changing board column semantics beyond phase initialization/healing.
- Enforcing status defaults at CRD/OpenAPI level (Kubernetes CRD schema defaulting for status subresource is not relied on here).

---

## Root-cause assessment

Likely root cause is **task creation without status phase**, not a single reconciliation failure:

1. `buildTask(...)` omits `status`, and at least two creation paths (`dispatcher` and `web`) do not immediately patch `status.phase`.
2. Even where a post-create patch exists (manager MCP/CLI), create+patch is two-step and can fail between calls.
3. Reconciler logic is tolerant (`?? "pending"`), but this does not enforce persisted state and can still leave CRs with undefined phase indefinitely.

Assumption: the reported limbo tasks were likely created through a path that didn’t set phase (or by a partial-failure between create and patch), not because the decision engine refused to process a well-formed pending task.

---

## Approach

Implement a **defense-in-depth** fix with one primary guardrail and one reconciliation self-heal:

1. **Creation-time invariant (primary):** make `buildTask(...)` set `status.phase = "pending"` by default so all first-party callers get initialized tasks atomically at create time.
2. **Reconciler auto-heal (secondary):** during reconciliation, detect tasks missing `status.phase` and patch `status.phase = "pending"` immediately, then skip further processing for that task in the same cycle (or continue from normalized local value if preferred).
3. **Keep explicit overrides working:** retain existing explicit idea-column behavior (`board.ts` patch to `idea`) and any intentional phase transitions.
4. **Test coverage:** add focused tests proving both guarantees.

Key decision: default in shared builder (`@percussionist/kube`) rather than duplicating per caller. This minimizes drift and ensures future create paths inherit the invariant automatically.

---

## Tasks (implementation steps)

1. **Add default status to shared Task builder**
   - File: `packages/kube/src/index.ts`
   - Update `buildTask(...)` return shape to include:
     - `status: { phase: "pending" }`
   - Ensure typing uses `Task`/`TaskStatus` safely (no `any`).

2. **Review and simplify per-caller creation behavior**
   - Files:
     - `packages/dispatcher/src/mcp-server.ts`
     - `packages/manager-controller/src/agent/tools.ts`
     - `packages/web/src/server/routes/board.ts`
     - `packages/cli/src/board.ts`
   - Decide per path whether post-create `patchTaskStatus(...pending...)` is still needed:
     - remove redundant patches where safe,
     - keep intentional non-pending overrides (e.g., ideas -> `phase: "idea"`).
   - Keep returned tool/API response phase values aligned with actual persisted state.

3. **Add reconciler self-heal for missing phase**
   - File: `packages/manager-controller/src/reconciler/index.ts`
   - Before deciding transitions, check `task.status?.phase`:
     - if missing, call `patchTaskStatus(taskName, { phase: "pending" }, namespace)`,
     - log a concise repair message,
     - avoid running normal transition logic against stale in-memory object for that iteration.
   - Result: orphan tasks from legacy/manual creation are repaired within one reconcile pass.

4. **Add decision/reconciler tests for healing behavior**
   - Files (likely):
     - `packages/manager-controller/src/reconciler/__tests__/decision.test.ts`
     - `packages/manager-controller/src/reconciler/__tests__/fixtures.ts`
     - or a new targeted reconciler integration-style unit test file if needed.
   - Add fixture support for tasks with `status` omitted or `phase` undefined.
   - Assert that missing-phase tasks are normalized to pending and subsequently schedulable.

5. **Add creation-path regression tests**
   - Add/update tests where present for:
     - dispatcher `create_task` path,
     - manager MCP `create_task` path,
     - web board task creation endpoint,
     - optional CLI unit test if test harness exists.
   - Minimum acceptance: a created Task object includes `status.phase` at creation time.

6. **Validation run**
   - Run targeted tests for modified packages.
   - Run repo typecheck (`pnpm typecheck`) to catch cross-package typing issues.

7. **Document behavioral expectation in code comments**
   - Add short comments near `buildTask(...)` and reconciler heal block clarifying invariant:
     - “All tasks must persist a phase; pending is default.”

---

## Acceptance criteria

- Creating a Task via any first-party path persists `status.phase` on the CR immediately (default `pending`, unless explicitly overridden like `idea`).
- Existing tasks lacking `status.phase` are auto-healed to `pending` within one reconcile cycle.
- Reconciler continues normal scheduling after heal; healed tasks no longer remain in limbo.
- Tests cover both creation-time defaulting and reconcile-time healing.

---

## Risks / open questions

1. **Status-on-create with status subresource:** confirm Kubernetes accepts initial `status` in create for this CRD setup (it typically does, even with `/status` enabled). If cluster behavior strips status, reconciler heal still guarantees eventual consistency.
2. **Race with concurrent status writers:** healing patch could conflict with another patch in same window; reuse existing retry behavior in `patchTaskStatus` and keep heal idempotent.
3. **Redundant patch churn:** if some callers still patch `pending` after create, there may be harmless extra writes; cleanup should remove unnecessary patches to reduce noise.
4. **Manual/external creators:** external clients that bypass `buildTask` can still create malformed objects; reconciler heal is the fallback safety net.

---

## Proposed BUILD task breakdown

1. **BUILD 1 — Enforce creation invariant in shared builder and callers**
   - Implement `buildTask` default status and adjust creation paths to avoid redundant pending patches.

2. **BUILD 2 — Reconciler auto-heal for legacy/malformed tasks**
   - Add missing-phase detection and patch logic in reconcile loop.

3. **BUILD 3 — Tests and verification**
   - Add/update unit tests for creation default + auto-heal and run typecheck/tests.
