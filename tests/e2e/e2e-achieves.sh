#!/usr/bin/env bash
# e2e-achieves.sh — End-to-end test: facilitator actually changes the outcome.
#
# Scenario:
#   1. A board task is assigned to e2e-stubborn-worker, which immediately calls
#      the fail_run MCP tool → OpenCodeRun.status.phase = Failed.
#   2. The manager detects the failure and spawns a facilitator run.
#   3. The facilitator (real LLM) analyzes the failure, sees e2e-capable-worker
#      as an available alternative, and outputs:
#        { "recommendedAction": "retry_alternative", "alternativeAgent": "e2e-capable-worker" }
#   4. The manager parses the result and dispatches a new run with e2e-capable-worker.
#   5. e2e-capable-worker outputs a success sentence → phase = Succeeded.
#   6. The test asserts the final worker run reached Succeeded. Exit 0 = pass.
#
# Prerequisites:
#   - Operator, manager, and dispatcher images built and loaded into minikube.
#     (The dispatcher image must include the MCP server — run `pnpm build` and
#      rebuild images before running this test.)
#   - At least a free LLM is reachable by opencode (used by the facilitator).
#     Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GITHUB_TOKEN if needed.
#
# Usage:
#   ./tests/e2e/e2e-achieves.sh            # run the test
#   ./tests/e2e/e2e-achieves.sh --down     # tear down all resources
#
# Environment variables:
#   MODEL       — LLM model string (default: empty, opencode picks its own)
#   LLM_SECRET  — K8s Secret name for provider keys (default: llm-keys)
#   ANTHROPIC_API_KEY, OPENAI_API_KEY, GITHUB_TOKEN — written into LLM_SECRET

set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

NS="percussionist-e2e-achieves"
OPERATOR_NS="percussionist"
PROJECT="e2e-achieves-test"
TASK_ID="t1"
TASK_LABEL="percussionist.dev/task-id"
LLM_SECRET="${LLM_SECRET:-llm-keys}"
MODEL="${MODEL:-}"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MANIFESTS="$REPO_ROOT/k8s/tests"

# ---------------------------------------------------------------------------
# Colours
# ---------------------------------------------------------------------------

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }

# Board state is stored in SQLite, not in CR status.board.
# Query the web API via kubectl exec.
board_json() {
  local project="${1:-$PROJECT}"
  kubectl exec -n "$OPERATOR_NS" deployment/percussionist-web -c web -- \
    wget -qO- "http://127.0.0.1:8080/api/board/${project}" 2>/dev/null || echo "{}"
}

# ---------------------------------------------------------------------------
# --down teardown
# ---------------------------------------------------------------------------

if [[ "${1:-}" == "--down" ]]; then
  yellow "Deleting namespace $NS..."
  kubectl delete namespace "$NS" --ignore-not-found --wait=true --timeout=60s
  yellow "Deleting ClusterAgents and project..."
  kubectl delete clusteragent e2e-stubborn-worker e2e-capable-worker facilitator --ignore-not-found 2>/dev/null || true
  kubectl delete opencodeproject e2e-achieves-test --ignore-not-found 2>/dev/null || true
  yellow "Restoring operator/manager PERCUSSIONIST_NAMESPACE to $OPERATOR_NS..."
  kubectl set env deployment/percussionist-operator -n "$OPERATOR_NS" \
    PERCUSSIONIST_NAMESPACE="$OPERATOR_NS" 2>/dev/null || true
  kubectl set env deployment/percussionist-manager  -n "$OPERATOR_NS" \
    PERCUSSIONIST_NAMESPACE="$OPERATOR_NS" 2>/dev/null || true
  green "Done."
  exit 0
fi

# ---------------------------------------------------------------------------
# Preflight
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
  yellow "WARNING: no LLM API key found. The facilitator run will start but LLM"
  yellow "calls may fail. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GITHUB_TOKEN"
  yellow "if a free model is not reachable by default."
fi

green "    Preflight OK"

# ---------------------------------------------------------------------------
# Step 1: Apply CRDs
# ---------------------------------------------------------------------------

bold "==> Step 1: Apply CRDs"
kubectl apply -f "$REPO_ROOT/k8s/crds/" --server-side 2>&1 | grep -v "^$" || true
green "    CRDs applied"

# ---------------------------------------------------------------------------
# Step 2: Deploy operator + manager
# ---------------------------------------------------------------------------

bold "==> Step 2: Deploy operator and manager"
kubectl apply -f "$REPO_ROOT/k8s/deploy/operator.yaml"
kubectl apply -f "$REPO_ROOT/k8s/deploy/manager-controller.yaml"
green "    Deployments applied"

# ---------------------------------------------------------------------------
# Step 3: Patch PERCUSSIONIST_NAMESPACE on both deployments
# ---------------------------------------------------------------------------

bold "==> Step 3: Patch PERCUSSIONIST_NAMESPACE=$NS on operator and manager"
kubectl set env deployment/percussionist-operator -n "$OPERATOR_NS" \
  PERCUSSIONIST_NAMESPACE="$NS"
kubectl set env deployment/percussionist-manager  -n "$OPERATOR_NS" \
  PERCUSSIONIST_NAMESPACE="$NS"
kubectl rollout status deployment/percussionist-operator -n "$OPERATOR_NS" --timeout=120s
kubectl rollout status deployment/percussionist-manager  -n "$OPERATOR_NS" --timeout=120s
green "    Operator and manager watching $NS"

# ---------------------------------------------------------------------------
# Step 4: Create namespace
# ---------------------------------------------------------------------------

bold "==> Step 4: Create namespace $NS"
kubectl get namespace "$NS" >/dev/null 2>&1 \
  || kubectl create namespace "$NS"
green "    Namespace $NS ready"

# ---------------------------------------------------------------------------
# Step 5: Dispatcher ServiceAccount + RBAC in e2e namespace
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
# Step 6: LLM secret
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
kubectl apply -f "$MANIFESTS/clusteragent-stubborn-worker.yaml"
kubectl apply -f "$MANIFESTS/clusteragent-capable-worker.yaml"
kubectl apply -f "$MANIFESTS/clusteragent-facilitator.yaml"
green "    ClusterAgents applied"

# ---------------------------------------------------------------------------
# Step 8: Apply OpenCodeProject
# ---------------------------------------------------------------------------

bold "==> Step 8: Apply OpenCodeProject $PROJECT"

MODEL_LINE=""
[[ -n "$MODEL" ]] && MODEL_LINE="  model: \"$MODEL\""

kubectl apply -f - <<EOF
apiVersion: percussionist.dev/v1alpha1
kind: OpenCodeProject
metadata:
  name: $PROJECT
  namespace: $NS
spec:
  displayName: "E2E Achieves Test"
${MODEL_LINE}
  secrets:
    llmKeysSecret: "$LLM_SECRET"
  board:
    phase: Active
    maxParallel: 1
    agents:
      - name: e2e-stubborn-worker
      - name: e2e-capable-worker
      - name: facilitator
    tasks:
      - id: t1
        title: "Analyze repository structure"
        agent: e2e-stubborn-worker
        description: >
          List the top-level files and directories in the /workspace directory.
          Output a brief summary of what you find.
EOF
green "    Project $PROJECT applied"

# ---------------------------------------------------------------------------
# Step 9: Wait for worker run to be spawned
# ---------------------------------------------------------------------------

bold "==> Step 9: Waiting for initial worker run (taskId=$TASK_ID) to be spawned..."

worker_run=""
deadline=$(( $(date +%s) + 120 ))
while true; do
  # Find a run for this task that is NOT a facilitation run (no spec.facilitation)
  mapfile -t candidates < <(kubectl get opencoderuns -n "$NS" \
    -l "$TASK_LABEL=$TASK_ID" \
    --no-headers -o custom-columns=NAME:.metadata.name 2>/dev/null \
    | grep -v '^$' || true)
  for c in "${candidates[@]}"; do
    fac="$(kubectl get opencoderuns "$c" -n "$NS" \
      -o jsonpath='{.spec.facilitation.targetRunName}' 2>/dev/null || true)"
    if [[ -z "$fac" ]]; then
      worker_run="$c"
      break
    fi
  done
  [[ -n "$worker_run" ]] && { green "    Initial worker run spawned: $worker_run"; break; }
  (( $(date +%s) >= deadline )) && { red "TIMEOUT: no worker run appeared after 120s"; exit 1; }
  printf '.'
  sleep 5
done

# ---------------------------------------------------------------------------
# Step 10: Wait for initial worker run to fail
# ---------------------------------------------------------------------------

bold "==> Step 10: Waiting for $worker_run to reach Failed..."
bold "    (stubborn worker calls fail_run tool → dispatcher marks Failed)"

deadline=$(( $(date +%s) + 180 ))
while true; do
  phase="$(kubectl get opencoderuns "$worker_run" -n "$NS" \
    -o jsonpath='{.status.phase}' 2>/dev/null || true)"
  msg="$(kubectl get opencoderuns "$worker_run" -n "$NS" \
    -o jsonpath='{.status.message}' 2>/dev/null || true)"
  if [[ "$phase" == "Failed" ]]; then
    green "    $worker_run is Failed"
    if [[ "$msg" == *"agent signalled failure"* ]]; then
      green "    Confirmed: failure triggered via fail_run MCP tool"
    else
      yellow "    NOTE: failure message does not mention fail_run: $msg"
      yellow "    (MCP tool may not have been called — check dispatcher logs)"
    fi
    break
  fi
  (( $(date +%s) >= deadline )) && {
    red "TIMEOUT: $worker_run did not reach Failed within 180s (phase=$phase)"
    kubectl describe opencoderuns "$worker_run" -n "$NS" 2>/dev/null | tail -20 || true
    exit 1
  }
  printf '.'
  sleep 5
done

# ---------------------------------------------------------------------------
# Step 11: Wait for facilitator run to be spawned
# ---------------------------------------------------------------------------

bold "==> Step 11: Waiting for facilitator run to be spawned..."

facilitator_run=""
deadline=$(( $(date +%s) + 180 ))
while true; do
  mapfile -t runs < <(kubectl get opencoderuns -n "$NS" \
    -l "$TASK_LABEL=$TASK_ID" \
    --no-headers -o custom-columns=NAME:.metadata.name 2>/dev/null \
    | grep -v '^$' || true)
  for run in "${runs[@]}"; do
    target="$(kubectl get opencoderuns "$run" -n "$NS" \
      -o jsonpath='{.spec.facilitation.targetRunName}' 2>/dev/null || true)"
    if [[ -n "$target" ]]; then facilitator_run="$run"; break; fi
  done
  [[ -n "$facilitator_run" ]] && { green "    Facilitator run spawned: $facilitator_run"; break; }
  (( $(date +%s) >= deadline )) && {
    red "TIMEOUT: no facilitator run appeared after 180s"
    kubectl get opencoderuns -n "$NS" -l "$TASK_LABEL=$TASK_ID" 2>/dev/null || true
    exit 1
  }
  printf '.'
  sleep 10
done

# ---------------------------------------------------------------------------
# Step 12: Wait for facilitator run to complete
# ---------------------------------------------------------------------------

bold "==> Step 12: Waiting for facilitator $facilitator_run to complete..."
bold "    (LLM must analyze failure and output retry_alternative JSON; up to 600s)"

deadline=$(( $(date +%s) + 600 ))
while true; do
  fac_phase="$(kubectl get opencoderuns "$facilitator_run" -n "$NS" \
    -o jsonpath='{.status.phase}' 2>/dev/null || true)"
  if [[ "$fac_phase" == "Succeeded" || "$fac_phase" == "Failed" ]]; then
    if [[ "$fac_phase" == "Succeeded" ]]; then
      green "    Facilitator run $facilitator_run completed: $fac_phase"
    else
      yellow "    Facilitator run $facilitator_run completed: $fac_phase"
      yellow "    (facilitator may still have produced parseable JSON — continuing)"
    fi
    break
  fi
  (( $(date +%s) >= deadline )) && {
    red "TIMEOUT: facilitator $facilitator_run did not complete within 600s (phase=$fac_phase)"
    exit 1
  }
  printf '.'
  sleep 10
done

# ---------------------------------------------------------------------------
# Step 13: Wait for alternative worker (e2e-capable-worker) to be spawned
# ---------------------------------------------------------------------------

bold "==> Step 13: Waiting for e2e-capable-worker run to be spawned..."
bold "    (manager must parse facilitator JSON and dispatch retry_alternative)"

alt_run=""
deadline=$(( $(date +%s) + 180 ))
while true; do
  mapfile -t runs < <(kubectl get opencoderuns -n "$NS" \
    -l "$TASK_LABEL=$TASK_ID" \
    --no-headers -o custom-columns=NAME:.metadata.name 2>/dev/null \
    | grep -v '^$' || true)
  for run in "${runs[@]}"; do
    agent="$(kubectl get opencoderuns "$run" -n "$NS" \
      -o jsonpath='{.spec.agent}' 2>/dev/null || true)"
    fac="$(kubectl get opencoderuns "$run" -n "$NS" \
      -o jsonpath='{.spec.facilitation.targetRunName}' 2>/dev/null || true)"
    if [[ "$agent" == "e2e-capable-worker" && -z "$fac" ]]; then
      alt_run="$run"
      break
    fi
  done
  [[ -n "$alt_run" ]] && { green "    Alternative worker spawned: $alt_run"; break; }
  (( $(date +%s) >= deadline )) && {
    red "TIMEOUT: no e2e-capable-worker run appeared after 180s"
    red "Board status:"
    board_json "$PROJECT" | python3 -m json.tool 2>/dev/null || true
    exit 1
  }
  printf '.'
  sleep 10
done

# ---------------------------------------------------------------------------
# Step 14: Wait for alternative worker to succeed
# ---------------------------------------------------------------------------

bold "==> Step 14: Waiting for $alt_run (e2e-capable-worker) to reach Succeeded..."

deadline=$(( $(date +%s) + 300 ))
while true; do
  alt_phase="$(kubectl get opencoderuns "$alt_run" -n "$NS" \
    -o jsonpath='{.status.phase}' 2>/dev/null || true)"
  if [[ "$alt_phase" == "Succeeded" ]]; then
    green "    $alt_run reached Succeeded"
    break
  fi
  if [[ "$alt_phase" == "Failed" ]]; then
    red "FAIL: $alt_run (e2e-capable-worker) reached Failed"
    red "      Capable worker should not fail — check agent system prompt and MCP config"
    kubectl logs "$alt_run" -n "$NS" -c dispatcher --tail=30 2>/dev/null || true
    exit 1
  fi
  (( $(date +%s) >= deadline )) && {
    red "TIMEOUT: $alt_run did not reach Succeeded within 300s (phase=$alt_phase)"
    exit 1
  }
  printf '.'
  sleep 10
done

# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------

echo
bold "================================================================"
green "PASS: facilitator redirected the task to e2e-capable-worker, which succeeded."
bold "================================================================"
echo

bold "All runs for task $TASK_ID:"
kubectl get opencoderuns -n "$NS" \
  -l "$TASK_LABEL=$TASK_ID" \
  -o custom-columns=\
NAME:.metadata.name,\
PHASE:.status.phase,\
AGENT:.spec.agent,\
FACILITATION:.spec.facilitation.targetRunName \
  2>/dev/null || true

echo
bold "Board status (workers + facilitation result):"
board_json "$PROJECT" | python3 -m json.tool 2>/dev/null || true

echo
yellow "Tear down with:  $0 --down"
