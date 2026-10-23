# syntax=docker/dockerfile:1
# Multi-stage image for the WS-B control plane.
#
# BUILD CONTEXT: the REPOSITORY ROOT (so the WS-E mobile login bundle can be
# copied in). Build with:
#   docker build -f cloud/control-plane/Dockerfile -t <tag> .
# CI (WS-C) must run `pnpm build:mobile` first so `dist-mobile-login/` exists
# at the repo root; when the directory is absent the control plane serves its
# built-in placeholder instead, but the COPY below requires it to exist.
# Tagging ({REGISTRY}/idbots/control-plane:{version}-{commit7}) is WS-C CI's job.

FROM node:24-bookworm-slim AS build
WORKDIR /app
# Toolchain for the better-sqlite3 native build (used when no prebuilt
# binary is available for the target platform).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY cloud/control-plane/package.json cloud/control-plane/pnpm-workspace.yaml cloud/control-plane/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY cloud/control-plane/tsconfig.json cloud/control-plane/tsconfig.build.json ./
COPY cloud/control-plane/src ./src
RUN pnpm build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN groupadd -g 1000 idbots && useradd -u 1000 -g idbots -m idbots
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
# WS-E's login bundle (built by `pnpm build:mobile` before the image build).
COPY dist-mobile-login/ ./dist-mobile-login/
# Placeholder served when dist-mobile-login is absent — harmless to ship.
COPY cloud/control-plane/static-login/ ./static-login/
USER 1000
EXPOSE 8080 9100
CMD ["node", "dist/main.js"]
