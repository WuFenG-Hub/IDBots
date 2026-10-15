# 11 — WS-A Implementation Plan

**Party:** IDBots development. **Spec:** `10-ws-a-idbots-server-mode.md` (the
requirements win if this plan and the spec disagree). **Contracts:** C1, C2,
and `02`, frozen at 1.0.0. **Accepted against:** AC-A-1 to AC-A-6, then the
Phase 1 scenarios in `60`.

The planning desk does not write this code. Implement on a branch plus a
worktree from `main`, per `AGENTS.md`. Do not push or merge until the owner
says so. The first task of every branch is to read `01` and `02` and file a
change request for anything that cannot be implemented as written.

Phase 0 reference, read-only: the archived branch `spike/linux-headless` at
`956f2b05` (`spikes/linux-headless/`), restored from the owner's git bundle or
patch-series tarball when needed. No file under `src/`, `dsh-runtime/`,
`SKILLs/`, or `scripts/` was changed there.

## Start now

Two branches in parallel. They touch different files.

### T1 — `feat/ipc-registry` (REQ-A-12, REQ-A-13, REQ-A-14)

Move IPC registration and renderer broadcast behind `registerIpcHandler` and
`broadcastToRenderers`. Desktop behavior stays the same. Land the REQ-A-13
audit (`docs/cloud-mobile/audits/invoke-event-shape.md`) in this branch.

Done when AC-A-1 passes on desktop and the delivery note maps every former
`ipcMain.handle` and `webContents.send` site to the new helpers.

### T2 — `feat/ipc-contract` (REQ-A-23, the data half of REQ-A-17)

`scripts/generate-ipc-contract.mjs` and the allowlist data that encodes `02`.
This branch does not enforce the allowlist at runtime (that is T3). Publish
`src/mobile/generated/ipc-contract.json` so WS-E can build against it.

Done when a test fails if the generated file is stale or a preload channel
has no tier. Hand the file path to the planning desk the day it exists; WS-E
is waiting on it.

## After T1 is merged

### T3 — `feat/gateway` (REQ-A-15 to REQ-A-22, REQ-A-24, REQ-A-25, REQ-A-29, REQ-A-30)

The gateway, including desktop dev mode (`IDBOTS_GATEWAY_DEV=1` on
`127.0.0.1:8790`). Enforce the allowlist from T2. Bundle channels may call a
local C4 stub until WS-D staging is up.

Done when `node cloud/conformance/run.mjs` passes against desktop dev mode
(AC-A-2, the desktop half) and AC-A-6 passes. Tell the planning desk: WS-E
can leave the mock bridge, and WS-B can point its proxy at a real gateway.

## After T3

### T4 — `feat/server-mode` (REQ-A-1 to REQ-A-11, REQ-A-31, REQ-A-32, REQ-A-33)

Server mode with no window, main-side bootstrap, and the three Phase 0
follow-ups: idle session ends within 10 minutes, no debugging port, start-up
jobs staggered. The REQ-A-2 audit
(`docs/cloud-mobile/audits/renderer-side-effects.md`) is part of this branch.
REQ-A-8 must retry a pending chain setup by itself when the gas sponsor
returns.

### T5 — `feat/tenant-image` (REQ-A-6, REQ-A-26, REQ-A-27, REQ-A-28)

`deploy/tenant-image/`. Entrypoint from the Phase 0 findings: clear stale
Xvfb locks, `--no-sandbox` on the Electron command line, no remote debugging
port, Debian `chromium`, shm 1g, memory limit 2304m. Can be drafted beside
T4 and finished when server mode boots.

Done when AC-A-3, AC-A-4, and AC-A-5 pass on the image. AC-A-5 includes one
web-search turn that forces the browser path (Phase 0 only proved the script
path). WS-C's CI pushes the image; this party does not open cloud accounts.

## Handback

One delivery note per branch: each REQ id, status, and evidence (test name or
log). Open S1 or S2 defects block acceptance.
