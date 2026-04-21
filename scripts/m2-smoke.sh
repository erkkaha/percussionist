#!/usr/bin/env bash
# M2 smoke test: install CRD + operator, submit a sample OpenCodeRun, wait
# for it to reach a terminal phase, print status.
#
# Prerequisites:
#   - minikube running, kubectl pointed at it
#   - Images loaded (see scripts/minikube-load.sh)
#   - ANTHROPIC_API_KEY exported (or edit examples/hello-run.yaml to use another provider)

set -euo pipefail

NS="percussionist"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }

if [[ "${1:-}" == "--down" ]]; then
  yellow "Deleting OpenCodeRun/hello and namespace $NS..."
  kubectl -n "$NS" delete opencoderun hello --ignore-not-found --wait=false
  kubectl delete -f "$REPO_ROOT/deploy/operator.yaml" --ignore-not-found --wait=false
  kubectl delete -f "$REPO_ROOT/crds/opencoderun.yaml" --ignore-not-found --wait=false
  exit 0
fi

command -v kubectl >/dev/null || { red "kubectl not found"; exit 1; }

CTX="$(kubectl config current-context 2>/dev/null || echo none)"
bold "Context: $CTX"
if [[ "$CTX" != *minikube* && "$CTX" != *k3s* && "$CTX" != *kind* && "$CTX" != *docker-desktop* ]]; then
  yellow "WARNING: non-local context. Ctrl-C within 5s to abort."
  sleep 5
fi

# --- 1. CRD ------------------------------------------------------------------
bold "Installing CRD"
kubectl apply -f "$REPO_ROOT/crds/opencoderun.yaml"
kubectl wait --for=condition=Established crd/opencoderuns.percussionist.dev --timeout=30s

# --- 2. Operator + RBAC ------------------------------------------------------
bold "Deploying operator"
kubectl apply -f "$REPO_ROOT/deploy/operator.yaml"
kubectl -n "$NS" rollout status deploy/percussionist-operator --timeout=90s

# --- 3. LLM secret from env --------------------------------------------------
LLM_ARGS=()
[[ -n "${ANTHROPIC_API_KEY:-}" ]] && LLM_ARGS+=(--from-literal=ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY")
[[ -n "${OPENAI_API_KEY:-}"    ]] && LLM_ARGS+=(--from-literal=OPENAI_API_KEY="$OPENAI_API_KEY")
if [[ ${#LLM_ARGS[@]} -eq 0 ]]; then
  yellow "No provider keys in env (ANTHROPIC_API_KEY, OPENAI_API_KEY)."
  yellow "The sample run will fail when the agent tries to call the LLM."
  LLM_ARGS+=(--from-literal=PLACEHOLDER=unused)
fi
kubectl -n "$NS" create secret generic llm-keys "${LLM_ARGS[@]}" \
  --dry-run=client -o yaml | kubectl apply -f -

# --- 4. Sample OpenCodeRun ---------------------------------------------------
bold "Applying sample OpenCodeRun 'hello'"
kubectl apply -f "$REPO_ROOT/examples/hello-run.yaml"

# --- 5. Wait for terminal phase ---------------------------------------------
bold "Waiting for phase in {Succeeded, Failed} (max 5min)..."
DEADLINE=$(( $(date +%s) + 300 ))
while true; do
  PHASE=$(kubectl -n "$NS" get opencoderun hello -o jsonpath='{.status.phase}' 2>/dev/null || true)
  printf '\r  phase=%-14s ' "${PHASE:-<pending>}"
  case "$PHASE" in
    Succeeded|Failed|Cancelled) echo; break ;;
  esac
  if [[ $(date +%s) -ge $DEADLINE ]]; then
    echo; red "Timed out waiting for terminal phase."; break
  fi
  sleep 3
done

# --- 6. Summary --------------------------------------------------------------
echo
bold "Final CR status:"
kubectl -n "$NS" get opencoderun hello -o yaml | sed -n '/^status:/,$p' || true

echo
bold "Dispatcher logs (last 40 lines):"
kubectl -n "$NS" logs pod/hello -c dispatcher --tail=40 2>&1 || true

cat <<EOF

------------------------------------------------------------------------
Inspect further:
  kubectl -n $NS get opencoderun
  kubectl -n $NS describe opencoderun hello
  kubectl -n $NS logs pod/hello -c opencode
  kubectl -n $NS logs pod/hello -c dispatcher
  kubectl -n $NS logs deploy/percussionist-operator

Tear down:
  $0 --down
------------------------------------------------------------------------
EOF