# deploy/tenant-image — stand-in tenant image

**Owner of the image contents: WS-A** (`00-program-plan.md` lists
`deploy/tenant-image/` as a WS-A deliverable). WS-C provides this stand-in so
the deployment pipeline and host plumbing are fully exercisable before WS-A
lands (mock-first rule). WS-A keeps the build script, labels, tag scheme, and
CI wiring, and swaps the image contents for the real IDBots server-mode build.

## What the stand-in implements (C1/C2 contract surface)

- `GET /healthz` unauthenticated, `200 {"ok":true}`
- `GET /readyz` with the frozen C1 payload shape (phase, versions, onboarding)
- `GET /gateway/v1/ws` WebSocket: `welcome` frame, `invoke` echo, `ping`/`pong`,
  max 3 clients (fourth closed `4009`), 1 MiB frame cap, 25 s ping / 60 s
  keepalive close, `401` on a missing/wrong `X-IDBots-Gateway-Secret`
- C1 environment contract: refuses to boot without `IDBOTS_SERVER_MODE=1`,
  `IDBOTS_TENANT_ID`, `IDBOTS_GATEWAY_SECRET`
- uid 1000, `/data` volume layout (`userdata`, `appdata`, `workspace`),
  JSON logs, SIGTERM closes sockets with `4012` and exits
- Image labels `org.idbots.{version,commit,contract,rollback-safe-to}`

It does **not** implement: real IPC channels, uploads, file tokens, mnemonic
export, Xvfb/Electron. The conformance kit (`cloud/conformance/`, WS-A)
supersedes `smoke-test.mjs` once it exists.

## Build

```bash
# version comes from package.json, tag is {version}-{commit7}
deploy/tenant-image/build.sh                 # build + load locally
deploy/tenant-image/build.sh --scan          # + Trivy gate (CRITICAL, fixed only)
deploy/tenant-image/build.sh --push          # + push to ACR (docker login first)
```

## Run (local check)

```bash
docker run --rm -d --init --name idb-t_smoke \
  --memory 2304m --cpus 2 --pids-limit 2048 --shm-size 1g \
  --cap-drop ALL --security-opt no-new-privileges \
  -e IDBOTS_SERVER_MODE=1 -e IDBOTS_TENANT_ID=t_smoke00000000000000 \
  -e IDBOTS_GATEWAY_SECRET=test-secret \
  -p 127.0.0.1:8790:8790 \
  registry.cn-hongkong.aliyuncs.com/idbots/tenant:<tag>

node deploy/tenant-image/smoke-test.mjs http://127.0.0.1:8790 test-secret
docker rm -f idb-t_smoke
```
