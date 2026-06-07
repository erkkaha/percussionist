# Plan: Testing improvements for reliable agent development

## Context

- Current automation has a strong unit/integration foundation in manager reconciler tests (`packages/manager-controller/src/reconciler/__tests__/*.test.ts`) and basic package tests (`pnpm test`), but CI (`.github/workflows/ci.yml`) only enforces build + typecheck.
- Existing E2E tests (`tests/e2e/e2e-facilitator.test.ts`, `e2e-advances.test.ts`, `e2e-achieves.test.ts`) already validate high-value lifecycle transitions (worker fail/succeed, facilitator/reviewer spawn, board done progression).
- E2E harness entry points are centralized in:
  - `tests/e2e/helpers/setup.ts` (cluster bootstrap + teardown)
  - `tests/e2e/helpers/kubectl.ts` (typed wrappers)
  - `tests/e2e/helpers/wait.ts` (polling)
- Determinism is currently mixed:
  - Good: `clusteragent-complete-worker.yaml` and `clusteragent-stubborn-worker.yaml` explicitly invoke `complete_run` / `fail_run`.
  - Weak: review/facilitation assertions in `e2e-advances` and `e2e-achieves` still accept terminal ambiguity (`Succeeded` or `Failed`) and rely on model-generated JSON being parsable.
  - Gap: plan fixture `k8s/tests/e2e-plan-agent.yaml` currently instructs `complete_run` instead of `complete_plan`, which misaligns with current PLAN semantics.
- Self-dev smoke testing (`k8s/self-dev/agents/meta-smoke-tester.yaml`) is intentionally heavy (Docker build + image load + full E2E) and should remain a deeper confidence lane rather than baseline dev gating.

## Scope boundaries

### In scope
- Define a deterministic test strategy that supports future feature development and agent alignment.
- Harden E2E so correctness is judged from CR/run/task state and deterministic tool calls, not model prose quality.
- Add reusable pod-exec utilities for cases where CR status alone is insufficient.
- Add PLAN-specific coverage using `complete_plan` semantics and plan artifact expectations.
- Propose CI tiering so fast checks are required and heavy smoke flows are optional/scheduled.

### Out of scope
- Rewriting reconciliation behavior solely for tests.
- Building a full multi-cluster matrix.
- Replacing existing smoke-test purpose (it remains the heavier integration lane).

## Assumptions

1. We can introduce additional test-only ClusterAgent fixtures under `k8s/tests/`.
2. Required CI checks must stay reasonably fast (target: minutes, not tens of minutes).
3. For deterministic E2E, invoking dispatcher tools (`complete_run`, `complete_plan`, `fail_run`) is preferred over natural language output.
4. Pod exec is acceptable when validating worktree/branch/session artifacts that are not exposed as stable API fields.

## Approach

1. **Adopt a layered testing model with explicit ownership**
   - Keep package tests as the default fast guardrail.
   - Add deterministic E2E “core” scenarios for lifecycle invariants.
   - Keep smoke tests as a separate deep lane (manual/scheduled/release-gated).

2. **Make E2E deterministic by construction (no model trust)**
   - Use test agents that either:
     - call dispatcher tools directly (preferred), or
     - emit fixed JSON with strict schema and no open-ended reasoning.
   - Convert ambiguous assertions into explicit phase/annotation/board expectations.

3. **Provide pod-exec checks as targeted ground truth tools**
   - Extend `tests/e2e/helpers/kubectl.ts` with `kubectlExec(...)` and JSON-safe helpers.
   - Use only for verification that cannot be asserted via Task/Run/Project status (e.g., plan file presence in worktree, branch name, session snapshot availability).

4. **Stabilize harness lifecycle and debugging ergonomics**
   - Improve `setup.ts` to isolate suites (unique namespaces/project names, consistent cleanup, safer env restoration).
   - Add structured failure dumps (runs/tasks/events/log snippets) to reduce flaky triage.

5. **Align tests with actual agent workflow semantics**
   - Add explicit PLAN E2E proving `complete_plan` and `.percussionist/plans/{task-id}.md` behavior.
   - Ensure BUILD and facilitation/review cases reflect transition rules represented in reconciler decision tests.

6. **Integrate two CI tiers**
   - Tier 1 (required on PR): build + typecheck + deterministic E2E core subset.
   - Tier 2 (optional/manual/scheduled): full E2E + smoke image flow + richer artifact capture.

## Tasks

1. **Write a testing strategy document**
   - Add `docs/testing-strategy.md` (or equivalent) defining layers, commands, and deterministic rules.
   - Document “what must be deterministic” and “what may remain model-dependent (if any)”.

2. **Normalize and expand deterministic ClusterAgent fixtures (`k8s/tests/`)**
   - Add/rename fixtures so intent is explicit (e.g., `clusteragent-plan-complete.yaml`, `clusteragent-reviewer-approve.yaml`, `clusteragent-facilitator-retry-alt.yaml`).
   - Fix plan fixture semantics: ensure PLAN test agent uses `complete_plan` (not `complete_run`).
   - Keep existing worker fixtures but remove duplicates/ambiguity where possible (`e2e-*.yaml` vs `clusteragent-*.yaml`).

3. **Upgrade kubectl helper surface in `tests/e2e/helpers/kubectl.ts`**
   - Add `kubectlExec(namespace, target, container?, command[])` wrapper.
   - Add helpers for JSON output extraction and strict parse errors.
   - Add reusable diagnostics helpers (`describeResource`, `logsForRun`, `listEvents`) for failure snapshots.

4. **Harden setup/teardown in `tests/e2e/helpers/setup.ts`**
   - Introduce safer setup API options (timeouts, namespace suffixes, deterministic cleanup policy).
   - Ensure teardown and env reset execute even after assertion errors.
   - Add explicit guardrails to avoid cross-suite namespace collisions.

5. **Refactor existing E2E suites to strict deterministic expectations**
   - `tests/e2e/e2e-advances.test.ts`: require deterministic reviewer outcome (no `Succeeded|Failed` fallback if deterministic fixture used).
   - `tests/e2e/e2e-achieves.test.ts`: require deterministic facilitator action and alternative agent dispatch outcome.
   - `tests/e2e/e2e-facilitator.test.ts`: keep deterministic fail path, add stronger assertions on facilitation linkage and status fields.

6. **Add PLAN-specific E2E coverage**
   - New test file under `tests/e2e/` for PLAN completion lifecycle.
   - Validate expected PLAN artifact path (`.percussionist/plans/<task-id>.md`) via pod-exec when needed.
   - Assert downstream phase transitions that follow from approved PLAN flow.

7. **Add dependency/feature-branch lifecycle E2E coverage (extended tier)**
   - Add scenario verifying predecessor gating and/or merge metadata visibility for BUILD chains.
   - Validate key worker status fields (`gitBranch`, `parentBranch`, `mergeIntoBranch`) where feature branching is enabled.

8. **Introduce suite selection conventions and scripts**
   - Add script variants in root `package.json` and/or `tests/e2e/package.json` (e.g., `e2e:core`, `e2e:extended`).
   - Use file naming or env-based filtering to keep selection deterministic and maintainable.

9. **Integrate CI tiers**
   - Update `.github/workflows/ci.yml` (or add dedicated E2E workflow) so Tier 1 runs on PR.
   - Add artifact upload for failures (kubectl diagnostics, logs, board snapshots).
   - Keep Tier 2 on manual dispatch/schedule to avoid slowing everyday iteration.

10. **Align self-dev smoke guidance**
    - Update `k8s/self-dev/agents/meta-smoke-tester.yaml` to run deterministic suite commands by default.
    - Require explicit failure evidence capture and infra-vs-product failure classification in its JSON output.

11. **Publish contributor workflow guidance**
    - Update `k8s/self-dev/README.md` and/or AGENTS docs with “when to run which tier”.
    - Provide recipe for adding a new deterministic E2E: fixture → helper usage → assertions → cleanup.

## Acceptance criteria

1. A documented testing strategy clearly defines unit/integration/E2E/smoke responsibilities and execution paths.
2. Core E2E tests pass repeatedly without depending on model reasoning quality.
3. PLAN E2E validates `complete_plan` semantics and plan artifact expectations.
4. Existing facilitator/reviewer E2E tests no longer rely on permissive terminal-state assertions for deterministic fixtures.
5. Pod-exec assertions are available as reusable helpers and used only where API state is insufficient.
6. CI enforces at least one required deterministic test tier beyond build/typecheck.
7. Self-dev smoke instructions and contributor docs are updated to reflect the tiered strategy.

## Risks / open questions

1. **CI cluster runtime choice:** determine whether to run core E2E on GitHub-hosted Kind or self-hosted runners.
2. **Runtime budget:** even deterministic E2E may be too slow for every PR if setup remains heavyweight.
3. **Fixture duplication debt:** current overlap between `e2e-*.yaml` and `clusteragent-*.yaml` may cause confusion unless consolidated.
4. **Pod-exec fragility:** commands used for exec assertions must remain minimal and image-stable.
5. **Feature-branch coverage boundary:** decide whether branch/merge metadata checks are core or extended tier only.

## Proposed BUILD task breakdown

1. **BUILD-A: Testing strategy + contributor docs**
   - Deliver strategy doc and contributor guidance for tier selection and deterministic principles.

2. **BUILD-B: Deterministic fixture consolidation and PLAN semantic fix**
   - Clean/expand `k8s/tests/` fixtures, including PLAN fixture that calls `complete_plan`.
   - Depends on: BUILD-A.

3. **BUILD-C: E2E helper hardening (exec + diagnostics + lifecycle APIs)**
   - Extend `tests/e2e/helpers/kubectl.ts` and `setup.ts` with reusable deterministic primitives.
   - Depends on: BUILD-B.

4. **BUILD-D: Refactor existing E2E tests to strict deterministic assertions**
   - Update `e2e-facilitator`, `e2e-advances`, `e2e-achieves` to use new fixtures/helpers and strict outcomes.
   - Depends on: BUILD-C.

5. **BUILD-E: New PLAN lifecycle E2E + dependency/feature-branch extended E2E**
   - Add missing PLAN and predecessor/branch lifecycle scenarios.
   - Depends on: BUILD-D.

6. **BUILD-F: CI tier rollout + smoke-agent alignment**
   - Introduce required core tier and optional extended/smoke tier; update smoke agent instructions for deterministic evidence.
   - Depends on: BUILD-D (and BUILD-E if extended coverage is included in Tier 1/2 workflows).
