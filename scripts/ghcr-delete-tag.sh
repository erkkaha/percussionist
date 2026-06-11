#!/usr/bin/env bash
set -u -o pipefail

# ghcr-delete-tag.sh — Delete container image tags from GHCR.
#
# Reads GITHUB_TOKEN or GH_TOKEN from environment.
# Token needs read:packages and write:packages scopes.
#
# Usage:  GITHUB_TOKEN=ghp_xxx ./ghcr-delete-tag.sh v0.2.0 0.2.1

API_BASE="https://api.github.com"
OWNER="erkkaha"
REPO="percussionist"
IMAGES=("runner" "operator" "dispatcher" "manager" "web" "memory")

usage() { echo "usage: $0 <tag> [tag ...]" >&2; exit 1; }
[ $# -gt 0 ] || usage

TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
if [ -z "$TOKEN" ]; then
  echo "error: set GITHUB_TOKEN or GH_TOKEN" >&2
  exit 1
fi

ghcurl() {
  curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" "$@"
}

# Generate all endpoint URLs to try for a given image.
endpoints_for() {
  local img="$1"
  # Try user-, org-, and repo-scoped endpoints.
  # Package names can be bare (runner) or repo-prefixed (percussionist/runner).
  echo "/users/$OWNER/packages/container/$img"
  echo "/users/$OWNER/packages/container/percussionist%2F$img"
  echo "/repos/$OWNER/$REPO/packages/container/$img"
  echo "/orgs/$OWNER/packages/container/percussionist%2F$img"
  echo "/orgs/$OWNER/packages/container/$img"
}

# Show what we can access for debugging
echo "Probing API access..."
debug_resp=$(ghcurl "$API_BASE/repos/$OWNER/$REPO/packages?package_type=container" 2>/dev/null)
if [ -n "$debug_resp" ]; then
  echo "  Repo packages: $(echo "$debug_resp" | jq -r '.[].name' 2>/dev/null | tr '\n' ' ')"
fi
debug_resp=$(ghcurl "$API_BASE/users/$OWNER/packages?package_type=container" 2>/dev/null)
if [ -n "$debug_resp" ]; then
  echo "  User packages: $(echo "$debug_resp" | jq -r '.[].name' 2>/dev/null | tr '\n' ' ')"
fi
debug_resp=$(ghcurl "$API_BASE/orgs/$OWNER/packages?package_type=container" 2>/dev/null)
if [ -n "$debug_resp" ]; then
  echo "  Org packages: $(echo "$debug_resp" | jq -r '.[].name' 2>/dev/null | tr '\n' ' ')"
fi
echo ""

for tag in "$@"; do
  [[ "$tag" != v* ]] && tag="v$tag"
  echo "---"
  echo "Tag: $tag"

  found_any=false

  for img in "${IMAGES[@]}"; do
    echo "  $img:"

    found_for_img=false

    for endpoint in $(endpoints_for "$img"); do
      [ $found_for_img = true ] && break
      url="$API_BASE$endpoint/versions?per_page=100"
      resp=$(ghcurl "$url")
      http_code=$(ghcurl -o /dev/null -w "%{http_code}" "$url")

      # If 404, try next endpoint variant
      if [ "$http_code" = "404" ]; then
        continue
      fi

      # Check for other errors
      err=$(echo "$resp" | jq -r '.message // empty' 2>/dev/null)
      if [ -n "$err" ]; then
        echo "    endpoint $endpoint error: $err"
        continue
      fi

      ids=$(echo "$resp" | jq -r ".[] | select(.metadata.container.tags | index(\"$tag\")) | .id" 2>/dev/null) || true

      if [ -z "$ids" ]; then
        echo "    no versions with tag \"$tag\" (endpoint $endpoint)"
        continue
      fi

      found_for_img=true
      found_any=true
      while IFS= read -r vid; do
        [ -z "$vid" ] && continue
        tags=$(echo "$resp" | jq -r ".[] | select(.id == $vid) | .metadata.container.tags | join(\", \")" 2>/dev/null) || tags="(unknown)"
        echo "    deleting version $vid (tags: $tags)"
        del_code=$(ghcurl -o /dev/null -w "%{http_code}" -X DELETE "$API_BASE$endpoint/versions/$vid")
        if [ "$del_code" = "204" ]; then
          echo "    done"
        else
          echo "    DELETE failed (HTTP $del_code) — need write:packages scope"
        fi
      done <<< "$ids"
    done

    if [ $found_for_img = false ]; then
      echo "    no reachable endpoint for this image"
    fi
  done

  if ! $found_any; then
    echo "  Nothing to delete for tag \"$tag\""
  fi
done
