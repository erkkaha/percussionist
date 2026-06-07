# Self-Development Resources

**FOR PERCUSSIONIST MAINTAINERS ONLY**

This directory contains ClusterAgents and Projects used for percussionist's own
development (dogfooding). **External users should NOT apply these manifests.**

## What's Here

- **agents/** - Meta-level agents (reviewer, smoke-tester, integrator, documenter)
- **projects/** - percussionist-dev project that orchestrates our own development
- **secrets/** - Instructions for creating required secrets (git keys, tokens)

## For Maintainers

### One-time setup

1. Follow instructions in `secrets/README.md` to create required secrets
2. Apply agents: `kubectl apply -f k8s/self-dev/agents/`
3. Apply project: `kubectl apply -f k8s/self-dev/projects/`
4. Verify: `beatctl project get percussionist-dev`

### Adding tasks

```bash
# Add a PLAN task first — planner explores and produces an implementation plan
beatctl board task add percussionist-dev \
  --title "Add Prometheus metrics endpoint" \
  --type PLAN \
  --agent planner \
  --description "..."

# After review, builder agents are dispatched for each BUILD task
```

### Monitoring

```bash
beatctl board get percussionist-dev
beatctl logs <run-name> -f
beatctl web   # open dashboard
```

## For External Users

**Skip this directory entirely.** Use `k8s/agents/` and `k8s/samples/` as starting
points for your own agents and projects.

## Workflow

Tasks flow: `PLAN → BUILD → REVIEW → (SMOKE) → INTEGRATE → (DOCUMENT)`

| Step | Agent | Purpose |
|------|-------|---------|
| PLAN | planner | Explore codebase, produce implementation plan, create BUILD tasks |
| BUILD | builder | Implement changes on `agent/<task-name>` branch |
| REVIEW | meta-reviewer | Typecheck, build, code quality review |
| SMOKE | meta-smoke-tester | Build images, deploy to test namespace, run e2e |
| INTEGRATE | meta-integrator | Merge approved branch to main, push to remote |
| DOCUMENT | meta-documenter | Update README/AGENTS.md to reflect changes |

SMOKE and DOCUMENT steps are optional — add them when the task warrants it.

## Testing Tiers — When to Run What

Percussionist uses a four-layer testing model. See [`docs/testing-strategy.md`](../../docs/testing-strategy.md) for full details.

| Tier | Command | When to run | Duration target |
|------|---------|-------------|-----------------|
| **Unit + Smoke** | `pnpm test` | Every commit; PR gate required | < 1 min |
| **Core E2E** | `pnpm e2e:core` | Before merging feature branches; CI on every PR | < 10 min |
| **Extended E2E** | `pnpm e2e:extended` | Before releases; manual trigger for complex paths | < 20 min |
| **Smoke (agent)** | meta-smoke-tester agent | Release gate; deep validation in isolated namespace | Variable |

### Contributor Checklist — Adding a New Test

1. **Unit test** — Add to `packages/*/src/__tests__/` if the change touches pure logic
2. **Smoke test** — Add to `packages/*/tests/smoke.test.ts` if it affects a web API endpoint
3. **Core E2E** — Add to `tests/e2e/` with a deterministic ClusterAgent fixture if it changes orchestrator behavior
4. **Extended E2E** — Add to `tests/e2e/` but mark as extended lane for complex paths (feature branching, dependencies)

### Recipe for Deterministic E2E Tests

See [`docs/testing-strategy.md`](../../docs/testing-strategy.md#adding-a-new-deterministic-e2e-test) for the full recipe. Key rules:
- Use `CRITICAL OVERRIDE` in ClusterAgent fixtures to force specific MCP tool calls
- Assert only on CR status fields and board JSON — never on model-generated text
- Use pod-exec (`kubectl exec`) only when CR status cannot express the needed fact (e.g., plan artifact existence)

## Branch Convention

Builder agents push to `agent/<task-name>` branches. The integrator merges
to `main` after the review step passes.
