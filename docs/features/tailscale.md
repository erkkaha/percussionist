# Tailscale (Mobile HTTPS Access)

The web pod runs a Tailscale sidecar that provisions a Let's Encrypt TLS certificate and proxies HTTPS to the web app on port 8080.

## Prerequisites (one-time)

1. **Tailscale account** at [login.tailscale.com](https://login.tailscale.com)
2. **Enable HTTPS**: Admin Console → DNS → **HTTPS Certificates** → Enable
3. **Auth key**: Admin Console → Keys → **Generate auth key** (reusable, tag `percussionist`)

## Setup

```bash
# 1. Create the auth secret
kubectl delete secret tailscale-auth -n percussionist --ignore-not-found
kubectl create secret generic tailscale-auth -n percussionist \
  --from-literal=key=tskey-auth-xxxxx

# 2. Restart web pod to pick up the secret
kubectl -n percussionist rollout restart deploy/percussionist-web
kubectl -n percussionist rollout status deploy/percussionist-web

# 3. Verify the sidecar connected
kubectl -n percussionist logs deploy/percussionist-web -c tailscale --tail=10
# Expected: "Tailscale IP: 100.x.x.x" and "HTTPS serve enabled"
```

## Access

Install Tailscale on your mobile device, log into the same tailnet, then open:

```
https://percussionist-web.<your-tailnet>.ts.net
```

## Sidecar Details

- Defined in `k8s/deploy/web.yaml` under the `percussionist-web` Deployment
- Runs `tailscale serve --https=443 http://127.0.0.1:8080`
- State persisted in K8s Secret `tailscale-state-web`
- Userspace networking only (no kernel TUN required)

## Troubleshooting

```bash
# Check sidecar logs
kubectl -n percussionist logs deploy/percussionist-web -c tailscale

# Verify Tailscale machine in admin console
# https://login.tailscale.com/admin/machines — look for "percussionist-web"
```
