# Plan: Fix meta-reviewer `complete_run` rejection by dispatcher git workflow check

## Context

The dispatcher's `complete_run` handler enforces a git workflow validation (branch creation, commit, push, PR) before allowing a run to complete. This is correct for BUILD-type runs but incorrectly applied to REVIEW-type facilitator runs where the agent does not create any code changes.

### Evidence

Review run `percussionist-dev-review-percussionist-dev-build-percussioni-19` (task: `percussionist-dev-build-percussionist-dev-plan-a13--00`) was rejected 3 times by the dispatcher with:
> "Cannot complete run - required git workflow steps are missing: No feature branch created, No commit, No push, No PR."

The meta-reviewer agent reviewed BUILD output, validated code changes, ran `pnpm typecheck` (passed), and approved the task — but could not call `complete_run`. The run eventually succeeded via timeout/override, but landed in `awaiting-human` phase despite `reviewApproved` being true.

### Root Cause

The git workflow validation in `packages/dispatcher/src/mcp-server.ts` (`validateGitWorkflow`, lines 142-208) only skips when `RUN_TASK` contains "do not perform any code changes". Review runs created by the manager's facilitator module do not include this phrase in their prompt, so validation always fails.

### Key Files

| File | Role |
|------|------|
| `packages/dispatcher/src/mcp-server.ts` (lines 142-208) | `validateGitWorkflow()` — git workflow check for BUILD runs |
| `packages/dispatcher/src/mcp-server.ts` (lines 307-356) | `complete_run` handler — invokes validation |
| `packages/operator/src/pod-builder.ts` (line 749) | Injects `RUN_TASK` env var from `spec.task` |
| `packages/manager-controller/src/facilitator.ts` (lines 97-212) | `buildSuccessReviewRun()` — creates review runs with prompt containing "reviewer agent" |
| `packages/api/src/index.ts` (line 461) | Run spec has optional `facilitation: FacilitationSpecSchema` field |

## Approach

**Add a new environment variable `RUN_IS_FACILITATION=1` to review/facilitator runs, and check it in the dispatcher's git workflow validation.**

This is the cleanest approach because:
- It uses existing Run spec structure (`spec.facilitation`) — facilitation runs are inherently non-code-change tasks
- No fragile string matching on prompt content
- Explicit and self-documenting
- Works for all facilitator run types (success review, failure analysis, BUILD task generation)

### Why not other approaches?

| Approach | Pros | Cons |
|----------|------|------|
| Check `RUN_AGENT` name pattern | No new env var needed | Fragile — depends on agent naming conventions; doesn't generalize to future reviewer agents |
| Add more keywords to RUN_TASK check | Simple | Fragile — depends on exact prompt wording; hard to maintain |
| Add capability flag to ClusterAgent schema | Explicit per-agent control | Overkill — requires API schema change, affects all agents, not just review runs |

## Tasks

### Task 1: Inject `RUN_IS_FACILITATION` env var in pod-builder.ts

**File:** `packages/operator/src/pod-builder.ts`
**Lines to modify:** ~748-756 (env var injection block)

Add a new environment variable when the Run spec has `spec.facilitation`:

```typescript
...(spec.facilitation ? [{ name: "RUN_IS_FACILITATION", value: "1" }] : []),
```

This should be added alongside the existing env vars in the opencode container's `env` array (after line 756, before `RUN_TIMEOUT_SECONDS`).

### Task 2: Check `RUN_IS_FACILITATION` in dispatcher validation

**File:** `packages/dispatcher/src/mcp-server.ts`
**Lines to modify:** ~142-149 (`validateGitWorkflow`) and ~214-219 (`validateGitWorkflowPlan`)

Add a skip check at the top of both validation functions:

```typescript
// Skip validation for facilitator runs (review, analysis, task generation).
if (process.env.RUN_IS_FACILITATION === "1") {
  return errors;
}
```

This goes right after the existing `RUN_TASK` check (line 147-149) in both functions.

### Task 3: Verify typecheck passes

Run `pnpm typecheck` from the workspace root to ensure all TypeScript types are correct and no regressions were introduced.

## Risks / Open Questions

1. **Backward compatibility**: Existing review runs created before this change won't have the env var, but they also won't be running anymore (they're already completed). New review runs will get the env var automatically. No migration needed.

2. **Other facilitator run types**: The `buildBuildTaskGeneratorRun` function (line 215) and `buildFailureFacilitatorRun` function (line 26) also create facilitation runs with `spec.facilitation`. Both will benefit from this fix — task generation runs and failure analysis runs should also not need git workflow validation.

3. **Edge case**: If someone manually creates a Run with `spec.facilitation` but expects git workflow validation, they'd be surprised. However, `spec.facilitation` is only set by the manager controller's facilitator module, so this shouldn't happen in practice.

4. **No test framework configured** (per AGENTS.md): No tests to update or add. The acceptance criteria are operational — meta-reviewer can complete runs without git errors.

## Acceptance Criteria

- [ ] Meta-reviewer can call `complete_run` without git workflow validation errors
- [ ] BUILD-type runs still require full git workflow (branch, commit, push, PR)
- [ ] PLAN-type runs still require git workflow (commit, push only — via `validateGitWorkflowPlan`)
- [ ] Other facilitator runs (failure analysis, task generation) also skip git validation
- [ ] `pnpm typecheck` passes with no errors

## BUILD Task Breakdown

1. **BUILD 1**: Inject `RUN_IS_FACILITATION=1` env var in pod-builder.ts when `spec.facilitation` is set
2. **BUILD 2**: Check `RUN_IS_FACILITATION` in dispatcher's `validateGitWorkflow()` and `validateGitWorkflowPlan()` functions
3. **BUILD 3** (optional, can be combined with BUILD 1): Run `pnpm typecheck` to verify no regressions

## Implementation Notes

- The change is minimal: ~5 lines of code across 2 files
- No API schema changes needed — `spec.facilitation` already exists in the Run spec
- No CRD regeneration needed
- The existing "do not perform any code changes" pattern in RUN_TASK remains as a fallback for other edge cases
