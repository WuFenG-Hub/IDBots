# 41 — WS-D Implementation Plan

**Party:** Metaso `assist-base-service`. **Spec:** `40-ws-d-metaso-bundle.md`.
**Contract:** C4, frozen at 1.0.0. **Accepted against:** AC-D-1 to AC-D-14.

The planning desk does not change the Metaso repository. Implement there and
send a delivery note. Read C4 first. The partner-policy mechanism is the one
known follow-up: file it as change request CR-1 (C4 becomes 1.1.0) before M2.
Do not ship a different exhaustion signal. Desktop clients already depend on
HTTP 429 and `free_quota_exhausted`.

## Start now

### T1 — staging bundle, mock gateway (REQ-D-1 to REQ-D-5, REQ-D-7 to REQ-D-9, REQ-D-16, REQ-D-17)

Staging deployment with its own database. Plans, create-order, status,
Alipay notify path, exactly-once crediting, admin list. Mock gateway on for
staging tests. Seed a ¥0.01 acceptance plan and placeholder production plans
until the owner sets prices (`15-ops-procurement.md`).

**By 2026-10-23:** send WS-A and WS-B the staging base URL. They stub C4
until that URL exists.

### T2 — quota (REQ-D-10 to REQ-D-14)

Identity-bound pool, free then purchased, the three quota fields, the ledger,
and `quota_exhausted` for a used-up purchased pool. A second bootstrap must
not refill an empty pool. Phase 0 already saw this for the free allowance.

### T3 — redeem export (REQ-D-15)

Admin export of a single-use code batch as CSV, one code per line, for the
control plane to import.

## Before M2

### T4 — CR-1 partner policy (REQ-D-6)

At least 50 new identities per day and 500 in total from the staging, then
the production, egress IP. Phase 0 saw no limit at 7 identities from one
Hong Kong IP. State the current per-IP limits in the delivery note. The
staging egress IP arrives from WS-C T2.

## Before M3

### T5 — same-phone Alipay (REQ-D-19, REQ-D-18)

Confirm that a 当面付 code can be paid on the same phone. If it cannot, say
so in the delivery note; the fallback needs an ICP filing, which is an owner
decision in the ops checklist. Refunds stay manual.

## Handback

Delivery note in the Phase 5 style: each REQ-D item, evidence, and any delta
from C4. Deltas become change requests. No merchant private key in the note.
