# LXD, MicroK8s, and Tailscale Playbook

This playbook installs a single-node Percussionist cluster in an LXD virtual
machine and exposes only the dashboard to a Tailscale tailnet. It avoids a
public load balancer and does not publish the MicroK8s API server with
Tailscale Serve.

The setup is intended for a trusted, single-user or small-team environment. A
single-node hostpath volume is not highly available and remains tied to the VM.

## Architecture

```text
workstation
  |
  | LXD bridge (Kubernetes administration)
  v
LXD VM
  +-- MicroK8s
  |   +-- Percussionist web (ClusterIP)
  |   +-- operator and manager
  |   +-- agent runner pods
  |   +-- optional Ollama embedding service
  |
  +-- Tailscale Serve (tailnet HTTPS)
        |
        +-- proxies the web ClusterIP only
```

Use an LXD **virtual machine**, not a privileged system container. MicroK8s can
run in a container with additional nesting and privilege, but the result has a
larger host attack surface and more cgroup, mount, AppArmor, and networking
edge cases.

## Variables

The examples use these values. Change them once before running the commands.

```bash
export VM=percussionist-k8s
export KUBECONFIG="$HOME/.kube/percussionist-k8s"
export NAMESPACE=percussionist
export WEB_BASE_URL=https://percussionist-k8s.example-tailnet.ts.net
export GITHUB_LOGIN=your-github-login
```

`WEB_BASE_URL` must be the final Tailscale HTTPS URL, with no trailing slash.
Do not use the example tailnet name literally.

## Prerequisites

- LXD is initialized with a working storage pool and bridge network.
- The workstation has `lxc`, `kubectl`, Node.js 24+, pnpm, and this repository.
- A Tailscale tailnet is available.
- An OpenCode-supported model provider is configured locally.
- The VM can pull images from GHCR and Docker Hub.

The sizing below is a practical starting point for one or two concurrent
agents. Model inference should run outside this VM unless it is deliberately
sized for that workload.

| Resource | Starting value |
|----------|----------------|
| CPU | 4 vCPUs |
| Memory | 16 GiB |
| Root disk | 150 GiB |
| `Project.spec.maxParallel` | 1 or 2 |

Hostpath PVCs consume the VM root disk. Increase the disk before creating PVCs;
shrinking it later is not supported.

## 1. Create the VM

Create an Ubuntu LTS VM and set its resources before starting the cluster:

```bash
lxc launch images:ubuntu/24.04 "$VM" --vm
lxc config set "$VM" limits.cpu=4 limits.memory=16GiB boot.autostart=true
lxc config device override "$VM" root size=150GiB
lxc config set "$VM" boot.autostart.priority=10
lxc exec "$VM" -- cloud-init status --wait
```

Confirm that this is a VM and that the requested disk size is present:

```bash
lxc config show "$VM" --expanded
lxc exec "$VM" -- df -h /
```

## 2. Install MicroK8s

Install MicroK8s in the VM and enable the required addons:

```bash
lxc exec "$VM" -- snap install microk8s --classic --channel=1.35/stable
lxc exec "$VM" -- microk8s status --wait-ready
lxc exec "$VM" -- microk8s enable dns hostpath-storage metrics-server rbac
lxc exec "$VM" -- microk8s status --wait-ready
```

The important non-default addon is `rbac`. Percussionist uses dedicated service
accounts and scoped RoleBindings; do not run it with authorization disabled.
MicroK8s uses Calico by default, which also enforces Percussionist's
NetworkPolicies.

Leave the MicroK8s ingress addon disabled. Tailscale Serve will terminate HTTPS
and proxy directly to the web Service, so an ingress controller is unnecessary
and may compete for ports on the VM.

```bash
lxc exec "$VM" -- microk8s disable ingress
```

### Workstation kubeconfig

Export a dedicated kubeconfig instead of replacing the workstation's default
configuration:

```bash
mkdir -p "$HOME/.kube"
lxc exec "$VM" -- microk8s config > "$KUBECONFIG"
chmod 600 "$KUBECONFIG"
kubectl get nodes
```

The generated server address is the VM's LXD bridge address. If that address
changes, export the kubeconfig again. Keep this file private because it contains
cluster-admin client credentials.

### StorageClass compatibility

MicroK8s creates a default StorageClass named `microk8s-hostpath`, while the
current Percussionist web manifest names `standard` explicitly. Create a
compatibility StorageClass before deploying:

```bash
kubectl apply -f - <<'EOF'
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: standard
provisioner: microk8s.io/hostpath
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
EOF
```

This is an alias using the same provisioner. It does not create a second
storage system.

Take the first optional recovery snapshot now:

```bash
lxc snapshot "$VM" microk8s-base
```

## 3. Deploy Percussionist

Do not use `beatctl deploy` for this topology. The current command assumes an
`ingress-nginx` deployment, patches its TLS certificate, and derives a minikube
`nip.io` URL. Apply the manifests directly instead:

```bash
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f k8s/crds/
kubectl apply -k k8s/deploy/
```

Remove the dashboard Ingress created by the generic manifests and disable
operator-created IDE Ingresses. The dashboard remains available through its
ClusterIP Service.

```bash
kubectl -n "$NAMESPACE" delete ingress percussionist-web --ignore-not-found
kubectl -n "$NAMESPACE" set env deployment/percussionist-operator \
  DEFAULT_STORAGE_CLASS=microk8s-hostpath \
  DEFAULT_STORAGE_ACCESS_MODE=ReadWriteOnce \
  PERCUSSIONIST_INGRESS_BASE_URL- \
  PERCUSSIONIST_INGRESS_CLASS-
```

Set the final public origin before configuring sign-in:

```bash
kubectl -n "$NAMESPACE" set env deployment/percussionist-web \
  WEB_BASE_URL="$WEB_BASE_URL"
```

Wait for the control-plane components:

```bash
kubectl -n "$NAMESPACE" rollout status deployment/percussionist-web
kubectl -n "$NAMESPACE" rollout status deployment/percussionist-operator
kubectl -n "$NAMESPACE" rollout status deployment/percussionist-manager
kubectl -n "$NAMESPACE" get pods,pvc
```

All PVCs should become `Bound`. A PVC that remains `Pending` usually indicates
a StorageClass name mismatch or insufficient VM disk space.

Take the second optional snapshot:

```bash
lxc snapshot "$VM" percussionist-installed
```

## 4. Add Tailnet-Only HTTPS

Install Tailscale inside the VM using the current instructions from
[Tailscale's Linux installation guide](https://tailscale.com/kb/1031/install-linux),
then enroll the VM:

```bash
lxc exec "$VM" -- tailscale up --ssh
lxc exec "$VM" -- tailscale status
```

`tailscale up` may print a browser authorization URL. Complete that flow as a
tailnet administrator. Use an auth key instead when unattended enrollment is
required, but do not put the key in shell history or this repository.

Tailscale gives the VM a tailnet IP in addition to configuring Serve. Serve is
not a firewall: use Tailscale grants or ACLs to limit which identities can reach
this VM, and deny MicroK8s API port `16443` to identities that do not administer
the cluster. Keep the exported kubeconfig restricted to cluster administrators.

Resolve the web Service's ClusterIP and configure Tailscale Serve inside the
VM:

```bash
lxc exec "$VM" -- bash -lc '
  WEB_SERVICE_IP=$(microk8s kubectl -n percussionist get service percussionist-web \
    -o jsonpath="{.spec.clusterIP}")
  tailscale serve --bg "http://${WEB_SERVICE_IP}:8080"
'
lxc exec "$VM" -- tailscale serve status
```

Expected status resembles:

```text
https://percussionist-k8s.example-tailnet.ts.net (tailnet only)
|-- / proxy http://10.152.183.x:8080
```

Use `tailscale serve`, not `tailscale funnel`. Serve is tailnet-only; Funnel
publishes a service to the internet.

Confirm that Kubernetes has no external dashboard path:

```bash
kubectl -n "$NAMESPACE" get service percussionist-web
kubectl -n "$NAMESPACE" get ingress
lxc exec "$VM" -- microk8s status
```

The web Service should be `ClusterIP`, there should be no dashboard Ingress,
and the MicroK8s ingress addon should be disabled.

After the Tailscale hostname is known, ensure `WEB_BASE_URL` exactly matches it:

```bash
kubectl -n "$NAMESPACE" set env deployment/percussionist-web \
  WEB_BASE_URL="$WEB_BASE_URL"
kubectl -n "$NAMESPACE" rollout status deployment/percussionist-web
```

Take the third optional snapshot:

```bash
lxc snapshot "$VM" tailnet-enabled
```

## 5. Configure Authentication

### Dashboard sign-in

Create a GitHub App with no permissions and no installation requirement. Set
its callback URL to this exact value:

```text
https://percussionist-k8s.example-tailnet.ts.net/api/auth/callback/github
```

The scheme, hostname, port, and path must equal
`${WEB_BASE_URL}/api/auth/callback/github`. Configure the app and allowlist from
the workstation without placing the client secret in a manifest:

```bash
pnpm beatctl auth github set-app <client-id> <client-secret>
pnpm beatctl auth github allow "$GITHUB_LOGIN"
pnpm beatctl auth session-secret
pnpm beatctl auth mcp-token
kubectl -n "$NAMESPACE" rollout restart deployment/percussionist-web
kubectl -n "$NAMESPACE" rollout status deployment/percussionist-web
```

An empty GitHub login allowlist permits nobody to sign in. Do not use
`beatctl auth web-token disable` outside temporary local troubleshooting because
it bypasses dashboard authentication.

### Wait for component key bootstrap

On startup, the web server creates scoped standing keys for the operator and
manager. Wait until both Secrets exist and contain a token before restarting
their Deployments:

```bash
until kubectl -n "$NAMESPACE" get secret operator-api-key \
  -o jsonpath='{.data.token}' 2>/dev/null | grep -q .; do sleep 2; done
until kubectl -n "$NAMESPACE" get secret manager-api-key \
  -o jsonpath='{.data.token}' 2>/dev/null | grep -q .; do sleep 2; done

kubectl -n "$NAMESPACE" rollout restart deployment/percussionist-operator
kubectl -n "$NAMESPACE" rollout restart deployment/percussionist-manager
kubectl -n "$NAMESPACE" rollout status deployment/percussionist-operator
kubectl -n "$NAMESPACE" rollout status deployment/percussionist-manager
pnpm beatctl auth key list
```

The restart is required because the keys are injected as environment variables
when each pod starts. Never print or decode the Secret payloads during routine
verification.

### OpenCode provider credentials

Authenticate OpenCode on the workstation, then import only the required
provider entries into Kubernetes:

```bash
opencode auth login <provider>
pnpm beatctl auth import --dry-run --provider <provider>
pnpm beatctl auth import --provider <provider>
kubectl -n "$NAMESPACE" get secret agent-auth
```

`beatctl auth import` reads the local auth file and writes an Opaque Secret; it
does not print token values. Re-run it after refreshing provider credentials.
Reference the Secret from `ClusterSettings`, a `Project`, or an individual
`Run` as appropriate:

```yaml
spec:
  secrets:
    authSecret:
      name: agent-auth
```

Snapshots taken after this point contain provider credentials and dashboard
secrets. Protect snapshot storage accordingly.

## 6. Optional Persistent Ollama for Embeddings

The repository's `k8s/deploy/ollama.yaml` does not declare persistent model
storage. Without a PVC, models are downloaded again whenever the Ollama pod is
recreated.

Create a PVC and mount it at Ollama's model directory:

```bash
kubectl -n "$NAMESPACE" apply -f - <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ollama-data
  labels:
    app.kubernetes.io/name: percussionist
    app.kubernetes.io/component: ollama
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: microk8s-hostpath
  resources:
    requests:
      storage: 10Gi
EOF

kubectl -n "$NAMESPACE" patch deployment ollama --type=strategic -p '
spec:
  template:
    spec:
      containers:
        - name: ollama
          volumeMounts:
            - name: ollama-data
              mountPath: /root/.ollama
      volumes:
        - name: ollama-data
          persistentVolumeClaim:
            claimName: ollama-data
'
kubectl -n "$NAMESPACE" rollout status deployment/ollama
kubectl -n "$NAMESPACE" get pvc ollama-data
```

Projects with vector memory enabled pull their configured embedding model on
startup. To preload and test the default model explicitly:

```bash
kubectl -n "$NAMESPACE" exec deployment/ollama -- ollama pull nomic-embed-text
kubectl -n "$NAMESPACE" exec deployment/ollama -- ollama list
```

Take an optional post-memory snapshot only after the model pull completes:

```bash
lxc snapshot "$VM" memory-enabled
```

## 7. Verification

### Cluster health

```bash
lxc exec "$VM" -- microk8s status --wait-ready
kubectl get nodes
kubectl -n "$NAMESPACE" get deployments,pods,services,pvc,networkpolicy
kubectl -n "$NAMESPACE" get events --sort-by=.lastTimestamp
```

Expected results:

- The node is `Ready`.
- Web, operator, and manager Deployments are available.
- PVCs are `Bound`.
- Web and manager Services are `ClusterIP`.
- `manager-ingress` and `memory-service-ingress` policies exist.
- No repeated warning events remain unexplained.

### Tailnet boundary

From a device logged into the tailnet, open `WEB_BASE_URL` and complete GitHub
sign-in. From a device outside the tailnet, the hostname must not provide access
to the dashboard.

From a non-administrator tailnet identity, also confirm that a TCP connection
to `<vm-tailnet-ip>:16443` is denied. This validates the tailnet policy around
the Kubernetes API independently of Tailscale Serve.

Also verify the configured origin without showing secret values:

```bash
kubectl -n "$NAMESPACE" get deployment percussionist-web \
  -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="WEB_BASE_URL")].value}{"\n"}'
lxc exec "$VM" -- tailscale serve status
```

### NetworkPolicy enforcement

The manager MCP port exposes destructive control-plane tools and must not be
reachable from a runner-like pod. This test should time out or fail to connect:

```bash
kubectl -n "$NAMESPACE" run network-policy-test \
  --image=busybox:1.36 \
  --labels='percussionist.dev/component=runner' \
  --restart=Never --rm -i \
  -- wget -T 3 -O /dev/null http://percussionist-manager:4097/mcp
```

A `401`, `403`, or other HTTP response means the network connection succeeded
and the NetworkPolicy was not enforcing the intended isolation. Check that
Calico is healthy and that the test pod did not carry an allowlisted label.

### Agent smoke run

Submit a short run using a model available through the imported provider:

```bash
export MODEL=<provider/model>
pnpm beatctl submit \
  --name tailnet-smoke \
  --task 'Reply with exactly: percussionist smoke passed' \
  --model "$MODEL" \
  --auth-secret agent-auth \
  --timeout 300
pnpm beatctl wait tailnet-smoke --timeout 360
pnpm beatctl get tailnet-smoke
```

Use CR status for pass or fail; do not treat model prose as a lifecycle oracle.
During a run, `pnpm beatctl auth key list` should show its short-lived `run:` key.
After the run reaches a terminal phase, the operator should revoke that key:

```bash
pnpm beatctl auth key list
kubectl -n "$NAMESPACE" logs deployment/percussionist-operator --since=10m
```

## 8. Recovery and Maintenance

### Routine checks

```bash
lxc list "$VM"
lxc exec "$VM" -- systemctl is-enabled snap.microk8s.daemon-kubelite tailscaled
lxc exec "$VM" -- tailscale serve status
kubectl -n "$NAMESPACE" get pods,pvc
```

Keep VM autostart, MicroK8s, and `tailscaled` enabled. Tailscale Serve's
background configuration persists across service and VM restarts.

### Restore a snapshot

Restoring rolls back Kubernetes state, PVC contents, database records, and
Secrets together. Stop the VM first and understand that all work after the
snapshot will be lost:

```bash
lxc stop "$VM"
lxc restore "$VM" <snapshot-name>
lxc start "$VM"
lxc exec "$VM" -- microk8s status --wait-ready
kubectl -n "$NAMESPACE" get pods,pvc
```

After restoring a snapshot made before Tailscale enrollment or key bootstrap,
repeat the corresponding sections. After restoring a snapshot containing stale
provider OAuth credentials, re-import them.

### Common failures

| Symptom | Check | Corrective action |
|---------|-------|-------------------|
| PVC remains `Pending` | `kubectl get storageclass` | Create `standard` alias or patch the workload to `microk8s-hostpath` |
| `beatctl deploy` fails looking for nginx | `kubectl -n ingress-nginx get deploy` | Use direct manifest application for this topology |
| Dashboard redirects to the wrong host | Inspect `WEB_BASE_URL` | Set it to the exact Tailscale HTTPS origin and restart web |
| GitHub reports callback mismatch | GitHub App callback setting | Set the exact `${WEB_BASE_URL}/api/auth/callback/github` URL |
| Operator cannot mint run keys | Check `operator-api-key` existence and operator logs | Wait for web bootstrap, then restart operator |
| Manager cannot report stats | Check `manager-api-key` existence and manager logs | Wait for web bootstrap, then restart manager |
| Dashboard unavailable after Service recreation | Compare Serve target with current ClusterIP | Re-run the Tailscale Serve configuration command |
| Ollama downloads models after restart | Check `/root/.ollama` mount and PVC | Add the persistent `ollama-data` volume |
| NetworkPolicy test receives HTTP response | Check Calico pods and labels | Restore CNI policy enforcement before running untrusted agents |

## Security Checklist

- The LXD guest is a VM, not a privileged container.
- MicroK8s RBAC is enabled.
- MicroK8s ingress is disabled.
- The web Service is `ClusterIP` and has no Ingress.
- Tailscale Serve reports `tailnet only`; Funnel is not enabled.
- Tailnet policy denies MicroK8s API port `16443` to non-administrators.
- GitHub sign-in has a non-empty login allowlist.
- Operator and manager use separate scoped keys.
- OpenCode credentials are stored in a Secret and never committed.
- Calico enforces the manager and memory NetworkPolicies.
- VM snapshots containing Secrets are access-controlled.
- Project concurrency matches the VM's CPU, memory, and storage constraints.
