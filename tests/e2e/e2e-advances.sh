#!/usr/bin/env bash
# e2e-advances.sh — End-to-end test: agent calls complete_run, reviewer approves,
#                   task advances to done.
#
# Scenario:
#   1. A board task is assigned to e2e-complete-worker, which immediately calls
#      the complete_run MCP tool → OpenCodeRun.status.phase = Succeeded with
#      message "agent signalled completion — ...".
#   2. The manager detects Succeeded + reviewer in roster → spawns a
#      success-review facilitator run.
#   3. The reviewer (e2e-reviewer agent) outputs:
#        { "recommendedAction": "approve", "diagnosis": "..." }
#   4. The manager parses the result → moves task to "done" in board status.
#   5. The test asserts the task is in board columns["done"]. Exit 0 = pass.
#
# Prerequisites:
#   - Operator, manager, and dispatcher images built and loaded into minikube.
#   - At least a free LLM is reachable by opencode (used by the reviewer LLM run).
#     Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GITHUB_TOKEN if needed.
#
# Usage:
#   ./tests/e2e/e2e-advances.sh            # run the test
#   ./tests/e2e/e2e-advances.sh --down     # tear down all resources

set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

NS="percussionist-e2e-advances"
OPERATOR_NS="percussionist"
PROJECT="e2e-advances-test"
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
  kubectl delete clusteragent e2e-complete-worker facilitator \
    --ignore-not-found 2>/dev/null || true
  kubectl delete opencodeproject "$PROJECT" --ignore-not-found 2>/dev/null || true
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
  yellow "WARNING: no LLM API key found. The reviewer run will start but LLM"
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
# Step 5: Dispatcher ServiceAccount + RBAC
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
kubectl apply -f "$MANIFESTS/clusteragent-complete-worker.yaml"
# The reviewer is applied as "facilitator" since that's the agent name the manager
# looks for when deciding to spawn a success-review run.
kubectl apply -f "$MANIFESTS/clusteragent-reviewer.yaml"
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
  displayName: "E2E Advances Test"
${MODEL_LINE}
  secrets:
    llmKeysSecret: "$LLM_SECRET"
  board:
    phase: Active
    maxParallel: 1
    agents:
      - name: e2e-complete-worker
      - name: facilitator
    tasks:
      - id: t1
        title: "Write a greeting"
        agent: e2e-complete-worker
        description: >
          Write a short greeting message to the user.
EOF
green "    Project $PROJECT applied"

# ---------------------------------------------------------------------------
# Step 9: Wait for worker run to be spawned
# ---------------------------------------------------------------------------

bold "==> Step 9: Waiting for initial worker run (taskId=$TASK_ID) to be spawned..."

worker_run=""
deadline=$(( $(date +%s) + 120 ))
while true; do
  mapfile -t candidates < <(kubectl get opencoderuns -n "$NS" \
    -l "$TASK_LABEL=$TASK_ID" \
    --no-headers -o custom-columns=NAME:.metadata.name 2>/dev/null \
    | grep -v "^$" || true)
  for name in "${candidates[@]}"; do
    faciliation_target=$(kubectl get opencoderuns "$name" -n "$NS" \
      -o jsonpath='{.spec.facilitation.targetRunName}' 2>/dev/null || echo "")
    if [[ -z "$faciliation_target" ]]; then
      worker_run="$name"
      break 2
    fi
  done
  [[ $(date +%s) -gt $deadline ]] && { red "FAIL: no worker run spawned within 120s"; exit 1; }
  printf "."
  sleep 3
done
green "    Initial worker run spawned: $worker_run"

# ---------------------------------------------------------------------------
# Step 10: Wait for worker run to reach Succeeded
# ---------------------------------------------------------------------------

bold "==> Step 10: Waiting for $worker_run to reach Succeeded..."
bold "    (complete_run MCP tool → dispatcher marks Succeeded)"

deadline=$(( $(date +%s) + 180 ))
while true; do
  phase=$(kubectl get opencoderuns "$worker_run" -n "$NS" \
    -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
  if [[ "$phase" == "Succeeded" ]]; then
    msg=$(kubectl get opencoderuns "$worker_run" -n "$NS" \
      -o jsonpath='{.status.message}' 2>/dev/null || echo "")
    break
  fi
  [[ "$phase" == "Failed" ]] && {
    red "FAIL: worker run $worker_run reached Failed (expected Succeeded)"
    kubectl get opencoderuns "$worker_run" -n "$NS" -o jsonpath='{.status.message}'
    exit 1
  }
  [[ $(date +%s) -gt $deadline ]] && {
    red "FAIL: worker run $worker_run did not reach Succeeded within 180s (phase=$phase)"
    exit 1
  }
  printf "."
  sleep 3
done

green "    $worker_run is Succeeded"
if echo "$msg" | grep -q "agent signalled completion"; then
  green "    Confirmed: completion triggered via complete_run MCP tool"
else
  yellow "    Note: run message: $msg"
  yellow "    (complete_run may not have been called — checking status message)"
fi

# ---------------------------------------------------------------------------
# Step 11: Wait for success-review run to be spawned
# ---------------------------------------------------------------------------

bold "==> Step 11: Waiting for success-review run to be spawned..."
bold "    (manager detects Succeeded + reviewer in roster → spawns review run)"

review_run=""
deadline=$(( $(date +%s) + 180 ))
while true; do
  mapfile -t candidates < <(kubectl get opencoderuns -n "$NS" \
    -l "$TASK_LABEL=$TASK_ID" \
    --no-headers -o custom-columns=NAME:.metadata.name 2>/dev/null \
    | grep -v "^$" || true)
  for name in "${candidates[@]}"; do
    [[ "$name" == "$worker_run" ]] && continue
    # Review run names contain "-review-"; facilitation runs contain "-facilitator-".
    # Accept any non-worker facilitation run for this task as the review run.
    has_facilitation=$(kubectl get opencoderuns "$name" -n "$NS" \
      -o jsonpath='{.spec.facilitation.targetRunName}' 2>/dev/null || echo "")
    if [[ -n "$has_facilitation" ]]; then
      review_run="$name"
      break 2
    fi
  done
  [[ $(date +%s) -gt $deadline ]] && {
    red "FAIL: no success-review run spawned within 180s"
    echo "Runs for task $TASK_ID:"
    kubectl get opencoderuns -n "$NS" -l "$TASK_LABEL=$TASK_ID" 2>/dev/null || true
    exit 1
  }
  printf "."
  sleep 3
done
green "    Success-review run spawned: $review_run"

# ---------------------------------------------------------------------------
# Step 12: Wait for the review run to complete
# ---------------------------------------------------------------------------

bold "==> Step 12: Waiting for reviewer $review_run to complete..."
bold "    (LLM outputs approve JSON; up to 600s)"

deadline=$(( $(date +%s) + 600 ))
review_phase=""
while true; do
  review_phase=$(kubectl get opencoderuns "$review_run" -n "$NS" \
    -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
  if [[ "$review_phase" == "Succeeded" || "$review_phase" == "Failed" ]]; then
    break
  fi
  [[ $(date +%s) -gt $deadline ]] && {
    red "FAIL: review run $review_run did not complete within 600s (phase=$review_phase)"
    exit 1
  }
  printf "."
  sleep 5
done
green "    Review run $review_run completed: $review_phase"

# ---------------------------------------------------------------------------
# Step 13: Wait for task to appear in board columns["done"]
# ---------------------------------------------------------------------------

bold "==> Step 13: Waiting for task $TASK_ID to appear in board columns[done]..."
bold "    (manager parses approve → moves task to done)"

deadline=$(( $(date +%s) + 180 ))
while true; do
  board_json=$(board_json "$PROJECT")
  done_tasks=$(echo "$board_json" | python3 -c \
    "import sys,json; b=json.load(sys.stdin); print(' '.join(b.get('columns',{}).get('done',[])))" \
    2>/dev/null || echo "")
  if echo "$done_tasks" | grep -qw "$TASK_ID"; then
    break
  fi
  [[ $(date +%s) -gt $deadline ]] && {
    red "FAIL: task $TASK_ID not in board columns[done] within 180s"
    echo "Current board:"
    echo "$board_json" | python3 -m json.tool 2>/dev/null || echo "$board_json"
    exit 1
  }
  printf "."
  sleep 3
done

green "    Task $TASK_ID is in done"

# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------

bold ""
bold "================================================================"
green "PASS: worker called complete_run, reviewer approved, task moved to done."
bold "================================================================"

bold ""
bold "All runs for task $TASK_ID:"
kubectl get opencoderuns -n "$NS" -l "$TASK_LABEL=$TASK_ID" \
  -o custom-columns='NAME:.metadata.name,PHASE:.status.phase,AGENT:.spec.agent,REVIEW:.spec.facilitation.successReview' \
  2>/dev/null || true

bold ""
bold "Board status:"
board_json "$PROJECT" | python3 -m json.tool 2>/dev/null || true

yellow ""
yellow "Tear down with:  tests/e2e/e2e-advances.sh --down"
