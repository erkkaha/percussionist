# BUILD Task Scoping Guidelines for Percussionist Self-Dev

**Authoritative reference for all future PLAN → BUILD task decomposition in the `percussionist-dev` project.**

This document defines how BUILD tasks must be scoped when generated from approved PLAN runs. It applies to both planner agents (who produce the initial breakdown) and buildgen facilitators (who validate and refine it).

## Guiding Principles

### 1. One commit, one BUILD task

A BUILD task should represent a single logical change that justifies its own commit and review cycle. If two changes must happen in the same commit to be correct — e.g., a schema update plus the codegen step that regenerates CRDs from that schema — they belong in the same BUILD task.

### 2. Bundle tightly-coupled changes

Schema updates, their downstream consumers (Zod types, operator logic), codegen regeneration, and YAML manifest updates are all part of one logical change — not separate tasks. The key question is: **would the codebase be broken if only half of these changes were applied?** If yes, they belong together.

### 3. Build verification is not a standalone task

Running `pnpm build` or `pnpm typecheck` is the builder's responsibility at the end of every BUILD task. It should never be a separate BUILD task. The meta-reviewer agent already runs these checks as part of its review gate — creating a dedicated BUILD task for them adds zero value and multiplies overhead.

### 4. Discovery bundled with implementation

If a task requires exploring code to understand how to implement something, that exploration belongs in the same BUILD task — not a separate "research" or "discovery" task. Builders are expected to read relevant files before implementing (see the builder agent prompt). A task titled "Explore X and report findings" is almost always over-splitting.

### 5. Split only when truly independent

Two BUILD tasks should only be split when they touch disjoint parts of the codebase AND can be merged in any order without conflicts (or have a clear predecessor relationship). If two changes share types, imports, or build artifacts, they are likely coupled and should stay together.

## Bundling Rules (Concrete)

| Scenario | Guidance |
|----------|----------|
| Schema change + Zod type update + CRD regeneration (`pnpm codegen`) | **One BUILD task.** All three are atomic — the schema is wrong until codegen runs, and downstream consumers won't compile without both. |
| API change + operator logic that consumes it | **One BUILD task.** The operator won't compile without both changes. |
| YAML manifest update + corresponding TypeScript builder function | **One BUILD task.** They implement one feature end-to-end. |
| Build verification (`pnpm build`, `pnpm typecheck`) | **Never a standalone task.** Part of every BUILD's verification step. |
| Documentation update (AGENTS.md, README) that reflects the code change | **Bundled with the last BUILD task** that touches code, or as part of the same task if trivial. |
| Two features touching completely different packages with no shared types | **Can be separate tasks**, but only if they can truly run in parallel and merge independently. |
| Refactoring one module across multiple files within a single package | **One BUILD task.** The refactoring is one logical change even though it touches many files. |

## What NOT to Do

- **Do not** create a BUILD task for "run pnpm build" or "run pnpm typecheck."
- **Do not** create a BUILD task for "regenerate CRDs" when it's triggered by a schema change — bundle with the schema task.
- **Do not** create a BUILD task that only reads files and writes findings unless another BUILD explicitly depends on that artifact file.
- **Do not** split a single feature into multiple tasks just because it touches multiple files.
- **Do not** create separate tasks for "update schema" vs "update consumers" — they are one logical change.
- **Do not** create separate tasks for "edit TypeScript" vs "edit YAML" — the language of the file is irrelevant to coupling.

## Correct vs Incorrect Decomposition (Examples)

### Example 1: Adding a new field to the Project CRD

**Incorrect (5 BUILD tasks):**
1. Add `featureBranchingEnabled` to the Zod schema in `api/src/project.ts`
2. Update operator logic to handle the new field
3. Run `pnpm codegen` to regenerate CRD YAML
4. Update `k8s/deploy/agents.yaml` with the new field in agent manifests
5. Run `pnpm build && pnpm typecheck`

**Correct (1 BUILD task):**
- "Add `featureBranchingEnabled` field to Project CRD and update all consumers"
  - Schema change + Zod types + operator logic + codegen + YAML updates + verification, all in one commit.

### Example 2: Adding a new MCP tool to the manager

**Incorrect (3 BUILD tasks):**
1. Add `inspect_cr` tool definition in `tools.ts`
2. Update the agent-config ConfigMap to expose the new tool
3. Run `pnpm build && pnpm typecheck`

**Correct (1 BUILD task):**
- "Add `inspect_cr` MCP tool and update agent config"
  - Tool implementation + ConfigMap update + verification, all in one commit.

### Example 3: Two independent features

**Correct (2 BUILD tasks):**
1. "Add Prometheus metrics endpoint to manager controller" — touches only `manager-controller/src/metrics.ts` and its server setup
2. "Update web dashboard stats page with new metric display" — touches only `web/src/components/StatsPanel.tsx` and related API calls

These are independent: they touch disjoint packages, share no types, and can merge in any order.

## How to Use This Document

### For Planner Agents

When producing a BUILD task breakdown from an approved PLAN:
1. Group changes by logical feature, not by file or step.
2. Apply the bundling rules table above — if two items match a "bundle" row, merge them into one task.
3. Remove any tasks whose sole purpose is verification or CRD regeneration.
4. Ensure each remaining task represents roughly 1–4 hours of focused implementation work.

### For Buildgen Facilitators

When validating a PLAN's BUILD task breakdown:
1. Check that no task exists solely for build verification, type-checking, or CRD regeneration.
2. Verify that tightly-coupled changes (schema + codegen, API + consumers) are bundled into single tasks.
3. If the task count seems unreasonably high relative to the plan scope, flag it for rework with a reference to these guidelines.

### For Builder Agents

When receiving an assigned BUILD task:
1. Build verification (`pnpm build && pnpm typecheck`) is your responsibility — run it before committing. Do not expect a separate task for this.
2. If the task description mentions changes that are tightly coupled (e.g., schema + codegen), implement all of them in one commit.

## References

- **PLAN context**: `.percussionist/plans/percussionist-dev-plan-7ab630.md` — the plan that defined these guidelines
- **Planner prompt**: `k8s/deploy/agents.yaml` (planner section) — references this document for task decomposition guidance
- **Buildgen facilitator prompt**: `k8s/deploy/agents.yaml` (facilitator-buildgen section) and `packages/manager-controller/src/facilitator.ts` — enforce bundling rules
- **Builder agent prompt**: `k8s/deploy/agents.yaml` (builder section) — clarifies build verification responsibility
