# Security Model

This document describes the security model, defaults, and operational guidance for
Percussionist — a Kubernetes-native orchestration system for AI agent runs.

## 1. Authentication & Authorization

### Web API (`packages/web`)

The web dashboard API has **no built-in authentication** by default. This is an
intentional design decision for single-tenant cluster deployments where network
isolation provides sufficient protection. In shared or externally-facing
deployments, operators should place the web service behind a reverse proxy with
authentication (e.g., OAuth2-proxy, Keycloak, or Tailscale's access controls).

**Sensitive endpoints** that require authentication in production:
- `POST /api/runs` — run creation
- `DELETE /api/runs/:name` — run deletion
- `PUT/POST /api/settings/secrets/*` — secret management
- `POST /api/projects` — project lifecycle operations

### Manager MCP Server (`packages/manager-controller`)

The manager's embedded MCP server listens on port **4097** and serves tools that
can modify cluster state (task phase transitions, run creation/deletion, workspace
exec). It is designed for **in-cluster use only**:

- The dispatcher sidecar binds to `127.0.0.1:4097` (loopback only) — this is a
  secure default that prevents external access.
- The manager controller's MCP server can be configured via environment variable
  or cluster settings; operators should ensure it does not bind to `0.0.0.0`.

**High-risk tools** available through the MCP interface:
| Tool | Risk Level | Description |
|------|-----------|-------------|
| `set_task_state` | High | Moves tasks between board columns, can cancel runs |
| `create_run` | High | Creates new agent runs with arbitrary specs |
| `force_retry` | Medium | Restarts stuck tasks |
| `exec_in_workspace` | Critical | Arbitrary command execution in run workspaces |
| `delete_run` | Medium | Deletes a run pod and associated resources |

### Request Body Limits

The manager MCP server enforces a **1 MB maximum request body** (`MAX_BODY_SIZE`)
to prevent resource exhaustion from oversized payloads.

## 2. Secure Defaults

### SSH / Git Host Key Verification

By default, git operations over SSH use `StrictHostKeyChecking=no` and
`UserKnownHostsFile=/dev/null`. This is a **backward-compatible insecure default**
that allows existing clusters to continue operating without changes.

To enable secure host key verification:

```yaml
apiVersion: percussionist.dev/v1alpha1
kind: Run
spec:
  source:
    git:
      url: ssh://git@github.com/org/repo.git
      # Enable strict host key checking
      sshHostKeyVerification: "strict"
      # Provide known_hosts entries via a Kubernetes Secret
      known_hostsSecret:
        name: my-git-known-hosts
        key: known_hosts  # optional, defaults to "known_hosts"
```

**Available modes:**

| Mode | Behavior | Use Case |
|------|----------|----------|
| `"no"` (default) | No host key verification. Accept any remote. | Backward compatibility, internal/private repos |
| `"accept-new"` | Accept and cache unknown hosts; reject changed keys. | New deployments where known_hosts isn't pre-provisioned |
| `"strict"` | Reject connections to unknown hosts. Require known_hostsSecret. | Production environments with pre-provisioned host keys |

**Provisioning known_hosts:**

```bash
# Collect host keys from your git server(s)
ssh-keyscan github.com > known_hosts
ssh-keyscan gitlab.com >> known_hosts

# Create a Kubernetes Secret
kubectl create secret generic my-git-known-hosts \
  --from-file=known_hosts \
  -n percussionist
```

### Network Bind Addresses

| Component | Default Bind | Notes |
|-----------|-------------|-------|
| Dispatcher MCP | `127.0.0.1:4097` | Loopback only — secure default |
| Manager MCP | Configurable (default: cluster-internal) | Should not bind to `0.0.0.0` in production |
| Web dashboard | ClusterIP Service + optional Ingress | Exposed via K8s networking layer |
| Runner pods | `0.0.0.0:<port>` | Internal only; accessible within pod network |

### Container Security Contexts

Runner pods use the `Never` restart policy and run as non-root by default (the
runner image is based on Alpine Linux with standard user permissions). Sidecar
containers can optionally specify a `securityContext` for additional hardening:

```yaml
sidecars:
  - name: test-db
    securityContext:
      privileged: false
      allowPrivilegeEscalation: false
```

## 3. Data Protection

### Secrets Handling

- SSH private keys are mounted as read-only volumes with `defaultMode: 0o400`
- GitHub tokens are mounted as read-only volumes with `defaultMode: 0o400`
- LLM API keys are injected via environment variables from K8s Secrets (optional)
- Auth secrets for the web dashboard reference a JSON file in a K8s Secret

### Session Data

Session messages are stored in ConfigMaps with size limits:
- Live sessions: capped at **20 MB** before falling back to truncated snapshots
- Snapshot ConfigMaps: automatically truncated to fit ConfigMap budget

## 4. Network Topology & Recommended Policies

### Assumed Topology

```
[External] → [Ingress/Proxy] → [Web Dashboard (port 8080)]
                                    ↓
                          [Manager Controller (:4097, :4096, :4098)]
                                    ↓
                          [Operator Controller]
                                    ↓
                          [Runner Pods (ephemeral, per-run)]
```

All inter-component communication is **in-cluster only**. No component exposes a
public-facing endpoint by default. The web dashboard can be exposed via Ingress or
Tailscale for operator access.

### Recommended Network Policies

For production deployments, apply the following network policies:

```yaml
# Allow manager to communicate with runner pods
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-manager-to-runners
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/component: runner
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app.kubernetes.io/component: manager
```

### PVC Data Layout (Isolation)

Each project gets an isolated data PVC (`{project}-data`) with the following layout:
- `/data/cache/` — package manager caches (shared across runs in same project)
- `/data/git-mirrors/{hash}/` — bare git mirrors (one per remote URL)
- `/data/worktrees/{run-name}/` — per-run worktree checkouts
- `/data/workspace/` — persistent local workspace (local git mode only)

## 5. Migration Guidance for Existing Clusters

### Upgrading from Pre-Security Defaults

Existing clusters that were deployed before this security model was documented will
continue to operate without changes:

1. **SSH host key verification**: Default remains `"no"` — no action required. To
   migrate, add `sshHostKeyVerification: "accept-new"` or `"strict"` with a
   corresponding `known_hostsSecret` to your Run specs.

2. **Web API authentication**: No automatic changes. If you need auth, deploy a
   reverse proxy (e.g., OAuth2-proxy) in front of the web service.

3. **Manager MCP exposure**: The dispatcher sidecar already binds loopback. Verify
   that the manager controller is not exposed via a ClusterIP or NodePort Service
   on port 4097. If it is, remove the Service or restrict its selector.

### Step-by-Step Migration to Strict SSH Mode

1. Create a `known_hosts` Secret in your namespace:
   ```bash
   ssh-keyscan github.com > known_hosts
   kubectl create secret generic git-known-hosts --from-file=known_hosts
   ```

2. Update your Project or Run spec:
   ```yaml
   source:
     git:
       url: https://github.com/org/repo.git  # or ssh:// URL
       sshHostKeyVerification: "strict"
       known_hostsSecret:
         name: git-known-hosts
   ```

3. Create a new Run — the operator will mount the known_hosts file and configure
   SSH with strict host key verification.

4. Verify the first run completes successfully (the runner will validate the
   remote server's host key against your known_hosts entries).

## 6. Emergency Override Mechanisms

### Force Retry Stuck Tasks

If a task is stuck due to SSH host key rejection or other transient issues:

```bash
# Use the force_retry MCP tool to restart at an incremented retry count
# This preserves historical runs and resets the task state
```

### Pause Reconciliation

To prevent the manager from overriding manual changes during incident response:

```bash
# Pause reconciliation for 10 minutes (auto-resumes)
kubectl exec -it deployment/percussionist-manager -- \
  bash -c 'curl -X POST http://127.0.0.1:4097/mcp \
    -H "Content-Type: application/json" \
    -d \'{"jsonrpc":"2.0","method":"tools/call","params":{"name":"pause_reconciliation","arguments":{"project":"my-project","durationSeconds":600}}}\''
```

### Scaling Down for Incident Response

If a run pod is exhibiting unexpected behavior:

```bash
kubectl delete pod <run-pod-name> -n percussionist
# The operator will not recreate it — the Run CR's status reflects the deletion
```

## 7. Known Security Considerations

### LLM-Generated Content in Sessions

Session messages contain content generated by LLMs, which may include:
- Code snippets (rendered via Shiki syntax highlighting)
- File paths and diffs
- Tool call inputs/outputs

These are rendered safely through React's text rendering or Shiki's HTML output.
No raw LLM output is ever executed as code on the client side.

### Workspace Command Execution

The `exec_in_workspace` MCP tool allows arbitrary command execution within run
workspaces. This is intentionally powerful for agent operations but should be
considered a privileged operation. In shared cluster environments, restrict access
to this tool via network policies or RBAC.

### Package Installation Validation

Package names passed to `apk add` are validated against an allowlist regex matching
Alpine package token format before command construction, preventing shell injection
through the package install path.

---

*This document is maintained by the Percussionist project team and updated as new
security findings or hardening measures are implemented.*
