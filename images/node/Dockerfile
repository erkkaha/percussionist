# Shared Dockerfile for the operator and dispatcher.
# Build with --build-arg PKG=operator or PKG=dispatcher.
#
#   docker build -t percussionist/operator:dev   --build-arg PKG=operator   -f images/node/Dockerfile .
#   docker build -t percussionist/dispatcher:dev --build-arg PKG=dispatcher -f images/node/Dockerfile .

ARG NODE_VERSION=22

# --- deps stage: install workspace deps once ---------------------------------
FROM node:${NODE_VERSION}-alpine AS deps
RUN apk add --no-cache libc6-compat
RUN corepack enable && corepack prepare pnpm@10.30.2 --activate

WORKDIR /repo
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/api/package.json        packages/api/package.json
COPY packages/operator/package.json   packages/operator/package.json
COPY packages/dispatcher/package.json packages/dispatcher/package.json
RUN pnpm install --frozen-lockfile=false

# --- build stage: compile TS --------------------------------------------------
FROM deps AS build
ARG PKG
COPY packages ./packages
RUN pnpm -C packages/api        run build \
 && pnpm -C packages/${PKG}     run build

# --- runtime: minimal node image with only prod deps --------------------------
FROM node:${NODE_VERSION}-alpine AS runtime
ARG PKG
ENV NODE_ENV=production
RUN apk add --no-cache tini

WORKDIR /app

# Copy the built JS plus node_modules. We ship the whole workspace's
# node_modules because pnpm symlinks across packages; splitting is possible
# but not worth the complexity at M2 scale.
COPY --from=build /repo/node_modules                     /app/node_modules
COPY --from=build /repo/packages/api/dist                /app/packages/api/dist
COPY --from=build /repo/packages/api/package.json        /app/packages/api/package.json
COPY --from=build /repo/packages/api/node_modules        /app/packages/api/node_modules
COPY --from=build /repo/packages/${PKG}/dist             /app/packages/${PKG}/dist
COPY --from=build /repo/packages/${PKG}/package.json     /app/packages/${PKG}/package.json
COPY --from=build /repo/packages/${PKG}/node_modules     /app/packages/${PKG}/node_modules

# Rewrite the workspace symlink target for @percussionist/api to the built
# dist dir. pnpm's workspace protocol leaves a symlink to ../api, which
# resolves fine after we copy packages/api above.

ENV PKG=${PKG}
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "node /app/packages/${PKG}/dist/index.js"]
