# Plan: Add manager-agent `manager_approve` tool for BUILD merge approvals

## Context

- Manager MCP tools are defined in `packages/manager-controller/src/agent/tools.ts`:
  - Tool metadata lives in the `TOOLS` array.
  - Runtime behavior lives in `callTool(name, args)`.
- Existing manual approval path uses Task annotations, not direct status edits:
  - `percussionist.dev/action-approved: "true"` is the canonical approval signal.
  - This is already used by web route `POST /api/projects/:project/board/tasks/:taskName/approve` in `packages/web/src/server/routes/board.ts`.
- Reconciler reads manual action annotations in `packages/manager-controller/src/reconciler/observations.ts` and transitions in `decideAwaitingHuman` (`packages/manager-controller/src/reconciler/decision.ts`):
  - For BUILD tasks in `awaiting-human`, approval moves task to `awaiting-merge`, sets `worker.mergeRunName`, and schedules `ScheduleMergeRun`.
  - Annotation keys are cleared by reconciler effects (`ClearTaskAnnotations`) after consumption.
- Transition table allows `awaiting-human -> awaiting-merge` (`packages/manager-controller/src/reconciler/transitions.ts`), but forcing phase changes manually (e.g., via `set_task_state`) risks bypassing merge scheduling logic if not done exactly right.

## Assumptions

- The MCP tool name should be **`manager_approve`** (explicit retry instruction), even though earlier discussion text used `approve_merge`.
- Primary target is BUILD tasks that are AI-approved and sitting in `awaiting-human`.
- Tool behavior should be safe to call multiple times and should not duplicate reconciler internals.

## Scope boundaries

### In scope
- Add a new manager-agent MCP tool in `packages/manager-controller/src/agent/tools.ts` for explicit merge approval actions.
- Tool input includes `project` and `task` (plus optional behavior flags if needed).
- Tool writes `percussionist.dev/action-approved: "true"` on the target Task.
- Tool behavior is idempotent and safe when repeatedly called.
- Tool response includes enough state to explain whether approval was newly applied, already present, or already progressed.

### Out of scope
- Changing reconciler decision logic for how approvals are interpreted.
- Replacing existing board API approve route.
- Broad redesign of all manual action tools.

## Approach

1. **Use annotation-first approval as the canonical mechanism (recommended default).**
   - Primary action: patch Task metadata annotations with:
     - `percussionist.dev/action-approved: "true"`
     - `percussionist.dev/action-request-changes: "false"` (parity with board approve route, reduces conflicting manual signals)
   - Rationale: preserves existing reconciler behavior (capacity checks, flow-mode branching, merge-run naming/scheduling, annotation cleanup) and avoids duplicating decision logic inside MCP tools.

2. **Do not directly force phase transition by default.**
   - Directly patching `awaiting-merge` from the tool would need to replicate `decideAwaitingHuman` side effects (`mergeRunName`, scheduling, flow checks), creating drift risk.
   - If “immediate transition” is desired later, add it only as an explicit opt-in mode and still keep annotation write as source-of-truth.

3. **Add phase-aware validation + idempotent outcomes.**
   - Expected phase for actionable approval: `awaiting-human`.
   - Handle other states deterministically:
     - `awaiting-merge`/`done`: treat as already approved/progressed (no-op success).
     - any other phase: return structured error (or optionally a strictness flag in future).
   - If annotation already set to `"true"`, return success with `alreadyApproved: true`.

4. **Expose the tool in MCP schema and runtime switch.**
- Add `manager_approve` to the `TOOLS` list with clear contract and examples.
- Add `case 'manager_approve'` in `callTool`.
- Reuse existing Kube helpers: `getTask`, `patchTask` (new import required in `tools.ts`).

5. **Add focused tests.**
   - Since `tools.ts` is hard to import directly (server boot side effects), follow existing source-level schema test pattern (see `agent/__tests__/memory-tools.test.ts`) for tool presence/required fields.
   - Add behavior tests around tool execution via extracted helper or targeted unit harness (if introducing a small pure helper is acceptable), covering:
     - happy path (`awaiting-human` → annotation patch),
     - already approved idempotency,
     - already progressed (`awaiting-merge`),
     - invalid phase error.

## Acceptance criteria

1. Manager MCP `tools/list` includes `manager_approve` with required args `project` and `task`.
2. Calling `manager_approve` on BUILD task in `awaiting-human` writes `percussionist.dev/action-approved: "true"` annotation.
3. Reconciler can pick up that annotation and move task to `awaiting-merge` with merge scheduling (existing flow unchanged).
4. Repeated calls are idempotent and do not create conflicting state.
5. Calling on non-actionable phases returns clear, deterministic result/error.
6. `pnpm typecheck` and relevant manager-controller tests pass.

## Tasks

1. **Add MCP tool schema entry** in `packages/manager-controller/src/agent/tools.ts`.
- Name: `manager_approve`.
- Description explicitly states canonical annotation behavior and expected phase.
- Input schema: `project` (string), `task` (string), optional `namespace`.

2. **Import metadata patch helper** in `tools.ts`.
   - Add `patchTask` import from `@percussionist/kube` (already used elsewhere in repo for annotations).

3. **Implement runtime handler** in `callTool` (`case 'manager_approve'`).
   - Load Task via `getTask(taskName, resourceNs)`.
   - Verify `task.spec.projectRef` matches `project` argument (defensive guard against cross-project task name mistakes).
   - Evaluate phase and existing annotations.
   - Apply `patchTask` annotation merge when action is needed.

4. **Define idempotency + error contract** in return payload.
   - Return fields such as: `project`, `task`, `phase`, `approved`, `alreadyApproved`, `alreadyProgressed`, `patched`.
   - For invalid phase (not `awaiting-human`, `awaiting-merge`, `done`), throw explicit error: `Task phase is "X", expected "awaiting-human"`.

5. **Parity with board route annotation semantics.**
   - When patching approval, also set `percussionist.dev/action-request-changes` to `"false"`.
   - Preserve existing annotations by merging with current annotation map.

6. **Add/update tests for tool definition.**
- Extend source-based schema tests in `packages/manager-controller/src/agent/__tests__/memory-tools.test.ts` or add a new focused `tools-schema.test.ts` to assert:
  - `manager_approve` exists,
  - required args include `project` and `task`.

7. **Add behavior tests for approval handler.**
   - Prefer extracting small pure helper (e.g., `approveMergeAction(...)`) to avoid full MCP server boot in tests.
   - Test paths:
     - actionable phase patch,
     - idempotent re-approve,
     - already progressed phase,
     - invalid phase rejection.

8. **Docs/agent prompt discoverability updates.**
   - Update manager tool docs/comments where tool list is described (if present in repo docs) so agents know to use `approve_merge` instead of raw `set_task_state` for this case.

9. **Verification pass.**
   - Run `pnpm typecheck`.
   - Run manager-controller tests (targeted or full `pnpm test` as feasible).
- Optionally validate in a dev environment by calling manager MCP `manager_approve` on a BUILD task in `awaiting-human` and confirming transition to `awaiting-merge` on reconcile.

## Proposed BUILD task breakdown

1. **BUILD A — Implement `manager_approve` MCP tool**
   - Add schema + runtime handler + imports + return contract.
   - Ensure annotation-first implementation and phase guards.

2. **BUILD B — Test coverage for schema and behavior**
   - Add/extend unit tests for tool listing and approval logic idempotency.
   - Include failure-mode assertions.

3. **BUILD C — Documentation and integration validation**
   - Update relevant manager tool documentation/prompts.
   - Validate flow against an `awaiting-human` BUILD task lifecycle.

## Risks / open questions

1. **Backwards compatibility for earlier naming:** previous discussions referenced `approve_merge`.
   - Decision: implement `manager_approve` as canonical name per retry instruction; optional alias can be considered later if needed.

2. **Phase strictness policy:** should non-`awaiting-human` calls hard-fail or soft-no-op?
   - Proposed: soft success for `awaiting-merge`/`done`, hard error otherwise.

3. **Should tool directly patch status to `awaiting-merge`?**
   - Proposed: no, to avoid duplicating reconciler orchestration logic and introducing drift.

4. **Testing ergonomics for `tools.ts`:** direct import side effects make behavior tests awkward.
   - May require small refactor to extract pure helper(s) for deterministic unit tests.
