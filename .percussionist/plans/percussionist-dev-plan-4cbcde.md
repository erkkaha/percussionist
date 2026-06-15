# Plan: Implement `beatctl validate agents` capability audit (`percussionist-dev-plan-4cbcde`)

## Context

- CLI entrypoints are wired in `packages/cli/src/index.ts`; current top-level groups include `project`, `agent`, and `board`, but there is no `validate` command yet.
- ClusterAgent capability source-of-truth is `AgentCapabilitySchema` in `packages/api/src/index.ts` (enum includes `task.plan.execute`, `task.build.execute`, etc.).
- Shared Kubernetes helpers already exist in `packages/kube/src/index.ts`:
  - `listClusterAgents()` for cluster-scoped ClusterAgents.
  - `listProjects(ns)` for namespaced Projects.
  - `validateAgentTaskCapability()` currently validates a single selected agent for PLAN/BUILD assignment.
- Existing tests cover single-agent gating in `packages/kube/src/__tests__/agent-capability.test.ts`, but there is no cluster-wide audit of:
  - invalid capability values/formatting,
  - project roster reference integrity,
  - role/name convention mismatches,
  - orphaned ClusterAgents.

## Scope boundaries

### In scope

- Add a new CLI subcommand path: `beatctl validate agents`.
- Implement a standalone audit pipeline that inspects all ClusterAgents and Project rosters and reports:
  - invalid enum values in `.spec.capabilities`,
  - capability formatting issues,
  - missing ClusterAgents referenced by Projects,
  - missing PLAN/BUILD execution capability coverage in Project rosters,
  - name/role convention mismatches (warning-level),
  - orphaned ClusterAgents (not referenced by any Project roster).
- Add unit tests for each validation category.

### Out of scope

- Changing CRD schemas or capability enum values.
- Mutating ClusterAgent or Project resources (audit is read-only).
- Enforcing new admission-time rules in operator/manager-controller.

## Assumptions

1. “Verify referenced ClusterAgents exist and have the required capability (`task.plan.execute` / `task.build.execute`)” means **per-project roster coverage**: each Project should have at least one referenced agent with PLAN capability and at least one with BUILD capability.
2. Name/role convention checks are **heuristic warnings** (not hard failures) based on common canonical names (`planner`, `builder`, `reviewer`, `buildgen`, `integrator`, `failure-analyst`) and role substrings.
3. Audit should evaluate Projects across namespaces (cluster-wide), since ClusterAgents are cluster-scoped.

## Approach

1. **Separate audit engine from CLI output**
   - Introduce pure validation logic that accepts `ClusterAgent[]` + `Project[]` and returns structured findings, so unit tests can cover behavior without mocking CLI I/O.
   - Keep command handler focused on data fetch + formatted reporting + exit code.

2. **Add cross-namespace project listing helper**
   - Extend `@percussionist/kube` with a cluster-wide project list helper (e.g. `listAllProjects`) using `custom.listClusterCustomObject` for `projects`.
   - Re-export via `packages/cli/src/kube.ts` shim so CLI command stays consistent with existing import style.

3. **Validation model and categories**
   - Define finding categories/severity (`error` vs `warning`) and stable issue codes to make output deterministic and testable.
   - Validate capabilities in three layers:
     - **Enum validity**: each value must satisfy `AgentCapabilitySchema`.
     - **Formatting quality**: trim/whitespace/casing/duplicate entries and non-string values flagged as formatting issues.
     - **Role expectation**: name-convention mapping to expected core capability.

4. **Project roster cross-reference**
   - For each Project:
     - Verify each `spec.agents[].name` exists as a ClusterAgent.
     - For existing references, compute capability sets.
     - Validate roster has at least one `task.plan.execute` and one `task.build.execute` agent.

5. **Orphan detection**
   - Build inverse index from project rosters.
   - Any ClusterAgent with zero references is reported as orphaned (warning).

6. **CLI UX + exit behavior**
   - Add `validate` command group with `agents` subcommand in `packages/cli/src/index.ts`.
   - Implement `runValidateAgents` in a new module (e.g. `packages/cli/src/validate.ts`) with table/section output:
     - summary counts by category and severity,
     - grouped details for each issue class.
   - Exit code policy:
     - `0` when no errors found (warnings allowed),
     - `1` when any error category exists.

## Tasks

1. **Create validation domain types and pure audit function**
   - Add a new CLI module (e.g. `packages/cli/src/validate.ts`) with:
     - finding interfaces,
     - deterministic issue code constants,
     - `auditAgentCapabilities(clusterAgents, projects)` pure function.

2. **Implement capability enum + formatting checks**
   - In audit function, inspect raw `spec.capabilities` per ClusterAgent and emit findings for:
     - invalid enum values (not in `AgentCapabilitySchema`),
     - formatting anomalies (leading/trailing whitespace, uppercase, duplicate capabilities, non-string values).

3. **Implement role/name convention heuristics**
   - Add canonical mapping checks (e.g. planner→`task.plan.execute`, builder→`task.build.execute`, reviewer→`task.review.evaluate`, buildgen→`task.build.generate`, integrator→`task.merge.execute`, failure-analyst→`task.failure.analyze`).
   - Emit warning when a name-convention match exists but expected capability is absent.

4. **Implement project roster reference and coverage checks**
   - For each Project (`metadata.namespace` + `metadata.name`):
     - emit missing-agent errors for unresolved roster references,
     - verify plan/build execution coverage in resolved roster and emit missing-capability errors.

5. **Implement orphaned ClusterAgent detection**
   - Compute referenced ClusterAgent names across all Project rosters.
   - Emit orphan warning for each ClusterAgent not referenced by any project.

6. **Add/extend kube helper for all-project listing**
   - In `packages/kube/src/index.ts`, add `listAllProjects(client?)` returning all Project CRs cluster-wide.
   - Add tests in `packages/kube/src/__tests__/` if needed for new helper behavior.
   - Re-export wrapper in `packages/cli/src/kube.ts`.

7. **Wire new CLI command**
   - Update `packages/cli/src/index.ts`:
     - add `validate` command group,
     - add `validate agents` subcommand calling `runValidateAgents`.
   - Keep CLI style consistent with existing command modules.

8. **Implement command handler output and exit codes**
   - In `runValidateAgents`, fetch data via `listClusterAgents` + `listAllProjects`, run audit, print grouped report, and set process exit status accordingly.

9. **Unit tests: validation categories (required)**
   - Add tests (prefer colocated with validation module) covering each requested category:
     1. invalid enum capability values,
     2. missing ClusterAgent references in project roster,
     3. missing plan/build capability coverage in roster,
     4. role/name convention mismatch warning,
     5. orphaned ClusterAgents,
     6. capability formatting issues.

10. **Unit tests: command-level behavior**
    - Add focused tests for CLI handler behavior:
      - exits 0 on clean/no-error audit,
      - exits 1 when errors exist,
      - includes category headings and summary counts.

11. **Verification gates**
    - Run targeted tests for touched packages (likely `@percussionist/kube` and any new CLI tests).
    - Run workspace `pnpm typecheck`.
    - Run workspace `pnpm test` if required by task acceptance for full confidence.

## Acceptance criteria

- `beatctl validate agents` exists and runs cluster-wide agent/project audit.
- Output explicitly reports: missing agents, missing capabilities, orphaned agents, invalid/formatting capability issues, and name/role convention mismatches.
- Audit uses `AgentCapabilitySchema` enum as validation authority.
- Command returns non-zero exit code when error-class findings exist.
- Unit tests exist for every requested validation category.
- Typecheck/tests pass for modified packages.

## Risks / open questions

- **Cross-namespace project listing:** if cluster RBAC restricts cluster-wide project list, command may need a fallback/flag to namespace scope.
- **Convention heuristics false positives:** custom agent naming may not match canonical conventions; warnings should be non-fatal and clearly labeled heuristic.
- **Formatting vs invalid value overlap:** a value like `" task.plan.execute "` could be reported as both formatting + invalid unless normalized carefully; implementation should avoid noisy duplicates.
- **CLI testing surface:** the CLI package currently has minimal direct tests; adding command-level unit tests may require small harness setup for mocking process exit/console.

## Proposed BUILD task breakdown

1. **BUILD A — Audit engine + tests**
   - Implement pure audit logic and category-complete unit tests for findings.

2. **BUILD B — Kube helper + CLI wiring**
   - Add all-project listing helper and `beatctl validate agents` command integration.

3. **BUILD C — Report UX + command behavior tests**
   - Finalize human-readable output, summary/exit semantics, and command-level tests.
