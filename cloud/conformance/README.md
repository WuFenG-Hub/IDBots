# Gateway Conformance Kit (REQ-A-30)

A runnable suite that checks the C2 gateway contract against **any** running
gateway: the desktop app in gateway dev mode, a tenant container (C1 server
mode), or — later — the WS-B control plane (`/ws` proxy).

It speaks the real wire protocol: the WebSocket invoke/result/event frames
from C2 plus the HTTP routes (`/healthz`, `/readyz`, upload, signed file
download). One line per check:

```
PASS|FAIL|SKIP <name> — <detail>
```

The process exits non-zero if any check FAILs (SKIP never fails the run).

## Usage

```
node cloud/conformance/run.mjs \
  --url ws://127.0.0.1:8790/gateway/v1/ws \
  --secret <gateway-secret> \
  [--tenant <tenant-id>] [--timeout-ms 20000]
```

- `--url` — the tenant's C2 WebSocket endpoint (through the control plane
  later, this becomes its public `/ws` URL; the kit derives the HTTP origin
  from it for the file/upload checks).
- `--secret` — the gateway secret (`IDBOTS_GATEWAY_SECRET`). It comes from
  argv only and is never printed.
- `--tenant` — optional; when given, the `welcome` frame's `tenantId` must
  match it.
- `--timeout-ms` — per-invoke timeout and the event-delivery window
  (default 20000).

The only dependency is `ws`. The kit imports it through `createRequire` from
its own location, so it resolves `ws` from the nearest `node_modules` walking
up from this file — in-tree that is the repo root's `node_modules`; copied
next to any other checkout or install that has `ws`, it keeps working with no
build step.

## Checks

1. **auth** — WS upgrade without the secret header → HTTP 401; with a wrong
   secret → HTTP 401.
2. **welcome** — the first frame is `welcome` with `v:1`, `contractVersion`,
   `appVersion`, `tenantId`, numeric `serverTime`, boolean `ready`, string
   `phase` (and `tenantId` matches `--tenant` when provided).
3. **invoke-allowed** — `app:getVersion` returns `ok:true`.
4. **invoke-denied** — `cowork:session:exportTranscript` (tier N) and
   `window:isMaximized` (tier S) both → `CHANNEL_NOT_ALLOWED`.
5. **invoke-not-found** — always SKIP: a correct server has no allowlisted
   but unregistered channel (`CHANNEL_NOT_FOUND` is covered by
   `tests/gatewayServer.test.mjs`).
6. **arg-restricted** — `cowork:session:start` with `{ cwd: '/etc' }` →
   `ARG_RESTRICTED` (AC-A-6 negative).
7. **payload-limit** — an invoke frame over 1 MiB → `PAYLOAD_TOO_LARGE`
   result, and the socket stays usable (`app:getVersion` still answers).
8. **file-roundtrip** — `POST /upload` a small text file → `gateway:file:sign`
   the returned path → `GET` the signed URL (both `/files/{token}` and
   `/gateway/v1/files/{token}` URL forms are resolved) → bytes identical
   (sha256); a tampered token → 404; `Range: bytes=0-3` → 206.
9. **upload-limits** — `POST /upload` with an `.exe` name → 415. (The 413
   size limit is covered by unit tests; the kit deliberately does not ship a
   25 MB body.)
10. **event-during-chat** — `cowork:session:start` with a trivial prompt;
    PASS when any `cowork:stream:*` event frame arrives within the window
    (error events count — they prove event delivery). When session start
    itself fails with a provider/config error (no LLM configured), the check
    SKIPs with the reason.
11. **reconnect-resync** — a second socket is welcomed, closed, and a
    reconnect is welcomed again; then `mobile:permission:listPending` and
    `cowork:stream:liveContent` (with bogus ids — a result, not a crash)
    both answer.
12. **invoke-timeout** — real check when the target enables the
    conformance-only test hook (`IDBOTS_GATEWAY_TEST_HOOKS=1`): the virtual
    `__test:sleep` channel (1.5 s timeout) is invoked with a 5 s sleep and must
    answer `TIMEOUT`; the PASS line carries the measured elapsed time. When the
    target has no test hook, the kit prints
    `SKIP(not-covered): invoke-timeout …` — explicitly **not covered**, never a
    pass. The test hook is not part of the frozen allowlist and must stay off
    in production.

## Running against desktop dev mode

The desktop app starts the gateway only when explicitly asked (REQ-A-22).
From the repo root, with an **isolated** user-data dir so the dev run cannot
touch your real data:

```bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" --no-use && nvm use 24

export IDBOTS_USER_DATA_PATH=/tmp/idbots-gateway-dev-data
export IDBOTS_GATEWAY_DEV=1
export IDBOTS_GATEWAY_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
export IDBOTS_GATEWAY_PORT=8790
# Optional, enables the __test:sleep hook so invoke-timeout really runs:
export IDBOTS_GATEWAY_TEST_HOOKS=1
export IDBOTS_GATEWAY_TEST_SLEEP_TIMEOUT_MS=1500

pnpm run electron:dev
```

Then, once the log prints `[Gateway] listening on http://127.0.0.1:8790`:

```bash
node cloud/conformance/run.mjs \
  --url ws://127.0.0.1:8790/gateway/v1/ws \
  --secret "$IDBOTS_GATEWAY_SECRET" \
  --tenant t_dev_local
```

Notes:

- Desktop dev mode binds `127.0.0.1` only and never starts in packaged
  builds; the tenant id defaults to `t_dev_local`.
- Set `IDBOTS_USER_DATA_PATH` **before** the first launch and point it at an
  empty directory; `configureUserDataPath()` picks it up so the store,
  skills, and settings of that run live there.
- The `event-during-chat` check needs a configured model route; a fresh
  isolated data dir with no provider configured SKIPs that check (as
  documented above).

## Running against a tenant container (later)

Start the tenant with the C1 environment (`IDBOTS_SERVER_MODE=1`,
`IDBOTS_TENANT_ID`, `IDBOTS_GATEWAY_SECRET`, and the `/data` volume), wait
for `GET /readyz` to return ready, then point the kit at the forwarded port:

```bash
node cloud/conformance/run.mjs \
  --url ws://127.0.0.1:<forwarded-port>/gateway/v1/ws \
  --secret "$IDBOTS_GATEWAY_SECRET" \
  --tenant "$IDBOTS_TENANT_ID"
```

Against a real tenant, every check is expected to PASS, including
`event-during-chat` (the tenant bootstrap configures the twin MetaBot's LLM
route before reporting ready).

When WS-B's control plane is up, the same kit runs through its public `/ws`
route (cookie auth is WS-B's side; the kit still sends the gateway secret
header the control plane adds upstream — see REQ-B-23).
