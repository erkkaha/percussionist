# Plan: Testing Improvements for Deterministic Agent Development

**Task:** `percussionist-dev-plan-d26f58`  
**Project:** `percussionist-dev`

## Context

- Current automated coverage is uneven across packages:
  - Strong unit coverage exists mainly in `packages/manager-controller/src/reconciler/__tests__/*.test.ts` (decision engine/flow/scheduler/transitions/reconcile).
  - `packages/memory-service/src/__tests__/*.test.ts` and `packages/web/tests/smoke.test.ts` have focused service/API tests.
  - `packages/operator`, `packages/dispatcher`, `packages/cli`, `packages/kube`, and `packages/api` currently have no direct test suites.
- Current E2E tests (`tests/e2e/*.test.ts`) use Bun + real `kubectl` orchestration helpers in `tests/e2e/helpers/*` and perform broad integration against a live cluster.
- Existing E2E scenarios are partially deterministic but still model-sensitive:
  - `e2e-achieves.test.ts` explicitly expects facilitator reasoning output (`retry_alternative`) and comments that “The LLM must analyze…”, which introduces non-determinism.
  - `e2e-facilitator.test.ts` and `e2e-advances.test.ts` are closer to deterministic behavior using constrained ClusterAgents.
- E2E setup mutates shared controller watch namespace (`PERCUSSIONIST_NAMESPACE`) in `tests/e2e/helpers/setup.ts`, increasing fragility for local runs and parallelism.
- There are consistency gaps in test assets (e.g. e2e tests reference `clusteragent-facilitator-failure.yaml`, but that manifest is not currently present under `k8s/tests/`).

## Scope boundaries

### In scope
- Define a practical testing strategy that improves confidence for future development and aligns agent workflows.
- Make E2E tests deterministic-first and resilient to LLM variability.
- Propose concrete test additions by package and by behavior risk.
- Add guardrails for “agent did actual thing” verification (including pod-level checks when needed).

### Out of scope
- Full implementation of all proposed tests in this PLAN task.
- Re-architecting the entire reconcile engine or replacing Bun/Vitest toolchain globally.
- Building a full external conformance suite for every CRD field immediately.

## Approach

Adopt a **test pyramid with deterministic E2E contract tests at the top**:

1. **Protect logic with pure unit tests first** (decision/transitions/parsing/builders).
2. **Add integration tests for API/tool boundaries** (dispatcher MCP handlers, kube patch semantics, CLI command behavior with mocked K8s).
3. **Refactor E2E into deterministic “control-plane contracts”** where model creativity is not required to pass.
4. **For critical E2E assertions, verify effects directly in Kubernetes resources/pods** rather than trusting assistant text.

Key decision:
- E2E should validate orchestration outcomes (Run/Task phase transitions, created resources, annotations, session persistence, worktree side effects) rather than natural-language reasoning quality from unconstrained models.

## Tasks

1. **Create testing strategy doc for contributors**
   - Add `docs/testing-strategy.md` describing:
     - test layers (unit/integration/e2e),
     - deterministic E2E principles,
     - when to use model-independent fixtures,
     - required checks before merging behavior changes.
   - Cross-link from `README.md` and `AGENTS.md` where testing commands are listed.

2. **Stabilize E2E fixture manifests and naming consistency**
   - Audit and reconcile `k8s/tests/*.yaml` used by `tests/e2e/*.test.ts`.
   - Add/fix missing manifests referenced by tests (notably `clusteragent-facilitator-failure.yaml`), or update tests to existing fixture names.
   - Ensure each E2E scenario has explicitly deterministic ClusterAgents (always fail / always complete / always emit fixed JSON).

3. **Refactor E2E helpers for stronger assertions and clearer failure diagnostics**
   - Extend `tests/e2e/helpers/kubectl.ts` and `tests/e2e/helpers/setup.ts` with reusable probes for:
     - run phase timeline,
     - task phase and worker patch fields,
     - facilitation target wiring,
     - annotation presence/clearing.
   - Improve error output to include `kubectl describe` / relevant logs on timeout.

4. **Introduce deterministic facilitator/reviewer E2E path**
   - Update `tests/e2e/e2e-achieves.test.ts` to avoid dependence on free-form LLM diagnosis.
   - Replace “model must infer retry_alternative” with fixed facilitator agent output fixture (static JSON with `recommendedAction: retry_alternative` + chosen `alternativeAgent`).
   - Keep assertions focused on manager behavior (new run scheduled with expected agent, task progression).

5. **Add “verify in pod/resource” E2E assertions for high-value paths**
   - For scenarios where agent behavior matters, assert side effects from K8s state and runtime context, not message text:
     - verify `Run.status.message` markers for tool-driven completion/failure,
     - verify target `Run.spec.facilitation.*` wiring,
     - when applicable, `kubectl exec` into relevant pod/container to validate expected artifacts or command effects.
   - Add helper wrappers for safe exec checks in `tests/e2e/helpers/kubectl.ts`.

6. **Expand manager-controller integration/unit coverage around currently fragile behavior**
   - Add tests in `packages/manager-controller/src/reconciler/__tests__/` for:
     - `generating-builds` edge cases (buildgen run missing/failed/succeeded with zero child tasks),
     - review fallback behavior when verdict annotation absent,
     - merge retry paths (`failed -> awaiting-merge` admin/human flows),
     - predecessor + `mergedAt` gating under feature branching.
   - Add targeted tests for facilitator parsing behavior in `packages/manager-controller/src/facilitator.ts` (JSON extraction robustness).

7. **Add dispatcher MCP server tests (currently missing)**
   - Create tests under `packages/dispatcher/src/` for `mcp-server.ts` and polling integration points:
     - tool schema validation (`fail_run`, `complete_run`, `complete_plan`, `get_status`),
     - state transitions/signaling behavior,
     - malformed payload handling and error messages.

8. **Add operator/kube contract tests for patch semantics and reconcile assumptions**
   - Add focused tests to lock in behavior called out in docs/conventions:
     - `undefined` dropped in merge patch vs explicit `null` clearing,
     - expected label/annotation propagation on created resources,
     - run status mirroring edge conditions.
   - Prefer lightweight mocked API clients for speed and determinism.

9. **Add CLI command tests for board/task/run flows with mocked kube layer**
   - Introduce tests for `@percussionist/cli` command modules (`runXxx` actions), covering argument validation and expected kube calls.
   - Focus first on high-churn commands (`board task add/move/remove`, `submit`, `wait`, `chat` plumbing).

10. **Define E2E run profiles and CI intent**
    - Split E2E into at least two profiles:
      - **Deterministic PR smoke** (short, model-independent, required for merge).
      - **Long/full soak** (optional/nightly, broader coverage).
    - Document required secrets/context and safe-cluster assumptions currently embedded in `tests/e2e/helpers/setup.ts`.

11. **Publish acceptance checklist for agent-aligned development**
    - Add a concise checklist in docs/AGENTS for feature PRs:
      - updated/added unit tests for changed decision logic,
      - deterministic E2E fixture updates when behavior changes,
      - explicit proof of side effects for agent actions (resource/pod verification where relevant).

## Risks / open questions

1. **Cluster coupling risk**
   - E2E currently modifies live deployment env vars (`PERCUSSIONIST_NAMESPACE`), which can interfere with local clusters if multiple test runs overlap.
   - Open question: should E2E deploy dedicated operator/manager instances into per-test namespaces instead of mutating shared ones?

2. **Tooling split risk (Bun vs Vitest)**
   - E2E uses Bun test runner while package unit tests use Vitest. This is workable but increases maintenance overhead.
   - Open question: keep split intentionally, or standardize long-term?

3. **Model dependency leakage**
   - Even with deterministic agents, accidental prompt/model dependence may creep back into E2E.
   - Mitigation: fixture-only facilitator/reviewer agents and assertions anchored to CR state.

4. **Runtime cost and flakiness**
   - Live-cluster tests are inherently slower and may fail due to environment drift.
   - Mitigation: strict deterministic smoke profile + richer timeout diagnostics + optional extended suite.

5. **Missing fixture/manifests drift**
   - Fixture references can diverge from checked-in YAML over time.
   - Mitigation: add a lightweight validation test that all referenced fixture files exist and parse.

## Acceptance criteria

- A documented testing strategy exists and is linked from contributor-facing docs.
- E2E facilitator/reviewer flows no longer rely on unconstrained model reasoning for pass/fail.
- At least one E2E path validates behavior through direct Kubernetes state/pod-level checks rather than assistant prose.
- Missing/incorrect E2E fixtures are reconciled so suites are self-contained and reproducible.
- New tests are added for previously untested high-risk areas (dispatcher MCP + at least one additional package-level contract area).
- A clear “required vs optional” test profile is defined for day-to-day agent development.

## Proposed BUILD task breakdown

1. **BUILD A — Testing strategy and contributor guidance**
   - Docs: `docs/testing-strategy.md`, `README.md`, `AGENTS.md` links/checklists.

2. **BUILD B — E2E fixture stabilization + deterministic facilitator path**
   - Files: `k8s/tests/*.yaml`, `tests/e2e/e2e-achieves.test.ts`, helper updates as needed.

3. **BUILD C — E2E helper hardening and pod/resource verification assertions**
   - Files: `tests/e2e/helpers/kubectl.ts`, `tests/e2e/helpers/setup.ts`, selected e2e tests.

4. **BUILD D — Manager-controller reconciler/facilitator test expansion**
   - Files: `packages/manager-controller/src/reconciler/__tests__/*.test.ts`, facilitator-focused tests.

5. **BUILD E — Dispatcher MCP test suite**
   - Files: `packages/dispatcher/src/**/*test*.ts` (new), possibly test config scaffolding.

6. **BUILD F — Operator/Kube/CLI contract tests (phased)**
   - Files: targeted test additions in `packages/operator`, `packages/kube`, `packages/cli` (prioritize one package first if scope needs splitting).

7. **BUILD G — E2E profiles + CI execution wiring**
   - Scripts/config/docs updates to separate deterministic smoke from long-running suite.
