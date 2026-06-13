---
layout: home

hero:
  name: Percussionist
  text: Kubernetes-native orchestration for AI agents
  tagline: Run OpenCode agents on Kubernetes with isolated workspaces, semantic memory, and enterprise-grade control.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/erkkaha/percussionist

features:
  - title: Git Workspace Isolation
    details: Every agent run gets its own git worktree. Remote mirrors with flock-serialized fetches. Local git workspaces for persistent, incremental development.
    link: /features/git-workspace
  - title: Vector Memory Service
    details: Per-project semantic memory with sqlite-vec embeddings. Session summarization and context injection so agents retain knowledge across runs.
    link: /features/vector-memory
  - title: Feature Branch Workflow
    details: Per-task feature branches eliminate worktree conflicts. PLAN assignments pass to BUILD tasks. Predecessor dependencies enforce correct build ordering.
    link: /features/feature-branching
  - title: Interactive Code Server
    details: Opt-in VS Code access to project workspaces. Inspect worktrees, review agent output, or intervene directly — all through your browser.
    link: /features/code-server
  - title: Runner Package System
    details: Declare Alpine packages in project specs. Agents discover available tools automatically. Per-run overrides for ad-hoc dependencies.
    link: /features/runner-packages
  - title: Mobile HTTPS Access
    details: Tailscale sidecar provisions Let's Encrypt TLS certificates. Access the web dashboard from any device on your tailnet.
    link: /features/tailscale
---
