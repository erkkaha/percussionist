# BUILD Task Scoping Guidelines for Percussionist Self-Dev

## Context

BUILD tasks generated from approved PLAN runs are being decomposed into excessively small units. A single feature change — e.g., a schema update, the logic that consumes it, the codegen step that regenerates CRDs, and a build verification — is routinely split into 5+ separate BUILD tasks. This creates:

- **Management overhead**: Each task requires its own run pod, worktree branch (under feature branching), merge cycle, and review gate.
- **Merge coordination cost**: Under `featureBranchingEnabled: true`, each BUILD gets a unique branch (`feature/{plan-id}--{build-id}`) that must be merged sequentially via predecessor dependencies or independently in parallel. Five tiny tasks means five branches, five merges.
- **Review fatigue**: Each task triggers its own meta-review cycle (typecheck + build), which is expensive for changes that are logically one unit of work.
- **Agent context fragmentation**: BUILD agents receive only their slice of the plan and must infer how it fits into the larger change, increasing the chance of subtle inconsistencies.

The root cause is two-fold:
1. The planner prompt (`k8s/deploy/agents.yaml` line 233) says *"Prefer many small steps over a few large ones"*, which agents interpret as "split aggressively."
2. The buildgen facilitator rules say *"one logical concern per task (roughly 1–4 hours of work)"* but don't define what constitutes a single logical concern, nor do they address bundling tightly-coupled changes.

## Approach

Define explicit scoping guidelines and embed them in the two agent prompts that control BUILD decomposition:
- **Planner prompt**: Guide PLAN agents to produce task breakdowns at the right granularity (feature-level, not step-level).
- **Buildgen facilitator prompt**: Give the buildgen agent concrete bundling rules so it doesn't over-split.

The guidelines are written as a project policy document and also injected directly into both prompts for maximum enforceability.

### Guiding Principles

1. **One commit, one BUILD task.** A BUILD task should represent a single logical change that justifies its own commit and review cycle. If two changes must happen in the same commit to be correct (e.g., schema change + codegen), they belong in the same BUILD task.
2. **Bundle tightly-coupled changes.** Schema updates, their downstream consumers, codegen regeneration, and YAML manifest updates are all part of one logical change — not separate tasks.
3. **Build verification is not a standalone task.** Running `pnpm build` or `pnpm typecheck` is the builder's responsibility at the end of every BUILD task. It should never be a separate BUILD task.
4. **Discovery and implementation are bundled.** If a task requires exploring code to understand how to implement something, that exploration belongs in the same BUILD task — not a separate "research" task.
5. **Split only when truly independent.** Two BUILD tasks should only be split when they touch disjoint parts of the codebase AND can be merged in any order without conflicts (or have a clear predecessor relationship).

### Bundling Rules (Concrete)

| Scenario | Guidance |
|----------|----------|
| Schema change + Zod type update + CRD regeneration (`pnpm codegen`) | **One BUILD task.** All three are atomic — the schema is wrong until codegen runs. |
| API change + operator logic that consumes it | **One BUILD task.** The operator won't compile without both changes. |
| YAML manifest update + corresponding TypeScript builder function | **One BUILD task.** They implement one feature end-to-end. |
| Build verification (`pnpm build`, `pnpm typecheck`) | **Never a standalone task.** Part of every BUILD's verification step. |
| Documentation update (AGENTS.md, README) that reflects the code change | **Bundled with the last BUILD task** that touches code, or as part of the same task if it's trivial. |
| Two features touching completely different packages with no shared types | **Can be separate tasks**, but only if they can truly run in parallel and merge independently. |

### What NOT to do

- Do not create a BUILD task for "run pnpm build" or "run pnpm typecheck."
- Do not create a BUILD task for "regenerate CRDs" when it's triggered by a schema change — bundle with the schema task.
- Do not create a BUILD task that only reads files and writes findings unless another BUILD explicitly depends on that artifact file.
- Do not split a single feature into multiple tasks just because it touches multiple files.

## Tasks

### 1. Write scoping guidelines document

**File**: `k8s/self-dev/SCOPING-GUIDELINES.md` (new)

Create a reference policy document in the self-dev directory that:
- States the guiding principles and bundling rules from this plan
- Provides concrete examples of correct vs incorrect task decomposition
- Serves as the authoritative reference for both planner agents and buildgen facilitators
- Is referenced by both agent prompts (see Task 2)

### 2. Update planner agent prompt

**File**: `k8s/deploy/agents.yaml` (planner section, lines ~194–241)

Replace the current guidance:
```
Prefer many small steps over a few large ones in the Tasks section.
```

With:
```
Structure BUILD task breakdown at feature-level granularity — not step-level.
Each BUILD task should represent one logical change that justifies its own commit and review cycle.
Bundle tightly-coupled changes (schema + codegen, API + consumers) into a single BUILD task.
Do NOT create standalone tasks for build verification or CRD regeneration — these are part of every BUILD's verification step.
```

Also update the Tasks section description from:
```
- **Tasks** — a numbered list of concrete implementation steps, each small enough to be done independently where possible
```

To:
```
- **Task Breakdown** — proposed BUILD tasks at feature-level granularity; bundle tightly-coupled changes (schema + codegen, API + consumers) into single tasks. Each task should represent one logical change that justifies its own commit and review cycle.
```

### 3. Update buildgen facilitator prompt (agents.yaml)

**File**: `k8s/deploy/agents.yaml` (facilitator-buildgen section, lines ~153–159)

Replace the current TASK DECOMPOSITION RULES with:

```
TASK DECOMPOSITION RULES:
- Each BUILD task should represent one logical change that justifies its own commit and review cycle.
- Bundle tightly-coupled changes into a single BUILD task: schema + Zod types + CRD regeneration (pnpm codegen) is ONE task; API change + operator consumers is ONE task.
- Build verification (pnpm build, pnpm typecheck) is the builder's responsibility — never create a standalone BUILD task for it.
- CRD regeneration triggered by a schema change belongs in the same BUILD task as the schema update.
- Split only when changes are truly independent: disjoint packages, no shared types, can merge in any order.
- A task should represent roughly 1–4 hours of focused implementation work.
- If a PLAN item is large but tightly coupled (e.g., refactoring one module), keep it as one BUILD task rather than splitting by file or function.
```

### 4. Update buildgen facilitator prompt (facilitator.ts)

**File**: `packages/manager-controller/src/facilitator.ts` (lines ~285–307)

Add to the CRITICAL — DO NOT section:
```
- Do NOT create standalone BUILD tasks for build verification, type-checking, or CRD regeneration. These are part of every builder's verification step.
- Do NOT split tightly-coupled changes (schema + codegen, API + consumers) into separate BUILD tasks. Bundle them as one logical change.
```

And update the existing requirements to reinforce bundling:
```
- Bundle schema changes with their downstream effects (Zod types, CRD regeneration via pnpm codegen, YAML manifests) into a single BUILD task.
```

### 5. Update builder agent prompt

**File**: `k8s/deploy/agents.yaml` (builder section, lines ~243–293)

Add to the Rules section:
```
- Build verification is part of your responsibility: run pnpm build and pnpm typecheck before committing. Do not expect a separate task for this.
```

## Risks / Open Questions

1. **Will agents actually follow these rules?** The guidelines are embedded in prompts, but LLMs can still over-split if the plan is ambiguous. Mitigation: the plan review facilitator should reject plans that produce overly-granular BUILD breakdowns. Consider adding a scoping check to the buildgen review step.

2. **What about genuinely large features?** A major refactor touching 10+ files across 3 packages might still need multiple BUILD tasks even if coupled. The guidelines say "bundle tightly-coupled changes" — but what's "tightly"? Open question: should we add a maximum task count per plan (e.g., no more than 5-7 BUILD tasks unless the feature is genuinely large)?

3. **Parallelism trade-off**: Bundling more work into each BUILD task reduces parallelism. However, since `maxParallel` defaults to 1 in self-dev and most features are sequential anyway, this is acceptable. For projects with higher `maxParallel`, independent features can still be split.

4. **Backward compatibility**: These changes only affect the self-dev project's planner/builder agents (via prompt text). They don't change any data models, CRDs, or reconciliation logic. Existing plans and BUILD tasks are unaffected.

5. **Plan review gate**: The plan review facilitator (`facilitator.ts` line 162) already checks that the plan "contains enough context to generate BUILD tasks." We should consider adding a secondary check: if the generated BUILD task count is unreasonably high relative to the plan scope, flag it for rework.

## Acceptance Criteria

1. Scoping guidelines document created at `k8s/self-dev/SCOPING-GUIDELINES.md`
2. Planner agent prompt updated with feature-level granularity guidance
3. Buildgen facilitator prompt (both locations) updated with bundling rules
4. Builder agent prompt updated to clarify build verification responsibility
5. Future plans generated by the planner will produce BUILD task breakdowns that conform to these guidelines

## Proposed BUILD Task Breakdown for This Plan

This plan itself is a single logical change — updating scoping policy across multiple files. It should be ONE BUILD task:

### 1. Implement BUILD task scoping guidelines (`k8s/self-dev/`)
**Scope**: Create the scoping guidelines document and update all four agent prompts (planner, buildgen-facilitator in agents.yaml, buildgen-facilitator in facilitator.ts, builder).

**Steps**:
1. Create `k8s/self-dev/SCOPING-GUIDELINES.md` with full policy text
2. Update planner prompt in `k8s/deploy/agents.yaml` — replace "many small steps" guidance with feature-level granularity rules
3. Update buildgen facilitator TASK DECOMPOSITION RULES in `k8s/deploy/agents.yaml` — add bundling rules, remove ambiguous language
4. Update buildgen facilitator prompt in `packages/manager-controller/src/facilitator.ts` — add CRITICAL DO NOT items for verification/codegen tasks
5. Update builder agent prompt in `k8s/deploy/agents.yaml` — clarify build verification responsibility
6. Run `pnpm build && pnpm typecheck` to verify no regressions

**Files Changed**:
| # | File | Change Type |
|---|------|-------------|
| 1 | `k8s/self-dev/SCOPING-GUIDELINES.md` | **New file** |
| 2 | `k8s/deploy/agents.yaml` | Edit (planner, buildgen-facilitator, builder sections) |
| 3 | `packages/manager-controller/src/facilitator.ts` | Edit (buildgen prompt lines ~285–307) |

**Verification**:
1. `pnpm build` — all packages compile
2. `pnpm typecheck` — no type errors
3. Verify agent prompts are syntactically valid YAML (agents.yaml) and TypeScript string literals (facilitator.ts)
4. Review the updated prompts to confirm scoping rules are clear and actionable
