# beatctl deploy — native MicroK8s support (Traefik-only platform layer)

Task ID: `idea-microk8s-platform-deploy`
Branch: `feature/idea-microk8s-platform-deploy`
Revision: 4 (retry 3/3)

> Supersedes revisions 1–3. Revisions 2–3 were built around a "minikube keeps
> nginx, MicroK8s gets Traefik" split with a full nginx cleanup sweep. The
> retry 3/3 feedback — **"minikube kan run traefik. no nginx support needed"**
> — removes that split: **both platforms run Traefik and the deploy carries
> zero nginx code paths.** Revision 4 is the authoritative plan and replaces
> the revision-1 copy in the plans ConfigMap.

## Context

`beatctl deploy` (`packages/cli/src/deploy.ts`) installs the whole control
plane (CRDs + operator + manager + web + NetworkPolicies) but is written
against one reference topology: minikube with the **ingress-nginx** addon.

- **TLS setup is always attempted and hardcodes ingress-nginx.** `setupTls()`
  targets the `ingress-nginx` namespace, Deployment and Service
  `ingress-nginx-controller`, patches its args with
  `--default-ssl-certificate=ingress-nginx/percussionist-tls-wildcard`, pins
  the HTTPS NodePort to 30443, and rolls out
  `deploy/ingress-nginx-controller`. ~30 literal `ingress-nginx` strings live
  in `deploy.ts` (verified: lines 7–11, 123, 149–172, 185–197, 222–259,
  262–305, 312–355, 362–367, 636, 644, 668–669, 756–757).
- **nip.io is assumed** with hardcoded ports: `setupTls()`,
  `patchedOperatorManifest()`, `applyGitopsBootstrap()` and the summary banner
  build `https://{nodeIP}.nip.io:30443`; `patchedOperatorManifest` only
  replaces `value:` lines that already contain `nip.io`, and web.yaml is never
  patched at all.
- **Checked-in manifests carry minikube+nginx defaults**:
  `k8s/deploy/operator.yaml` (`DEFAULT_STORAGE_CLASS=standard`,
  `PERCUSSIONIST_INGRESS_BASE_URL=http://192.168.49.2.nip.io:30080`,
  `PERCUSSIONIST_INGRESS_CLASS=nginx`), `k8s/deploy/web.yaml` (Ingress host
  `app.192.168.49.2.nip.io`, `ingressClassName: nginx`,
  `WEB_BASE_URL=http://app.192.168.49.2.nip.io`, and a **stale `traefik.me`
  comment block that contradicts the file's own nip.io host**).
- **The LXD/MicroK8s playbook is blocked by design**:
  `docs/guide/lxd-microk8s-tailscale.md` says "Do not use `beatctl deploy` for
  this topology" and hand-rolls a `standard` StorageClass alias + manual
  manifest apply (lines ~134–160, 527–528).

The operator side is already almost platform-agnostic:
`packages/operator/src/config.ts` consumes `DEFAULT_STORAGE_CLASS`,
`DEFAULT_STORAGE_ACCESS_MODE`, `PERCUSSIONIST_INGRESS_BASE_URL`,
`PERCUSSIONIST_INGRESS_CLASS` and `PERCUSSIONIST_INGRESS_ANNOTATIONS` from
env, and `renderIdeIngress()` (`packages/operator/src/code-server.ts` line 652)
builds the per-project code-server Ingress from those knobs. One gap: the
rendered Ingress sets **no `spec.tls`** — HTTPS today relies on the
controller's *default certificate*, which is exactly what the deploy's nginx
arg-patch provides. `beatctl doctor` (`doctor-platform.ts`) is platform-neutral
(no nginx strings) and already verifies `WEB_BASE_URL` matches the Ingress
host, which the web-manifest patching below must keep true.

### Verified platform facts (official docs, Aug 2026)

1. **MicroK8s ingress addon (microk8s.io/docs/addon-ingress):**
   - Since **1.35 the addon ships Traefik** (Helm chart) with three
     IngressClasses: **`public` (default — "backward compatible with the
     previous NGINX setup"), `traefik`, `nginx`** (legacy compat via the
     `kubernetesIngressNginx` provider). Pre-1.35 the addon is NGINX.
   - TLS: `microk8s enable ingress --default-ssl-certificate NAMESPACE/NAME` —
     documented, idempotent, sets Traefik's default TLS certificate from an
     existing Secret.
   - `microk8s disable ingress` removes Traefik, Gateway API CRDs, and legacy
     NGINX resources. Gateway resources live in the `ingress` namespace
     (`traefik-gateway`), i.e. the Helm release/Deployment/Service is `traefik`
     in the `ingress` namespace.
   - Addon set: `microk8s enable dns rbac hostpath-storage ingress`. `rbac`
     turns on real RBAC (Percussionist's ServiceAccounts + RoleBindings are
     meaningless under the default `AlwaysAllow`). `hostpath-storage` creates
     the `microk8s-hostpath` StorageClass (node-local, `WaitForFirstConsumer`).
     MicroK8s' default Calico CNI enforces `k8s/deploy/networkpolicy.yaml`.
   - kubectl reaches MicroK8s via a kubeconfig exported from `microk8s config`
     (:16443); the `microk8s` binary may not exist on the workstation
     (LXD-VM topology) and may need `sudo` when it does. The deploy must not
     require the `microk8s` CLI and must never run `sudo microk8s` implicitly.
2. **minikube Traefik addon (minikube.sigs.k8s.io/docs/handbook/addons/traefik/):**
   - Addon name is **`traefik`** (`minikube addons enable traefik`), minikube
     **≥ 1.39**, installed from the official Traefik Helm chart into
     **`kube-system`**; Deployment and Service are both named **`traefik`**.
   - The Service is **LoadBalancer** and Traefik additionally binds the node's
     ports **80/443 via hostPort** — the dashboard/per-run URLs are
     `http(s)://{nodeIP}/…` with **no NodePort suffix**.
   - The addon creates **IngressClass `traefik` and registers it as the
     default class** (`ingressClass.isDefaultClass=true`), so Ingresses with no
     `ingressClassName` are handled too.
   - TLS is configured **per-Ingress via `spec.tls.secretName`**; there is no
     addon option for a controller default certificate.
   - The old `ingress` (nginx) addon is **unmaintained** and minikube
     recommends `traefik` instead; the two cannot be enabled at the same time
     (both bind 80/443) — migrate with `minikube addons disable ingress &&`
     `minikube addons enable traefik`.

### Retry feedback (drives this revision)

1. **MicroK8s is a first-class citizen** — `beatctl deploy` with no flags must
   work on MicroK8s (auto-detect), docs give MicroK8s equal billing, and the
   LXD playbook's "apply manifests by hand" workaround goes away.
2. **Traefik is the only ingress controller** — on minikube (traefik addon) and
   on MicroK8s 1.35+ (ingress addon). Percussionist Ingresses use the
   IngressClass the platform ships (`traefik` on minikube, `public` on
   MicroK8s; both exist on both, and `traefik` also exists on k3s).
3. **No nginx support needed** — the deploy carries **zero nginx code paths**:
   no nginx TLS patching, no legacy-NGINX MicroK8s backend handling, no nginx
   cleanup sweep. A cluster whose only ingress controller is nginx gets a
   clear, actionable error telling the user how to get Traefik (or to use
   `--platform generic --skip-tls --ingress-class <name>` for an HTTP-only
   install). The checked-in manifests and docs stop assuming nginx entirely.

## Approach

Introduce a **platform layer** in the CLI: `DeployPlatform` profiles +
auto-detection (default) with explicit `--platform` override, Traefik-only
TLS wiring per platform, generalized manifest patching (operator **and** web),
and a small additive operator change so code-server Ingresses can carry
`spec.tls`. The nginx machinery in `deploy.ts` is deleted, not preserved.

### Key decisions

1. **`--platform auto|minikube|microk8s|generic`** (default `auto`), resolved
   from the live cluster and **always printed**; `--platform` always overrides.
   Detection order:
   - kubeconfig context name (`kubectl config current-context`): contains
     `microk8s` → microk8s; contains `minikube` → minikube. Authoritative —
     works on a fresh MicroK8s with no addons enabled yet.
   - Cluster probes: `microk8s-hostpath` StorageClass exists, or a node has the
     `node.kubernetes.io/microk8s-controlplane` label → microk8s; node names
     start with `minikube` → minikube (renamed-context fallback).
   - Else `generic` (no ingress/TLS assumptions — LXD/Tailscale and real
     clusters; implies `--skip-tls`).
   - A minikube cluster with the old nginx addon still resolves to the minikube
     profile (it is a minikube cluster); the ingress-backend check then fails
     with the migration command rather than attempting nginx support (see
     decision 6).
2. **`PlatformProfile` struct** in a new `packages/cli/src/deploy-platform.ts`:
   `{ name, ingressNamespace, controllerDeployment: 'traefik',
   controllerService: 'traefik', ingressClass, storageClass, httpPort,
   httpsPort, defaultDomain(ip), tlsMechanism: 'addon-default-cert' |
   'per-ingress' | 'none', addonEnableHint }`.
   - **minikube**: `kube-system` / `traefik` / `traefik`, class `traefik`
     (also the addon's default class), `storageClass: standard`, ports **80 /
     443** (hostPort; no NodePort suffix in URLs), domain `{ip}.nip.io`,
     `tlsMechanism: 'per-ingress'`.
   - **microk8s**: `ingress` / `traefik` / `traefik`, class **`public`**
     (MicroK8s' documented default, nginx-routing-compatible), `storageClass:
     microk8s-hostpath`, HTTP/HTTPS ports **detected at deploy time** (Service
     type NodePort → pin 443-port to 30443 when settable; LoadBalancer →
     detect the LB address/port — see risks), domain `{ip}.nip.io`,
     `tlsMechanism: 'addon-default-cert'`.
   - **generic**: no namespace/class/port assumptions, storage class left at
     the manifest default unless `--storage-class`, `tlsMechanism: 'none'`.
   - `detectTraefikController(profile)` probes the profile's namespace for the
     `traefik` Deployment/Service, reads the Service type + NodePorts, and
     confirms the IngressClass exists. Result feeds port/URL and TLS decisions
     and the nginx-mismatch error.
3. **New flags** on `beatctl deploy` (`packages/cli/src/index.ts` lines 64–75,
   extended `DeployOpts` in `deploy.ts`):
   - `--platform auto|minikube|microk8s|generic` (default `auto`)
   - `--domain <host>` — decouples the base URL from nip.io; wildcard cert
     becomes `*.{domain}` (default per profile: `{ip}.nip.io`)
   - `--http-port <port>` / `--https-port <port>` — override the profile's
     ingress ports (NodePort pinning target on microk8s; URL suffix on
     minikube if a user insists on non-80/443 access)
   - `--storage-class <name>` — overrides `DEFAULT_STORAGE_CLASS` (also useful
     for longhorn/rwx clusters on any platform)
   - `--ingress-class <name>` — overrides the IngressClass (k3s, kind, and the
     legacy-HTTP escape hatch for nginx clusters; generic, not nginx-specific)
   - `--skip-tls` — no cert generation, no Secret, no default-cert wiring, no
     port pinning; `generic` implies it
   - `--tls-secret <ns>/<name>` — TLS Secret name (default
     `percussionist-tls-wildcard` in the profile's ingress namespace for
     `addon-default-cert` platforms, deploy namespace otherwise)
4. **Platform preflight is CLI-optional, verification-mandatory** (new
   `packages/cli/src/deploy-preflight.ts`):
   - microk8s with `microk8s` on PATH: `microk8s status --wait-ready` →
     `microk8s enable dns rbac hostpath-storage ingress` →
     `microk8s status --wait-ready` (addons are idempotent).
   - microk8s without the CLI (LXD-VM): verify effects via kubectl —
     `microk8s-hostpath` StorageClass exists, `traefik` Deployment present in
     `ingress`, CoreDNS Available; **fail with the exact `microk8s enable …`
     command to run on the host** if anything is missing. RBAC enablement is
     not externally verifiable → best-effort warning with instructions, never a
     silent skip.
   - minikube: `minikube addons enable traefik`, first running
     `minikube addons disable ingress` if the nginx addon is enabled (they
     cannot coexist). If the `minikube` CLI is absent (unusual for a minikube
     cluster), verify `traefik` in `kube-system` + IngressClass `traefik` and
     fail with instructions.
   - generic: no addon handling.
   - Never shell out to `sudo microk8s` / `sudo minikube` implicitly.
5. **TLS wiring per platform** (profile-driven refactor of `setupTls()`):
   - Cert generation is unchanged in mechanics but parameterized:
     `*.{domain}` SAN, applied as the `--tls-secret` Secret **before** any
     controller configuration (both platforms require the Secret to exist
     first).
   - **microk8s (`addon-default-cert`)**: `microk8s enable ingress
     --default-ssl-certificate <ns>/<secret>` — the documented, idempotent
     mechanism (CLI present) or, with no CLI, a documented best-effort patch of
     the `traefik` Deployment (file-provider dynamic config with the Secret
     mounted — exact args to be verified live, see risks).
   - **minikube (`per-ingress`)**: no controller patch at all. The deploy
     patches the web Ingress with `spec.tls` (via `patchedWebManifest`) and the
     operator is taught to emit `spec.tls` on code-server Ingresses via a new
     additive env (`PERCUSSIONIST_INGRESS_TLS_SECRET`, see decision 7). This is
     the mechanism the minikube docs document.
   - **generic / `--skip-tls`**: skip the whole TLS block; patch with the
     `http` base URL and print a "TLS not configured" note.
   - Port/URL: pin the microk8s HTTPS NodePort to `--https-port` (30443) only
     when the controller Service type is NodePort; when LoadBalancer/hostPort,
     detect the actual address and use the profile default ports (minikube:
     80/443 → no suffix in URLs).
   - The stale "Runs: https://<run-name>…" banner lines (deploy.ts 668–669,
     756–757) are removed — per-run Ingresses no longer exist
     (`packages/operator/src/config.ts` comment: "Per-run Ingress was removed
     when `opencode web` was replaced by the tmux-wrapped TUI").
6. **Ingress-backend mismatch handling (the "no nginx support" boundary):**
   after platform resolution, `detectTraefikController()` runs. If a Traefik
   controller is present (either profile namespace), proceed. If an nginx
   controller is found instead (e.g. old minikube `ingress` addon, MicroK8s
   <1.35, or a hand-installed ingress-nginx), **fail with an actionable error**:
   - minikube: `minikube addons disable ingress && minikube addons enable
     traefik`
   - MicroK8s <1.35: upgrade MicroK8s, then `microk8s enable ingress` (Traefik)
   - generic out: `beatctl deploy --platform generic --skip-tls
     --ingress-class nginx --domain <host>` for an HTTP-only install.
   No nginx controller gets patched, configured, or pinned anywhere.
7. **Per-Ingress TLS support (small additive operator change):**
   - `packages/operator/src/config.ts`: read
     `PERCUSSIONIST_INGRESS_TLS_SECRET` (optional, default '').
   - `packages/operator/src/code-server.ts` `renderIdeIngress()`: when set, add
     `spec.tls: [{ hosts: [host], secretName }]` for the rendered host.
   - `packages/operator/src/code-server.test.ts`: cover the block's
     presence/absence.
   - This is the only operator change; it is off by default and lets the
     code-server Ingress serve the wildcard cert on `per-ingress` platforms.
     The deploy sets it on both Traefik platforms (harmless on microk8s, where
     the addon default cert covers everything anyway).
8. **Manifest patching generalized and extended to web.yaml** (pure functions
   in a new `packages/cli/src/deploy-manifests.ts`, unit-testable):
   - `patchedOperatorManifest(yaml, { baseUrl, storageClass, ingressClass,
     tlsSecret })` — replace the `value:` under `PERCUSSIONIST_INGRESS_BASE_URL`
     (nip.io-agnostic regex — match the env-name/value pair, not the value
     content), `DEFAULT_STORAGE_CLASS`, `PERCUSSIONIST_INGRESS_CLASS`, and add
     `PERCUSSIONIST_INGRESS_TLS_SECRET` when given. Keep the
     warn-and-apply-unmodified fallback.
   - `patchedWebManifest(yaml, { host, ingressClass, webBaseUrl, tlsSecret })`
     — replace the Ingress `host:` line, `ingressClassName`, `WEB_BASE_URL`
     env, and add a `spec.tls` block when `tlsSecret` given (minikube). This is
     what keeps `checkDashboard` (`doctor-platform.ts`) happy: `WEB_BASE_URL`
     origin must equal the Ingress host.
   - `gitops-manifest.ts`: `patchFluxManifest` gains optional `storageClass`
     and `ingressClass` substitutions (same name/value-pair regex style as the
     existing `INGRESS_RE`, throw-on-drift as today);
     `applyGitopsBootstrap()` threads the computed base URL/storage/class. The
     flux path's web Ingress keeps the checked-in defaults (documented, see
     risks).
9. **Checked-in manifest defaults go Traefik** so plain
   `kubectl apply -f k8s/deploy/` works on any Traefik cluster (minikube,
   MicroK8s 1.35+, k3s — all three expose an IngressClass named `traefik`):
   - `operator.yaml`: `PERCUSSIONIST_INGRESS_CLASS: traefik`;
     `PERCUSSIONIST_INGRESS_BASE_URL: http://192.168.49.2.nip.io` (no `:30080`
     — Traefik binds node port 80); comment examples Traefik-ified (drop the
     nginx annotation example, add a `traefik.ingress.kubernetes.io/…` example
     and a MicroK8s variant).
   - `web.yaml`: `ingressClassName: traefik`; comment block rewritten to the
     Traefik reality (**fixing the stale `traefik.me` reference** that
     contradicts the file's own nip.io host); `WEB_BASE_URL` stays
     `http://app.192.168.49.2.nip.io` (no port).
   - `k8s/local.example/tailnet-ingress.yaml`: `ingressClassName: traefik` +
     comment update.
10. **`--down`** — unchanged resource deletion; optionally delete the TLS
    Secret from the profile's namespace. Addons are never disabled on teardown
    (conservative: cluster-level state the user may share).
11. **MicroK8s API-server TLS is out of scope** — kubectl reaches MicroK8s via
    the exported kubeconfig; `beatctl` never touches :16443.

## Scope boundaries

- **CLI + checked-in deploy manifests + `renderIdeIngress` (one additive env) +
  docs/scripts only.** No changes to `packages/web`, `packages/manager-controller`,
  `packages/api`, or the CRDs. The operator change is exactly the optional
  `spec.tls` block in decision 7.
- **No microk8s image-load script.** Loading locally-built images into
  MicroK8s (`microk8s ctr images import` / `sideload`) is a separate concern;
  `scripts/minikube-load.sh`'s nginx pin block becomes a traefik-aware
  equivalent (see task 5).
- **No nginx support, anywhere.** No nginx code paths, no legacy MicroK8s
  NGINX backend handling (MicroK8s <1.35 is out of scope and errors clearly),
  no nginx doc inventory. The only nginx mention kept is in the actionable
  error text telling users how to move to Traefik.
- **No E2E suite in CI** — CI has no MicroK8s or minikube-Traefik cluster.
  Verification is unit tests (pure functions) + the documented manual playbook
  run.
- **RBAC enforcement** is enabled/verified best-effort (warning), never
  silently disabled.
- `--platform generic` is included because the LXD/Tailscale playbook is the
  exact topology where the current command fails; it is the smallest expression
  of "no ingress assumptions".

## Tasks (BUILD breakdown)

1. **BUILD: platform layer — profiles, auto-detection, CLI flags**
   - New `packages/cli/src/deploy-platform.ts`: `DeployPlatform` union,
     `PlatformProfile` interface, `platformProfile(platform)`, `resolvePlatform()`
     (context name → StorageClass/node-label/node-name probes → generic),
     `baseUrl(profile, domain, httpPort, httpsPort)`,
     `detectTraefikController()` (probe `kube-system`/`ingress` for Deployment
     + Service `traefik`, read Service type/NodePorts, confirm IngressClass),
     and the three profiles from decision 2.
   - `packages/cli/src/index.ts` (deploy command, lines 64–75): add
     `--platform`, `--domain`, `--http-port`, `--https-port`,
     `--storage-class`, `--ingress-class`, `--skip-tls`, `--tls-secret`;
     extend `DeployOpts` in `deploy.ts`.
   - Wire into `runDeploy()`: resolve platform (print it), run preflight
     (task 3), run `detectTraefikController()` and fail on nginx mismatch
     (decision 6).
   - Behavior guarantee: `auto` on a minikube+traefik cluster reproduces the
     old no-flag flow except the nginx→traefik names, ports (80/443) and URL
     (no `:30443`).

2. **BUILD: parameterize TLS/ingress setup (deploy.ts)**
   - Refactor `setupTls()` / `applyTlsSecret()` / `existingCertIsValid()` /
     `pinHttpsNodePort()` to take the `PlatformProfile` + resolved controller
     info. Delete `patchIngressNginxDefaultCert()` and every literal
     `ingress-nginx` string. `generateCert(ip, domain, dir)` → `*.{domain}`.
   - `configureDefaultCert(profile, secretRef)` dispatch:
     - microk8s: `microk8s enable ingress --default-ssl-certificate …`
       (CLI present) else documented best-effort Traefik Deployment patch
       (exact flag verified live — see risks).
     - minikube: no controller action (per-Ingress TLS covers it).
     - none: skip.
   - NodePort pin only when Service type is NodePort (microk8s); detect
     LoadBalancer address/ports otherwise; build the summary URL from the
     detected facts. `--skip-tls`/generic skip the whole block.
   - Remove the stale "Runs:" banner lines; print `Dashboard:
     https://app.{domain}{:port?}/`.
   - `ensureNamespace(ns)` helper (create-if-missing, ignore already-exists).
   - `--down`: optionally delete the TLS Secret from the profile namespace.

3. **BUILD: platform preflight (addons, RBAC, storage, Traefik presence)**
   - New `packages/cli/src/deploy-preflight.ts`:
     `ensureMicroK8sPrereqs()` (CLI path vs kubectl-verification path, decision
     4), `ensureMinikubePrereqs()` (`disable ingress` if enabled → `enable
     traefik`, or verify `kube-system/traefik` + IngressClass `traefik`),
     `ensureGenericPrereqs()` (no-op).
   - Called from `runDeploy()` before TLS setup, per resolved platform; on
     microk8s also drive `detectTraefikController()` to pick ports and the
     `public` class.

4. **BUILD: manifest patching (+ web.yaml, + operator spec.tls, + gitops)**
   - New `packages/cli/src/deploy-manifests.ts`: `patchedOperatorManifest`
     and `patchedWebManifest` per decision 8; `deploy.ts` applies the patched
     web.yaml next to the patched operator.yaml (temp file, `finally` cleanup,
     same pattern as today's operator patch).
   - Operator: `config.ts` reads `PERCUSSIONIST_INGRESS_TLS_SECRET`;
     `code-server.ts` `renderIdeIngress()` emits `spec.tls` when set;
     extend `code-server.test.ts`.
   - `gitops-manifest.ts`: `patchFluxManifest` gains `storageClass` /
     `ingressClass` (name/value-pair regexes, throw-on-drift as today);
     `applyGitopsBootstrap()` threads computed base URL/storage/class; extend
     `k8s/flux/percussionist.yaml`'s patch block with the
     `DEFAULT_STORAGE_CLASS` and `PERCUSSIONIST_INGRESS_CLASS` env entries.
   - Update checked-in `operator.yaml` / `web.yaml` defaults and comment blocks
     per decision 9.

5. **BUILD: scripts + docs**
   - `scripts/minikube-load.sh`: replace the ingress-nginx NodePort pin block
     with a traefik-aware block (pin `kube-system/traefik` HTTPS NodePort to
     30443 only when the Service is NodePort; no-op otherwise — hostPort
     addon); update comments/URLs to drop the nginx wording.
   - `README.md`: minikube section switches to
     `minikube addons enable traefik` (note: disable `ingress` first; note the
     old addon is unmaintained); ingress-controller table + operator-config
     examples Traefik-ified; add a MicroK8s quickstart block
     (`microk8s enable dns rbac hostpath-storage ingress`, export kubeconfig,
     `beatctl deploy`).
   - `docs/guide/installation.md`: nginx mention (~line 111) →
     controller-neutral; add a "Platforms" section — `--platform auto`
     detection, MicroK8s quickstart, the new flags.
   - `docs/reference/cli.md`: extend the `deploy` section (line 74) with the
     new flags and a microk8s example.
   - `docs/guide/lxd-microk8s-tailscale.md`: replace "Do not use `beatctl
     deploy`" + manual `kubectl set env` + `standard` SC alias steps with
     `beatctl deploy` (auto-detect) or `--platform microk8s --skip-tls`
     (ingress addon disabled / Tailscale Serve termination); update the
     "Common failures" nginx row; keep the hostpath single-node caveat.
   - `k8s/local.example/tailnet-ingress.yaml`: class + comment → traefik.

6. **BUILD: unit tests**
   - `packages/cli/test/deploy-platform.test.ts` (bun:test, pure-function style
     like `gitops-manifest.test.ts`): `auto` detection (context-name hits,
     StorageClass-probe hit, node-label hit, fallback to generic), profile
     resolution (minikube/microk8s/generic), `baseUrl()` / domain / port
     handling, `detectTraefikController` with stubbed probe output, nginx
     mismatch error path.
   - `packages/cli/test/deploy-manifests.test.ts`: `patchedOperatorManifest`
     (base URL / storage class / ingress class / TLS-secret substitution,
     idempotency on re-run, unknown-value warning path), `patchedWebManifest`
     (host / ingressClassName / WEB_BASE_URL / spec.tls) — both against the
     real checked-in manifests (repo-root read, same trick as
     `gitops-manifest.test.ts`).
   - Extend `gitops-manifest.test.ts` for `storageClass`/`ingressClass`
     (throw-on-drift covered) and `code-server.test.ts` for the `spec.tls`
     block.
   - `--skip-tls` / `--platform` flag plumbing asserted at the `DeployOpts`
     mapping level.
   - Gate: `pnpm typecheck && pnpm test` from repo root; `packages/cli` and
     `packages/operator` suites green.

## Acceptance criteria

- `beatctl deploy` **with no flags** works end-to-end on MicroK8s 1.35+
  (auto-detection resolves microk8s; `dns rbac hostpath-storage ingress`
  enabled when the CLI is present, actionable fatal errors when not; operator
  deployed with `DEFAULT_STORAGE_CLASS=microk8s-hostpath`,
  `PERCUSSIONIST_INGRESS_BASE_URL=https://{domain}:{https-port}`,
  `PERCUSSIONIST_INGRESS_CLASS=public`; web Ingress host + `WEB_BASE_URL`
  patched to `app.{domain}`; wildcard TLS Secret installed and wired to Traefik
  via the documented `--default-ssl-certificate` mechanism; dashboard reachable
  at the printed URL).
- `beatctl deploy` with no flags works end-to-end on minikube + the `traefik`
  addon (Deployment/Service `kube-system/traefik`, class `traefik`, URLs on
  node ports 80/443 without a suffix; web Ingress carries `spec.tls`; code-server
  Ingresses carry `spec.tls` via `PERCUSSIONIST_INGRESS_TLS_SECRET`).
- A cluster whose only ingress controller is nginx (old minikube addon,
  MicroK8s <1.35, hand-installed ingress-nginx) **fails fast with the exact
  Traefik-migration command**, or installs HTTP-only with
  `--platform generic --skip-tls --ingress-class <name>`. No nginx controller
  is ever patched.
- Data PVCs bind on MicroK8s without a `standard` alias StorageClass.
- `beatctl deploy --platform generic` applies manifests without touching any
  ingress controller / TLS state (LXD + Tailscale topology works).
- Zero literal `ingress-nginx` strings remain in `packages/cli/src/deploy.ts`;
  `operator.yaml` / `web.yaml` / `README.md` / installation docs no longer
  present nginx as a Percussionist assumption (web.yaml's stale `traefik.me`
  comment contradiction is fixed).
- `pnpm typecheck && pnpm test` pass; new unit tests cover detection, profile
  resolution, URL building, both manifest-patch functions, and the operator
  `spec.tls` block deterministically without a cluster.
- Docs updated (installation.md, cli.md, lxd-microk8s-tailscale.md, README.md),
  including the Traefik ingress-class and MicroK8s quickstart material.
- The plans ConfigMap holds this revision (revision 4), not the stale revision
  1.

## Risks / open questions

- **Traefik default-cert mechanics on the no-CLI microk8s path and exact
  Service/port shape need live verification** on a real MicroK8s 1.35+ cluster:
  the `ingress` namespace's `traefik` Deployment/Service names, Service type
  (NodePort vs LoadBalancer/metallb) and NodePorts, and the correct Traefik
  static-config mechanism for a default certificate (file-provider dynamic
  config with a mounted Secret). The primary TLS path is the documented addon
  option (`microk8s enable ingress --default-ssl-certificate …`); the arg-patch
  fallback is best-effort until verified. Port/URL facts are detected at deploy
  time, never assumed.
- **minikube per-Ingress TLS assumes Traefik honors `spec.tls.secretName`**
  (it does — documented) and that the addon's Service/hostPort shape matches
  the docs (minikube ≥1.39, `kube-system/traefik`, hostPort 80/443, default
  IngressClass `traefik`). Verify once live; the `--domain`/`--http-port`/
  `--https-port` overrides and `--skip-tls` cover deviations.
- **GitOps parity for the web Ingress** is partial: `patchFluxManifest`
  carries storage/ingress-class/base-URL into the operator patch, but the web
  Ingress under `--gitops` keeps the checked-in `traefik` class + default host
  (`app.192.168.49.2.nip.io`), which is only correct for the default minikube
  domain. Documented, not silently broken; non-minikube gitops users patch the
  web Ingress via their own Flux patch or the local overlay.
- **`microk8s`/`minikube` CLIs may be absent** (LXD-VM topology) or need
  `sudo`; the verification-only paths plus clear fatal messages cover both.
  Never shell out to `sudo microk8s`/`sudo minikube` implicitly.
- **RBAC enablement is not externally verifiable** — best-effort warning only.
- **`WEB_BASE_URL`/GitHub App coupling**: `--domain`/`--https-port` change the
  OAuth callback; docs must state they must match the registered callback.
- **hostpath-storage is node-local** — single-node only, not HA; docs repeat
  the caveat.
- **Auto-detection is advisory** — `--platform` always overrides, and the
  detected platform is always printed; detection never gates destructive
  actions.
- **Deterministic E2E coverage is not possible in CI** (no MicroK8s /
  minikube-Traefik cluster); manual playbook verification is the gate. Keep
  every testable pure function isolated from kubectl so unit coverage is
  meaningful.
