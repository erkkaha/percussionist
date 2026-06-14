# PLAN: Fix PLAN merge flow so conflicts are surfaced and task is not marked done on failed merge

## Context

- Merge runs are created by the reconciler via `ScheduleMergeRun` effects and built with `buildMergeRun()` in `packages/manager-controller/src/worker-builder.ts`.
  - BUILD task merge path: `awaiting-merge` (`decideAwaitingMerge` in `packages/manager-controller/src/reconciler/decision.ts`).
  - PLAN feature-branch merge path: `awaiting-feature-merge` (`decideAwaitingFeatureMerge` in the same file).
- `buildMergeRun()` currently instructs integrator agents to call `percussionist_dispatcher_complete_run` on completion (worker-builder.ts:332).
- In dispatcher prompt mode (`packages/dispatcher/src/polling.ts`), any `complete_run`/`complete_plan` signal causes the Run CR to be patched as `status.phase = Succeeded` with only a freeform summary string.
- Reconciler merge logic currently treats `mergeRun.status.phase === 'Succeeded'` as merge success and transitions the task to `done`:
  - BUILD: `awaiting-merge -> done` with `worker.mergedAt`.
  - PLAN: `awaiting-feature-merge -> done` with `worker.mergedAt`.
- There is no structured merge verdict equivalent to review verdict (`complete_review` + `percussionist.dev/review-verdict` annotation + `getReviewVerdict()` parsing).
- Root failure mode: integrator can report conflict/escalation in prose but still call `complete_run`, yielding Run `Succeeded` and false-positive task completion.

## Scope boundaries

- **In scope:** structured merge completion semantics, reconciler behavior for merge outcomes, merge-run prompts, tests, and API/annotation normalization for merge verdicts.
- **Out of scope:** redesigning the whole task lifecycle, changing human UX flows beyond existing `awaiting-human`, or introducing automatic conflict resolution.
- **Assumption:** keep existing task phases; use existing `awaiting-human` for escalation instead of introducing a new phase (unless explicitly requested later).

## Approach

1. Add a dedicated dispatcher MCP tool, `complete_merge`, with structured fields that encode merge outcomes deterministically (similar to `complete_review`).
2. Persist merge verdict to Run annotations (e.g. `percussionist.dev/merge-verdict`) and still finish the run from dispatcher perspective.
3. Update merge-run prompts to require `complete_merge` instead of `complete_run`.
4. Update reconciler observations + decision logic to gate task transitions on structured merge verdict when present:
   - Only mark task `done` when verdict explicitly indicates landed merge.
   - Route conflicts/human-required outcomes to `awaiting-human` with `worker.mergeError`.
   - Treat transient failures as `failed` (retry/manual intervention remains existing behavior).
5. Apply the same verdict handling to both merge contexts:
   - BUILD merges (`awaiting-merge`, usually feature sub-branch -> plan branch)
   - PLAN integration merges (`awaiting-feature-merge`, usually plan branch -> main)
6. Preserve backward compatibility: if no merge verdict annotation exists (older runs), fallback to current phase-based behavior initially, then optionally tighten later.

## Proposed `complete_merge` schema

Reference pattern: `complete_review` in `packages/dispatcher/src/mcp-server.ts` + normalization in `@percussionist/api`.

### Tool input (proposed)

- `outcome: "merged" | "already-merged" | "conflict" | "push-failed" | "transient-failure"`
- `diagnosis: string` (required short summary)
- `details?: string` (optional longer context)
- `sourceBranch?: string`
- `targetBranch?: string`
- `mergeCommitSha?: string` (required for `merged`, optional for `already-merged`)
- `requiresHuman?: boolean` (default derived by outcome; explicit override allowed)

### Normalized verdict shape (proposed)

Add in `packages/api/src/index.ts`:

```ts
interface NormalizedMergeVerdict {
  outcome: 'merged' | 'already-merged' | 'conflict' | 'push-failed' | 'transient-failure';
  diagnosis?: string;
  details?: string;
  sourceBranch?: string;
  targetBranch?: string;
  mergeCommitSha?: string;
  requiresHuman: boolean;
}
```

Normalization helper (parallel to `normalizeReviewVerdict`) should:

- enforce enum/length constraints,
- coerce legacy aliases if needed,
- derive sensible default `requiresHuman` (`true` for conflict/push-failed unless explicitly false in controlled cases),
- drop invalid optional fields safely.

Annotation key:

- `percussionist.dev/merge-verdict` on merge run `metadata.annotations`.

## Reconciler behavior proposal

### Observations

- Extend `packages/manager-controller/src/reconciler/observations.ts` with `getMergeVerdict(run)`.
- Parse annotation via API normalizer.

### Decision rules (core)

Update both `decideAwaitingMerge()` and `decideAwaitingFeatureMerge()`:

1. If merge run phase is `Succeeded`:
   - If normalized merge verdict exists:
     - `outcome in {merged, already-merged}` and `requiresHuman === false` -> `done`, set `worker.mergedAt`.
     - `requiresHuman === true` or `outcome === conflict` -> `awaiting-human`, set `worker.mergeError` from diagnosis/details.
     - `outcome in {push-failed, transient-failure}` -> `failed` (or `awaiting-human` for push-failed if policy prefers human gate; decide explicitly during implementation).
   - If no merge verdict (back-compat): preserve current behavior (`done`) but emit audit message indicating unstructured success.
2. If merge run phase is `Failed`: keep current behavior (BUILD -> `failed`; PLAN feature merge -> `awaiting-human`) with `mergeError` from run status message.
3. Stale/missing run handling stays unchanged.

### Why this fixes the incident class

- Integrator can finish run execution successfully while still reporting unresolved conflicts structurally.
- Reconciler no longer equates “run succeeded” with “merge landed.”

## Prompt / instruction changes

Update merge-run prompt in `buildMergeRun()` (`packages/manager-controller/src/worker-builder.ts`):

- Replace completion instruction:
  - from: `When done, call percussionist_dispatcher_complete_run...`
  - to: `Call percussionist_dispatcher_complete_merge with structured outcome...`
- Add explicit outcome mapping guidance:
  - successful push verified -> `merged` (+ sha)
  - already contained/no-op -> `already-merged`
  - merge conflict requiring human intervention -> `conflict`, `requiresHuman=true`
  - remote rejection/auth/protection failure -> `push-failed`
  - infra/network transient -> `transient-failure`

## Concrete implementation tasks

1. **API: add merge verdict types and normalizer**
   - File: `packages/api/src/index.ts`
   - Add schema/types for merge verdict normalization.
   - Export `NormalizedMergeVerdict` and `normalizeMergeVerdict()`.
   - Add unit tests similar to `packages/api/src/__tests__/review-verdict.test.ts`.

2. **Dispatcher MCP: add `complete_merge` tool contract**
   - File: `packages/dispatcher/src/mcp-server.ts`
   - Add tool definition with JSON schema.
   - On call, normalize payload, write `percussionist.dev/merge-verdict` annotation to current Run.
   - Signal completion (reuse run completion mechanism) with summary derived from diagnosis.
   - Keep `complete_run` for non-merge runs.

3. **Dispatcher docs/comments/tool listing updates**
   - Files: `packages/dispatcher/src/index.ts`, header comments in `mcp-server.ts`.
   - Include `complete_merge` in exposed tool lists and explanatory comments.

4. **Reconciler observations: read merge verdict annotation**
   - File: `packages/manager-controller/src/reconciler/observations.ts`
   - Add annotation key constant + parser helper `getMergeVerdict(run)`.

5. **Reconciler decisions: gate merge success on verdict**
   - File: `packages/manager-controller/src/reconciler/decision.ts`
   - Update `decideAwaitingMerge()` and `decideAwaitingFeatureMerge()` success branches to inspect merge verdict.
   - Preserve fallback for missing verdict (compat path) with explicit event reason.
   - Ensure `worker.mergeError` is populated for conflict/human-required outcomes.

6. **Merge prompt update for integrator agent**
   - File: `packages/manager-controller/src/worker-builder.ts`
   - Replace completion instruction and add explicit structured reporting guidance.

7. **Decision engine tests (critical regression coverage)**
   - File: `packages/manager-controller/src/reconciler/__tests__/decision.test.ts`
   - Add/adjust tests for both phases (`awaiting-merge`, `awaiting-feature-merge`):
     - run Succeeded + verdict merged -> done
     - run Succeeded + verdict conflict/requiresHuman -> awaiting-human
     - run Succeeded + verdict push-failed/transient -> failed (or chosen policy)
     - run Succeeded + no verdict -> current fallback behavior

8. **Dispatcher tool tests**
   - Add/extend tests in dispatcher package for `complete_merge` validation + annotation write behavior.

9. **End-to-end deterministic test scenario**
   - Add E2E (likely extended suite) to reproduce incident class:
     - merge run returns structured conflict verdict,
     - PLAN task transitions to `awaiting-human` (not `done`),
     - `mergedAt` remains unset.

10. **Follow-up hardening (optional, if accepted during implementation)**
    - Add warning/telemetry for merge runs still using `complete_run`.
    - Plan migration to require verdict strictly after deprecation window.

## Proposed BUILD task breakdown

1. **BUILD A:** API merge verdict schema + normalization + unit tests.
2. **BUILD B:** Dispatcher `complete_merge` MCP tool + annotation patching + tests.
3. **BUILD C:** Reconciler observations/decision updates for verdict-aware merge outcomes + decision tests.
4. **BUILD D:** Merge prompt updates in worker-builder and deterministic E2E for conflict escalation path.

Dependency order: A -> B -> C -> D (C depends on A types; D depends on B/C behavior).

## Acceptance criteria (implementation-level)

1. Merge runs can report structured outcomes via `complete_merge`.
2. Reconciler does not mark PLAN `done` solely because merge run is `Succeeded`; it requires a success merge verdict (or explicit backward-compatible fallback path).
3. Conflict outcomes route PLAN merge state to `awaiting-human` with `worker.mergeError` set.
4. Same structured behavior applies to BUILD merge runs and PLAN feature->main merge runs.
5. Integrator prompt explicitly instructs `complete_merge` usage and outcome mapping.
6. Automated tests cover the conflict regression path and success path deterministically.

## Risks / open questions

1. **Outcome policy nuance:** whether `push-failed` should be `failed` (retryable) or `awaiting-human` (manual intervention) may depend on environment; choose and document one deterministic policy.
2. **Backward compatibility window:** immediate strict enforcement could affect older integrator prompts/runs; staged rollout with fallback is safer.
3. **Agent compliance:** integrator may still call `complete_run`; decide whether to treat missing verdict as success (temporary) or escalation (strict mode).
4. **Source of truth for merge SHA:** if fast-forward push is no-op/already merged, SHA semantics must be explicit to avoid false validation assumptions.
5. **Phase semantics:** user story mentions `awaiting-human`; current lifecycle already supports it. Introducing a new phase is unnecessary unless product requires separate UI treatment.
