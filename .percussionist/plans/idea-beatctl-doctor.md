# beatctl doctor — read-only cluster diagnostics

Task ID: `idea-beatctl-doctor`
Branch: `feature/idea-beatctl-doctor`

## Context

`beatctl` (`packages/cli/src/index.ts`) is a commander-based CLI with thin
subcommand modules. There is already one read-only diagnostics command group,
`beatctl validate` (`packages/cli/src/validate.ts`), which audits ClusterAgent
capabilities and Project rosters. It establishes the house pattern for a
read-only report command:

- Pure check functions returning typed findings (`AuditIssueCode` const object,
  `AgentCapabilityAuditFinding` with `severity: 'error' | 'warning'`).
- A `runValidateAgents(opts, deps)` entry with injectable `loadData` and `log`
  so the report logic is unit-testable without a cluster (see
  `packages/cli/test/validate.test.ts`).
- Summary + per-category section output, `process.exitCode = 1` when errors exist.

The doctor command is broader: it checks the whole control plane, not just CR
content. Everything it needs is already reachable from the CLI:

| Check area | Existing surface |
|---|---|
| CRDs | `makeNodeApiClient(kc, ApiextensionsV1Api)` from `@percussionist/kube` (`kubeConfig()`, `makeNodeApiClient`, `loadFromKubeconfig` exported) |
| RBAC | SA/Role/ClusterRole/Bindings in `k8s/deploy/operator.yaml`, `manager-controller.yaml`, `web.yaml` |
| NetworkPolicy | `k8s/deploy/networkpolicy.yaml` (`manager-ingress`, `memory-service-ingress`); enforcement depends on CNI (Calico/Cilium enforce; minikube/kind default CNI does not — documented acceptable) |
| DNS | CoreDNS deployment in `kube-system`; Services `percussionist-manager`, `percussionist-web`, `ollama`; DNS names like `percussionist-manager.percussionist.svc.cluster.local` used by web → manager MCP |
| Storage | Operator `ensureDataPVC` (`packages/operator/src/pvc-helper.ts`) creates `{project}-data` PVCs (50Gi, `DEFAULT_STORAGE_CLASS=standard`, RWO); web uses `percussionist-web-db-v3` PVC |
| Scoped credentials | Secrets `operator-api-key`, `manager-api-key` (web-issued scoped keys, see `packages/web/src/server/routes/agent-keys.ts`), `manager-mcp-token` (shared web+manager), `web-auth` (token/session-secret/github-*/disabled), `opencode-auth`, `llm-keys` |
| Provider auth / models | Manager MCP `list_models` tool (`packages/manager-controller/src/agent/tools.ts` → opencode sidecar `GET /provider`); web proxies it via `packages/web/src/server/routes/providers.ts` using `managerMcpHeaders()` (Bearer `MCP_TOKEN`) against `percussionist-manager:4097/mcp` |
| Dashboard origin | `WEB_BASE_URL` env on web Deployment vs Ingress host `app.<ip>.nip.io`; GitHub App callback must equal `${WEB_BASE_URL}/api/auth/callback/github`; web `/api/health` (public, returns `{ok, namespace, authDisabled}`) |
| Component health | Deployments `percussionist-operator` / `percussionist-manager` / `percussionist-web` (+ `opencode-web` sidecar, `ollama` when memory services exist) |

The manager's MCP server exempts loopback callers from the bearer-token check
(`tools.ts` ~line 2776: `kubectl port-forward` traffic arrives on the pod's
loopback), and NetworkPolicy explicitly permits port-forward-sourced traffic to
chat:4098. So the CLI can reach the manager's MCP port via
`kubectl port-forward svc/percussionist-manager <local>:4097` — mirroring the
existing `web-client.ts` / `chat.ts` port-forward pattern — and send the
`MCP_TOKEN` header when the secret exists for robustness.

## Approach

Add a new top-level `beatctl doctor` command in a new module
`packages/cli/src/doctor.ts`, following the `validate.ts` report pattern:

1. **Pure, injectable check functions** — one per diagnostic area, returning
   `{ status: 'pass' | 'warn' | 'fail', message, detail? }`. Each function
   accepts its API clients as parameters so unit tests can stub them (bun:test,
   same shape as `validate.test.ts`).
2. **`runDoctor(opts, deps)` orchestrator** — collects per-check results,
   prints a summary + per-category details (or raw JSON with `--json`), sets
   `process.exitCode` (0 clean, 1 any fail, 2 fatal/connection error). Log
   injection for tests.
3. **Read-only guarantee** — only `get/list` API verbs, bounded network probes
   (`AbortSignal.timeout`), and an optional opt-in `--probe-dns` exec
   (`getent hosts` in an existing pod). No creates/patches/deletes anywhere.
4. **Reuse existing surfaces** — manager MCP `list_models` for provider/model
   checks; web `/api/health` for dashboard health; K8s discovery APIs for
   everything else. No server-side changes.
5. **New small helpers** — `packages/cli/src/manager-mcp.ts` (port-forward to
   `svc/percussionist-manager:4097`, JSON-RPC `tools/call` with optional Bearer
   token from `manager-mcp-token` secret) and a lazy builder for the additional
   API clients (`ApiextensionsV1Api`, `RbacAuthorizationV1Api`,
   `NetworkingV1Api`, `StorageV1Api`) via `makeNodeApiClient(kubeConfig(), ...)`.

### Command surface

```
beatctl doctor
  -n, --namespace <ns>      namespace to inspect (default: percussionist)
  --check <name>            run only the named checks (repeatable)
  --json                    emit machine-readable JSON report
  --probe-dns               exec `getent hosts` into a ready pod to verify
                            in-cluster DNS resolution (opt-in, best-effort)
  --timeout <seconds>       per-probe timeout (default: 30)
```

Exit codes: `0` all checks pass, `1` any check fails, `2` cluster unreachable
or fatal error.

### Check categories (10)

1. `crds` — the 5 CRDs (`runs`, `projects`, `tasks`, `clusteragents`,
   `clustersettings` in group `percussionist.dev/v1alpha1`) exist and have the
   `Established` condition.
2. `rbac` — ServiceAccounts (`percussionist-operator`, `percussionist-manager`,
   `percussionist-web`, `percussionist-dispatcher`), ClusterRoles/Roles and
   RoleBindings/ClusterRoleBindings exist and reference the right subject/roleRef
   names (names sourced from the deploy manifests).
3. `network-policy` — `manager-ingress` and `memory-service-ingress`
   NetworkPolicies exist; detect an enforcing CNI (calico/cilium/antrea/weave
   daemonsets in `kube-system`); when the default CNI is in use, report a
   **warning** (documented acceptable — bearer token is the effective control,
   per `networkpolicy.yaml` header comment).
4. `dns` — CoreDNS deployment in `kube-system` is Available; Services
   `percussionist-manager`, `percussionist-web`, `ollama` exist with ready
   Endpoints; with `--probe-dns`, exec `getent hosts
   <svc>.<ns>.svc.cluster.local` into a ready percussionist pod (best-effort;
   RBAC/exec failures downgrade to warning).
5. `storage` — a default StorageClass exists; web PVC
   `percussionist-web-db-v3` is `Bound`; for each Project, `{project}-data` PVC
   exists and is `Bound` (`Pending` → warning with provisioning note; `Lost`/`Failed`
   → error). Check the operator's `DEFAULT_STORAGE_CLASS` env resolves.
6. `credentials` — required Secrets present with expected keys: `operator-api-key`
   (`token`), `manager-api-key` (`token`), `manager-mcp-token` (`token`),
   `web-auth` (`token`, `session-secret`, `github-client-id`,
   `github-client-secret`, `github-allowed-logins`). Optional: `opencode-auth`
   (`auth.json`), `llm-keys` — absent → warning with remediation
   (`beatctl auth import` / create secret). Best-effort: if a CLI session exists,
   query web `/api/internal/agent-keys` for the key inventory; otherwise warning
   "run `beatctl auth login` to verify agent keys".
7. `providers` — provider authentication: call manager MCP `list_models` via
   port-forward; report connected providers; zero connected providers when
   credentials exist → error; in dev mode (`AUTH_DISABLED=1`) downgrade to
   warning.
8. `models` — model endpoints: at least one connected provider with ≥1 model;
   cross-check the effective default model (from `opencode-config` ConfigMap /
   ClusterSettings / Project specs) resolves to a connected provider; print the
   provider → model table (also under `--json`).
9. `dashboard` — web Deployment `WEB_BASE_URL` matches the Ingress
   `percussionist-web` host (scheme+host); not the `http://localhost:8080`
   fallback; GitHub App client id configured (else warning: no sign-in possible);
   `AUTH_DISABLED` state surfaced; web `/api/health` returns `ok:true` and the
   expected namespace.
10. `health` — Deployments `percussionist-operator`, `percussionist-manager`,
    `percussionist-web` have `availableReplicas >= 1` and ready pods; `ollama`
    deployment healthy iff any Project has `spec.embedding.enabled`; manager MCP
    responds to a JSON-RPC `tools/list`; web `/api/health` reachable (via
    `PERCUSSIONIST_WEB_URL` or port-forward).

## Scope boundaries

- **CLI-only.** No changes to operator/manager/web/memory-service code. All data
  comes from existing K8s APIs and the existing manager MCP + web health
  surfaces.
- **Read-only.** No create/update/patch/delete of any cluster resource. The only
  in-pod action is the opt-in `--probe-dns` exec of a read-only `getent hosts`.
- **Bounded probes.** Every network call uses `AbortSignal.timeout`
  (default 30s, overridable).
- **Not a fixer.** `doctor` diagnoses and prints remediation hints (e.g.
  `beatctl auth import`, `beatctl deploy`), but never mutates.
- Out of scope: `beatctl validate` (stays separate — config/agent audit), web UI
  equivalents, server-side health endpoints.

## Tasks (BUILD breakdown)

1. **BUILD: doctor scaffolding + report plumbing**
   - Add `packages/cli/src/doctor.ts`: `DoctorCheckStatus`, per-check result
     type, `runDoctor(opts, deps)` with summary/exit-code logic and `--json`
     output (modeled on `runValidateAgents` in `validate.ts`).
   - Register `beatctl doctor` in `packages/cli/src/index.ts` with the flags
     above.
   - Add `packages/cli/src/k8s-clients.ts` (or extend `doctor.ts`) with a lazy
     `doctorClients()` helper building `ApiextensionsV1Api`,
     `RbacAuthorizationV1Api`, `NetworkingV1Api`, `StorageV1Api` via
     `makeNodeApiClient(kubeConfig(), ...)` from `@percussionist/kube`.

2. **BUILD: static cluster checks — crds, rbac, network-policy, dns, storage**
   - `checkCrds`, `checkRbac`, `checkNetworkPolicy`, `checkDns`,
     `checkStorage` pure functions wired into `runDoctor`.
   - DNS check includes CoreDNS Availability, Service Endpoints, and the
     opt-in `--probe-dns` exec (`kubectl exec` pattern like `attach.ts`).
   - CNI enforcement heuristic (daemonset name lookup) + warning path.

3. **BUILD: credentials, providers, models checks**
   - `checkCredentials` (Secret presence + expected keys, optional-key
     warnings, best-effort `/api/internal/agent-keys` via `web-client.ts`
     when a session exists).
   - Add `packages/cli/src/manager-mcp.ts`: `managerMcpRequest(namespace,
     tool, args)` — port-forward `svc/percussionist-manager` → local:4097,
     JSON-RPC `tools/call`, optional Bearer `MCP_TOKEN` from
     `manager-mcp-token`.
   - `checkProviders` + `checkModels` using `list_models`; default-model
     cross-check against `opencode-config` ConfigMap / ClusterSettings /
     Project specs.

4. **BUILD: dashboard origin + component health checks**
   - `checkDashboard` (`WEB_BASE_URL` vs Ingress host, GitHub App config,
     `/api/health` via `PERCUSSIONIST_WEB_URL` or port-forward — reuse
     `withWebApi` from `web-client.ts`).
   - `checkHealth` (deployments ready, ollama conditional, manager MCP
     `tools/list` probe).

5. **BUILD: unit tests**
   - `packages/cli/test/doctor.test.ts` (bun:test): stub API clients and
     probes; assert pass/warn/fail mapping, summary output, `--json` shape,
     exit codes 0/1/2 (mirroring `validate.test.ts` conventions).
   - Run `pnpm typecheck && pnpm test` from repo root; ensure
     `packages/cli` suite passes.

6. **BUILD: docs**
   - Add a `doctor` section to `docs/reference/cli.md` (flags, exit codes,
     check list); note the read-only guarantee and the NetworkPolicy-CNI
     warning semantics.

## Acceptance criteria

- `beatctl doctor` runs against a live cluster, covers all 10 categories, and
  prints per-category pass/warn/fail with remediation hints.
- Exit codes: `0` healthy, `1` any fail, `2` cluster unreachable.
- `--json` emits a structured report; `--check` filters categories.
- The command performs no writes (verified by code review: only get/list
  verbs + bounded probes).
- `pnpm typecheck && pnpm test` pass; `packages/cli/test/doctor.test.ts`
  covers the report logic deterministically without a cluster.
- `docs/reference/cli.md` documents the command.

## Risks / open questions

- **CNI enforcement heuristic** is name-based (calico/cilium/antrea/weave
  daemonsets) and can miss exotic CNIs (GKE Dataplane V2, Azure NPM). Always
  downgrade an "unknown" to a warning, never an error; document the caveat.
- **Provider checks depend on the manager's opencode-web sidecar** being
  healthy. If `list_models` fails, report the specific cause (sidecar not
  ready vs MCP unreachable) rather than a generic error.
- **`/api/internal/agent-keys` needs a session**; without `beatctl auth
  login` the doctor can only verify Secret presence — scoped-key inventory
  degrades to a warning. Acceptable; do not attempt to mint keys.
- **MCP loopback exemption** — docs state port-forward arrives on loopback,
  so no token is required; still attach `MCP_TOKEN` when the secret exists to
  be robust if that assumption changes.
- **`Pending` PVCs** may be transiently provisioning; warn (not fail) and
  only error on `Lost`/`Failed`.
- Verify `ApiextensionsV1Api` / `RbacAuthorizationV1Api` /
  `NetworkingV1Api` / `StorageV1Api` are exported by the installed
  `@kubernetes/client-node` at build time (they are standard; add to the
  import list in `kube.ts` if a convenience export is wanted).
