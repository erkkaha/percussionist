# Custom Resource Definitions

Percussionist defines 5 CRDs under the API group `percussionist.dev/v1alpha1`.

## Run

Represents a single agent execution. Created by `beatctl submit` or the board controller.

```yaml
apiVersion: percussionist.dev/v1alpha1
kind: Run
metadata:
  name: my-project-run-abc123
  namespace: percussionist
  labels:
    percussionist.dev/project: my-project
spec:
  project: my-project
  task: Implement the login endpoint
  agent: builder
status:
  phase: Running
  sessionID: sess_abc123
  podName: my-project-run-abc123
```

Run phases: `Pending`, `Initializing`, `Running`, `WaitingForInput`, `Succeeded`, `Failed`, `Cancelled`.

## Project

Top-level configuration object for an agent project.

```yaml
apiVersion: percussionist.dev/v1alpha1
kind: Project
metadata:
  name: my-project
  namespace: percussionist
spec:
  source:
    git:
      url: https://github.com/example/repo.git
  agents:
    - name: builder
    - name: planner
      model: anthropic/claude-sonnet-4
  maxParallel: 2
  phase: Active
status:
  board:
    ideas: []
    backlog: []
    "in-progress": []
    review: []
    done: []
    blocked: []
```

## Task

First-class work item on the project board.

```yaml
apiVersion: percussionist.dev/v1alpha1
kind: Task
metadata:
  name: my-project-build-abc123
  namespace: percussionist
  labels:
    percussionist.dev/project: my-project
spec:
  projectRef: my-project
  type: BUILD
  title: Implement login endpoint
  description: |
    Build a login endpoint with email/password auth.
  agent: builder
  parentTaskRef: my-project-plan-xyz789
  predecessorRef: my-project-build-def456
status:
  phase: running
  worker:
    runName: my-project-run-abc123
    retryCount: 0
```

Task phases: `idea`, `pending`, `scheduled`, `initializing`, `running`, `waiting-for-input`, `succeeded`, `reviewing`, `awaiting-human`, `awaiting-merge`, `rework-requested`, `generating-builds`, `awaiting-children`, `awaiting-feature-merge`, `done`, `failed`.

## ClusterAgent

Cluster-scoped agent role definition.

```yaml
apiVersion: percussionist.dev/v1alpha1
kind: ClusterAgent
metadata:
  name: builder
spec:
  content: |
    ---
    name: builder
    description: Builder agent
    mode: primary
    ---
    You are a builder agent. Implement the assigned task following codebase conventions.
    Call complete_run when done.
  model: github-copilot/claude-sonnet-4.5
```

## ClusterSettings

Cluster-wide configuration singleton (name must be `default`).

```yaml
apiVersion: percussionist.dev/v1alpha1
kind: ClusterSettings
metadata:
  name: default
spec:
  runnerImage: ghcr.io/erkkaha/percussionist/runner:latest
  runTTLDays: 7
```
