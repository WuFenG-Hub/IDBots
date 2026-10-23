# syntax=docker/dockerfile:1
# Multi-stage image for the WS-B control plane.
# Tagging ({REGISTRY}/idbots/control-plane:{version}-{commit7}) is WS-C CI's job.

FROM node:24-bookworm-slim AS build
WORKDIR /app
# Toolchain for the better-sqlite3 native build (used when no prebuilt
# binary is available for the target platform).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN groupadd -g 1000 idbots && useradd -u 1000 -g idbots -m idbots
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
USER 1000
EXPOSE 8080 9100
CMD ["node", "dist/main.js"]
