# Plan: Testing Improvements for Deterministic Agent Development (Bun-first)

**Task:** `percussionist-dev-plan-d26f58`  
**Project:** `percussionist-dev`

## Context

- Existing test surface is broad but inconsistent:
  - `tests/e2e/*.test.ts` already runs with Bun (`bun:test`) and real `kubectl` orchestration via `tests/e2e/helpers/{setup,kubectl,wait}.ts`.
  - `packages/web/tests/smoke.test.ts` and `packages/memory-service/src/__tests__/*.test.ts` are already Bun-based and deterministic.
  - `packages/manager-controller/src/reconciler/__tests__/*.test.ts` still uses Vitest imports/config (`packages/manager-controller/package.json`, `vitest.config.ts`) and is now the main outlier.
- E2E determinism is partial:
  - `tests/e2e/e2e-achieves.test.ts` still depends on facilitator reasoning and comments “LLM must analyze…”.
  - `tests/e2e/e2e-facilitator.test.ts` and `tests/e2e/e2e-advances.test.ts` are closer to control-plane contract tests.
- Fixture drift exists:
  - E2E references `clusteragent-facilitator-failure.yaml`, but current `k8s/tests/` has `clusteragent-facilitator.yaml`, `clusteragent-reviewer.yaml`, and `clusteragent-failure-analyst.yaml`.
- Cluster-level setup is fragile:
  - `tests/e2e/helpers/setup.ts` patches shared deployments’ `PERCUSSIONIST_NAMESPACE`, which is hard to parallelize safely.
- Self-dev flow expects smoke confidence (`k8s/self-dev/README.md`, `k8s/self-dev/agents/meta-smoke-tester.yaml`) but currently uses heavy image-build + long E2E runs as the main gate.

## Scope boundaries

### In scope
- Define a Bun-first testing strategy that aligns agent development loops.
- Make E2E deterministic-by-default (model-independent pass/fail).
- Add high-value assertions that validate Kubernetes/pod side effects instead of trusting model text.
- Propose concrete package-level testing expansions and CI/smoke profile split.

### Out of scope
- Implementing every proposed test in this PLAN task.
- Full infra redesign of cluster provisioning for all tests.
- Evaluating subjective model quality (prompt quality benchmarks, natural-language scoring).

## Approach

Use a **Bun-first test pyramid** with deterministic control-plane E2E contracts:

1. **Unify test runner direction toward Bun** so contributor commands are simpler and agent workflows are consistent.
2. **Expand fast package-level tests** for decision logic and tool contracts to reduce reliance on expensive cluster tests.
3. **Reframe E2E as orchestration verification** (Run/Task state, annotations, facilitation wiring, session artifacts), not free-form model reasoning.
4. **Use pod/resource verification for agent actions** when behavior claims matter (e.g., check files/process output via `kubectl exec` or resource status via `kubectl get/describe`).

Assumption (explicit): mainline direction is Bun as primary test runner; this plan includes migration work for remaining Vitest areas to align with that direction.

## Tasks

1. **Document the testing model and merge gates**
   - Add `docs/testing-strategy.md` with layers: package/unit, integration/contract, deterministic e2e smoke, optional full soak.
   - Define “agent-aligned proof” rules: when a test must verify CR state and when pod exec checks are required.
   - Link from `README.md` and `AGENTS.md` command sections.

2. **Move manager-controller tests from Vitest to Bun**
   - Migrate imports in `packages/manager-controller/src/reconciler/__tests__/*.test.ts` from `vitest` to `bun:test` equivalents.
   - Update `packages/manager-controller/package.json` scripts/devDependencies for Bun runner.
   - Remove obsolete `packages/manager-controller/vitest.config.ts` if no longer needed.
   - Ensure root-level `pnpm test` behavior remains coherent after migration.

3. **Stabilize E2E fixture inventory and naming**
   - Audit `tests/e2e/*.test.ts` manifest references against `k8s/tests/*.yaml`.
   - Resolve missing/renamed facilitator fixture references (either create missing file or update test references to canonical fixtures).
   - Add a lightweight fixture existence/parse test to catch drift early.

4. **Make facilitator/reviewer E2E deterministic**
   - Update `tests/e2e/e2e-achieves.test.ts` to use fixed facilitator output (static JSON contract) rather than unconstrained reasoning.
   - Keep assertions on manager outcomes: retry path selection, alternative agent run creation, terminal phases.
   - Ensure reviewer-style flows remain deterministic (`clusteragent-reviewer.yaml` pattern).

5. **Add stronger Kubernetes-side assertions and pod exec helpers**
   - Extend `tests/e2e/helpers/kubectl.ts` with safe wrappers for:
     - `kubectl describe` dump on timeout,
     - targeted `read logs` helper for failed run pods,
     - controlled `kubectl exec` checks (container name + command + timeout).
   - Use these helpers in at least one e2e scenario to validate runtime side effects rather than assistant text.

6. **Add missing package-level contract tests in high-risk areas**
   - **Dispatcher:** add tests for MCP handlers (`complete_plan`, `complete_run`, `fail_run`, `get_status`) and malformed payload paths.
   - **Kube/Operator contract edges:** add tests for merge-patch semantics (`undefined` dropped vs `null` clears), label/annotation propagation.
   - **CLI:** add focused tests for high-churn `runXxx` command behavior with mocked kube layer.

7. **Split E2E execution profiles for developer flow**
   - Define deterministic PR smoke profile (short, no model trust assumptions).
   - Define optional extended/full profile for broader regressions.
   - Update self-dev smoke guidance (`k8s/self-dev/README.md` and/or smoke agent instructions) to prefer deterministic profile for standard validation and reserve full suite for deeper checks.

8. **Reduce e2e environment coupling over time**
   - Short-term: document safe assumptions in `tests/e2e/helpers/setup.ts` and add guardrails around namespace mutation.
   - Follow-up option: dedicate isolated operator/manager instances per e2e run namespace to enable parallel runs without global env mutation.

## Risks / open questions

1. **Bun migration compatibility risk**
   - Some Vitest mock/spy patterns may need adaptation in `manager-controller` tests.
   - Mitigation: migrate incrementally file-by-file and keep behavior parity checks.

2. **Cluster flakiness and runtime cost**
   - Live-cluster e2e remains slower and can fail from environment drift.
   - Mitigation: deterministic smoke profile + stronger diagnostics (`describe/logs/exec`) for fast triage.

3. **Fixture/prompt drift**
   - Deterministic manifests can still drift from test expectations over time.
   - Mitigation: add fixture reference validation test and keep fixtures minimal/static.

4. **Pod exec brittleness/security**
   - `kubectl exec` assertions can be fragile if container names or startup timing change.
   - Mitigation: use helper abstractions with retries, explicit container targeting, and fallback to resource-level assertions where possible.

5. **Namespace mutation interference**
   - Current setup patches shared deployments’ watch namespace.
   - Open question: when to prioritize isolated control-plane deployment for tests vs incremental hardening only?

## Acceptance criteria

- Testing strategy doc exists and is linked from contributor-facing docs.
- Bun is the primary test runner across active package tests (including `manager-controller`), with obsolete Vitest scaffolding removed or intentionally retained with explicit rationale.
- E2E facilitator/reviewer scenarios are deterministic and do not rely on unconstrained model reasoning.
- At least one E2E path proves behavior via Kubernetes state and/or pod exec side-effect verification.
- Fixture references used by E2E are consistent with `k8s/tests/` and validated by an automated check.
- A documented required-vs-optional test profile split exists for day-to-day agent development.

## Proposed BUILD task breakdown

1. **BUILD A — Bun-first test strategy docs + contributor checklist**
   - Files: `docs/testing-strategy.md`, `README.md`, `AGENTS.md`.

2. **BUILD B — Manager-controller Vitest→Bun migration**
   - Files: `packages/manager-controller/src/reconciler/__tests__/*.test.ts`, `packages/manager-controller/package.json`, remove/replace `vitest.config.ts`.

3. **BUILD C — E2E fixture consistency + deterministic facilitator path**
   - Files: `k8s/tests/*.yaml`, `tests/e2e/e2e-achieves.test.ts`, fixture validation test file.

4. **BUILD D — E2E helper hardening + pod/resource verification assertions**
   - Files: `tests/e2e/helpers/kubectl.ts`, `tests/e2e/helpers/setup.ts`, selected `tests/e2e/*.test.ts`.

5. **BUILD E — Dispatcher MCP contract tests**
   - Files: new tests under `packages/dispatcher/src/**` (and test config/scripts as required).

6. **BUILD F — Kube/Operator/CLI contract coverage expansion**
   - Files: targeted tests in `packages/kube`, `packages/operator`, `packages/cli` for patch semantics and command behavior.

7. **BUILD G — E2E profile split + self-dev smoke alignment**
   - Files: root/package scripts, e2e docs, `k8s/self-dev/README.md`, and possibly `k8s/self-dev/agents/meta-smoke-tester.yaml` guidance.
