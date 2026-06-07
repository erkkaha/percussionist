# Plan: Testing improvements for reliable agent development

## Context

- Current test entrypoints are split between root scripts (`/workspace/package.json`):
  - `pnpm test` (package-level test suites)
  - `pnpm e2e` (`bun test tests/e2e/ --timeout 660000 --concurrency 1`)
- End-to-end coverage lives in `tests/e2e/` with shared cluster setup in:
  - `tests/e2e/helpers/setup.ts`
  - `tests/e2e/helpers/kubectl.ts`
  - `tests/e2e/helpers/wait.ts`
- Existing e2e flows (`e2e-facilitator.test.ts`, `e2e-advances.test.ts`, `e2e-achieves.test.ts`) already validate key board/run transitions, but parts of the flow still tolerate model-dependent behavior (for example allowing facilitation/review runs to end as `Succeeded` or `Failed` and continuing if JSON is still parsed).
- Test ClusterAgent manifests in `k8s/tests/*.yaml` are partially deterministic (e.g. explicit `complete_run`/`fail_run` workers), but facilitator/reviewer outcomes are not fully isolated from model variability.
- CI currently runs build/typecheck only (`.github/workflows/ci.yml`), so test failures are discovered late and inconsistently.
- There is an existing smoke-testing role (`k8s/self-dev/agents/meta-smoke-tester.yaml`) that builds images and runs e2e in an isolated namespace, but this flow is heavy and not suitable as a fast, repeatable quality gate for regular development.

## Scope boundaries

### In scope
- Define a deterministic, layered testing strategy for future development.
- Refactor e2e scenarios to reduce or eliminate trust in model quality.
- Add reusable harness utilities for in-cluster assertions, including pod-exec checks where needed.
- Align test expectations with agent-development workflows (PLAN/BUILD/review/facilitation paths).
- Introduce CI gating strategy for fast tests plus optional heavier e2e tiers.

### Out of scope
- Rewriting manager reconciliation logic unrelated to testability.
- Re-architecting deployment/runtime components outside test harness needs.
- Building a full production-scale cluster test matrix in this iteration.

## Approach

1. **Adopt a clear test pyramid for Percussionist**
   - Keep package-level tests as the default fast guardrail.
   - Add a deterministic e2e "core" suite for board lifecycle invariants.
   - Keep smoke image-build validation as a separate, slower lane.

2. **Make e2e deterministic by design (no model trust)**
   - Treat model text quality as non-authoritative in e2e.
   - Prefer scripted test agents that call control-plane MCP tools (`complete_run`, `complete_plan`, `fail_run`) or output fixed JSON payloads.
   - Replace assertions that depend on nuanced model reasoning with assertions on Kubernetes state transitions and run/task status fields.

3. **Add pod-exec based assertions for ground truth when needed**
   - Extend `tests/e2e/helpers/kubectl.ts` with explicit helpers for `kubectl exec` + structured output parsing.
   - Use exec-based checks for evidence that cannot be reliably inferred from status alone (e.g., expected files in worktree, branch checkout, session snapshot availability, container-level command results).
   - Keep these checks targeted and deterministic; avoid broad shell-script assertions that are hard to debug.

4. **Stabilize and parameterize e2e environment setup**
   - Consolidate repeated suite patterns (namespace naming, project naming, agent fixture selection).
   - Add strict cleanup guarantees and clearer failure diagnostics (resource snapshots on timeout/failure).
   - Introduce tagged suites (e.g. `core`, `extended`, `smoke`) to support selective execution locally and in CI.

5. **Align tests with agent-development lifecycle**
   - Add deterministic scenarios for PLAN completion semantics (`complete_plan`) and BUILD completion semantics (`complete_run`).
   - Cover failure-analysis and review transitions with fixed facilitator/reviewer fixtures.
   - Ensure test names and assertions map directly to board phases and task/run status fields used by maintainers.

6. **Wire tests into CI in two tiers**
   - Tier 1 (required): fast package-level tests + deterministic e2e core subset.
   - Tier 2 (optional/nightly/manual): full e2e + smoke image build/deploy path.
   - Publish artifacts on failures (kubectl describe/logs + board snapshots) to reduce triage time.

## Tasks

1. **Document target testing architecture**
   - Add a testing strategy doc under `docs/` describing layers, ownership, and execution commands.
   - Define "deterministic e2e" rules (no semantic dependence on model correctness).

2. **Define canonical deterministic test fixtures in `k8s/tests/`**
   - Add/update ClusterAgent fixtures for:
     - always-complete BUILD worker
     - always-fail BUILD worker
     - deterministic PLAN completer (calls `complete_plan`)
     - deterministic facilitator/reviewer JSON responders
   - Ensure fixture naming clearly signals intent and test scope.

3. **Refactor e2e helper library for reuse and observability**
   - Extend `tests/e2e/helpers/kubectl.ts` with:
     - `kubectlExec(...)` wrapper
     - helper(s) to fetch structured JSON from exec output
     - helper(s) for richer failure dumps
   - Keep existing typed wrappers and error handling patterns.

4. **Harden cluster lifecycle handling in `tests/e2e/helpers/setup.ts`**
   - Add stricter before/after semantics to avoid cross-suite leakage.
   - Add configurable timeouts and polling defaults for slower clusters.
   - Ensure teardown runs even when intermediate assertions fail.

5. **Rewrite current e2e scenarios to remove model-trust assumptions**
   - Update `tests/e2e/e2e-facilitator.test.ts`, `e2e-advances.test.ts`, and `e2e-achieves.test.ts` to assert deterministic transitions.
   - Replace permissive assertions ("Succeeded or Failed") with explicit expected outcomes where fixtures are deterministic.
   - Use pod-exec assertions only where state transitions are insufficient.

6. **Add missing lifecycle coverage for agent workflow alignment**
   - Add an e2e scenario for PLAN task completion using `complete_plan` and plan artifact expectations.
   - Add/expand BUILD-chain scenario coverage for predecessor dependency behavior and merge gating metadata when applicable.

7. **Introduce suite tagging/execution modes**
   - Add a lightweight convention for selecting `core` vs `extended` suites.
   - Update root/test scripts to expose these modes clearly for local development and automation.

8. **Integrate deterministic tests into CI workflow**
   - Extend `.github/workflows/ci.yml` (or add a dedicated workflow) to run required test tier(s).
   - Keep required checks fast enough for PR iteration; move heavy cluster/image flows to separate trigger.

9. **Align self-dev smoke workflow with deterministic evidence collection**
   - Update `k8s/self-dev/agents/meta-smoke-tester.yaml` guidance to prefer deterministic suite commands and mandatory artifact collection on failure.
   - Ensure smoke output clearly distinguishes infra failures from product-regression failures.

10. **Add contributor guidance for agent developers**
    - Document how to pick the right test tier before/after agent changes.
    - Include patterns for adding new deterministic e2e cases (fixture + assertions + cleanup expectations).

## Acceptance criteria

1. Deterministic e2e core suite can be run repeatedly with stable pass/fail behavior without relying on model reasoning quality.
2. E2E assertions primarily validate CR/task/run state transitions; model-generated prose is not used as a correctness oracle.
3. Pod-exec checks are available as reusable helpers and used only for state that cannot be asserted from CR status/board data.
4. PLAN and BUILD completion semantics are both covered by e2e using the correct dispatcher tools.
5. CI enforces at least one required test tier beyond build/typecheck.
6. Smoke workflow instructions and contributor docs are updated to match the new deterministic strategy.

## Risks / open questions

1. **Cluster availability in CI:** running deterministic e2e still requires a reliable Kubernetes runtime; decide whether to run only on specific runners or on schedule/manual triggers.
2. **Execution time budget:** even deterministic e2e can be slow; need a strict boundary between required core checks and extended coverage.
3. **Fixture drift:** test ClusterAgent manifests can drift from production assumptions; assign ownership and review expectations for `k8s/tests/` fixtures.
4. **Pod-exec portability:** command availability inside containers may vary by image; helpers should avoid brittle shell dependencies.
5. **Feature-branch workflow coverage depth:** clarify whether branch/merge metadata tests are required in core tier or only extended tier.

## Proposed BUILD task breakdown

1. **BUILD-A: Testing strategy doc + contributor guidance**
   - Deliver docs for test pyramid, deterministic rules, and developer workflow.

2. **BUILD-B: Deterministic ClusterAgent fixture set refresh**
   - Add/update fixture manifests in `k8s/tests/` for deterministic PLAN/BUILD/facilitator/reviewer paths.
   - Depends on: BUILD-A.

3. **BUILD-C: E2E helper upgrades (exec + diagnostics + lifecycle hardening)**
   - Extend `tests/e2e/helpers/kubectl.ts` and `setup.ts` with reusable deterministic utilities.
   - Depends on: BUILD-B.

4. **BUILD-D: Refactor existing e2e suites to deterministic assertions**
   - Update current e2e test files to use new fixtures/helpers and strict outcomes.
   - Depends on: BUILD-C.

5. **BUILD-E: Add PLAN-centric and dependency/branch lifecycle e2e coverage**
   - Add missing scenario files for plan completion and task dependency behavior.
   - Depends on: BUILD-D.

6. **BUILD-F: CI test-tier integration + smoke-agent alignment**
   - Add/adjust workflows for required vs optional tiers; update `meta-smoke-tester` instructions and failure artifact expectations.
   - Depends on: BUILD-D (and BUILD-E if new suites are required in CI).
