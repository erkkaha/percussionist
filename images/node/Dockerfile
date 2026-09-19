# Shared Dockerfile for the operator, dispatcher, and manager controller.
# Build with --build-arg PKG=operator|dispatcher|manager-controller.
#
#   docker build -t percussionist/operator:dev          --build-arg PKG=operator           -f images/node/Dockerfile .
#   docker build -t percussionist/dispatcher:dev        --build-arg PKG=dispatcher         -f images/node/Dockerfile .
#   docker build -t percussionist/manager:dev           --build-arg PKG=manager-controller -f images/node/Dockerfile .
#
# Each image installs and builds only its own dependency subgraph
# (`pnpm --filter <pkg>...`). That matters since the manager pulled in
# @percussionist/runner-opencode (OpenCode 2 embedded, ~450 MB of
# node_modules): sharing one install would have grown the operator and
# dispatcher images by the same amount for nothing.

ARG NODE_VERSION=24

# --- deps stage: install this package's workspace subgraph -------------------
FROM node:${NODE_VERSION}-alpine AS deps
ARG PKG
RUN apk add --no-cache libc6-compat
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate

WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/api/package.json                packages/api/package.json
COPY packages/kube/package.json               packages/kube/package.json
COPY packages/operator/package.json           packages/operator/package.json
COPY packages/dispatcher/package.json         packages/dispatcher/package.json
COPY packages/manager-controller/package.json packages/manager-controller/package.json
COPY packages/runner-opencode/package.json    packages/runner-opencode/package.json
# The filter needs the package *name*; the directory is what the build arg
# names. pnpm resolves `{packages/<dir>}...` to the package and its deps.
# --ignore-scripts: the OpenCode SDK's native transitive deps ship prebuilt
# binaries; nothing else here has install scripts that matter.
RUN pnpm install --frozen-lockfile --ignore-scripts --config.strict-dep-builds=false \
      --filter "{packages/${PKG}}..."

# --- build stage: compile TS --------------------------------------------------
FROM deps AS build
ARG PKG
COPY packages/api/src                          packages/api/src
COPY packages/api/tsconfig.json                packages/api/tsconfig.json
COPY packages/kube/src                         packages/kube/src
COPY packages/kube/tsconfig.json               packages/kube/tsconfig.json
COPY packages/operator/src                     packages/operator/src
COPY packages/operator/tsconfig.json           packages/operator/tsconfig.json
COPY packages/dispatcher/src                   packages/dispatcher/src
COPY packages/dispatcher/tsconfig.json         packages/dispatcher/tsconfig.json
COPY packages/manager-controller/src           packages/manager-controller/src
COPY packages/manager-controller/tsconfig.json packages/manager-controller/tsconfig.json
COPY packages/runner-opencode/src              packages/runner-opencode/src
COPY packages/runner-opencode/tsconfig.json    packages/runner-opencode/tsconfig.json
# Clean dist dirs first to avoid tsc incremental compilation skipping new files,
# then build the subgraph in dependency order (pnpm -r honours the graph).
RUN rm -rf packages/*/dist \
 && pnpm --config.strict-dep-builds=false -r --filter "{packages/${PKG}}..." run build
# Stage exactly what the runtime needs: the root store plus each built
# package's dist, manifest and own node_modules links. Packages outside the
# subgraph have no dist and are skipped.
RUN mkdir -p /out \
 && cp -a --parents node_modules /out/ \
 && for p in packages/*; do \
      [ -d "$p/dist" ] || continue; \
      cp -a --parents "$p/dist" "$p/package.json" /out/; \
      [ -d "$p/node_modules" ] && cp -a --parents "$p/node_modules" /out/ || true; \
    done

# --- runtime: minimal node image with the built subgraph ---------------------
FROM node:${NODE_VERSION}-alpine AS runtime
ARG PKG
ENV NODE_ENV=production
# git + openssh-client: the dispatcher sidecar runs git in the run workspace
# (clean-tree check and refs/percussionist/* branch publish on completion);
# the manager's embedded OpenCode host uses git for its vcs status.
RUN apk add --no-cache tini git openssh-client ca-certificates

WORKDIR /app
COPY --from=build /out /app

ENV PKG=${PKG}
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "node /app/packages/${PKG}/dist/index.js"]
