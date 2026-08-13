# CLI Reference (beatctl)

`beatctl` is the Percussionist command-line interface. It talks directly to the Kubernetes API.

## Run Commands

### submit

Create a new Run (ad-hoc, outside the board workflow).

```bash
beatctl submit --project <name> [--task "<prompt>"] [--agent <name>] [--model <name>]
beatctl submit -f run.yaml
beatctl submit --interactive                  # no prompt; keep runner alive for attach
```

### ls

List Runs in a namespace.

```bash
beatctl ls [-n <namespace>]
beatctl list                                   # alias
```

### get

Show details for a single Run.

```bash
beatctl get <run-name> [-o yaml|json]
```

### attach

Exec into the run's pod and open the opencode TUI attached to the live agent
session.

```bash
beatctl attach <run-name> [-n <namespace>]
```

`beatctl attach` runs `kubectl exec -it pod/<pod> -c opencode -- opencode attach
http://127.0.0.1:4096`: it execs into the pod's `opencode` container — where the
runner serves the headless agent API on `:4096` — and attaches to the session
with a full TUI. No port-forward or auth-Secret read is involved.

### logs

Stream logs from a run's pod.

```bash
beatctl logs <run-name> [--container opencode] [--tail <lines>] [--follow]
```

### wait

Block until a run reaches a terminal phase (exit 0 on Succeeded).

```bash
beatctl wait <run-name> [--timeout <seconds>] [--for <phase>]
```

### cancel

Delete a run (cascades to its pod/service/secret).

```bash
beatctl cancel <run-name>
```

### chat

Interactive chat with the manager agent.

```bash
beatctl chat [--namespace <ns>]
```

### deploy

Install or remove Percussionist CRDs and deployments.

```bash
beatctl deploy                                # install
beatctl deploy --down                         # remove
beatctl deploy --gitops                       # install via Flux
beatctl deploy --gitops --release v0.2.11     # ...pinned to a release
```

`--gitops` hands the control plane to Flux so that later upgrades apply CRDs as
well as images — the in-place upgrade path cannot touch CRDs. See
[GitOps upgrades](/guide/gitops).

### web

Open the dashboard in your browser via localhost port-forward.

```bash
beatctl web [--port <port>] [--no-browser]
```

## Management Commands

### project

Manage Project templates (reusable run defaults).

```bash
beatctl project list                          # list all projects
beatctl project get <name>                    # show project spec
beatctl project create --name <name> ...      # create a project
beatctl project delete <name>                 # delete a project
```

### agent

Manage ClusterAgent resources.

```bash
beatctl agent list
beatctl agent get <name> [-o yaml|json]
beatctl agent create --name <name> -f agent.md
beatctl agent delete <name>
```

### board

Manage the kanban board embedded in a Project.

```bash
beatctl board get <project>                   # show board state
beatctl board task add <project> --title "..." --agent <name>
beatctl board task move <project> --task-name <name> --to <column>
beatctl board task remove <project> --task-name <name>
```

### auth

Manage OpenCode provider credentials, dashboard sign-in, and agent API keys.

```bash
beatctl auth import                           # copy auth.json to cluster Secret
```

Signing in. The CLI uses the OAuth 2.0 device grant: it prints a code, you
approve it in an already-signed-in browser, and the CLI receives a session.

```bash
beatctl auth login                            # device-code sign-in
beatctl auth login --no-browser                # print the URL instead of opening it
beatctl auth whoami                           # show the signed-in identity
beatctl auth logout                           # discard the local session
```

Dashboard sign-in is GitHub-only. Register a GitHub App whose callback URL
exactly matches `${WEB_BASE_URL}/api/auth/callback/github`. **No permissions are
required at all**, and the App does not need to be installed anywhere — the web
flow authorizes without installation.

Two GitHub App specifics worth knowing:

- The callback must be an **exact** match. GitHub Apps allow no host-only or
  subdirectory matching and no loopback port exception (that exception is for
  classic OAuth Apps). Up to 10 callback URLs may be registered, so add one per
  origin you sign in from. `redirect_uri` is derived from `WEB_BASE_URL` rather
  than the browser's current URL, so sign-in always round-trips through that
  origin — sign in via the Ingress; `beatctl web`'s port-forward is for viewing.
  For local sign-in, run web with a fixed `WEB_BASE_URL` and register it too.
- **Email is optional.** GitHub Apps ignore the OAuth `scope` parameter, so an
  account with a private email returns no address unless you grant Account
  Permissions → Email Addresses → Read-only. The `user` table needs an email, so
  when none is available one is synthesized as
  `<login>@users.noreply.github.com` — unroutable, and nothing sends mail here.
  Grant the permission only if you want your real address stored; note that
  adding an account permission after authorizing requires re-authorizing the App
  (GitHub does not prompt for account-permission changes on its own).

```bash
beatctl auth github set-app <clientId> <clientSecret>
beatctl auth github allow <login...>          # replace the sign-in allowlist
beatctl auth session-secret                   # rotate session signing secret
beatctl auth mcp-token                        # rotate the manager MCP token
```

Agent API keys. Each agent holds a key scoped to what it actually needs; run pods
get a `stats:write` key that expires with the run.

```bash
beatctl auth key list                         # scopes, usage, expiry
beatctl auth key rotate operator              # re-mint a standing component key
beatctl auth key rotate manager
```

Legacy shared-token commands, kept for the migration window (see SECURITY.md §1):

```bash
beatctl auth web-token show                   # print the legacy shared token
beatctl auth web-token set <token>            # set it
beatctl auth web-token rotate                 # generate a random one
beatctl auth web-token disable                # bypass auth entirely (dev)
beatctl auth web-token enable                 # enforce auth
```

### ssh-key

Manage SSH key Secrets for private git repos.

```bash
beatctl ssh-key create [--key ~/.ssh/id_ed25519]
```

### github-token

Manage GitHub token Secrets for gh CLI auth in runners.

```bash
beatctl github-token create [--token <token>]
```

## Diagnostics Commands

### doctor

Read-only cluster diagnostics for the whole control plane. `beatctl doctor`
audits CRDs, RBAC wiring, NetworkPolicy enforcement, DNS, storage,
credentials, providers, models, the dashboard origin, and component health,
then prints a per-category `pass`/`warn`/`fail` report with remediation hints.

```bash
beatctl doctor                               # full report (all 10 checks)
beatctl doctor --check crds --check storage  # run only the named checks
beatctl doctor --json                        # machine-readable JSON report
beatctl doctor --probe-dns                   # exec getent hosts into a pod
beatctl doctor --timeout 60                  # 60s per-probe timeout
```

| Flag | Alias | Description |
|------|-------|-------------|
| `--namespace` | `-n` | Namespace to inspect (default: `percussionist`) |
| `--check` | | Run only the named check category (repeatable) |
| `--json` | | Emit a machine-readable JSON report |
| `--probe-dns` | | Exec `getent hosts` into a ready pod to verify in-cluster DNS (opt-in, best-effort) |
| `--timeout` | | Per-probe timeout in seconds (default: `30`) |

Exit codes:

- `0` — all checks pass
- `1` — at least one check failed
- `2` — cluster unreachable / fatal connection error (no report produced)

The ten check categories (`--check <name>` filters by these names):

1. `crds` — the 5 `percussionist.dev/v1alpha1` CRDs (`runs`, `projects`,
   `tasks`, `clusteragents`, `clustersettings`) exist and are `Established`.
2. `rbac` — ServiceAccounts, (Cluster)Roles and (Cluster)RoleBindings exist
   and reference the right subject/roleRef names.
3. `network-policy` — the `manager-ingress` and `memory-service-ingress`
   NetworkPolicies exist; a warning is reported when the CNI cannot enforce
   them.
4. `dns` — CoreDNS is Available; control-plane Services (`percussionist-manager`,
   `percussionist-web`, `ollama`) have ready endpoints; with `--probe-dns`,
   execs `getent hosts` into a ready pod.
5. `storage` — a default StorageClass exists; the web PVC and each
   `{project}-data` PVC are `Bound` (`Pending` → warning, `Lost`/`Failed` →
   error); the operator's `DEFAULT_STORAGE_CLASS` env resolves.
6. `credentials` — required Secrets (`operator-api-key`, `manager-api-key`,
   `manager-mcp-token`, `web-auth`) are present with expected keys; optional
   Secrets (`opencode-auth`, `llm-keys`) warn with remediation hints.
7. `providers` — provider authentication via the manager MCP `list_models`
   tool (port-forward); zero connected providers with credentials configured
   is an error (dev mode downgrades to a warning).
8. `models` — at least one connected provider exposes ≥1 model; the effective
   default model (opencode-config / ClusterSettings / Project specs) resolves
   to a connected provider; prints the provider → model table.
9. `dashboard` — `WEB_BASE_URL` matches the Ingress host (not the
   `http://localhost:8080` port-forward fallback); GitHub App client id
   configured; web `/api/health` answers `ok:true` with the expected namespace.
10. `health` — control-plane Deployments have ready replicas; `ollama` is
    healthy iff a Project enables `spec.embedding`; manager MCP answers a
    `tools/list` probe; web `/api/health` is reachable.

**Read-only guarantee.** `beatctl doctor` only issues `get`/`list` API verbs
plus bounded network probes (every call times out per `--timeout`). It never
creates, patches, or deletes anything. The only in-pod action is the opt-in
`--probe-dns` exec of a read-only `getent hosts`, which is best-effort and
downgraded to a warning on RBAC/exec failures. The command diagnoses and
prints remediation hints (e.g. `beatctl auth import`, `beatctl deploy`) but
never mutates the cluster.

**NetworkPolicy/CNI warning semantics.** NetworkPolicy enforcement depends on
the CNI. With the default minikube/kind CNI (which does not enforce),
`network-policy` reports a **warning**, not an error — documented as acceptable
because the manager's bearer token is the effective access control (see the
header comment in `k8s/deploy/networkpolicy.yaml`). CNI detection is a
name-based heuristic that looks for `calico`, `cilium`, `antrea`, or `weave`
DaemonSets in `kube-system`; unknown CNIs (GKE Dataplane V2, Azure NPM, …) are
treated as non-enforcing and downgrade to a warning, never an error.

**Out of scope.** `beatctl validate` remains a separate command (config/agent
audit of ClusterAgent capabilities and Project rosters). No server-side health
endpoints or web-UI equivalents were added — all data comes from existing
Kubernetes APIs, the manager MCP, and the web `/api/health` endpoint.

## Global Flags

| Flag | Alias | Description |
|------|-------|-------------|
| `--namespace` | `-n` | Override namespace (default: `percussionist`) |
| `--output` | `-o` | Output format (`yaml`, `json`) |
