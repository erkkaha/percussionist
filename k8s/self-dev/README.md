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

## Branch Convention

Builder agents push to `agent/<task-name>` branches. The integrator merges
to `main` after the review step passes.
