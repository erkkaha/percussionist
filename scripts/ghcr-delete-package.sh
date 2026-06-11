#!/usr/bin/env bash
set -euo pipefail

# ghcr-delete-package.sh — Delete GHCR container packages.
#
# Reads GH_TOKEN or GITHUB_TOKEN from environment.
# Token needs read:packages + delete:packages scopes.
#
# Examples:
#   GH_TOKEN=... ./scripts/ghcr-delete-package.sh --yes runner web
#   GH_TOKEN=... ./scripts/ghcr-delete-package.sh --all --yes

API_BASE="https://api.github.com"
OWNER="${GH_OWNER:-erkkaha}"
REPO="${GH_REPO:-percussionist}"
DEFAULT_PACKAGES=("runner" "operator" "dispatcher" "manager" "web" "memory")

DRY_RUN=true
USE_ALL=false
declare -a PACKAGES=()

usage() {
  cat >&2 <<'EOF'
usage: ghcr-delete-package.sh [--owner <org>] [--repo <repo>] [--all] [--yes] <package> [package...]

Delete GHCR container packages for an org/repo.

Options:
  --owner <org>   GitHub org/user owner (default: GH_OWNER or erkkaha)
  --repo <repo>   Repository name for repo-scoped fallback (default: GH_REPO or percussionist)
  --all           Delete default Percussionist packages
  --yes           Execute deletion (without this, dry-run only)
  -h, --help      Show this help

Env:
  GH_TOKEN or GITHUB_TOKEN must be set.
EOF
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --owner)
      [ $# -ge 2 ] || usage
      OWNER="$2"
      shift 2
      ;;
    --repo)
      [ $# -ge 2 ] || usage
      REPO="$2"
      shift 2
      ;;
    --all)
      USE_ALL=true
      shift
      ;;
    --yes)
      DRY_RUN=false
      shift
      ;;
    -h|--help)
      usage
      ;;
    --*)
      echo "error: unknown option: $1" >&2
      usage
      ;;
    *)
      PACKAGES+=("$1")
      shift
      ;;
  esac
done

if [ "$USE_ALL" = true ]; then
  PACKAGES=("${DEFAULT_PACKAGES[@]}")
fi

[ ${#PACKAGES[@]} -gt 0 ] || usage

TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
if [ -z "$TOKEN" ]; then
  echo "error: set GH_TOKEN or GITHUB_TOKEN" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required" >&2
  exit 1
fi

ghcurl() {
  curl -sS -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" "$@"
}

endpoints_for() {
  local pkg="$1"
  # Try all known scopes because OWNER may be a user account (not org)
  # and package names may be either bare (runner) or repo-prefixed
  # (percussionist/runner).
  echo "/users/$OWNER/packages/container/$pkg"
  echo "/users/$OWNER/packages/container/$REPO%2F$pkg"
  echo "/orgs/$OWNER/packages/container/$pkg"
  echo "/orgs/$OWNER/packages/container/$REPO%2F$pkg"
  echo "/repos/$OWNER/$REPO/packages/container/$pkg"
}

list_visible_packages() {
  local url
  for url in \
    "$API_BASE/users/$OWNER/packages?package_type=container&per_page=100" \
    "$API_BASE/orgs/$OWNER/packages?package_type=container&per_page=100" \
    "$API_BASE/repos/$OWNER/$REPO/packages?package_type=container&per_page=100"
  do
    code=$(ghcurl -o /dev/null -w "%{http_code}" "$url")
    if [ "$code" = "200" ]; then
      names=$(ghcurl "$url" | jq -r '.[].name' 2>/dev/null | tr '\n' ' ')
      [ -n "$names" ] && echo "Visible packages from $url: $names"
    fi
  done
}

echo "Owner: $OWNER"
echo "Repo: $REPO"
echo "Mode: $([ "$DRY_RUN" = true ] && echo dry-run || echo delete)"
echo "Packages: ${PACKAGES[*]}"
echo

deleted_any=false

for pkg in "${PACKAGES[@]}"; do
  echo "---"
  echo "Package: $pkg"
  removed=false

  while IFS= read -r endpoint; do
    [ "$removed" = true ] && break

    info_url="$API_BASE$endpoint"
    code=$(ghcurl -o /dev/null -w "%{http_code}" "$info_url")

    if [ "$code" = "404" ]; then
      continue
    fi

    if [ "$code" != "200" ]; then
      echo "  endpoint $endpoint unavailable (HTTP $code)"
      continue
    fi

    if [ "$DRY_RUN" = true ]; then
      echo "  would delete via $endpoint"
      removed=true
      deleted_any=true
      break
    fi

    del_code=$(ghcurl -o /dev/null -w "%{http_code}" -X DELETE "$info_url")
    if [ "$del_code" = "204" ]; then
      echo "  deleted via $endpoint"
      removed=true
      deleted_any=true
    else
      echo "  DELETE failed via $endpoint (HTTP $del_code)"
    fi
  done < <(endpoints_for "$pkg")

  if [ "$removed" = false ]; then
    echo "  package not found or not accessible"
  fi
done

if [ "$deleted_any" = false ]; then
  echo
  echo "No packages matched."
  list_visible_packages
fi
