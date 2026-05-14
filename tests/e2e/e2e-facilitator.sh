#!/usr/bin/env bash
# e2e-facilitator.sh — End-to-end test: board task → failure → facilitator spawned.
#
# What this script does:
#   1. Deploys the operator and manager-controller into the percussionist namespace,
#      patched to watch percussionist-e2e.
#   2. Creates the percussionist-e2e namespace with required RBAC and an LLM secret.
#   3. Applies two ClusterAgents (e2e-failing-worker, facilitator) and an
#      OpenCodeProject with one board task that is guaranteed to time out.
#   4. Waits for the worker OpenCodeRun to be spawned, then to fail.
#   5. Waits for the manager to spawn a facilitator OpenCodeRun.
#   6. Prints the facilitator run details and the board status. Exits 0.
#
# Usage:
#   ./tests/e2e/e2e-facilitator.sh            # run the test
#   ./tests/e2e/e2e-facilitator.sh --down     # tear down all resources
#
# Environment variables:
#   MODEL       — LLM model string passed to the project (default: empty, let
#                 opencode pick from its own config)
#   LLM_SECRET  — name of the K8s Secret containing provider API keys
#                 (default: llm-keys)
#   ANTHROPIC_API_KEY, OPENAI_API_KEY, GITHUB_TOKEN — written into LLM_SECRET

set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

NS="percussionist-e2e"
OPERATOR_NS="percussionist"
PROJECT="e2e-facilitator-test"
TASK_ID="t1"
TASK_LABEL="percussionist.dev/task-id"
LLM_SECRET="${LLM_SECRET:-llm-keys}"
MODEL="${MODEL:-}"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MANIFESTS="$(dirname "$0")/manifests"

# ---------------------------------------------------------------------------
# Colours
# ---------------------------------------------------------------------------

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }

# ---------------------------------------------------------------------------
# --down: tear everything down
# ---------------------------------------------------------------------------

if [[ "${1:-}" == "--down" ]]; then
  yellow "Deleting namespace $NS..."
  kubectl delete namespace "$NS" --ignore-not-found --wait=false
  yellow "Restoring operator/manager PERCUSSIONIST_NAMESPACE to $OPERATOR_NS..."
  kubectl set env deployment/percussionist-operator  -n "$OPERATOR_NS" \
    PERCUSSIONIST_NAMESPACE="$OPERATOR_NS" 2>/dev/null || true
  kubectl set env deployment/percussionist-manager   -n "$OPERATOR_NS" \
    PERCUSSIONIST_NAMESPACE="$OPERATOR_NS" 2>/dev/null || true
  green "Done."
  exit 0
fi

# ---------------------------------------------------------------------------
# Preflight checks
# ---------------------------------------------------------------------------

bold "==> Preflight checks"

command -v kubectl >/dev/null 2>&1 || { red "kubectl not found in PATH"; exit 1; }

CTX="$(kubectl config current-context 2>/dev/null || echo none)"
bold "    kubectl context: $CTX"
if [[ "$CTX" != *k3s* && "$CTX" != *kind* && "$CTX" != *docker-desktop* \
   && "$CTX" != *homelab* && "$CTX" != *minikube* && "$CTX" != *rancher* ]]; then
  yellow "WARNING: context does not look like a local/homelab cluster ($CTX)."
  yellow "Resources will be created there. Ctrl-C within 5s to abort."
  sleep 5
fi

if [[ -z "${ANTHROPIC_API_KEY:-}" && -z "${OPENAI_API_KEY:-}" && -z "${GITHUB_TOKEN:-}" ]]; then
  yellow "WARNING: no ANTHROPIC_API_KEY, OPENAI_API_KEY, or GITHUB_TOKEN found."
  yellow "The worker and facilitator runs will start but LLM calls will fail."
  yellow "The worker will still time out and the facilitator will still be spawned."
fi

green "    Preflight OK"

# ---------------------------------------------------------------------------
# Helper: wait_for <description> <timeout_s> <interval_s> <command...>
#   Runs <command> repeatedly until it exits 0 or timeout is reached.
#   The command's stdout is captured; on success the last stdout is echoed.
# ---------------------------------------------------------------------------

wait_for() {
  local desc="$1"
  local timeout_s="$2"
  local interval_s="$3"
  shift 3
  local deadline=$(( $(date +%s) + timeout_s ))
  bold "==> Waiting: $desc (timeout ${timeout_s}s)"
  while true; do
    local out
    if out="$("$@" 2>/dev/null)"; then
      green "    OK: $out"
      echo "$out"
      return 0
    fi
    if (( $(date +%s) >= deadline )); then
      red "TIMEOUT waiting for: $desc"
      return 1
    fi
    printf '.'
    sleep "$interval_s"
  done
}

# ---------------------------------------------------------------------------
# Step 1: Apply CRDs
# ---------------------------------------------------------------------------

bold "==> Step 1: Apply CRDs"
kubectl apply -f "$REPO_ROOT/crds/" --server-side 2>&1 | grep -v "^$" || true
green "    CRDs applied"

# ---------------------------------------------------------------------------
# Step 2: Deploy operator + manager into percussionist namespace
# ---------------------------------------------------------------------------

bold "==> Step 2: Deploy operator and manager"
kubectl apply -f "$REPO_ROOT/deploy/operator.yaml"
kubectl apply -f "$REPO_ROOT/deploy/manager-controller.yaml"
green "    Deployments applied"

# ---------------------------------------------------------------------------
# Step 3: Patch PERCUSSIONIST_NAMESPACE on both deployments to watch e2e ns
# ---------------------------------------------------------------------------

bold "==> Step 3: Patch PERCUSSIONIST_NAMESPACE=$NS on operator and manager"
kubectl set env deployment/percussionist-operator -n "$OPERATOR_NS" \
  PERCUSSIONIST_NAMESPACE="$NS"
kubectl set env deployment/percussionist-manager  -n "$OPERATOR_NS" \
  PERCUSSIONIST_NAMESPACE="$NS"

# Wait for rollout so they are watching the right namespace before we create resources.
kubectl rollout status deployment/percussionist-operator -n "$OPERATOR_NS" --timeout=120s
kubectl rollout status deployment/percussionist-manager  -n "$OPERATOR_NS" --timeout=120s
green "    Operator and manager watching $NS"

# ---------------------------------------------------------------------------
# Step 4: Create e2e namespace
# ---------------------------------------------------------------------------

bold "==> Step 4: Create namespace $NS"
kubectl get namespace "$NS" >/dev/null 2>&1 \
  || kubectl create namespace "$NS"
green "    Namespace $NS ready"

# ---------------------------------------------------------------------------
# Step 5: Dispatcher RBAC in e2e namespace
#   The Role+RoleBinding in deploy/operator.yaml are hardcoded to the
#   percussionist namespace. Replicate them into percussionist-e2e so the
#   dispatcher sidecar can patch OpenCodeRun status there.
# ---------------------------------------------------------------------------

bold "==> Step 5: Create dispatcher ServiceAccount + RBAC in $NS"
kubectl apply -f - <<EOF
apiVersion: v1
kind: ServiceAccount
metadata:
  name: percussionist-dispatcher
  namespace: $NS
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: percussionist-dispatcher
  namespace: $NS
rules:
  - apiGroups: ["percussionist.dev"]
    resources: ["opencoderuns"]
    verbs: ["get", "list"]
  - apiGroups: ["percussionist.dev"]
    resources: ["opencoderuns/status"]
    verbs: ["get", "update", "patch"]
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["create", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: percussionist-dispatcher
  namespace: $NS
subjects:
  - kind: ServiceAccount
    name: percussionist-dispatcher
    namespace: $NS
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: percussionist-dispatcher
EOF
green "    Dispatcher ServiceAccount + RBAC ready in $NS"

# ---------------------------------------------------------------------------
# Step 6: LLM keys secret
# ---------------------------------------------------------------------------

bold "==> Step 6: Create LLM secret $LLM_SECRET in $NS"
SECRET_ARGS=()
[[ -n "${ANTHROPIC_API_KEY:-}" ]] && SECRET_ARGS+=(--from-literal=ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY")
[[ -n "${OPENAI_API_KEY:-}"    ]] && SECRET_ARGS+=(--from-literal=OPENAI_API_KEY="$OPENAI_API_KEY")
[[ -n "${GITHUB_TOKEN:-}"      ]] && SECRET_ARGS+=(--from-literal=GITHUB_TOKEN="$GITHUB_TOKEN")
if [[ ${#SECRET_ARGS[@]} -eq 0 ]]; then
  SECRET_ARGS+=(--from-literal=PLACEHOLDER=unused)
fi
kubectl -n "$NS" create secret generic "$LLM_SECRET" \
  "${SECRET_ARGS[@]}" \
  --dry-run=client -o yaml | kubectl apply -f -
green "    Secret $LLM_SECRET ready"

# ---------------------------------------------------------------------------
# Step 7: Apply ClusterAgents
# ---------------------------------------------------------------------------

bold "==> Step 7: Apply ClusterAgents"
kubectl apply -f "$MANIFESTS/clusteragent-failing-worker.yaml"
kubectl apply -f "$MANIFESTS/clusteragent-facilitator.yaml"
green "    ClusterAgents applied"

# ---------------------------------------------------------------------------
# Step 8: Apply OpenCodeProject (generate YAML inline; omit model if unset)
# ---------------------------------------------------------------------------

bold "==> Step 8: Apply OpenCodeProject $PROJECT"

MODEL_LINE=""
if [[ -n "$MODEL" ]]; then
  MODEL_LINE="  model: \"$MODEL\""
fi

kubectl apply -f - <<EOF
apiVersion: percussionist.dev/v1alpha1
kind: OpenCodeProject
metadata:
  name: $PROJECT
  namespace: $NS
spec:
  displayName: "E2E Facilitator Test"
${MODEL_LINE}
  secrets:
    llmKeysSecret: "$LLM_SECRET"
  source:
    git:
      # Intentionally invalid URL — git-clone init container will fail, causing
      # the operator to set OpenCodeRun.status.phase = Failed deterministically.
      url: https://git.invalid/e2e-nonexistent-repo.git
  board:
    phase: Active
    maxParallel: 1
    agents:
      - name: e2e-failing-worker
      - name: facilitator
    overrides:
      timeoutSeconds: 120
    tasks:
      - id: t1
        title: "Fail intentionally"
        agent: e2e-failing-worker
        description: >
          This task is intentionally designed to time out and fail so that the
          facilitator agent is triggered to investigate.
EOF
green "    Project $PROJECT applied"

# ---------------------------------------------------------------------------
# Step 9: Wait for worker OpenCodeRun to be spawned
# ---------------------------------------------------------------------------

bold "==> Step 9: Waiting for worker run (taskId=$TASK_ID) to be spawned..."

worker_run=""
deadline=$(( $(date +%s) + 120 ))
while true; do
  worker_run="$(kubectl get opencoderuns -n "$NS" \
    -l "$TASK_LABEL=$TASK_ID" \
    --no-headers -o custom-columns=NAME:.metadata.name 2>/dev/null \
    | grep -v '^$' | head -1 || true)"
  if [[ -n "$worker_run" ]]; then
    green "    Worker run spawned: $worker_run"
    break
  fi
  if (( $(date +%s) >= deadline )); then
    red "TIMEOUT: no worker run appeared for taskId=$TASK_ID after 120s"
    red "Board status:"
    kubectl get opencodeproject "$PROJECT" -n "$NS" \
      -o jsonpath='{.status.board}' 2>/dev/null | python3 -m json.tool 2>/dev/null || true
    exit 1
  fi
  printf '.'
  sleep 5
done

# ---------------------------------------------------------------------------
# Step 10: Wait for worker run to reach Failed phase
# ---------------------------------------------------------------------------

bold "==> Step 10: Waiting for worker run $worker_run to fail..."
bold "    (git-clone init container will fail on invalid URL; allowing up to 300s)"

deadline=$(( $(date +%s) + 300 ))
while true; do
  phase="$(kubectl get opencoderuns "$worker_run" -n "$NS" \
    -o jsonpath='{.status.phase}' 2>/dev/null || true)"
  if [[ "$phase" == "Failed" ]]; then
    green "    Worker run $worker_run is Failed"
    break
  fi
  if (( $(date +%s) >= deadline )); then
    red "TIMEOUT: worker run $worker_run did not reach Failed within 300s (phase=$phase)"
    kubectl describe opencoderuns "$worker_run" -n "$NS" 2>/dev/null | tail -20 || true
    exit 1
  fi
  printf '.'
  sleep 10
done

# ---------------------------------------------------------------------------
# Step 11: Wait for facilitator run to be spawned
#   The manager reconciles on a 30s periodic resync. Allow up to 180s.
#   A facilitator run has .spec.facilitation set (non-empty object).
# ---------------------------------------------------------------------------

bold "==> Step 11: Waiting for facilitator run to be spawned (manager resync up to 30s)..."

facilitator_run=""
deadline=$(( $(date +%s) + 180 ))
while true; do
  # List all runs for this task; find one that has spec.facilitation.targetRunName set.
  mapfile -t runs < <(kubectl get opencoderuns -n "$NS" \
    -l "$TASK_LABEL=$TASK_ID" \
    --no-headers -o custom-columns=NAME:.metadata.name 2>/dev/null \
    | grep -v '^$' || true)

  for run in "${runs[@]}"; do
    target="$(kubectl get opencoderuns "$run" -n "$NS" \
      -o jsonpath='{.spec.facilitation.targetRunName}' 2>/dev/null || true)"
    if [[ -n "$target" ]]; then
      facilitator_run="$run"
      break
    fi
  done

  if [[ -n "$facilitator_run" ]]; then
    green "    Facilitator run spawned: $facilitator_run"
    break
  fi

  if (( $(date +%s) >= deadline )); then
    red "TIMEOUT: no facilitator run appeared for taskId=$TASK_ID after 180s"
    red "All runs for this task:"
    kubectl get opencoderuns -n "$NS" \
      -l "$TASK_LABEL=$TASK_ID" 2>/dev/null || true
    red "Board status:"
    kubectl get opencodeproject "$PROJECT" -n "$NS" \
      -o jsonpath='{.status.board}' 2>/dev/null | python3 -m json.tool 2>/dev/null || true
    exit 1
  fi
  printf '.'
  sleep 10
done

# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------

echo
bold "================================================================"
green "SUCCESS: facilitator run was spawned."
bold "================================================================"
echo

bold "Facilitator run:"
kubectl get opencoderuns "$facilitator_run" -n "$NS" \
  -o custom-columns=\
NAME:.metadata.name,\
PHASE:.status.phase,\
STARTED:.status.startedAt,\
TARGET:.spec.facilitation.targetRunName \
  2>/dev/null || true

echo
bold "Board status (${PROJECT}):"
kubectl get opencodeproject "$PROJECT" -n "$NS" \
  -o jsonpath='{.status.board}' 2>/dev/null \
  | python3 -m json.tool 2>/dev/null \
  || kubectl get opencodeproject "$PROJECT" -n "$NS" \
       -o jsonpath='{.status.board}' 2>/dev/null \
  || true

echo
bold "All runs for task $TASK_ID:"
kubectl get opencoderuns -n "$NS" \
  -l "$TASK_LABEL=$TASK_ID" \
  -o wide 2>/dev/null || true

echo
yellow "Tear down with:  $0 --down"
