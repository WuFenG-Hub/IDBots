# syntax=docker/dockerfile:1
# Fake tenant image (REQ-B-21). NOTE: there is no Docker daemon on the dev
# machine, so this image is built by CI (WS-C), not locally — local runs use
# child-process mode through test/fake-docker instead. Build context: this
# directory.

FROM node:24-alpine
WORKDIR /srv/fake-tenant
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod
COPY fake-tenant.mjs ./
EXPOSE 8790
USER node
CMD ["node", "fake-tenant.mjs"]
