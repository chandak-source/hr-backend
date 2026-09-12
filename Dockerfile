# syntax=docker/dockerfile:1

# ---- dependencies -----------------------------------------------------------
# Split out so the install layer is cached until the manifests actually change.
FROM node:22-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime

# tini reaps zombies and forwards signals, so the SIGTERM handling in
# src/server.js actually runs on `docker stop`.
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    PORT=4000

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts

# The official image ships an unprivileged `node` user (uid 1000). Nothing here
# writes to disk, so the app never needs to own its files.
USER node

EXPOSE 4000

# Liveness, not readiness: /health returns 503 whenever MongoDB blips, and
# Docker would keep restarting a perfectly healthy process.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health/live" > /dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
