# WS-C C1 (workorder) — STAND-IN tenant image.
#
# This image exists so that the deployment pipeline (CI build -> Trivy scan ->
# push) and the host/network plumbing (AC-C-1 isolation checks need a listener
# on 8790) are exercisable before WS-A ships the real tenant image. It
# implements the C1 contract SURFACE (env contract, /healthz, /readyz shape,
# C2 welcome + echo over WebSocket, JSON logs, uid 1000, /data volume, SIGTERM
# handling) but it is NOT the IDBots backend.
#
# WS-A replaces this directory's image contents per 00-program-plan.md
# (deploy/tenant-image/ is a WS-A deliverable); the build script, CI wiring,
# labels, and tags stay. See README.md.

FROM node:24-bookworm-slim

ARG APP_VERSION=0.0.0
ARG APP_COMMIT=unknown
ARG CONTRACT_VERSION=1.0.0
ARG ROLLBACK_SAFE_TO=""

# C1 image labels (used by the control plane for upgrade/rollback decisions).
LABEL org.idbots.version="${APP_VERSION}" \
      org.idbots.commit="${APP_COMMIT}" \
      org.idbots.contract="${CONTRACT_VERSION}" \
      org.idbots.rollback-safe-to="${ROLLBACK_SAFE_TO}"

ENV IDBOTS_IMAGE_VERSION="${APP_VERSION}" \
    IDBOTS_IMAGE_COMMIT="${APP_COMMIT}" \
    IDBOTS_CONTRACT_VERSION="${CONTRACT_VERSION}" \
    IDBOTS_GATEWAY_PORT=8790 \
    IDBOTS_USER_DATA_PATH=/data/userdata \
    IDBOTS_APP_DATA_PATH=/data/appdata \
    IDBOTS_WORKSPACE_PATH=/data/workspace \
    TZ=Asia/Shanghai

# C1 volume layout. The official node image ships a "node" user with uid 1000.
RUN mkdir -p /data/userdata /data/appdata /data/workspace/uploads \
  && chown -R node:node /data

WORKDIR /app
COPY --chown=node:node server.mjs entrypoint.sh ./
RUN chmod +x entrypoint.sh

# C1: runs as uid 1000, non-root. Must be run with --init (tini via docker).
USER node
VOLUME ["/data"]
EXPOSE 8790

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.IDBOTS_GATEWAY_PORT||8790)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The entrypoint is where WS-A's real image removes stale Xvfb locks, starts
# Xvfb :99 and D-Bus, then execs Electron --no-sandbox. The stand-in execs node.
ENTRYPOINT ["/app/entrypoint.sh"]
