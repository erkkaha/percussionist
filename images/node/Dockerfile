# Shared Dockerfile for the operator, dispatcher, and manager controller.
# Build with --build-arg PKG=operator|dispatcher|manager-controller.
#
#   docker build -t percussionist/operator:dev          --build-arg PKG=operator           -f images/node/Dockerfile .
#   docker build -t percussionist/dispatcher:dev        --build-arg PKG=dispatcher         -f images/node/Dockerfile .
#   docker build -t percussionist/manager:dev           --build-arg PKG=manager-controller -f images/node/Dockerfile .

ARG NODE_VERSION=24

# --- deps stage: install workspace deps once ---------------------------------
FROM node:${NODE_VERSION}-alpine AS deps
RUN apk add --no-cache libc6-compat
RUN corepack enable && corepack prepare pnpm@10.30.2 --activate

WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/api/package.json              packages/api/package.json
COPY packages/operator/package.json         packages/operator/package.json
COPY packages/dispatcher/package.json       packages/dispatcher/package.json
COPY packages/manager-controller/package.json packages/manager-controller/package.json
RUN pnpm install --frozen-lockfile

# --- build stage: compile TS --------------------------------------------------
FROM deps AS build
ARG PKG
COPY packages ./packages
RUN pnpm -C packages/api              run build \
 && pnpm -C packages/operator         run build \
 && pnpm -C packages/dispatcher       run build \
 && pnpm -C packages/manager-controller run build

# --- runtime: minimal node image with all built packages --------------------
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
COPY --from=build /repo/packages/operator/dist           /app/packages/operator/dist
COPY --from=build /repo/packages/operator/package.json   /app/packages/operator/package.json
COPY --from=build /repo/packages/operator/node_modules   /app/packages/operator/node_modules
COPY --from=build /repo/packages/dispatcher/dist         /app/packages/dispatcher/dist
COPY --from=build /repo/packages/dispatcher/package.json /app/packages/dispatcher/package.json
COPY --from=build /repo/packages/dispatcher/node_modules /app/packages/dispatcher/node_modules
COPY --from=build /repo/packages/manager-controller/dist /app/packages/manager-controller/dist
COPY --from=build /repo/packages/manager-controller/package.json /app/packages/manager-controller/package.json
COPY --from=build /repo/packages/manager-controller/node_modules /app/packages/manager-controller/node_modules

ENV PKG=${PKG}
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "node /app/packages/${PKG}/dist/index.js"]
