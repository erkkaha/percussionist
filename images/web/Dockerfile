# Dockerfile for the percussionist web dashboard.
#
#   docker build -t percussionist/web:dev -f images/web/Dockerfile .

ARG NODE_VERSION=22

# --- deps stage ---------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS deps
RUN apk add --no-cache libc6-compat
RUN corepack enable && corepack prepare pnpm@10.30.2 --activate

WORKDIR /repo
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/api/package.json packages/api/package.json
COPY packages/web/package.json packages/web/package.json
RUN pnpm install --frozen-lockfile=false && pnpm approve-builds esbuild

# --- build stage: copy only source (not node_modules) so pnpm links survive --
FROM deps AS build
COPY packages/api/src           packages/api/src
COPY packages/api/tsconfig.json packages/api/tsconfig.json
COPY packages/web/src              packages/web/src
COPY packages/web/tsconfig.json    packages/web/tsconfig.json
COPY packages/web/tsconfig.server.json packages/web/tsconfig.server.json
COPY packages/web/tsconfig.client.json packages/web/tsconfig.client.json
COPY packages/web/vite.config.ts   packages/web/vite.config.ts
RUN pnpm -C packages/api run build \
 && pnpm -C packages/web run build

# --- runtime ------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production
RUN apk add --no-cache tini

WORKDIR /app

COPY --from=build /repo/node_modules                    /app/node_modules
COPY --from=build /repo/packages/api/dist               /app/packages/api/dist
COPY --from=build /repo/packages/api/package.json       /app/packages/api/package.json
COPY --from=build /repo/packages/api/node_modules       /app/packages/api/node_modules
COPY --from=build /repo/packages/web/dist               /app/packages/web/dist
COPY --from=build /repo/packages/web/package.json       /app/packages/web/package.json
COPY --from=build /repo/packages/web/node_modules       /app/packages/web/node_modules

EXPOSE 8080
ENV PORT=8080

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/app/packages/web/dist/server/index.js"]
