# syntax=docker/dockerfile:1.7
#
# codex-responses-adapter — container image
# -----------------------------------------
# Multi-stage build producing a minimal `node:20-alpine` runtime image.
# The container expects the config YAML to be mounted at
# `/etc/codex-responses-adapter/config.yaml`; the ENTRYPOINT points the
# adapter CLI at that path by default.
#
# Example:
#   docker build -t codex-responses-adapter .
#   docker run --rm \
#     -v /local/path/to/adapter-config:/etc/codex-responses-adapter:ro \
#     -p 8787:8787 \
#     codex-responses-adapter
#
# The mount target is a directory so the user can also drop a
# `records/` subdirectory alongside `config.yaml` when `log.record_bodies`
# is enabled. Port 8787 is the default `listen.port`; override by
# publishing a different host port or editing the mounted config.

# ---------- Stage 1: builder ----------
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies first so Docker can cache the layer as long
# as package.json / package-lock.json are unchanged.
COPY package.json package-lock.json ./
RUN npm ci

# Copy the remaining sources needed to produce `dist/`.
COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ---------- Stage 2: runtime ----------
FROM node:20-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

# Install production-only dependencies. We copy the lockfile so
# `npm ci --omit=dev` yields a reproducible tree, matching the versions
# resolved by the builder stage.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

# Copy the compiled JavaScript produced by the builder.
COPY --from=builder /app/dist ./dist

# Create the default config mount point. The image ships an empty
# directory so `-v` mounts can land on a known path without the operator
# having to create it first.
RUN mkdir -p /etc/codex-responses-adapter \
    && chown -R node:node /etc/codex-responses-adapter /app

# The `node:alpine` image ships a non-root `node` user; drop privileges
# so the adapter cannot write outside its own working directory.
USER node

EXPOSE 8787

ENTRYPOINT ["node","dist/cli/index.js","start","--config","/etc/codex-responses-adapter/config.yaml"]
