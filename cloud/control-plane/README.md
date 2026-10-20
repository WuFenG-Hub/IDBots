# @idbots/control-plane

WS-B control plane for the IDBots cloud/mobile program. It owns users,
invites, and login; creates and manages one tenant container per user; and is
the only public entry to those containers. It implements contract **C3**
(control-plane public API), consumes **C1** (tenant runtime) and **C2**
(gateway protocol), and never reads user content.

This directory is its own pnpm package with its own lockfile (REQ-B-1): the
repository-root `pnpm install` does not install it.

## Layout

- `src/config.ts` — environment parsing/validation (`loadConfig`, pure)
- `src/ids.ts` — `u_`/`t_` id and invite-code generators
- `src/crypto.ts` — AES-256-GCM secret encryption, SHA-256, phone masking
- `src/db/` — better-sqlite3 open helper, WAL, versioned migrations
- `src/rateLimit.ts` — C3 SMS/verify rate-limit rules (pure, `now` injected)
- `src/cookies.ts` — `idb_session` cookie build/parse/clear
- `src/origin.ts` — Origin header checks for state-changing requests
- `src/sms.ts` — SMS provider interface, fake provider, code hashing
- `src/services/signup.ts` — invite-consuming sign-up transaction core
- `src/docker/client.ts` — Docker Engine API client (`ping` wired; rest stubbed)
- `src/server.ts`, `src/main.ts` — minimal node:http server and entry point

## Requirements

- Node.js `>=24 <25`
- pnpm `11.24.0` (pinned by the root; `corepack enable`)

## Install, build, test, lint

```sh
pnpm install                # generates pnpm-lock.yaml; builds better-sqlite3
pnpm build                  # tsc -> dist/
pnpm test                   # node:test via tsx (fresh temp SQLite per file)
pnpm lint                   # eslint flat config
pnpm start                  # node dist/main.js (after build)
```

## Configuration

All configuration comes from environment variables (WS-C provides an env
file). See REQ-B in `docs/cloud-mobile/20-ws-b-control-plane.md` for the
authoritative table.

| Variable | Meaning |
|----------|---------|
| `CP_PUBLIC_ORIGIN` | `https://app.{APP_DOMAIN}`; Origin checks and cookies |
| `CP_LISTEN` | public listen address (default `0.0.0.0:8080`) |
| `CP_METRICS_LISTEN` | internal metrics listen address (default `0.0.0.0:9100`) |
| `CP_DB_PATH` | SQLite file on a persistent volume |
| `CP_MASTER_KEY` | 32 bytes base64; AES-256-GCM key for gateway secrets and redeem codes |
| `CP_DOCKER_URL` | Docker Engine API, e.g. `http://docker-proxy:2375` or `http+unix:///var/run/docker.sock` |
| `CP_TENANT_IMAGE` | default tenant image tag |
| `CP_TENANT_NETWORK` | Docker network for tenants |
| `CP_TENANT_MEMORY_MB` | default `2304` (C1 resources) |
| `CP_TENANT_CPUS` | default `2` |
| `CP_TENANT_ENV_*` | extra env passed to every tenant (prefix stripped) |
| `CP_SMS_MODE` | `aliyun` or `fake` |
| `CP_SMS_ACCESS_KEY_ID`, `CP_SMS_ACCESS_KEY_SECRET`, `CP_SMS_SIGN_NAME`, `CP_SMS_TEMPLATE_LOGIN`, `CP_SMS_TEMPLATE_REVERIFY` | Alibaba Cloud SMS |
| `CP_FAKE_SMS_NUMBERS` | staging-only test numbers for the fixed code `246810` |
| `CP_ALERT_WEBHOOK` | Feishu/DingTalk webhook for provisioning and upgrade failures |

`CP_SMS_MODE=fake` refuses to start unless `CP_PUBLIC_ORIGIN` is
`localhost`, `127.0.0.1`, `[::1]`, or a `*.staging` origin.

Minimal local run (SQLite in /tmp, no docker required — `/health` reports
`docker: false` then):

```sh
CP_PUBLIC_ORIGIN=http://localhost:8080 \
CP_DB_PATH=/tmp/cp.sqlite \
CP_MASTER_KEY="$(node -e 'console.log(Buffer.alloc(32,7).toString("base64"))')" \
CP_DOCKER_URL=http+unix:///var/run/docker.sock \
CP_TENANT_IMAGE=example/idbots-tenant:0.1.0 \
CP_TENANT_NETWORK=idbots-tenants \
CP_SMS_MODE=fake CP_FAKE_SMS_NUMBERS=+8613900000000 \
pnpm start
```

## Dockerfile

`Dockerfile` is a multi-stage build: `node:24-bookworm-slim` build stage
(corepack pnpm, `pnpm install --frozen-lockfile`, `pnpm build`) and a runtime
stage with production `node_modules` only, running as uid 1000. It exposes
8080 (public) and 9100 (internal metrics). Image tagging
(`{REGISTRY}/idbots/control-plane:{version}-{commit7}`) is WS-C CI's job.

## Local loop with the fake tenant

> **TODO (lands with the fake tenant)** — per REQ-B-21, a fake tenant under
> `test/fake-tenant/` (C1 `/healthz` + `/readyz` with scripted phases, C2
> server) plus the docker harness will complete the local provisioning loop
> here. A later phase fills this section.

## Note

The package is not shipped in desktop builds; `electron-builder.json` does
not include `cloud/`. The root ESLint config ignores `cloud/**` and this
package lints itself (`pnpm lint`).
