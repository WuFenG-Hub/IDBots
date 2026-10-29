# 51 — WS-E Implementation Plan

**Party:** mobile client. **Spec:** `50-ws-e-mobile-client.md`. **Contracts:**
C2, C3, C4 through `bundle:*`, and `02`, frozen at 1.0.0. **Accepted
against:** AC-E-1 to AC-E-9 and scenarios A-01 to A-12 in `60` for Phase 1.
Shells and Square are Phase 2 (M4).

The planning desk does not write this code. One branch plus one worktree
from `main`, per `AGENTS.md`. Do not push or merge until the owner says so.
Read `02` first and file a change request if a screen needs a channel that
is not listed.

## Start now

### T1 — `feat/mobile-bridge` (REQ-E-1, REQ-E-8, REQ-E-18, REQ-E-25)

Package layout, `pnpm run dev:mobile`, and the mock bridge. Screens are not
required yet. The mock must be enough for the next branch to render login,
chat, tasks, and Me without a backend.

### T2 — `feat/mobile-p1-screens` (REQ-E-10 to REQ-E-15, REQ-E-19 to REQ-E-21)

Phase 1 screens on the mock bridge: login, shell, chat, tasks, Me, recharge.
Recharge calls the mock and renders the Alipay hand-off states. The iOS
shell hides recharge; the web app keeps it. Login detects an in-app WeChat
or QQ browser and tells the user to open the system browser.

Done when the screens can be clicked through on the mock and the build stays
inside the size budgets. Acceptance will look at this before the real
gateway exists.

## As soon as WS-A T2 publishes `ipc-contract.json`

### T3 — gateway client (REQ-E-2 to REQ-E-7, REQ-E-9, REQ-E-26)

Real shim, resync, uploads, local file URLs. `dev:mobile` proxies to a
desktop gateway when WS-A T3 is up; until then the tests use a local fixture
server that speaks C2.

Done when AC-E-2 passes against desktop dev mode.

## After WS-B staging and WS-D staging

### T4 — end to end on staging

Replace the mocks. Phase 1 device pass (REQ-E-27, the M3 half): iPhone
Safari, and Android Chrome on Xiaomi, Huawei, and OPPO or vivo.

## Native shells and remaining Phase 2 scope

### T5 — P2 features plus the native-shell packages (REQ-E-16, REQ-E-17, REQ-E-22 to REQ-E-24)

Square, Buzz, private chat, and mnemonic export remain Phase 2 feature work.
The detailed native package is [`native-shell/README.md`](native-shell/README.md).
It splits the Capacitor shell into NS0–NS3 so native code development can run
in parallel with PWA staging acceptance; native release acceptance remains
gated on the core M3/M4 journeys. The APK can be signed as soon as the ops
checklist has the Android keystore. TestFlight waits on the Apple Developer
account. Do not submit to the public App Store in this release.

## Handback

A delivery note per branch: each REQ id, status, and evidence. For T2,
include a short recording or screenshots of the mock click-through. No
session cookie or phone number in the note.
