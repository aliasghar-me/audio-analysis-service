# syntax=docker/dockerfile:1.7
#
# audio-analysis-service API.
#
#   docker build -f infra/api.Dockerfile -t audio-analysis-api .

FROM node:26-slim AS builder

# Node 25 dropped corepack from the official images, so pnpm is installed
# rather than activated.
RUN npm install --global pnpm@9.15.9
WORKDIR /repo

# Manifests first: a dependency install is then only redone when a manifest
# changes, not on every source edit.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json ./apps/api/

RUN --mount=type=cache,id=pnpm,target=/pnpm-store \
  pnpm config set store-dir /pnpm-store \
  && pnpm install --frozen-lockfile --filter @audio/api...

COPY tsconfig.base.json ./
COPY apps/api ./apps/api

# Prisma 7 emits TypeScript rather than prebuilt JavaScript, so the client has
# to exist before tsc runs or the API will not compile.
RUN pnpm --filter @audio/api exec prisma generate \
  && pnpm --filter @audio/api exec tsc -p tsconfig.build.json

# Assemble a self-contained runtime directory.
#
# `pnpm deploy --prod` is the obvious tool and it does not work here: it
# disables the lockfile, re-resolves from scratch, and fails with a spurious
# ERR_PNPM_CATALOG_ENTRY_NOT_FOUND_FOR_SPEC for a catalog this repo does not
# define. A prod install against the frozen lockfile is both deterministic and
# one less moving part — and because .npmrc sets node-linker=hoisted, the
# resulting node_modules is a plain tree that can simply be copied.
#
# Note the deliberate absence of `|| true` on this chain: an earlier version
# ended with it, so when the deploy step failed the build still succeeded and
# shipped an image with no node_modules at all. It crash-looped on the first
# require. A build step that cannot fail is not a build step.
RUN pnpm install --frozen-lockfile --prod --filter @audio/api... \
  && mkdir -p /deploy \
  && cp -r node_modules /deploy/node_modules \
  && cp -r apps/api/dist /deploy/dist \
  && cp apps/api/package.json /deploy/package.json

# ---------------------------------------------------------------------------
# Migration runner
# ---------------------------------------------------------------------------
#
# A separate stage on purpose. `pnpm deploy --prod` correctly drops
# devDependencies, which means the runtime image has neither pnpm nor the Prisma
# CLI — so `docker compose run api pnpm db:migrate:deploy` against it fails with
# "exec pnpm failed". Keeping the migration as its own tagged artifact leaves
# the runtime lean and makes the release step explicit.
FROM builder AS migrate
WORKDIR /repo/apps/api
CMD ["npx", "prisma", "migrate", "deploy"]

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:26-slim AS runtime

# The node images already ship a non-root `node` user; creating another one
# collides with an existing gid on this base image and buys nothing.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder --chown=node:node /deploy ./

# Uploaded audio lives on a volume, not in the image layer.
RUN mkdir -p /data/storage && chown -R node:node /data/storage

ENV NODE_ENV=production
ENV API_PORT=4490
ENV STORAGE_DIR=/data/storage

USER node
EXPOSE 4490

# Readiness rather than liveness: a database blip should take the container out
# of rotation, not restart a process that is working fine.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4490/health').then(r=>r.json()).then(j=>process.exit(j.database==='up'?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
