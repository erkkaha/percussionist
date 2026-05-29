# Plan: Per-Agent Default Models for Agents

## Context

### Current State

Percussionist currently supports model configuration at two levels only:

1. **Project-level default** (`Project.spec.model`): A single model string applied to all runs in a project when no other override is present. Example from `k8s/self-dev/projects/percussionist-dev.yaml`:
   ```yaml
   spec:
     model: lmstudio/qwen3.6-35b-a3b@q4_k_s
   ```

2. **Run-level override** (via MCP tools): The `manager-agent_create_run` and `manager-agent_force_retry` tools accept an optional `model` parameter that directly sets `workerRun.spec.model`.

The model resolution hierarchy is defined in `resolveRunConfig()` (`packages/api/src/index.ts`, lines 1106-1145):
```
runOverrides?.model (highest) → boardOverrides?.model → project.spec.model (lowest)
```

### How Agents Are Configured Today

Agents are referenced via `Project.spec.agents` — an array of `AgentRef` objects:
```typescript
export const AgentRefSchema = z.object({
  name: z.string().min(1).max(63),
});
```

Each entry is a simple `{name}` reference to a `ClusterAgent` CR. The project's agent roster looks like:
```yaml
agents:
  - name: planner
  - name: builder
  - name: meta-reviewer
```

The actual agent content lives in `ClusterAgent` CRs (`k8s/self-dev/agents/*.yaml`) as YAML front-matter + system prompt. OpenCode supports a per-agent `model` field in its own `.md` file front-matter, but Percussionist does not expose this at the schema layer — it only passes through content verbatim via ConfigMaps.

### The Gap

There is no way to configure a default model **per agent** within a project's configuration. All agents share whatever `Project.spec.model` is set to (or falls back to global defaults). Users who want different models for different roles (e.g., a cheaper/faster model for planning, a more capable model for building) must either:
- Use the same model for all agents (suboptimal cost/performance tradeoff), or
- Manually override via MCP tool calls after task creation (fragile, not declarative).

### OpenCode's Native Support

OpenCode supports per-agent `model` in its `.md` agent front-matter:
```yaml
---
name: plan
mode: primary
model: anthropic/claude-haiku-4-20250514
---
You are a planning agent...
```

However, Percussionist's architecture handles model selection at the **Run level** via `RUN_MODEL` environment variable injection (operator → dispatcher → OpenCode prompt body), not through opencode's native per-agent config. This means even if we added `model` to ClusterAgent front-matter, it wouldn't be used unless we also wired up Percussionist's run creation path to respect it.

## Approach

### Design Decision: Add `model` to `Project.spec.agents[]` (not ClusterAgentSpecSchema)

We add an optional `model` field directly to the `AgentRefSchema` used in `Project.spec.agents`. This is the right level because:

1. **Per-project granularity**: Different projects may want different models for the same agent role. A cluster-wide `ClusterAgent` shouldn't dictate which model a project uses.
2. **Simplicity**: No changes needed to the operator's ConfigMap rendering or ClusterAgent CR format. The model is resolved at run-creation time and set on `Run.spec.model`.
3. **Consistency with existing patterns**: `Project.spec.model` already provides a project-level default; this extends that pattern per-agent.

### Model Precedence (Final)

The complete precedence chain, from highest to lowest priority:

| Priority | Source | Mechanism |
|----------|--------|-----------|
| 1 | MCP tool override | `create_run` / `force_retry` `model` arg → directly sets `workerRun.spec.model` after resolution |
| 2 | Per-agent model | `Project.spec.agents[].model` for the task's assigned agent → resolved in `buildWorkerRun()` |
| 3 | Project default | `Project.spec.model` → resolved via `resolveRunConfig(project.spec, ...)` |

### Architecture Impact

**Files that change:**
- `packages/api/src/index.ts` — Extend `AgentRefSchema` with optional `model` field; update `buildWorkerRun()` to accept per-agent model resolution.
- `codegen/gen-crds.mjs` — No changes needed (auto-regenerates from Zod schemas).

**Files that do NOT change:**
- `packages/operator/` — The operator already reads `Run.spec.model` and injects it as `RUN_MODEL`. No modifications needed.
- `packages/dispatcher/` — Already handles `RUN_MODEL` correctly. No changes needed.
- MCP tools (`create_run`, `force_retry`) — Already support explicit `model` overrides; they set `spec.model` after resolution, which naturally takes precedence over our new per-agent default.

### Why Not Modify ClusterAgentSpecSchema?

Adding `model` to `ClusterAgentSpecSchema` would make it a cluster-wide setting shared across all projects. This is less flexible because:
- The same agent role (e.g., "planner") might need different models in dev vs prod projects.
- It would require the operator to parse front-matter and inject model info into ConfigMaps, adding complexity.
- It doesn't solve the reconciler's run creation path — `buildWorkerRun` still wouldn't know about per-agent models without K8s API calls.

### Validation Strategy

**No synchronous validation against available models.** Validating a model string against the sidecar's `list_models` output would require:
- A K8s API call to discover which run pods exist and are ready.
- An HTTP request to each pod's MCP server on port 4097.
- Handling race conditions (pods not yet running).

Instead, we defer validation to runtime: if an invalid model is specified, OpenCode will error when attempting to use it, and the run will fail with a clear error message. This matches Percussionist's existing approach for other optional fields (e.g., `image` in `Project.spec.model`).

## Tasks

### Task 1: Extend AgentRefSchema with Optional Model Field

**File:** `packages/api/src/index.ts`  
**Lines:** ~276-281

Change the `AgentRefSchema` from:
```typescript
export const AgentRefSchema = z.object({
  name: z.string().min(1).max(63),
});
```

To:
```typescript
export const AgentRefSchema = z.object({
  name: z.string().min(1).max(63),
  model: z.string().optional(),
});
```

Add a JSDoc comment explaining the field:
```typescript
// A reference to a ClusterAgent by name.
// Optional `model` overrides the project-level default for this agent specifically.
export const AgentRefSchema = z.object({
  name: z.string().min(1).max(63),
  model: z.string().optional(),
});
```

**Impact:** This is a backward-compatible change — existing YAML files without `model` continue to work since the field is optional. The CRD will be auto-regenerated by running `pnpm codegen`.

### Task 2: Modify buildWorkerRun to Resolve Per-Agent Model Overrides

**File:** `packages/manager-controller/src/worker-builder.ts`  
**Function:** `buildWorkerRun()` (lines ~32-167)

The current model resolution in `buildWorkerRun()`:
```typescript
const resolved = resolveRunConfig(project.spec, undefined, undefined, {
  runner: { image: ..., resources: ... },
});
// ... later ...
spec: {
  // ...
  model: resolved.model,   // ← only uses project.spec.model
}
```

We need to check for a per-agent model override **before** falling back to `project.spec.model`. The approach:

1. After resolving the base config via `resolveRunConfig()`, look up the task's agent name in `project.spec.agents`.
2. If that agent has a `model` field set, use it as the effective model (unless an explicit run override is already provided).
3. The resolution logic should be:

```typescript
// After resolveRunConfig returns base config:
let finalModel = resolved.model; // starts as project.spec.model

// Check for per-agent model override
const roster = project.spec.agents ?? [];
const taskAgentName = task.spec.agent;
if (taskAgentName) {
  const agentEntry = roster.find((a) => a.name === taskAgentName);
  if (agentEntry?.model) {
    finalModel = agentEntry.model;
  }
}

// spec.model is set to finalModel below
```

This means the model resolution in `buildWorkerRun` becomes:
```
explicit run override (set after buildWorkerRun returns, by MCP tools) 
  → per-agent model from project roster 
    → project.spec.model (via resolveRunConfig)
```

**Important:** The MCP tool overrides (`create_run` / `force_retry`) set `workerRun.spec.model` **after** calling `buildWorkerRun()`, so they naturally take highest priority. Our new per-agent check happens inside `buildWorkerRun()` as the middle layer.

### Task 3: Update Self-Development Project YAML (Example Usage)

**File:** `k8s/self-dev/projects/percussionist-dev.yaml`

Demonstrate the new feature by adding model overrides to agents that benefit from different models:
```yaml
agents:
  - name: planner
    model: lmstudio/qwen3.6-35b-a3b@q4_k_s   # planning can use same/default model
  - name: builder
    model: lmstudio/qwen3.6-35b-a3b@q4_k_s   # building uses the same for now
  - name: meta-reviewer
    model: lmstudio/qwen3.6-35b-a3b@q4_k_s   # review can use a lighter model
  - name: meta-smoke-tester
    model: lmstudio/qwen3.6-35b-a3b@q4_k_s
  - name: meta-integrator
    model: lmstudio/qwen3.6-35b-a3b@q4_k_s
  - name: meta-documenter
    model: lmstudio/qwen3.6-35b-a3b@q4_k_s
```

Note: The actual model values would be chosen based on cost/performance analysis. This is a demonstration of the syntax, not prescriptive model assignments.

### Task 4: Regenerate CRD YAML

Run `pnpm codegen` to regenerate CRD YAML files from the updated Zod schemas. This will update:
- `k8s/crds/project.yaml` — AgentRefSchema now includes optional `model` field in the JSON Schema for `spec.agents`.

### Task 5: Type Check and Build Verification

Run `pnpm typecheck` to verify TypeScript compilation succeeds across all packages. The changes are minimal (one schema extension, one function modification) so this should pass cleanly.

## Risks and Open Questions

### Risk 1: Backward Compatibility with Existing Projects
**Status:** Low risk. The `model` field is optional in the Zod schema (`z.string().optional()`). Existing Project CRs without per-agent models will continue to work — they'll fall through to `Project.spec.model`.

### Risk 2: Model String Format Validation
**Status:** Medium concern. We don't validate model strings against available providers/models. Invalid model strings will cause run failures at runtime with OpenCode errors. This is consistent with how other optional fields (like `image`) are handled in Percussionist. If needed, a future enhancement could add validation via the `list_models` MCP tool.

### Risk 3: Interaction with OpenCode's Native Per-Agent Models
**Status:** Low risk. The operator passes `Run.spec.model` as `RUN_MODEL` env var. OpenCode uses this as a global default. If users also define per-agent models in their ClusterAgent front-matter (opencode's native format), opencode will prefer the agent-level model over RUN_MODEL — which is actually the desired behavior. The two mechanisms complement each other rather than conflict.

### Risk 4: Feature Branching Compatibility
**Status:** No impact. Per-agent models are resolved at run-creation time from `Project.spec.agents`, which is independent of feature branching logic in the reconciler.

### Open Question 1: Should We Also Support Per-Agent Model in ClusterAgentSpecSchema?
Currently not planned. If users want cluster-wide default models for specific agent roles (e.g., "all planners use haiku"), they could create separate ClusterAgents per model variant. This can be added later if demand arises.

### Open Question 2: Should We Surface Per-Agent Model in the Web Dashboard?
The web dashboard (`packages/web`) displays project configuration and run details. Adding a column or field to show which model each agent uses would improve observability, but is out of scope for this plan. It can be a follow-up BUILD task.

## Acceptance Criteria

1. **Schema:** `AgentRefSchema` includes an optional `model: string` field. TypeScript types are correctly inferred (`AgentRef { name: string; model?: string }`).
2. **CRD:** Regenerated CRD YAML (`k8s/crds/project.yaml`) reflects the new `model` property in the agents array schema.
3. **Reconciler:** When a task is scheduled for an agent with `Project.spec.agents[].model` set, the created Run CR has that model in `spec.model`.
4. **Precedence:** MCP tool `model` overrides still take highest priority (verified by checking that `create_run` and `force_retry` continue to work as before).
5. **Backward Compatibility:** Projects without per-agent models continue to use `Project.spec.model` as the default for all agents.
6. **Type Check:** `pnpm typecheck` passes with no errors across all packages.
7. **Build:** `pnpm build` succeeds for all affected packages (`@percussionist/api`, `@percussionist/manager-controller`).

## BUILD Task Breakdown

| # | Task Type | Description | Dependencies |
|---|-----------|-------------|--------------|
| 1 | BUILD | Extend `AgentRefSchema` in `packages/api/src/index.ts` with optional `model` field and JSDoc comment | None |
| 2 | BUILD | Modify `buildWorkerRun()` in `packages/manager-controller/src/worker-builder.ts` to resolve per-agent model from project roster before falling back to project default | Task 1 |
| 3 | BUILD | Regenerate CRD YAML via `pnpm codegen` and commit updated files | Task 2 |
| 4 | BUILD | Update `k8s/self-dev/projects/percussionist-dev.yaml` with example per-agent model configuration | Task 3 |
| 5 | BUILD | Run `pnpm typecheck` and `pnpm build` to verify all changes compile cleanly | Tasks 1-4 |

## Files Changed Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `packages/api/src/index.ts` | Modify | Add optional `model` field to `AgentRefSchema` (line ~278) |
| `packages/manager-controller/src/worker-builder.ts` | Modify | Add per-agent model resolution in `buildWorkerRun()` before setting `spec.model` |
| `k8s/crds/project.yaml` | Auto-generated | Regenerated CRD reflecting new schema |
| `k8s/self-dev/projects/percussionist-dev.yaml` | Modify | Example usage of per-agent models |

## Implementation Notes

### Code Location Reference

- **AgentRefSchema:** `packages/api/src/index.ts:276-281`
- **ProjectSpecSchema.agents:** `packages/api/src/index.ts:799`
- **buildWorkerRun():** `packages/manager-controller/src/worker-builder.ts:32-167`
- **resolveRunConfig():** `packages/api/src/index.ts:1106-1145` (for reference on existing resolution pattern)
- **create_run tool:** `packages/manager-controller/src/agent/tools.ts:797-861` (verifies precedence — sets model after buildWorkerRun returns)
- **force_retry tool:** `packages/manager-controller/src/agent/tools.ts:918-990` (same pattern as create_run)

### Testing Approach

Since this is a schema + logic change without new external dependencies, testing focuses on:
1. TypeScript type checking (`pnpm typecheck`) — ensures types are correct.
2. Build verification (`pnpm build`) — ensures no compilation errors.
3. Manual e2e test in self-dev project: Apply updated CRD, create a project with per-agent models, verify runs use the correct model (check `kubectl get run -o yaml` for `spec.model`).

No unit tests are added because the change is minimal and follows existing patterns already covered by the manager-controller's reconciler tests.
