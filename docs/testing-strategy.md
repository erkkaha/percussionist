# Testing Strategy

## Overview

Percussionist uses a **four-layer testing model** to balance speed, confidence, and coverage across development workflows: unit tests (fastest), integration/smoke tests, deterministic E2E (core lane), and extended E2E (deep lane). Each layer has explicit responsibility boundaries and deterministic pass/fail criteria.

## Layers

### Layer 1 — Unit Tests (`packages/*/src/__tests__/*.test.ts`)

**Scope:** Individual functions, classes, and pure logic with no external dependencies.

- Run via `pnpm test` (which delegates to `pnpm -r run test`).
- Framework: Bun test (all packages).
- No network calls, no file system mutations beyond temp dirs, no Kubernetes client.
- Examples: state-machine transitions (`transitions.test.ts`), scheduler logic (`scheduler.test.ts`), decision engine rules (`decision.test.ts`).

**Responsibility:** Verify correctness of isolated code paths. Fast feedback (< 30s total).

#### Recording fake-kube helper (API-interaction tests)

Reconcile loops and kube write helpers talk to the Kubernetes API through
lazy-singleton clients; unit tests that need to exercise those paths (rather
than pure logic) use a small **recording fake** installed via `spyOn` /
`defineProperty` swaps:

- `packages/kube/src/__tests__/helpers/fake-kube.ts` — installs on the
  `core()` / `custom()` singleton instances used by the kube package's write
  helpers.
- `packages/operator/src/test-helpers/fake-kube.ts` — installs on
  `CoreV1Api.prototype` / `CustomObjectsApi.prototype` etc., so it intercepts
  both the operator's own clients and the shared kube singletons.

Contract: `installFakeKube(script)` returns `{ calls, restore }` where `calls`
is the recorded `{ method, args }` log and `script` maps method names to
scripted responses — `{ value }`, `{ error }` (an Error carrying
`statusCode`, see `kubeError`/`notFound`/`conflict`/`tooManyRequests`/
`serverError`), or `{ once }` sequences. Scripted failures cover
404/409/429/5xx so fallback, "already exists", retry/backoff and transient
failure paths are all testable without a cluster.

The helper is **deliberately duplicated** between the two packages (per the
rev24 plan) — test-only code, no shared workspace package. If the pattern
grows a third consumer, consolidate into a shared test package.

### Layer 2 — Integration / Smoke Tests (`packages/*/tests/smoke.test.ts`)

**Scope:** Full application components wired together, exercising real APIs and data stores without a live cluster.

- Run via `pnpm test` (co-located with unit tests in the same package).
- Framework: Bun test.
- Uses in-memory or temp-dir equivalents of external dependencies (e.g., SQLite DB in `/tmp`, Hono app's `app.request()` instead of HTTP server binding).
- Example: web dashboard smoke tests that exercise board API, stats ingestion, and session endpoints against the real Hono app with a temp DB.

**Responsibility:** Verify component integration contracts. Fast feedback (< 30s total).

### Layer 3 — Deterministic E2E (`tests/e2e/e2e-*.test.ts`) — Core Lane

**Scope:** Full orchestrator flows on a live cluster, using deterministic test agents and strict state-based assertions.

- Run via `pnpm e2e:core`.
- Framework: Bun test with shared harness in `tests/e2e/helpers/`.
- **Deterministic control points only**: tests use ClusterAgent fixtures that instruct the agent to call specific MCP tools (`complete_run`, `complete_plan`, `fail_run`, `report_unrelated_issue`) rather than relying on LLM-generated prose.
- Assertions are exclusively on CR status fields (`Run.status.phase`, `Task.status.phase`, board JSON columns) — never on model output text or summaries.

**Current test suites:**

| File | Lane | Scenario | Key assertions |
|------|------|----------|----------------|
| `e2e-advances.test.ts` | Core | Worker calls `complete_run` → review run spawned → task reaches awaiting-human | Run phase transitions, review run lifecycle, task status phase |
| `e2e-basic-failure.test.ts` | Core | Worker fails (invalid git URL) → task reaches failed | Run failure, task status phase |
| `e2e-achieves.test.ts` | Core | Worker calls fail_run → auto-retry scheduled | Run failure via MCP, task retry lifecycle |
| `e2e-capability-enforcement.test.ts` | Core | Agent without required capability cannot create tasks / complete runs | Capability-gated tool rejection, task/run state unchanged |

The extended lane (`tests/e2e/` as a whole) additionally picks up:
`e2e-abandon-exit.test.ts`, `e2e-plan-merge-conflict-escalation.test.ts`, and
`e2e-review-findings.test.ts`. Note that `pnpm e2e:extended` runs every file in
the directory — including the core suites — while `pnpm e2e:core` runs only the
four files listed in its script.

**Responsibility:** Validate end-to-end orchestrator behavior with model-independent guarantees. Target: < 10 minutes per suite on a local cluster.

### Layer 4 — Extended E2E (`tests/e2e/`) — Deep Lane

**Scope:** Complex scenarios that exercise feature branching, dependency chains, and integration modes. Slower but still deterministic.

- Run via `pnpm e2e:extended`.
- Same harness as core lane; `pnpm e2e:extended` runs every test file in the directory (core suites included).
- Examples (planned): predecessor gating with merged dependencies, feature-branch metadata verification (`gitBranch`, `parentBranch`, `mergeIntoBranch`), PLAN lifecycle with artifact validation.

**Responsibility:** Validate complex orchestrator paths that are too slow for the PR-required gate but important for release confidence.

## Deterministic Principles

### Rule 1 — Never trust model prose for pass/fail

Test assertions must be based on **observable state**, not LLM-generated text:

- **Good:** `expect(runPhase).toBe("Succeeded")`
- **Bad:** Parse the agent's session summary to check if it "mentions completion"
- **Good:** Assert board column membership via `boardJson(project, ns)["columns"]["done"]`
- **Bad:** Check that a review verdict annotation contains certain keywords

### Rule 2 — MCP tool calls are the deterministic control points

When testing agent behavior, use ClusterAgent fixtures that instruct agents to call specific MCP tools:

```yaml
# Good: deterministic fixture
spec:
  content: |
    CRITICAL OVERRIDE: Call complete_run immediately with summary "done".

# Bad: open-ended instruction
spec:
  content: |
    Complete the task and signal success when done.
```

### Rule 3 — Pod-exec is a targeted oracle, not a primary assertion mechanism

Use `kubectl exec` only when CR status fields cannot express the needed fact:

- **Allowed:** Verify `.percussionist/plans/<task-id>.md` exists in the worktree (plan artifact)
- **Allowed:** Check installed packages via `apk list` in the runner pod
- **Not allowed:** Read agent session logs to verify behavior that should be reflected in CR status
- **Not allowed:** Parse file contents for text patterns — assert existence or non-existence only

### Rule 4 — Every test must clean up after itself

Tests create Kubernetes resources (namespaces, projects, tasks) and must tear them down even on assertion failure. Use `afterAll` with guaranteed cleanup:

```typescript
afterAll(async () => {
  await teardown(NS); // deletes namespace, restores operator config
});
```

### Rule 5 — Tests are model-agnostic

A test should pass regardless of which LLM provider or model is configured. The deterministic fixtures ensure the agent follows a prescribed path; the model choice only affects timing, not correctness.

## Responsibility Boundaries

| Layer | Runs on PR? | Cluster needed? | Model needed? | Target duration |
|-------|-------------|-----------------|---------------|-----------------|
| Unit (`pnpm test`) | **Required** (CI + pre-commit) | No | No | < 30s |
| Smoke (`pnpm test`, same) | **Required** (CI + pre-commit) | No | No | < 30s |
| Core E2E (`pnpm e2e:core`) | No — manual (`workflow_dispatch`) | Yes (Kind/minikube) | Optional* | < 10 min |
| Extended E2E (`pnpm e2e:extended`) | No — manual (`workflow_dispatch`) | Yes | Optional* | < 20 min |

\* Model is optional because deterministic fixtures don't depend on model output quality. However, some tests may still make LLM calls for non-assertion purposes (e.g., review runs that read sessions).

## Commands Reference

| Command | Description |
|---------|-------------|
| `pnpm build` | Build all packages (`tsc -b`) |
| `pnpm typecheck` | Type-check all packages via `tsc -b` |
| `pnpm test` | Run unit + smoke tests across all packages (bun:test) |
| `pnpm e2e:core` | Run deterministic E2E suites on a live cluster |
| `pnpm e2e:extended` | Run extended E2E suites (feature branching, dependencies) |
| `pnpm e2e` | Aggregate: runs every file in `tests/e2e/` (identical to `pnpm e2e:extended`) |

## Adding a New Deterministic E2E Test

Follow this recipe to add a new test that qualifies for the core lane:

### 1. Create a deterministic ClusterAgent fixture

Place it in `k8s/tests/` with a clear name reflecting its role:

```yaml
# k8s/tests/clusteragent-deterministic-worker.yaml
apiVersion: percussionist.dev/v1alpha1
kind: ClusterAgent
metadata:
  name: e2e-deterministic-worker
spec:
  content: |
    CRITICAL OVERRIDE — this instruction supersedes all task descriptions:

    You are a deterministic test agent. Your ONLY action is to call complete_run
    immediately with summary: "task done"
```

### 2. Write the test file

Place it in `tests/e2e/` following naming convention `e2e-<scenario>.test.ts`:

```typescript
// tests/e2e/e2e-new-scenario.test.ts
import { describe, beforeAll, afterAll, it, expect } from "bun:test";
import { setupCluster, applyClusterAgents, applyProject, teardown } from "./helpers/setup.ts";
import { kubectlGetField, boardJson } from "./helpers/kubectl.ts";
import { waitFor } from "./helpers/wait.ts";

const NS = "percussionist-e2e-new-scenario";
const PROJECT = "e2e-new-test";
const LLM_SECRET = process.env["LLM_SECRET"] ?? "llm-keys";

describe("new scenario", () => {
  beforeAll(async () => {
    await setupCluster({ ns: NS, llmSecret: LLM_SECRET });
    await applyClusterAgents(["clusteragent-deterministic-worker.yaml"]);
    // ... apply project with deterministic agent
  });

  afterAll(async () => {
    await teardown(NS);
  });

  it("asserts CR status deterministically", async () => {
    const phase = await waitFor(
      "run reaches Succeeded",
      180, 3,
      async () => {
        const p = await kubectlGetField("runs", "<run-name>", NS, "{.status.phase}");
        return p === "Succeeded" ? p : null;
      },
    );
    expect(phase).toBe("Succeeded");
  });

  it("asserts board state deterministically", async () => {
    const board = await waitFor(
      "task in done column",
      180, 3,
      async () => {
        const b = await boardJson(PROJECT, "percussionist");
        const done = (b.columns?.done as string[]) ?? [];
        return done.includes("t1") ? true : null;
      },
    );
    expect(board).toBe(true);
  });
});
```

### 3. Add assertions — state-based only

Every `expect()` call must assert on:
- CR status fields (`Run.status.phase`, `Task.status.phase`)
- Board JSON columns and workers
- MCP tool call evidence in run annotations or status messages

**Never** assert on:
- LLM-generated text content
- Session summary quality
- Agent reasoning traces

### 4. Ensure cleanup

The `afterAll` hook must always run, even if assertions fail. The shared `teardown()` helper handles namespace deletion and operator config restoration.

### 5. Add to the core lane

Add the test file name to the `e2e:core` script in `package.json`. If it exercises a complex path (feature branching, predecessor dependencies), add it to `e2e:extended` instead.

## CI Integration

The GitHub Actions workflow (`.github/workflows/ci.yml`) runs:
1. **Typecheck & Build + Unit/Smoke tests** — required on every PR and push to main (fast, no cluster or API keys needed)
2. **Core E2E** — manual only (`workflow_dispatch`); needs a cluster plus provider keys, which makes it too expensive for every PR. Runs against a Kind cluster provisioned by the CI job
3. **Extended E2E** — also `workflow_dispatch`-only, on its own Kind cluster; a weekly scheduled trigger runs the dependency-audit job only

Extended E2E handles deep validation: building Docker images and running full E2E suites in an isolated namespace. This is a release gate, not a PR gate.

## Troubleshooting

### Test hangs on cluster bootstrap

The shared setup (`setupCluster()`) applies CRDs, deploys operator + manager, patches watch namespaces, and waits for rollouts. If this step exceeds the timeout:
- Verify the target cluster has sufficient resources (operator needs ~200m CPU, 256Mi memory)
- Check that no stale deployments from previous test runs are blocking namespace creation
- Use `DEBUG=1` to see which setup step is slow

### Pod-exec checks fail intermittently

When using `kubectl exec` to verify artifacts (e.g., plan file existence):
- Ensure the worktree path matches the git cache mode (`/data/worktrees/{run-name}/` for remote git, `/data/workspace/` for local)
- Use `waitFor()` with generous timeout — pod startup is non-deterministic
- Avoid image-specific assumptions (e.g., don't hardcode Alpine package paths)

### Namespace cleanup fails

If `teardown()` can't delete the namespace because resources are stuck:
- Check for finalizers on lingering CRs: `kubectl get runs -n <ns> -o jsonpath='{.items[*].metadata.finalizers}'`
- Force-delete with `--grace-period=0 --force` as a last resort (not in shared helpers)
