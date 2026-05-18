#!/usr/bin/env bash
# Build the percussionist images and load them into the minikube node.
#
# Builds five images:
#   percussionist/runner:dev       (opencode + git + ssh; used by every run pod)
#   percussionist/operator:dev     (CRD reconciler Deployment)
#   percussionist/dispatcher:dev   (sidecar that drives each run)
#   percussionist/web:dev          (web dashboard)
#   percussionist/manager:dev      (kanban board manager controller)
#
# minikube cannot pull these from a registry (tags aren't pushed), so we build
# on the host and use `minikube image load` to copy them into the node.
#
# Usage:
#   ./scripts/minikube-load.sh                       # build all + load
#   ./scripts/minikube-load.sh --no-build            # load existing local images
#   ./scripts/minikube-load.sh --only runner         # build+load just one
#   ./scripts/minikube-load.sh --no-build --only operator
#   ./scripts/minikube-load.sh --force               # no-cache build +
#                                                    # auto-evict pods pinning
#                                                    # the old image
#
# --force is the "I know what I'm doing, just make it fresh" switch:
#   * docker build with --no-cache (so workspace symlink + pnpm install in the
#     Dockerfile actually pick up package changes)
#   * if the operator image changed: scale deploy/percussionist-operator to 0
#     until the image is loaded, then back to 1
#   * if the runner/dispatcher image changed and any OpenCodeRun pods are
#     pinning the old ID: delete those OpenCodeRun CRs (cascades to pods).
#     The script prints what it's about to delete and asks for confirmation
#     unless --yes is also passed.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD=true
ONLY=""
FORCE=false
YES=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build) BUILD=false; shift ;;
    --only)     ONLY="${2:-}"; shift 2 ;;
    --force)    FORCE=true; shift ;;
    --yes|-y)   YES=true; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

command -v minikube >/dev/null || { echo "minikube not found in PATH" >&2; exit 1; }
command -v docker   >/dev/null || { echo "docker not found in PATH"  >&2; exit 1; }
command -v kubectl  >/dev/null || { echo "kubectl not found in PATH" >&2; exit 1; }

if ! minikube status >/dev/null 2>&1; then
  echo "minikube is not running. Start it first: minikube start" >&2
  exit 1
fi

build_one() {
  local name="$1"; local tag="$2"
  local extra=()
  if $FORCE; then extra+=(--no-cache); fi
  case "$name" in
    runner)
      docker build "${extra[@]}" -t "$tag" "$REPO_ROOT/images/runner"
      ;;
    operator)
      docker build "${extra[@]}" -t "$tag" --build-arg PKG=operator \
        -f "$REPO_ROOT/images/node/Dockerfile" "$REPO_ROOT"
      ;;
    dispatcher)
      docker build "${extra[@]}" -t "$tag" --build-arg PKG=dispatcher \
        -f "$REPO_ROOT/images/node/Dockerfile" "$REPO_ROOT"
      ;;
    web)
      local web_version
      web_version="$(node -p "require('$REPO_ROOT/packages/web/package.json').version")"
      docker build "${extra[@]}" -t "$tag" \
        --build-arg VERSION="$web_version" \
        -f "$REPO_ROOT/images/web/Dockerfile" "$REPO_ROOT"
      ;;
    manager)
      docker build "${extra[@]}" -t "$tag" --build-arg PKG=manager-controller \
        -f "$REPO_ROOT/images/node/Dockerfile" "$REPO_ROOT"
      ;;
    *) echo "unknown image: $name" >&2; return 1 ;;
  esac
}

# Return the short (12-char) image ID of $tag on the host, or empty.
host_image_id() {
  local tag="$1"
  docker image inspect --format '{{.Id}}' "$tag" 2>/dev/null \
    | cut -d: -f2 | cut -c1-12 || true
}

# Return the short image ID of $tag inside minikube, or empty. Parses
# `minikube image ls --format table` (box-drawing separators).
minikube_image_id() {
  local tag="$1" short_tag
  short_tag="${tag%:*}"
  minikube image ls --format table 2>/dev/null \
    | awk -F'│' -v t="$short_tag" '$2 ~ t {gsub(/ /,"",$4); print $4}' \
    | head -n1 | cut -c1-12 || true
}

confirm() {
  local prompt="$1"
  if $YES; then return 0; fi
  read -r -p "$prompt [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]]
}

# List Runs whose pods are still running in the cluster. For the
# runner/dispatcher images we delete the CR (the operator + k8s GC handle
# the rest). For the operator image we scale the Deployment.
list_runs_with_pods() {
  kubectl get runs.percussionist.dev -A -o json 2>/dev/null \
    | jq -r '.items[] | select(.status.podName != null) |
             "\(.metadata.namespace)/\(.metadata.name)"' 2>/dev/null \
    || true
}

# Evict anything that might be pinning the old image for $name.
evict_for() {
  local name="$1"
  case "$name" in
    operator)
      if kubectl -n percussionist get deploy percussionist-operator >/dev/null 2>&1; then
        echo ">> --force: scaling deploy/percussionist-operator to 0"
        kubectl -n percussionist scale deploy/percussionist-operator --replicas=0
        kubectl -n percussionist wait --for=delete pod \
          -l app.kubernetes.io/component=operator \
          --timeout=60s 2>/dev/null || true
      fi
      ;;
    runner|dispatcher)
      local runs
      runs="$(list_runs_with_pods)"
      if [[ -z "$runs" ]]; then return 0; fi
      echo ">> --force: these Runs have live pods that may pin the old $name image:"
      echo "$runs" | sed 's/^/     /'
      if ! confirm "   Delete them?"; then
        echo "   aborting" >&2
        return 1
      fi
      while IFS= read -r nsname; do
        [[ -z "$nsname" ]] && continue
        local ns="${nsname%/*}" n="${nsname##*/}"
        kubectl -n "$ns" delete run.percussionist.dev "$n" --wait=false
      done <<<"$runs"
      # Wait for the actual run pods (labelled `percussionist.dev/run=<name>`)
      # to terminate. Listing CRs no longer works here because we just
      # deleted them; their child pods linger briefly during GC.
      echo "   waiting for pods to terminate..."
      for _ in $(seq 1 60); do
        local remaining
        remaining="$(kubectl get pods -A \
          -l percussionist.dev/run \
          --no-headers 2>/dev/null | wc -l)"
        [[ "$remaining" -eq 0 ]] && break
        sleep 1
      done
      # Double-check — any lingering container that's actually pinning the
      # image will still block `minikube image rm`. Wait on the minikube
      # docker daemon too.
      local pinning_cid
      for _ in $(seq 1 30); do
        pinning_cid="$(minikube ssh -- docker ps -q \
          --filter "ancestor=docker.io/percussionist/$name:dev" 2>/dev/null \
          | tr -d '\r')"
        [[ -z "$pinning_cid" ]] && break
        sleep 1
      done
      ;;
    web)
      if kubectl -n percussionist get deploy percussionist-web >/dev/null 2>&1; then
        echo ">> --force: scaling deploy/percussionist-web to 0"
        kubectl -n percussionist scale deploy/percussionist-web --replicas=0
        kubectl -n percussionist wait --for=delete pod \
          -l app.kubernetes.io/component=web \
          --timeout=60s 2>/dev/null || true
      fi
      ;;
    manager)
      if kubectl -n percussionist get deploy percussionist-manager >/dev/null 2>&1; then
        echo ">> --force: scaling deploy/percussionist-manager to 0"
        kubectl -n percussionist scale deploy/percussionist-manager --replicas=0
        kubectl -n percussionist wait --for=delete pod \
          -l app.kubernetes.io/component=manager \
          --timeout=60s 2>/dev/null || true
      fi
      ;;
  esac
}

# After eviction, minikube's docker still holds the untagged blob under the
# old ID. `minikube image rm` + `load` is the reliable way to replace.
force_reload() {
  local tag="$1"
  echo ">> --force: removing stale $tag from minikube"
  minikube image rm "docker.io/$tag" >/dev/null 2>&1 || true
  echo ">> --force: loading fresh $tag"
  minikube image load "$tag"
}

# Undo the operator/web scale-down from evict_for.
restore_operator() {
  if kubectl -n percussionist get deploy percussionist-operator >/dev/null 2>&1; then
    echo ">> --force: scaling deploy/percussionist-operator back to 1"
    kubectl -n percussionist scale deploy/percussionist-operator --replicas=1
    kubectl -n percussionist rollout status deploy/percussionist-operator --timeout=60s || true
  fi
}

restore_web() {
  if kubectl -n percussionist get deploy percussionist-web >/dev/null 2>&1; then
    echo ">> --force: scaling deploy/percussionist-web back to 1"
    kubectl -n percussionist scale deploy/percussionist-web --replicas=1
    kubectl -n percussionist rollout status deploy/percussionist-web --timeout=60s || true
  fi
}

restore_manager() {
  if kubectl -n percussionist get deploy percussionist-manager >/dev/null 2>&1; then
    echo ">> --force: scaling deploy/percussionist-manager back to 1"
    kubectl -n percussionist scale deploy/percussionist-manager --replicas=1
    kubectl -n percussionist rollout status deploy/percussionist-manager --timeout=60s || true
  fi
}

process_one() {
  local name="$1"; local tag="$2"
  if $BUILD; then
    echo ">> Building $tag${FORCE:+ (no-cache)}"
    build_one "$name" "$tag"
  fi

  if $FORCE; then
    # Only bother with eviction / rm+load if the IDs actually diverge. If
    # nothing's running with the old image, a plain `image load` works fine.
    local host_id mk_id
    host_id="$(host_image_id "$tag")"
    mk_id="$(minikube_image_id "$tag")"
    if [[ -n "$host_id" && "$host_id" != "$mk_id" ]]; then
      evict_for "$name" || return 1
      force_reload "$tag"
    else
      echo ">> Loading $tag into minikube"
      minikube image load "$tag" --overwrite=true
    fi
  else
    echo ">> Loading $tag into minikube"
    minikube image load "$tag" --overwrite=true
  fi

  # Sanity-check: `minikube image load --overwrite=true` silently no-ops when
  # a running container inside minikube is still referencing the previous
  # image ID (docker refuses to untag a referenced image). Compare IDs and
  # auto-recover when possible.
  local host_id mk_id
  host_id="$(host_image_id "$tag")"
  mk_id="$(minikube_image_id "$tag")"
  if [[ -n "$host_id" && -n "$mk_id" && "$host_id" != "$mk_id" ]]; then
    if ! $FORCE; then
      echo ">> image-ID mismatch — retrying with rm + load" >&2
      force_reload "$tag"
      host_id="$(host_image_id "$tag")"
      mk_id="$(minikube_image_id "$tag")"
    fi
  fi

  # If still mismatched, the image is pinned by a running container.
  if [[ -n "$host_id" && -n "$mk_id" && "$host_id" != "$mk_id" ]]; then
    echo "!! ERROR: $tag image-ID mismatch" >&2
    echo "     host:     $host_id" >&2
    echo "     minikube: $mk_id" >&2
    echo "" >&2
    echo "   A running container is pinning the old image." >&2
    if ! $FORCE; then
      echo "   Re-run with --force to auto-evict and reload." >&2
    else
      echo "   (auto-eviction may have failed; check if the deployment is scaled to 0)" >&2
      echo "" >&2
      echo "   Manual fix:" >&2
      echo "   kubectl -n percussionist scale deploy/percussionist-${name} --replicas=0" >&2
      echo "   minikube image rm docker.io/$tag" >&2
      echo "   minikube image load $tag" >&2
      echo "   kubectl -n percussionist scale deploy/percussionist-${name} --replicas=1" >&2
    fi
    return 1
  fi
}

# The M1 script supported `IMAGE=` to override a single image; keep that
# behaviour for the runner for backward compat.
RUNNER_TAG="${IMAGE:-percussionist/runner:dev}"
OPERATOR_TAG="percussionist/operator:dev"
DISPATCHER_TAG="percussionist/dispatcher:dev"
WEB_TAG="percussionist/web:dev"
MANAGER_TAG="percussionist/manager:dev"

RESTORE_OPERATOR=false
RESTORE_WEB=false
RESTORE_MANAGER=false

if [[ -n "$ONLY" ]]; then
  case "$ONLY" in
    runner)     process_one runner     "$RUNNER_TAG" ;;
    operator)   process_one operator   "$OPERATOR_TAG"; $FORCE && RESTORE_OPERATOR=true ;;
    dispatcher) process_one dispatcher "$DISPATCHER_TAG" ;;
    web)        process_one web        "$WEB_TAG"; $FORCE && RESTORE_WEB=true ;;
    manager)    process_one manager    "$MANAGER_TAG"; $FORCE && RESTORE_MANAGER=true ;;
    *) echo "unknown --only value: $ONLY (runner|operator|dispatcher|web|manager)" >&2; exit 2 ;;
  esac
else
  process_one runner     "$RUNNER_TAG"
  process_one operator   "$OPERATOR_TAG";   $FORCE && RESTORE_OPERATOR=true
  process_one dispatcher "$DISPATCHER_TAG"
  process_one web        "$WEB_TAG";        $FORCE && RESTORE_WEB=true
  process_one manager    "$MANAGER_TAG";    $FORCE && RESTORE_MANAGER=true
fi

# Bring scaled-down deployments back up.
if $RESTORE_OPERATOR; then restore_operator; fi
if $RESTORE_WEB; then restore_web; fi
if $RESTORE_MANAGER; then restore_manager; fi

echo ">> Images present in minikube:"
minikube image ls | grep -E 'percussionist/(runner|operator|dispatcher|web|manager)' || true

# ---------------------------------------------------------------------------
# Pin the ingress-nginx HTTP NodePort to 30080 so the dashboard and per-run
# URLs stay stable across cluster restarts.  Idempotent: skipped when already
# correct or when the addon is not installed.
if kubectl -n ingress-nginx get svc ingress-nginx-controller &>/dev/null; then
  current_np=$(kubectl -n ingress-nginx get svc ingress-nginx-controller \
    -o jsonpath='{.spec.ports[?(@.name=="http")].nodePort}' 2>/dev/null || true)
  if [[ "$current_np" != "30080" ]]; then
    echo ">> Pinning ingress-nginx HTTP NodePort to 30080 (was ${current_np:-unset})"
    kubectl -n ingress-nginx patch svc ingress-nginx-controller --type=json \
      -p='[{"op":"replace","path":"/spec/ports/0/nodePort","value":30080}]'
  else
    echo ">> ingress-nginx HTTP NodePort already pinned to 30080"
  fi
fi

# ---------------------------------------------------------------------------
# Print access URLs.
MINIKUBE_IP=$(minikube ip 2>/dev/null || echo "192.168.49.2")
echo ""
echo "================================================================"
echo "  Dashboard:  https://app.${MINIKUBE_IP}.nip.io:30443/"
echo "  Runs:       https://<run>.${MINIKUBE_IP}.nip.io:30443/"
echo "  (requires: minikube addons enable ingress)"
echo "  Note: accept the self-signed cert on first visit"
echo "        or run: beatctl deploy  (sets up TLS automatically)"
echo "================================================================"
