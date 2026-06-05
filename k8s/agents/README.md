# Example ClusterAgents

These agents are provided as reference implementations for common roles in a
percussionist project. Customize them for your own use case or use them as-is.

## Agents in this directory

| Agent | Role |
|-------|------|
| `planner` | Explores the codebase and produces a structured implementation plan |
| `builder` | Implements a BUILD task and commits the work |
| `buildgen` | Generates BUILD tasks from a completed PLAN |
| `reviewer` | Performs a success-review pass after a worker completes |
| `failure-analyst` | Diagnoses repeated task failures and recommends a next action |
| `integrator` | Merges an approved feature branch into the target branch and pushes to remote |

## Self-development agents

Agents used for percussionist's own development live in `k8s/self-dev/agents/`
and are **not intended for external use**. See `k8s/self-dev/README.md`.

## Creating your own agents

Define a `ClusterAgent` CR and apply it:

```bash
beatctl agent create --name my-agent -f my-agent.yaml
# or
kubectl apply -f my-agent.yaml
```

Reference the agent by name in a Project's `spec.agents[]` or on a Task's `spec.agent`.
See the main README.md for full ClusterAgent documentation.
