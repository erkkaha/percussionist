# Plan: Testing improvements for reliable, model-independent agent development

## Context

- The current test surface is split across:
  - **State-machine/unit tests** in `packages/manager-controller/src/reconciler/__tests__/*.test.ts` (e.g. `decision.test.ts`, `scheduler.test.ts`, `transitions.test.ts`, `flow.test.ts`, `reconcile.test.ts`).
  - **Package-level tests** like `packages/web/tests/smoke.test.ts` and `packages/memory-service/src/__tests__/routes.test.ts`.
  - **Cluster E2E tests** in `tests/e2e/*.test.ts` with shared harness code in `tests/e2e/helpers/setup.ts`, `kubectl.ts`, and `wait.ts`.
- The root CI workflow (`.github/workflows/ci.yml`) currently runs only `pnpm build` and `pnpm typecheck`; no deterministic E2E is required on PRs.
- Existing E2E already covers important orchestrator flows:
  - `e2e-facilitator.test.ts`: worker failure triggers facilitator run.
  - `e2e-advances.test.ts`: successful worker triggers reviewer and task reaches done.
  - `e2e-achieves.test.ts`: failed worker + facilitator recommendation results in alternative worker success.
- Determinism is currently uneven:
  - Good: fixtures like `k8s/tests/clusteragent-stubborn-worker.yaml` call `fail_run` directly.
  - Weak: some tests still allow reviewer/facilitator terminal ambiguity (`Succeeded` or `Failed`) and infer correctness from model-produced text/JSON.
  - Gap: `k8s/tests/e2e-plan-agent.yaml` instructs a PLAN test agent to call `complete_run`, not `complete_plan`.
- Current self-dev smoke flow (`k8s/self-dev/agents/meta-smoke-tester.yaml`) is heavy (build images, load to minikube, run full E2E) and suitable as a deep lane, not default PR gate.

## Scope boundaries

### In scope
1. Define a clear **testing strategy** for future development and agent alignment.
2. Make core E2E assertions **model-independent** (state/tool-driven, not prose-driven).
3. Add safe, reusable **pod exec verification** for artifacts not represented in CR status.
4. Add PLAN lifecycle coverage that validates `complete_plan` and plan-artifact behavior.
5. Propose a practical **tiered CI strategy** (fast required lane + deeper optional lane).

### Out of scope
1. Re-architecting the reconciler solely for testability.
2. Building a full multi-cluster or provider test matrix.
3. Converting smoke tests into a mandatory per-PR gate.

## Assumptions

1. We can add/rename test-only ClusterAgent fixtures under `k8s/tests/`.
2. Deterministic E2E should prefer explicit MCP tool calls (`complete_plan`, `complete_run`, `fail_run`) over LLM-generated summaries.
3. `kubectl exec` in E2E pods is acceptable when CR fields do not expose the needed fact.
4. PR-required checks must remain relatively fast (single-digit minutes target).

## Approach

1. **Codify a layered test strategy** so contributors know where to add coverage (unit vs E2E vs smoke).
2. **Redesign core E2E around deterministic control points**:
   - deterministic test agents,
   - strict assertions on `Run.status`, `Task.status`, and board state,
   - no “model guessed correctly” requirements.
3. **Use pod-exec only as a targeted oracle** for non-API-visible facts (e.g., plan artifact exists in worktree).
4. **Separate lanes**:
   - core deterministic E2E (PR-eligible),
   - extended/smoke E2E (manual or scheduled).
5. **Align PLAN semantics explicitly** by testing `complete_plan` path and `.percussionist/plans/<task-id>.md` expectations.

## Tasks

1. **Document testing strategy and boundaries**
   - Add `docs/testing-strategy.md` defining:
     - test layers,
     - ownership,
     - deterministic rules (“never trust model prose for pass/fail”),
     - when pod-exec is allowed.
   - Include canonical commands from root (`pnpm test`, `pnpm e2e`) and planned split commands (core vs extended).

2. **Fix PLAN fixture semantics and consolidate E2E fixtures**
   - Update `k8s/tests/e2e-plan-agent.yaml` to use `complete_plan` semantics.
   - Reconcile overlapping fixture naming between `e2e-*.yaml` and `clusteragent-*.yaml`.
   - Create explicit deterministic fixtures for:
     - plan completion,
     - reviewer approve/request_changes,
     - facilitator retry_same/retry_alternative.

3. **Strengthen E2E helper API in `tests/e2e/helpers/kubectl.ts`**
   - Add `kubectlExec(...)` wrapper with container targeting.
   - Add convenience helpers for deterministic evidence collection (run logs, describe, events).
   - Add robust JSON parsing helpers for exec output with strict error surfacing.

4. **Harden E2E setup/teardown ergonomics in `tests/e2e/helpers/setup.ts`**
   - Improve namespace isolation conventions (suite-unique names/suffixes).
   - Ensure cleanup/env restoration runs even after assertion failures.
   - Add optional debug mode to retain namespace on failure for triage.

5. **Refactor current E2E suites to strict deterministic assertions**
   - `tests/e2e/e2e-advances.test.ts`: stop accepting ambiguous reviewer run outcomes when deterministic fixture is used.
   - `tests/e2e/e2e-achieves.test.ts`: assert facilitator recommendation path and alternative-agent dispatch deterministically.
   - `tests/e2e/e2e-facilitator.test.ts`: add stronger linkage assertions (`targetRunName`, status reason/message shape).

6. **Add new PLAN lifecycle E2E**
   - Add `tests/e2e/e2e-plan-completion.test.ts` (name TBD).
   - Validate:
     - PLAN run completes via `complete_plan`,
     - expected plan artifact path `.percussionist/plans/<task-id>.md` exists (pod-exec when needed),
     - resulting task phase transitions align with flow settings.

7. **Add extended E2E for feature-branch/dependency correctness**
   - Add scenario for predecessor gating + merged dependency behavior.
   - Assert key worker metadata fields (`gitBranch`, `parentBranch`, `mergeIntoBranch`) under `featureBranchingEnabled: true`.
   - Keep this scenario in extended lane unless runtime proves acceptable for core.

8. **Define and wire E2E suite tiers**
   - Add script split in root `package.json` and/or `tests/e2e/package.json`:
     - `e2e:core` (deterministic fast lane),
     - `e2e:extended` (longer branch/dependency paths),
     - keep `e2e` as aggregate if desired.
   - Ensure test-file selection mechanism is explicit and stable.

9. **Integrate core lane in CI and preserve deep smoke lane**
   - Extend `.github/workflows/ci.yml` or add dedicated workflow to run deterministic core E2E on PRs.
   - Upload diagnostics artifacts on failure (events, run summaries, logs).
   - Keep heavy smoke (`meta-smoke-tester`) as manual/scheduled/release gate.

10. **Update self-dev smoke and contributor guidance**
    - Update `k8s/self-dev/agents/meta-smoke-tester.yaml` to prioritize deterministic suite commands and structured evidence output.
    - Update `k8s/self-dev/README.md` (and AGENTS docs if needed) with “which lane to run when”.
    - Add contributor checklist for adding new deterministic E2E tests (fixture + helper + assertions + cleanup).

## Acceptance criteria

1. A committed testing strategy document explains test layers and deterministic rules.
2. Core E2E tests no longer depend on model narrative quality to pass/fail.
3. PLAN-specific E2E verifies `complete_plan` and plan artifact expectations.
4. Existing E2E suites use strict state-based assertions instead of permissive terminal fallbacks.
5. Pod-exec checks are implemented as reusable helpers and used only where CR status is insufficient.
6. CI includes at least one required deterministic E2E lane in addition to build/typecheck.
7. Self-dev smoke guidance and contributor docs match the tiered strategy.

## Risks / open questions

1. **Runtime budget:** even deterministic E2E may be too slow if cluster bootstrap remains expensive.
2. **CI environment choice:** decide between GitHub-hosted Kind, self-hosted cluster, or split strategy.
3. **Fixture migration churn:** renaming/consolidating fixtures may briefly destabilize existing test references.
4. **Pod-exec brittleness:** checks must avoid image/path assumptions that can drift.
5. **Tier boundary decisions:** determine whether feature-branch metadata tests stay extended or move to core.

## Proposed BUILD task breakdown

1. **BUILD-1 — Testing strategy + docs lane definition**
   - Deliver `docs/testing-strategy.md` and contributor lane-selection guidance.

2. **BUILD-2 — Deterministic fixture cleanup + PLAN semantic correction**
   - Update `k8s/tests/*` fixtures including `e2e-plan-agent.yaml` to align with `complete_plan`.
   - Depends on: BUILD-1.

3. **BUILD-3 — E2E helper hardening (kubectl exec + diagnostics)**
   - Extend `tests/e2e/helpers/kubectl.ts` and `setup.ts` with stable primitives for deterministic checks.
   - Depends on: BUILD-2.

4. **BUILD-4 — Refactor existing E2E to strict deterministic behavior**
   - Update `e2e-facilitator`, `e2e-advances`, and `e2e-achieves` to remove model-dependent ambiguity.
   - Depends on: BUILD-3.

5. **BUILD-5 — Add PLAN lifecycle and feature-branch/dependency E2E**
   - Add missing PLAN completion coverage and extended branch/dependency scenarios.
   - Depends on: BUILD-4.

6. **BUILD-6 — CI integration + smoke-agent alignment**
   - Wire `e2e:core` into PR CI; keep extended/smoke in optional lane; update meta-smoke tester output expectations.
   - Depends on: BUILD-4 (and BUILD-5 if extended suite wiring is included).
