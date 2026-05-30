# BUILD Task Scoping Guidelines for Percussionist Self-Dev

## Context

BUILD tasks generated from approved PLAN runs should be decomposed at **feature-level granularity**, not step-level. A single feature change — e.g., a schema update, the logic that consumes it, the codegen step that regenerates CRDs, and a build verification — is one logical unit of work, not five separate tasks.

Over-splitting creates:
- **Management overhead**: Each task requires its own run pod, worktree branch (under feature branching), merge cycle, and review gate.
- **Merge coordination cost**: Under `featureBranchingEnabled: true`, each BUILD gets a unique branch that must be merged sequentially via predecessor dependencies or independently in parallel. Five tiny tasks means five branches, five merges.
- **Review fatigue**: Each task triggers its own meta-review cycle (typecheck + build), which is expensive for changes that are logically one unit of work.
- **Agent context fragmentation**: BUILD agents receive only their slice of the plan and must infer how it fits into the larger change, increasing the chance of subtle inconsistencies.

## Guiding Principles

1. **One commit, one BUILD task.** A BUILD task should represent a single logical change that justifies its own commit and review cycle. If two changes must happen in the same commit to be correct (e.g., schema change + codegen), they belong in the same BUILD task.
2. **Bundle tightly-coupled changes.** Schema updates, their downstream consumers, codegen regeneration, and YAML manifest updates are all part of one logical change — not separate tasks.
3. **Build verification is not a standalone task.** Running `pnpm build` or `pnpm typecheck` is the builder's responsibility at the end of every BUILD task. It should never be a separate BUILD task.
4. **Discovery and implementation are bundled.** If a task requires exploring code to understand how to implement something, that exploration belongs in the same BUILD task — not a separate "research" task.
5. **Split only when truly independent.** Two BUILD tasks should only be split when they touch disjoint parts of the codebase AND can be merged in any order without conflicts (or have a clear predecessor relationship).

## Bundling Rules (Concrete)

| Scenario | Guidance |
|----------|----------|
| Schema change + Zod type update + CRD regeneration (`pnpm codegen`) | **One BUILD task.** All three are atomic — the schema is wrong until codegen runs. |
| API change + operator logic that consumes it | **One BUILD task.** The operator won't compile without both changes. |
| YAML manifest update + corresponding TypeScript builder function | **One BUILD task.** They implement one feature end-to-end. |
| Build verification (`pnpm build`, `pnpm typecheck`) | **Never a standalone task.** Part of every BUILD's verification step. |
| Documentation update (AGENTS.md, README) that reflects the code change | **Bundled with the last BUILD task** that touches code, or as part of the same task if it's trivial. |
| Two features touching completely different packages with no shared types | **Can be separate tasks**, but only if they can truly run in parallel and merge independently. |

## What NOT to do

- Do not create a BUILD task for "run pnpm build" or "run pnpm typecheck."
- Do not create a BUILD task for "regenerate CRDs" when it's triggered by a schema change — bundle with the schema task.
- Do not create a BUILD task that only reads files and writes findings unless another BUILD explicitly depends on that artifact file.
- Do not split a single feature into multiple tasks just because it touches multiple files.

## Correct vs Incorrect Decomposition

### Example: Adding a new field to a CRD schema

**INCORRECT (5 tasks):**
1. "Add new field to Zod schema"
2. "Update TypeScript types for the new field"
3. "Regenerate CRD YAML with pnpm codegen"
4. "Update operator logic to handle the new field"
5. "Run pnpm build and pnpm typecheck"

**CORRECT (1 task):**
1. "Add new field to CRD schema, update Zod types, regenerate CRDs, and update operator logic"

### Example: Fixing a bug in one module

**INCORRECT (3 tasks):**
1. "Explore the codebase to understand the bug"
2. "Implement the fix for the bug"
3. "Run pnpm typecheck to verify no regressions"

**CORRECT (1 task):**
1. "Fix the bug in module X — explore, implement, and verify with pnpm typecheck"
