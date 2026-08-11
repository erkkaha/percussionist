# beatctl deploy --platform microk8s — native MicroK8s deployment support

Task ID: `idea-microk8s-platform-deploy`
Branch: `feature/idea-microk8s-platform-deploy`

## Context

`beatctl deploy` (`packages/cli/src/deploy.ts`) installs the whole control plane
(CRDs + operator + manager + web + NetworkPolicies), and is currently written
against one reference topology — minikube:

- **TLS setup is always attempted and is minikube/ingress-nginx-specific.**
  `setupTls()` hardcodes the `ingress-nginx` namespace, the
  `ingress-nginx-controller` Deployment, and patches its args with
  `--default-ssl-certificate=ingress-nginx/percussionist-tls-wildcard`; it pins
  the HTTPS NodePort to 30443 and the HTTP one to 30080 (`scripts/minikube-load.sh`
  does the same).
- **nip.io is assumed.** `setupTls()`, `patchedOperatorManifest()`,
  `applyGitopsBootstrap()`, and the final summary all build
  `https://{nodeIP}.nip.io:30443`. `patchedOperatorManifest`'s regex only
  replaces `value:` lines that already contain `nip.io`.
- **Checked-in manifests carry minikube defaults.** `k8s/deploy/operator.yaml`
  sets `DEFAULT_STORAGE_CLASS=standard` and
  `PERCUSSIONIST_INGRESS_BASE_URL=http://192.168.49.2.nip.io:30080`;
  `k8s/deploy/web.yaml` hardcodes Ingress host `app.192.168.49.2.nip.io` with
  `ingressClassName: nginx` and `WEB_BASE_URL=http://app.192.168.49.2.nip.io`.
  `beatctl deploy` never patches web.yaml — it relies on those checked-in
  defaults matching the cluster, which only holds for minikube.

The operator side is already platform-agnostic: `packages/operator/src/config.ts`
reads `DEFAULT_STORAGE_CLASS` (data PVCs), `PERCUSSIONIST_INGRESS_BASE_URL` and
`PERCUSSIONIST_INGRESS_CLASS` (code-server + per-project Ingresses) from env, so
a deploy that patches those env values needs **zero operator code changes**.

MicroK8s differs from minikube in five ways the deploy must account for:

1. **Addons** — `microk8s enable dns rbac hostpath-storage ingress`. `dns`
   deploys CoreDNS; `rbac` switches the API server from its default
   `--authorization-mode=AlwaysAllow` to real RBAC (Percussionist relies on
   dedicated ServiceAccounts + scoped RoleBindings, and MicroK8s' default Calico
   CNI then enforces `k8s/deploy/networkpolicy.yaml`); `hostpath-storage` creates
   the default `microk8s-hostpath` StorageClass (node-local, single-node only);
   `ingress` deploys the ingress controller.
2. **Ingress controller identity differs by MicroK8s version.** Before 1.35 the
   addon is NGINX: namespace `ingress`, Deployment
   `nginx-ingress-microk8s-controller`, Service `ingress`. Since 1.35 the addon
   ships **Traefik** (namespace `ingress`, Helm chart), with IngressClasses
   `public` (default), `traefik`, and `nginx` (backward-compat — existing
   `ingressClassName: nginx` resources keep working). The current hardcoded
   `ingress-nginx` namespace breaks on both.
3. **RBAC** — off by default on MicroK8s; must be enabled or the security model
   (NetworkPolicy enforcement, scoped service accounts) silently degrades.
4. **Storage** — the operator's `DEFAULT_STORAGE_CLASS` must become
   `microk8s-hostpath` (the `lxd-microk8s-tailscale.md` playbook currently
   creates a `standard` alias SC as a workaround).
5. **kubectl access** — kubectl reaches MicroK8s through a kubeconfig exported
   from `microk8s config`; the workstation may not have the `microk8s` CLI
   (e.g. MicroK8s running inside an LXD VM). The deploy must not require the
   `microk8s` binary.

`docs/guide/lxd-microk8s-tailscale.md` documents this gap explicitly: *"Do not
use `beatctl deploy` for this topology … Apply the manifests directly instead"*
plus manual `kubectl set env` overrides. This task closes that gap.

## Approach

Introduce a **platform profile** abstraction in the CLI, defaulting to today's
exact minikube behavior, plus a `microk8s` profile that parameterizes every
minikube-specific assumption and a `generic` profile that makes no ingress/TLS
assumptions at all (covers the Tailscale/LXD topology).

### Key decisions

1. **`--platform <minikube|microk8s|generic>` flag** (default `minikube`, so
   existing behavior is a pure regression target). Platform selection is
   explicit — no brittle auto-detection as a gating mechanism. A best-effort
   *warning* when the current context looks like MicroK8s but `--platform
   minikube` was passed is a nice-to-have, never a blocker.
2. **Platform profile struct** in a new `packages/cli/src/deploy-platform.ts`:
   `{ namespace, service, deployment, ingressClass, defaultStorageClass,
   httpNodePort, httpsNodePort, defaultDomain(ip), controllerKind }`. The TLS
   helpers (`applyTlsSecret`, `patchIngressNginxDefaultCert`, `pinHttpsNodePort`,
   rollout wait) all take the profile instead of the hardcoded strings.
3. **`--domain <host>`** decouples the base URL from nip.io. Default is still
   `{ip}.nip.io` for minikube (and as a MicroK8s convenience), but a user can
   pass a real DNS name (or `192.168.1.5.nip.io` explicitly). The wildcard cert
   becomes `*.{domain}` and the operator/web URLs follow. **`--http-port` /
   `--https-port`** override NodePorts (defaults per profile: 30080/30443).
4. **`--skip-tls`** skips cert generation + controller default-cert patch +
   NodePort pinning; the `generic` platform implies it. This is the Tailscale /
   real-ingress / no-ingress escape hatch.
5. **MicroK8s addon handling is CLI-optional, verification-mandatory.**
   - If the `microk8s` binary is on PATH: run `microk8s status --wait-ready`,
     then `microk8s enable dns rbac hostpath-storage ingress` (idempotent),
     then `microk8s status --wait-ready`.
   - If not (LXD-VM case): verify effects through kubectl — `microk8s-hostpath`
     StorageClass exists, an ingress controller is present in the `ingress`
     namespace, CoreDNS is Available — and fail with the exact `microk8s enable
     ...` command to run on the host if any is missing. RBAC enablement cannot
     be verified externally without probing unprivileged requests; emit a
     warning with instructions instead of guessing.
6. **Ingress backend detection on MicroK8s** at deploy time: if
   `nginx-ingress-microk8s-controller` exists → legacy NGINX path (patch
   deployment args `--default-ssl-certificate=ingress/percussionist-tls-wildcard`,
   keep `ingressClassName: nginx`); if a Traefik deployment exists in `ingress`
   → prefer `microk8s enable ingress --default-ssl-certificate
   percussionist/percussionist-tls-wildcard` semantics via a deployment-args
   patch fallback (`--default-ssl-certificate=...` works on Traefik too), and
   set `ingressClassName: public`. `ingressClassName: nginx` is documented to
   keep working on Traefik, so the `nginx` class remains a safe cross-version
   fallback. The Secret must exist before the controller consumes it — apply the
   Secret first, then patch / re-enable.
7. **Manifest patching is generalized and extended to web.yaml** (today only
   operator.yaml is patched):
   - `patchedOperatorManifest(operatorYaml, baseUrl, storageClass, ingressClass)`
     — replace any existing `value:` under `PERCUSSIONIST_INGRESS_BASE_URL`
     (drop the nip.io-specific regex), replace `DEFAULT_STORAGE_CLASS`'s value,
     and set `PERCUSSIONIST_INGRESS_CLASS`.
   - New `patchedWebManifest(webYaml, domain, ingressClass, httpsPort)` —
     replaces the Ingress `host: app.<old>` line, `ingressClassName`, and the
     `WEB_BASE_URL` env value, so the dashboard origin always matches the
     Ingress (this is what `checkDashboard` in `doctor-platform.ts` verifies).
   - `patchFluxManifest` in `gitops-manifest.ts` already matches the
     name/value pair (not nip.io) — only the operator.yaml regex in `deploy.ts`
     needs generalizing.
8. **`ensureNamespace()`** — create the target namespace if missing (all
   platforms benefit; the playbook currently hand-rolls this).
9. **`--down`** — unchanged resource deletion; optionally delete the TLS Secret
   from the profile's namespace. Addons are never disabled on teardown
   (conservative: they are cluster-level state the user may share).
10. **MicroK8s TLS on the API server is out of scope** — kubectl reaches
    MicroK8s via the exported kubeconfig (API server on :16443 with its own
    certs); `beatctl` never touches it.

## Scope boundaries

- **CLI + checked-in deploy manifests only.** No changes to
  `packages/operator`, `packages/web`, `packages/manager-controller`,
  `packages/api`, or the CRDs. The operator already consumes all the env knobs
  (`DEFAULT_STORAGE_CLASS`, `PERCUSSIONIST_INGRESS_BASE_URL`,
  `PERCUSSIONIST_INGRESS_CLASS`) that the deploy sets.
- **No microk8s image-load script.** `scripts/minikube-load.sh` is untouched;
  loading locally-built dev images into MicroK8s (`microk8s ctr images import`
  / `sideload`) is a separate concern and out of scope.
- **No E2E suite in CI** — CI has no MicroK8s cluster. Verification is unit
  tests (pure functions) + the documented manual playbook run.
- **RBAC enforcement** is enabled/verified best-effort (warning), never
  silently disabled.
- `--platform generic` is included because the LXD/Tailscale playbook is the
  exact topology where the current command fails; it is the smallest expression
  of "no nginx, no nip.io assumptions".

## Tasks (BUILD breakdown)

1. **BUILD: platform profiles + CLI wiring**
   - New `packages/cli/src/deploy-platform.ts`:
     `DeployPlatform = 'minikube' | 'microk8s' | 'generic'`, `PlatformProfile`
     interface, `platformProfile(platform)` resolver with the three profiles
     (defaults above), `baseUrl(profile, domain, port)`, and
     `detectMicroK8sIngressBackend()` (returns `'nginx' | 'traefik' | undefined`
     by probing deployments in the `ingress` namespace).
   - `packages/cli/src/index.ts`: add `--platform <p>`, `--domain <host>`,
     `--http-port <n>`, `--https-port <n>`, `--skip-tls` to the `deploy`
     command; pass through in `DeployOpts` (`deploy.ts`).
   - Behavior-preserving default: no flags ⇒ identical to today's minikube path.

2. **BUILD: parameterize TLS/ingress setup**
   - Refactor `setupTls()` / `applyTlsSecret()` / `patchIngressNginxDefaultCert()`
     / `pinHttpsNodePort()` in `deploy.ts` to take the `PlatformProfile`
     (namespace, service, deployment, ports). `generateCert(ip, domain, dir)`
     uses `*.{domain}`.
   - `--skip-tls` and `platform === 'generic'`: skip the whole TLS block; use
     the profile's/default base URL for patching and the summary (with a clear
     "TLS not configured" note).
   - MicroK8s backend handling: legacy-NGINX arg patch vs Traefik default-cert
     patch (see decision 6), Secret applied to the correct namespace *before*
     the controller patch.
   - `ensureNamespace(ns)` helper (create-if-missing, ignore already-exists).

3. **BUILD: generalize manifest patching (+ web.yaml)**
   - `patchedOperatorManifest(operatorYaml, { baseUrl, storageClass,
     ingressClass })` in `deploy.ts`: replace the nip.io-specific regex with one
     matching any existing `value:` under `PERCUSSIONIST_INGRESS_BASE_URL`;
     replace `DEFAULT_STORAGE_CLASS` and `PERCUSSIONIST_INGRESS_CLASS` values.
   - New `patchedWebManifest(webYaml, { domain, ingressClass, port })` (in
     `deploy.ts` or a small manifest-patch module) replacing the Ingress host
     line, `ingressClassName`, and `WEB_BASE_URL` env value; write to a temp
     file and apply like the operator patch. Keep the current
     warn-and-apply-unmodified fallback semantics.
   - `applyGitopsBootstrap()` already passes a computed URL through
     `patchFluxManifest` — thread `baseUrl` instead of the hardcoded nip.io URL;
     confirm `gitops-manifest.test.ts` still passes (regex is name/value based).

4. **BUILD: MicroK8s preflight (addons, RBAC, storage, ingress)**
   - `ensureMicroK8sPrereqs(profile)`: if `microk8s` on PATH → `microk8s status
     --wait-ready` → `microk8s enable dns rbac hostpath-storage ingress` →
     `microk8s status --wait-ready`; else → kubectl verification of
     `microk8s-hostpath` StorageClass, `ingress` namespace controller presence,
     CoreDNS Availability; clear fatal errors with the exact host command when
     something is missing. Best-effort RBAC warning (unverifiable externally).
   - Wire into `runDeploy()` before TLS setup, microk8s platform only.
   - Detect the ingress backend (decision 6) and choose
     `DEFAULT_STORAGE_CLASS=microk8s-hostpath` + the right ingress class.

5. **BUILD: unit tests**
   - `packages/cli/test/deploy-platform.test.ts` (bun:test, mirrors
     `gitops-manifest.test.ts` pure-function style): profile resolution
     (minikube/microk8s/generic), `baseUrl()` / domain handling (default nip.io
     vs `--domain`), `patchedOperatorManifest` (storage class + base URL +
     ingress class substitution, idempotency on re-run, unknown-value warning
     path), `patchedWebManifest` (host / ingressClassName / WEB_BASE_URL),
     `--skip-tls` flag plumbing, ingress-backend detection with stubbed kubectl
     output.
   - Run `pnpm typecheck && pnpm test` from repo root; `packages/cli` suite
     green; existing `gitops-manifest.test.ts` untouched or extended only if the
     INGRESS_RE changes.

6. **BUILD: docs**
   - `docs/guide/installation.md`: document `--platform`, `--domain`,
     `--skip-tls`, and a MicroK8s quickstart (`microk8s enable dns rbac
     hostpath-storage ingress`, export kubeconfig, `beatctl deploy --platform
     microk8s`).
   - `docs/reference/cli.md`: extend the `deploy` section with the new flags.
   - `docs/guide/lxd-microk8s-tailscale.md`: replace the "Do not use `beatctl
     deploy` for this topology" + manual `kubectl set env` steps with
     `beatctl deploy --platform microk8s --skip-tls` (ingress addon disabled /
     Tailscale Serve termination), and update the "Common failures" row for the
     old nginx assumption. Keep the StorageClass note (no longer needs the
     `standard` alias when deploying via the CLI).

## Acceptance criteria

- `beatctl deploy --platform microk8s` runs end-to-end on a MicroK8s cluster
  (1.35+ Traefik and <1.35 NGINX paths both handled or explicitly detected):
  addons enabled when the CLI is present / verified with actionable errors when
  not; operator deployed with `DEFAULT_STORAGE_CLASS=microk8s-hostpath`,
  `PERCUSSIONIST_INGRESS_BASE_URL=https://{domain}:{https-port}`,
  `PERCUSSIONIST_INGRESS_CLASS` matching the backend; web Ingress host +
  `WEB_BASE_URL` patched to `app.{domain}`; wildcard TLS cert installed on the
  MicroK8s ingress controller (or `--skip-tls` honored); dashboard reachable at
  the printed URL.
- Data PVCs bind on MicroK8s without creating a `standard` alias SC.
- `beatctl deploy --platform generic` applies manifests without touching any
  ingress controller / TLS state (LXD + Tailscale topology works).
- Default `beatctl deploy` (no flags) is byte-for-byte behavior-preserving for
  minikube (regression-checked against the current flow).
- No `ingress-nginx` or `nip.io` string is required by the microk8s/generic
  paths; `--domain` fully overrides the base URL.
- `pnpm typecheck && pnpm test` pass; `deploy-platform.test.ts` covers profile
  resolution, URL building, and both manifest-patch functions deterministically
  without a cluster.
- Docs updated (installation.md, cli.md, lxd-microk8s-tailscale.md).

## Risks / open questions

- **MicroK8s 1.35+ Traefik specifics need live verification**: exact
  Deployment/Service names in the `ingress` namespace and whether
  `--default-ssl-certificate` on the Traefik deployment args behaves like the
  NGINX flag. Implementation should probe for both backends and prefer the
  documented `microk8s enable ingress --default-ssl-certificate
  <ns>/<secret>` path for Traefik (ordering: Secret first, then re-enable/patch),
  falling back to arg patching; `ingressClassName: nginx` is the documented
  backward-compat class and works on both backends.
- **`microk8s` CLI may not exist on the workstation** (LXD-VM topology) and may
  need `sudo` when it does; the verification-only path plus clear fatal
  messages must cover both. Never shell out to `sudo microk8s` implicitly.
- **RBAC enablement is not externally verifiable** — best-effort warning only.
- **NodePort pinning** may be unnecessary or impossible if the MicroK8s ingress
  Service is LoadBalancer (metallb) rather than NodePort; the pin step must
  detect the service type and skip gracefully, and the summary URL must use the
  actual detected port.
- **`WEB_BASE_URL`/GitHub App coupling**: changing the domain/port changes the
  OAuth callback; docs must state that `--domain`/`--https-port` must match the
  registered callback.
- **hostpath-storage is node-local** — single-node only, not HA; the playbook
  already says this and the docs should repeat it.
- **Deterministic E2E coverage is not possible in CI** (no MicroK8s); manual
  playbook verification is the gate. Keep every testable pure function isolated
  from kubectl so unit coverage is meaningful.
