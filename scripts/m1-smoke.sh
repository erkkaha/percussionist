#!/usr/bin/env bash
# M1 smoke test: runs `opencode serve` in a Kubernetes pod and opens a
# port-forward so you can `opencode attach` from your laptop.
#
# Prerequisites:
#   - kubectl configured against the target cluster (ideally homelab k3s)
#   - Runner image available in the cluster:
#       * Docker Desktop k8s: `docker build -t percussionist/runner:dev images/runner`
#       * k3s:                 `docker save percussionist/runner:dev | sudo k3s ctr images import -`
#       * registry:            push and override IMAGE below
#   - At least one provider API key exported, e.g. ANTHROPIC_API_KEY
#
# Usage:
#   ./scripts/m1-smoke.sh                 # apply, forward, print attach cmd
#   ./scripts/m1-smoke.sh --down          # tear down namespace
#   IMAGE=myrepo/runner:tag ./scripts/m1-smoke.sh
#   LOCAL_PORT=14096 ./scripts/m1-smoke.sh

set -euo pipefail

NS="percussionist-m1"
POD="opencode-smoke"
SVC="opencode-smoke"
LOCAL_PORT="${LOCAL_PORT:-4096}"
IMAGE="${IMAGE:-percussionist/runner:dev}"
MANIFEST="$(cd "$(dirname "$0")/.." && pwd)/k8s/samples/m1-smoke.yaml"

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }

if [[ "${1:-}" == "--down" ]]; then
  yellow "Deleting namespace $NS..."
  kubectl delete namespace "$NS" --ignore-not-found --wait=false
  exit 0
fi

# --- Sanity checks -----------------------------------------------------------

command -v kubectl >/dev/null || { red "kubectl not found in PATH"; exit 1; }

CTX="$(kubectl config current-context 2>/dev/null || echo none)"
bold "Current kubectl context: $CTX"
if [[ "$CTX" != *k3s* && "$CTX" != *kind* && "$CTX" != *docker-desktop* && "$CTX" != *homelab* && "$CTX" != *minikube* ]]; then
  yellow "WARNING: context does not look like a local/homelab cluster."
  yellow "Pod will be created in '$CTX'. Ctrl-C within 5s to abort."
  sleep 5
fi

if [[ -z "${ANTHROPIC_API_KEY:-}" && -z "${OPENAI_API_KEY:-}" ]]; then
  yellow "No ANTHROPIC_API_KEY or OPENAI_API_KEY exported; opencode will start"
  yellow "but any prompt requiring an LLM will fail. Continuing anyway."
fi

# --- Apply namespace & secrets ----------------------------------------------

kubectl get namespace "$NS" >/dev/null 2>&1 || kubectl create namespace "$NS"

# Basic-auth password: random if not provided.
SERVER_PASSWORD="${OPENCODE_SERVER_PASSWORD:-$(head -c 16 /dev/urandom | base64 | tr -d '=+/' | cut -c1-16)}"

kubectl -n "$NS" create secret generic opencode-smoke-auth \
  --from-literal=password="$SERVER_PASSWORD" \
  --dry-run=client -o yaml | kubectl apply -f -

# Build the LLM secret from whatever keys are in the environment.
LLM_SECRET_ARGS=()
[[ -n "${ANTHROPIC_API_KEY:-}" ]] && LLM_SECRET_ARGS+=(--from-literal=ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY")
[[ -n "${OPENAI_API_KEY:-}"    ]] && LLM_SECRET_ARGS+=(--from-literal=OPENAI_API_KEY="$OPENAI_API_KEY")
# The secret must exist even if empty so the optional secretKeyRefs resolve cleanly.
if [[ ${#LLM_SECRET_ARGS[@]} -eq 0 ]]; then
  LLM_SECRET_ARGS+=(--from-literal=PLACEHOLDER=unused)
fi
kubectl -n "$NS" create secret generic opencode-smoke-llm \
  "${LLM_SECRET_ARGS[@]}" \
  --dry-run=client -o yaml | kubectl apply -f -

# --- Apply pod/service (possibly with image override) ------------------------

if [[ "$IMAGE" != "percussionist/runner:dev" ]]; then
  yellow "Using custom image: $IMAGE"
  sed "s#image: percussionist/runner:dev#image: $IMAGE#" "$MANIFEST" | kubectl apply -f -
else
  kubectl apply -f "$MANIFEST"
fi

# --- Wait for readiness ------------------------------------------------------

bold "Waiting for pod $POD to be ready..."
if ! kubectl -n "$NS" wait --for=condition=Ready "pod/$POD" --timeout=120s; then
  red "Pod did not become ready. Recent logs:"
  kubectl -n "$NS" logs "$POD" --tail=50 || true
  kubectl -n "$NS" describe "pod/$POD" | tail -30 || true
  exit 1
fi

# --- Port-forward + attach instructions -------------------------------------

green "Pod is ready."
echo
bold "Starting port-forward: localhost:$LOCAL_PORT -> svc/$SVC:4096"
echo "(Ctrl-C here tears down the forward; the pod keeps running.)"
echo

# Detect a stale listener on LOCAL_PORT (e.g. a previous port-forward that
# was SIGKILL'd but left its socket hanging). kubectl will refuse to bind,
# but curl will happily talk to the dead socket and every request will 401.
if ss -tln 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${LOCAL_PORT}\$"; then
  red "Port $LOCAL_PORT is already in use on this host."
  red "Kill the owning process or set LOCAL_PORT=<free-port> and rerun."
  exit 1
fi

cat <<EOF
------------------------------------------------------------------------
In another terminal, attach to the running opencode server:

  export OPENCODE_SERVER_PASSWORD='$SERVER_PASSWORD'
  opencode attach http://localhost:$LOCAL_PORT

Or probe it manually:

  curl -u opencode:'$SERVER_PASSWORD' http://localhost:$LOCAL_PORT/global/health

Tear everything down with:

  $0 --down
------------------------------------------------------------------------
EOF

exec kubectl -n "$NS" port-forward "svc/$SVC" "$LOCAL_PORT:4096"
