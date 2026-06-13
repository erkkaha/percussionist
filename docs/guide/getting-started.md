# Getting Started

Percussionist runs [OpenCode](https://opencode.ai) AI agents inside Kubernetes pods with isolated workspaces, git integration, and semantic memory.

## Prerequisites

- **Kubernetes cluster** (minikube, k3s, or any conformant cluster)
- **kubectl** configured with cluster access
- **Node.js 24+** and **pnpm** (for CLI use)

## Quick Start

1. **Install CRDs and manifests**

```bash
kubectl apply -f k8s/crds/
kubectl apply -f k8s/deploy/
```

2. **Create a Project**

```yaml
apiVersion: percussionist.dev/v1alpha1
kind: Project
metadata:
  name: my-project
  namespace: percussionist
spec:
  source:
    git:
      url: https://github.com/your/repo.git
```

```bash
kubectl apply -f my-project.yaml
```

3. **Create a Task**

```bash
beatctl board task add my-project --title "Implement login" --agent builder --type BUILD
```

Or create a Task CR directly:

```yaml
apiVersion: percussionist.dev/v1alpha1
kind: Task
metadata:
  name: my-project-build-login
  namespace: percussionist
  labels:
    percussionist.dev/project: my-project
spec:
  projectRef: my-project
  type: BUILD
  title: Implement login
  agent: builder
```

4. **Submit a Run**

```bash
pnpm beatctl submit --project my-project --task my-task
```

## Next Steps

- [Installation](/guide/installation) — detailed deployment guide
- [Configuration](/guide/configuration) — project spec reference
- [CLI Reference](/reference/cli) — `beatctl` commands
