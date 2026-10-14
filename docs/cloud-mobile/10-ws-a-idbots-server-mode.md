# 10 — WS-A: IDBots Server Mode and Gateway

**Party:** IDBots development party. **Repository:** IDBots (this repo).
**Implements:** C1 (tenant runtime) and C2 (gateway protocol) in
`01-interface-contracts.md`, and the allowlist in `02-ipc-allowlist-v1.md`.
**Consumers:** WS-B (control plane), WS-C (runs the image), WS-E (mobile
client).

## Goal

The same IDBots codebase runs either as today's desktop app or, with
`IDBOTS_SERVER_MODE=1`, as a headless per-user backend in a Linux container
that serves the gateway protocol. Desktop behavior does not change.

## Background You Need

- Read `AGENTS.md` and `CLAUDE.md` at the repository root (branching,
  worktrees on the external SSD, pnpm only, DSH runtime rules, database
  safety, verification gates).
- Read the design spec sections "Tenant Server Mode and Remote Gateway" and
  "Security and Custody"
  (`docs/superpowers/specs/2026-10-14-mobile-cloud-design.md`).
- Read the Phase 0 report (`spikes/linux-headless/PHASE0_REPORT.md` once
  delivered). Its "Required App Changes" and "Tenant Image Requirements"
  sections are inputs to REQ-A-6 and REQ-A-26.

Current facts:

- `src/main/main.ts` registers 312 IPC handlers with `ipcMain.handle`; five
  service files register 30 more (`services/trafficAccountService.ts` 18,
  `services/metabotWalletIpc.ts` 4, `services/feeRateStore.ts` 4,
  `services/llmRelayService.ts` 3, `services/jevRelayService.ts` 1).
- Main-to-renderer events are sent through 54 `BrowserWindow.getAllWindows()`
  calls and 51 `webContents.send` calls spread over `main.ts`,
  `libs/scheduler.ts`, `skillManager.ts`, `metaAppManager.ts`,
  `libs/coworkOpenAICompatProxy.ts`, and the Bot Browser services.
- 22 handlers in `main.ts` (and 2 sites in `im/feishuGateway.ts`) use
  `event.sender` or `BrowserWindow.fromWebContents`.
- The main window runs with `sandbox: true`, `contextIsolation: true`, and
  `nodeIntegration: false`. A sandboxed preload cannot `require` local
  modules, so the preload cannot import a shared contract module at runtime.
- On a fresh install the renderer (`src/renderer/services/llmFreeQuotaBootstrap.ts`,
  called from `App.tsx`) bootstraps the free LLM provider; the twin MetaBot is
  created by `WelcomeFlow` after a user click; `src/main/libs/welcomeBootstrap.ts`
  holds the welcome logic used by the runner.
- Tray (`trayManager.ts`), auto-launch (`autoLaunchManager.ts`), the sleep
  guard, and `app.on('window-all-closed')` (quits on Linux) are desktop
  behaviors.
- `sanitizeIpcPayload` and `readCoworkStreamLiveContent` already exist in
  `main.ts` and are reused by the gateway.

## Requirements

### Server Mode Runtime

- **REQ-A-1 Mode switch.** `IDBOTS_SERVER_MODE=1` enables server mode; when
  unset, every code path behaves exactly as today. Server-mode code lives
  under `src/main/server/` and is entered from a small number of guarded
  branches in `main.ts`.
- **REQ-A-2 No renderer window.** Server mode creates no `BrowserWindow`, does
  not quit when no window exists, and never waits for
  `startup:rendererInitialized`. Before implementing, produce an audit
  (`docs/cloud-mobile/audits/renderer-side-effects.md`) of every startup or
  periodic side effect that today runs in the renderer (for example free-quota
  provisioning) and state for each whether server mode must run it main-side.
  Each "must" becomes part of REQ-A-8. If Phase 0 shows Electron cannot run
  without a window in the chosen display mode, use one hidden window that
  loads nothing and record why.
- **REQ-A-3 Graceful shutdown.** On `SIGTERM` and `SIGINT`: close gateway
  sockets with code 4012, stop accepting invokes, let running turns reach a
  checkpoint or stop them through the existing stop path, flush SQLite, stop
  the DSH runtime and other child processes, and exit within 20 s.
- **REQ-A-4 Desktop subsystems off.** Server mode skips tray, auto-update,
  auto-launch registration, sleep guard, power guard, global shortcuts,
  application menu, and `desktopCapturer`.
- **REQ-A-5 Desktop-only features off.** Bot Browser, screenshot tools,
  MetaApps local open, calendar tools, local project folders, MCP local
  servers, and the Docker sandbox execution mode are disabled. Agent tools
  that depend on them are not offered to the model in server mode.
- **REQ-A-6 Linux display strategy.** Use the display mode Phase 0
  recommends (Xvfb or `--ozone-platform=headless`) and apply every item in the
  report's "Required App Changes" as proper, tested code (not the spike
  patches).
- **REQ-A-7 Paths.** Data paths come from C1 (`/data/userdata`,
  `/data/appdata`, `/data/workspace`). The cowork working directory defaults to
  `/data/workspace` and every R-cwd and R-path rule in `02` is enforced in the
  gateway layer before the handler runs.
- **REQ-A-8 Server bootstrap.** On every start, a main-side state machine
  brings the tenant to ready. Steps, in order, each idempotent and recorded in
  the database so an interrupted bootstrap resumes:
  1. `identity` — create the user identity with
     `IDBOTS_BOOTSTRAP_DISPLAY_NAME` if none exists.
  2. `llmProvider` — bootstrap the Metaso relay (`metaid-free`) and make it the
     default provider if no provider is configured.
  3. `twinMetabot` — create the twin MetaBot on-chain (same code path as
     `idbots:createMetaBotOnChain`, with the default persona in the user's
     locale) if no twin exists; resume a pending chain setup if one exists.
  4. `workspace` — set the cowork working directory to `/data/workspace`.
  5. `trafficAccount` — ensure the traffic account, bind all bots, claim the
     free grant if available, and set fee mode to traffic sponsorship.
  6. `redeemCode` — apply `IDBOTS_BOOTSTRAP_TRAFFIC_REDEEM_CODE` once.
  7. Start the MetaWeb listener so private chats and Gig Square orders are
     received while no phone is connected.
  Failures in steps 1–4 set phase `failed` (retried with backoff, at most
  every 5 minutes); failures in 5–6 set `degraded`. Locale comes from
  `IDBOTS_BOOTSTRAP_LOCALE`.
- **REQ-A-9 Health endpoints.** `/healthz` and `/readyz` exactly as C1.
- **REQ-A-10 Logging.** In server mode, logs go to stdout as JSON lines (C1),
  with secrets, mnemonics, phone numbers, and message contents removed.
- **REQ-A-11 Permissions while disconnected.** Background sessions (scheduled,
  long-term, IM, A2A, Gig Square) use the existing unattended policy and never
  wait. User-started sessions wait for an answer; pending requests are kept so
  `mobile:permission:listPending` can return them after a reconnect.

### IPC Registry and Broadcast

- **REQ-A-12 Registry.** Add `registerIpcHandler(channel, handler)` in
  `src/main/ipc/registry.ts`. It calls `ipcMain.handle` (desktop behavior
  unchanged) and stores the handler in a map that the gateway can call. Replace
  all 342 registrations in `main.ts` and the five service files. A test fails
  if any `ipcMain.handle(` call remains outside the registry.
- **REQ-A-13 Invoke event shape.** Gateway calls pass a synthetic event
  `{ sender: null, senderFrame: null, gateway: { clientId } }`. Review the 24
  `event.sender` / `fromWebContents` sites: each handler either works with the
  synthetic event or is not allowlisted. Record the review in
  `docs/cloud-mobile/audits/event-sender-review.md`.
- **REQ-A-14 Broadcast.** Add `broadcastToRenderers(channel, ...args)` in
  `src/main/ipc/broadcast.ts`. It sends to every live window (desktop) and to
  every connected gateway client when the channel is an allowlisted event
  (server mode, with the R-store filter for `store:changed`). Replace every
  existing broadcast site. Sends to one specific window (Bot Browser bridges)
  stay as they are and are documented as desktop-only.

### Gateway

- **REQ-A-15 Server.** HTTP and WebSocket server on
  `0.0.0.0:{IDBOTS_GATEWAY_PORT}` in server mode only, implementing every C2
  route. Secret check in constant time. Built on Node's `http` module plus one
  small, maintained WebSocket library (for example `ws`); no web framework.
- **REQ-A-16 Protocol.** Frames, error codes, limits, keepalive, and close
  codes exactly as C2. Unit tests cover each error code.
- **REQ-A-17 Allowlist.** `src/main/gateway/allowlist.ts` encodes `02`
  (channel → tier, restriction, timeout). `IDBOTS_GATEWAY_TIER` selects the
  highest tier. The tests listed at the end of `02` pass.
- **REQ-A-18 Files.** `gateway:file:sign` and the download route as C2:
  realpath confinement to `/data`, HMAC tokens bound to the tenant, 10-minute
  expiry, `Range` support, correct `Content-Type`.
- **REQ-A-19 Upload.** Upload route as C2: 25 MB limit, sanitized names,
  executable types refused, stored under `/data/workspace/uploads/`.
- **REQ-A-20 Sensitive route.** Reveal-mnemonic route as C2: verifies the
  reverify token (HMAC, tenant, purpose, expiry, single-use nonce), returns the
  mnemonic with `Cache-Control: no-store`, writes an audit line without the
  mnemonic.
- **REQ-A-21 Static bundle.** Serve `dist-mobile/` at `/app/` with the cache
  headers in C2.
- **REQ-A-22 Desktop dev mode.** `IDBOTS_GATEWAY_DEV=1` on a normal desktop
  run starts the gateway on `127.0.0.1:8790` with the secret from
  `IDBOTS_GATEWAY_SECRET` (or a printed random one), next to the normal
  window. Events go to both. This lets WS-E develop against a real backend
  without containers. It is never enabled in packaged desktop builds unless
  the variable is set.

### Contract and Facades

- **REQ-A-23 Contract generator.** `scripts/generate-ipc-contract.mjs` parses
  `src/main/preload.ts` with the TypeScript compiler API and writes
  `src/mobile/generated/ipc-contract.json`: for every exposed method its path
  (for example `cowork.startSession`), kind (`invoke`, `on`, or `send`),
  channel, and how arguments are forwarded. Wrappers it cannot classify are
  listed as `custom` and fail the run unless listed in an explicit override
  file. A test fails when the generated file is stale or when a channel has no
  tier in the allowlist. The preload stays the single source of truth because
  it cannot import shared modules at runtime.
- **REQ-A-24 New channels.** Implement `gateway:file:sign`,
  `mobile:permission:listPending`, `mobile:bootstrap:status`, and
  `bundle:getPlans`, `bundle:createOrder`, `bundle:getOrder`, `bundle:getMeters`
  (C4 calls signed with the user identity, reusing the signer in
  `trafficAccountService.ts`). Add the matching preload methods so desktop can
  use them too. `bundle:*` works against a local C4 stub until WS-D staging is
  available.
- **REQ-A-25 Quota exhausted.** When the relay returns `QUOTA_EXHAUSTED`
  (C4), the cowork stream error carries a stable code
  (`metadata.errorCode = 'LLM_QUOTA_EXHAUSTED'`) so desktop and mobile can show
  a recharge action instead of a raw error.

### Tenant Image

- **REQ-A-26 Dockerfile.** `deploy/tenant-image/Dockerfile`, multi-stage:
  build stage (pnpm install with the frozen lockfile, renderer build, Electron
  compile, skills build, and `pnpm run build:mobile` once WS-E has added that
  script) and a runtime stage without compilers.
  Runtime contains the dependencies from the Phase 0 report, the pptx skill's
  npm dependencies, the Playwright Chromium build, and CJK fonts. Runs as uid
  1000, `HEALTHCHECK` on `/healthz`, labels from C1. The kernel-patch check
  (`node scripts/apply-dsh-kernel-patches.cjs --check`) and
  `pnpm run check:dsh-deps` run during the build and fail it on error.
- **REQ-A-27 Versioning.** Image tag `{appVersion}-{commit7}`; `/readyz` and
  the `welcome` frame report the same version and contract version. Each
  release note states `org.idbots.rollback-safe-to`.
- **REQ-A-28 Migrations.** No change in this workstream deletes or resets user
  data. Any schema change ships with an idempotent first-run migration, as for
  desktop auto-updates.

### Tests and Tooling

- **REQ-A-29 Unit and integration tests** (node tests under `tests/`):
  registry completeness; allowlist tiers and restrictions; frame codec and
  error codes; file token signing, expiry, tenant binding, and path
  confinement (including symlink escape); reverify token validation and nonce
  reuse; upload limits; server bootstrap resume after a simulated crash at each
  step.
- **REQ-A-30 Gateway conformance kit.** `cloud/conformance/` contains a
  runnable suite (`node cloud/conformance/run.mjs --url ws://… --secret …`)
  that checks C2 behavior against any running gateway: welcome frame, an
  allowed and a denied channel, an invoke timeout, payload limit, event
  delivery during a chat turn, file sign and download, upload, and reconnect
  resync. WS-B runs it through the control plane; WS-E uses it to check the
  staging tenant.

## Deliverables

1. Branches following `AGENTS.md`, merged only on the owner's instruction:
   - `feat/ipc-registry` (REQ-A-12 to A-14) — lands first; it is a pure
     refactor and is verified on desktop.
   - `feat/gateway` (REQ-A-15 to A-25, A-29, A-30) — includes desktop dev mode.
   - `feat/server-mode` (REQ-A-1 to A-11) and `feat/tenant-image`
     (REQ-A-26 to A-28).
2. The two audit documents named in REQ-A-2 and REQ-A-13.
3. Tenant image pushed to the staging registry by WS-C's CI.
4. A delivery note per branch listing each requirement with evidence.

## Acceptance Criteria

- **AC-A-1** Desktop regression: on macOS and Windows packaged builds, a
  smoke run (onboarding, chat with a skill, scheduled task, Gig Square list,
  Bot Browser open) behaves as before; all node tests, lint, Electron compile,
  and skills build pass.
- **AC-A-2** `node cloud/conformance/run.mjs` passes against a tenant
  container started with C1 settings, and against desktop dev mode.
- **AC-A-3** A fresh tenant container reaches `/readyz` ready within 300 s;
  a restart reaches it within 90 s; killing the container during each
  bootstrap step and restarting completes bootstrap with exactly one twin
  MetaBot.
- **AC-A-4** `docker stop -t 30` exits in under 20 s with SQLite
  `PRAGMA integrity_check` returning `ok`.
- **AC-A-5** Idle memory of a server-mode tenant is at or below the Phase 0
  idle number (no renderer window should make it lower); peak during the
  docx skill stays under `tenantMemoryLimitMB`.
- **AC-A-6** Security tests: a call to every N channel returns
  `CHANNEL_NOT_ALLOWED`; R-path and R-cwd negatives return `ARG_RESTRICTED`;
  a file token from tenant A fails on tenant B; a reused reverify nonce fails;
  no API key appears in any gateway response or log.
- **AC-A-7** The contract generator test fails when a preload channel is added
  without a tier, and passes on `main`.

## Out of Scope

Control-plane logic (WS-B), host networking and backups (WS-C), Metaso server
changes (WS-D), mobile UI (WS-E), KMS encryption of mnemonics, push
notifications, idle sleep and wake of tenants.
