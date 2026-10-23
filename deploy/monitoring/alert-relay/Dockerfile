FROM node:24-alpine
USER node
WORKDIR /app
COPY --chown=node:node relay.mjs ./
EXPOSE 9080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q --tries=1 -O /dev/null http://127.0.0.1:9080/healthz
CMD ["node", "relay.mjs"]
