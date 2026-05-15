# Dockerfile for the percussionist web dashboard.
#
# Build stage uses Node + pnpm (same toolchain as the rest of the monorepo) to
# compile the TypeScript server and the Vite client bundle. The runtime stage
# switches to the official Bun image so the server runs under Bun and has
# access to bun:sqlite for the stats database.
#
#   docker build -t percussionist/web:dev -f images/web/Dockerfile .

ARG NODE_VERSION=24
ARG BUN_VERSION=1.3.13

# --- deps stage ---------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS deps
RUN apk add --no-cache libc6-compat
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate

WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/api/package.json packages/api/package.json
COPY packages/kube/package.json packages/kube/package.json
COPY packages/web/package.json packages/web/package.json
RUN pnpm install --frozen-lockfile --config.strict-dep-builds=false

# --- build stage --------------------------------------------------------------
FROM deps AS build
COPY packages/api/src           packages/api/src
COPY packages/api/tsconfig.json packages/api/tsconfig.json
COPY packages/kube/src           packages/kube/src
COPY packages/kube/tsconfig.json packages/kube/tsconfig.json
COPY packages/web/src              packages/web/src
COPY packages/web/src/client/index.html packages/web/src/client/index.html
COPY packages/web/tsconfig.json    packages/web/tsconfig.json
COPY packages/web/tsconfig.server.json packages/web/tsconfig.server.json
COPY packages/web/tsconfig.client.json packages/web/tsconfig.client.json
COPY packages/web/vite.config.ts   packages/web/vite.config.ts
RUN ./node_modules/.bin/tsc -p packages/api/tsconfig.json \
 && ./node_modules/.bin/tsc -p packages/kube/tsconfig.json \
 && cd packages/web && ./node_modules/.bin/vite build --config vite.config.ts && cd /repo \
 && ./node_modules/.bin/tsc -p packages/web/tsconfig.server.json

# --- runtime (Bun) ------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-alpine AS runtime

WORKDIR /app

# Copy compiled server + client bundle + dependencies from the build stage.
COPY --from=build /repo/node_modules                    /app/node_modules
COPY --from=build /repo/packages/api/dist               /app/packages/api/dist
COPY --from=build /repo/packages/api/package.json       /app/packages/api/package.json
COPY --from=build /repo/packages/api/node_modules       /app/packages/api/node_modules
COPY --from=build /repo/packages/kube/dist              /app/packages/kube/dist
COPY --from=build /repo/packages/kube/package.json      /app/packages/kube/package.json
COPY --from=build /repo/packages/kube/node_modules      /app/packages/kube/node_modules
COPY --from=build /repo/packages/web/dist               /app/packages/web/dist
COPY --from=build /repo/packages/web/package.json       /app/packages/web/package.json
COPY --from=build /repo/packages/web/node_modules       /app/packages/web/node_modules

# Data directory for stats.db (override DATA_DIR to mount a PVC here).
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data

EXPOSE 8080
ENV PORT=8080

# Bun runs the compiled JS directly — no tsx, no node.
CMD ["bun", "/app/packages/web/dist/server/index.js"]
