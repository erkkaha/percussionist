#!/usr/bin/env bash
# Bump the patch version of @percussionist/web.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$REPO_ROOT/packages/web/package.json"

current="$(node -p "require('$PKG').version")"
major="${current%%.*}"
rest="${current#*.}"
minor="${rest%.*}"
patch="${rest#*.}"

new_patch=$((patch + 1))
new_version="${major}.${minor}.${new_patch}"

node -e "
const pkg = require('$PKG');
pkg.version = '$new_version';
require('fs').writeFileSync('$PKG', JSON.stringify(pkg, null, 2) + '\n');
"

echo "${current} → ${new_version}"
