# syntax=docker/dockerfile:1.7
#
# audio-analysis-service web UI.
#
#   docker build -f infra/web.Dockerfile -t audio-analysis-web .

FROM node:26-slim AS builder

RUN npm install --global pnpm@9.15.9
WORKDIR /repo

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/web/package.json ./apps/web/

RUN --mount=type=cache,id=pnpm,target=/pnpm-store \
  pnpm config set store-dir /pnpm-store \
  && pnpm install --frozen-lockfile --filter @audio/web...

COPY tsconfig.base.json ./
COPY apps/web ./apps/web

# Next evaluates `rewrites()` at BUILD time and freezes the result into
# routes-manifest.json, so the proxy target has to be known here — setting
# API_URL on the running container would be silently ignored.
ARG API_URL=http://localhost:4490
ENV API_URL=$API_URL

# `output: 'standalone'` traces exactly the files the server needs, so the
# runtime image below carries no pnpm store and no build toolchain.
RUN pnpm --filter @audio/web build

FROM node:26-slim AS runtime

# The node images already ship a non-root `node` user.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The standalone bundle is rooted at the workspace, so server.js sits under the
# app's own path inside it.
COPY --from=builder --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static

ENV NODE_ENV=production
ENV PORT=3490
ENV HOSTNAME=0.0.0.0

USER node
EXPOSE 3490

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3490/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/web/server.js"]
