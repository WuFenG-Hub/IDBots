# 21 — WS-B Implementation Plan

**Party:** control-plane development. **Spec:** `20-ws-b-control-plane.md`.
**Contract:** C3, frozen at 1.0.0. Consumes C1 and C2. **Accepted against:**
AC-B-1 to AC-B-6, then scenarios A-01, A-02, A-08 in `60`.

The planning desk does not write this code. One branch plus one worktree
from `main`, per `AGENTS.md`. Do not push or merge until the owner says so.
Read `01` first and file a change request for anything that cannot be
implemented as written.

Build the fake tenant yourself (REQ-B-21). Do not wait for the WS-A image.

## Start now

### T1 — `feat/control-plane` (REQ-B-1 to REQ-B-5, REQ-B-21, REQ-B-22)

Package, Dockerfile, SQLite migrations, configuration, and the fake tenant.
Unit tests for rate limits, invite consumption, redeem-code assignment,
cookies, Origin checks, and secret encryption.

SMS mode `fake` with `CP_FAKE_SMS_NUMBERS` is enough. Real SMS waits on
`15-ops-procurement.md` (signature and templates). Do not block T1 on it.

Done when the package runs locally against the fake tenant and the README
explains that loop.

### T2 — same branch or `feat/control-plane-auth` (REQ-B-6 to REQ-B-12, REQ-B-18)

Invite login, provisioning, the tenant status machine, upgrade and rollback,
and the admin CLI, all against the fake tenant. Redeem codes are assigned
one per user; an empty pool alerts and does not hand out a code twice.

Done when a scripted phone can sign up, get a fake tenant, disconnect, and
reconnect to the same tenant.

## After WS-A T3 (desktop gateway) and in parallel with the rest

### T3 — `feat/control-plane-proxy` (REQ-B-13 to REQ-B-20)

Proxy `/ws`, files, upload, and `/app`. Re-verification and deletion request.
Login page can be a placeholder until WS-E's `dist-mobile-login/` exists
(REQ-B-19).

## After WS-A T5, WS-C staging, and the ops checklist through staging

### T4 — staging integration (REQ-B-23, AC-B-1 to AC-B-6)

Point provisioning at the real tenant image. Run the conformance kit through
the public `/ws`. Real SMS replaces fake mode for the one real-phone pass;
fake numbers stay available for the rest.

## Handback

A delivery note per branch: each REQ id, status, and evidence. No secret,
invite code, or full phone number in the note.
