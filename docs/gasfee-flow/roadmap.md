# Roadmap — Phases, Milestones, Acceptance Criteria

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done

Working agreements:

- Backend (`assist-base-service`) work is delivered **as spec only** — see
  `backend-spec.md`. We never modify that repository.
- Mock payment first; real Stripe/Alipay later, both together.
- MVC single-ISP first; multi-ISP later.

---

## Phase 0 — Consensus & Documentation `[x]`

**Goal**: shared understanding of background, vision, goals, and plans, durable
across sessions.

**Deliverables**: this documentation set (`README.md`, `roadmap.md`,
`architecture.md`, `backend-spec.md`, `idbots-implementation-plan.md`).

**Acceptance**: product owner confirms the docs match their intent.

---

## Phase 1 — Backend: Traffic Account & Metering (spec → review)

**Goal**: `assist-base-service` gains a user-dimension traffic account, metering
by `txSize`, recharge orders (mock payment), and usage-statistics APIs.

**Milestones**:

- `[x]` M1.1 Spec reviewed & accepted by backend team (we deliver `backend-spec.md`)
- `[x]` M1.2 Traffic account + address binding + ledger implemented
- `[x]` M1.3 Sponsor flow integration: `pre` resolves traffic account, reserve by
  estimated bytes; `commit` success deducts actual `txSize`; expiry/failure releases
- `[x]` M1.4 Recharge orders + mock payment confirm + pricing table API
- `[x]` M1.5 Usage APIs (balance, ledger paged, per-address per-day aggregation)
- `[x]` M1.6 Admin console: pricing plans, dynamic fee rate, usage dashboard,
  account lookup, manual grants (backend-spec §10)
- `[x]` M1.7 Deployed to testnet/staging, verified end-to-end with IDBots
  (code review passed 2026-08-09; 2 must-fix items returned to backend; 10/13
  acceptance criteria need the integration env)
  → done 2026-08-10: backend instance at http://47.76.58.120:7882; all 13
  acceptance criteria verified live (§9.1-9.13) via `scripts/traffic-e2e/`;
  §9.9 (enabled=false) covered by backend unit tests (config-side).

**Acceptance**: against `backend-spec.md` acceptance criteria; an IDBots client
can bind, recharge (mock), spend traffic on real on-chain pins, and read usage.

---

## Phase 2 — IDBots: Generalize Sponsor to All On-Chain Writes

**Goal**: every `createPin()` (private/group chat, buzz, info pins, protocol pins,
files) can be paid from the traffic pool via the sponsor protocol, with self-pay
fallback. Fee-rate injection unified.

**Milestones**:

- `[x]` M2.1 Reusable sponsor protocol client extracted (challenge/pre/sign/commit)
- `[x]` M2.2 `createPinWorker` supports "build unsigned draft" mode
- `[x]` M2.3 `createPin()` traffic-mode branch + self-pay fallback + toggle setting
- `[ ]` M2.4 Fee rate explicitly threaded through all createPin call sites
  → ready to start; work items in `m2-4-fee-rate-threading.md`
- `[x]` M2.5 Tests: sponsor path for chat pins; fallback matrix

**Acceptance**: with traffic mode on and a funded pool, a bot can chat/buzz/upload
with zero wallet balance; with traffic exhausted it cleanly falls back or errors
per the toggle policy.

---

## Phase 3 — IDBots: Recharge Entry & Traffic Center UI

**Goal**: user-facing recharge flow (mock payment), pricing table display,
traffic balance, and per-bot/day usage views.

**Milestones**:

- `[x]` M3.1 Traffic account service client (ensure account, bind bots, balance/usage)
- `[x]` M3.2 Settings "Traffic" tab: pricing table + recharge flow (mock pay)
- `[x]` M3.3 Traffic center: balance, ledger, per-bot daily usage
- `[x]` M3.4 Traffic/self-pay toggle UI; low-balance & insufficient-traffic UX
- `[x]` M3.5 Account binding automation: bind all local bot addresses to the user account

**Acceptance**: a fresh user can complete: see pricing → recharge ¥10 (mock) →
see 100 MB balance → send messages → watch per-bot usage update.

---

## Phase 4 — Real Payment Integration

**Goal**: replace mock gateway with Stripe + Alipay (both together), after company
qualifications are ready. Detailed plan: `phase4-payment-plan.md`.

- `[ ]` M4.1 PaymentGateway adapter interface finalized (backend)
- `[ ]` M4.2 Stripe adapter + webhook verification
- `[ ]` M4.3 Alipay adapter + notify verification
- `[ ]` M4.4 Client payment UX for both providers; reconciliation tooling

**Acceptance**: real payment in sandbox/production-test mode credits traffic
exactly once (idempotent webhooks).

---

## Phase 5 — Procurement & Pricing Operations

**Goal**: close the economic loop — use revenue to buy SPACE below retail traffic
price and refill the sponsor gas pool; admin-adjustable pricing/rates.

- `[ ]` M5.1 Procurement ledger (purchase records, avg cost)
- `[ ]` M5.2 Gas pool health ↔ procurement alerts (extend existing `/v1/internal/gas/health`)
- `[ ]` M5.3 Admin pricing console (rate table, margin guardrails)

**Acceptance**: operators can see margin per MB sold vs procurement cost; pool
runway alerts trigger procurement.

---

## Phase 6 — Multi-ISP (Multi-Chain) Recharge

**Goal**: users pick an ISP (chain): MVC default; Doge and others with different
rates (e.g. ¥10 → 0.1 MB on Doge).

- `[ ]` M6.1 Chain-dimension pricing table
- `[ ]` M6.2 Per-chain traffic sub-balances or chain-tagged traffic
- `[ ]` M6.3 Sponsor/delegation support for non-MVC chains (Dogechain assist, etc.)
- `[ ]` M6.4 Client ISP picker

**Acceptance**: user chooses ISP at recharge and per-write routing follows the
selected ISP.

---

## Current Focus

Phases 0–3 complete and merged to `main` (through R1/R2 QA fixes, 2026-08-11).
Next, in order: M2.4 fee-rate threading (client, see
`m2-4-fee-rate-threading.md`); backend ledger `txId` request (sent, see
`backend-request-ledger-txid.md`); P2-03 production apiBase switch before
release; Phase 4 real payment once company qualifications land (see
`phase4-payment-plan.md`). Product-owner decision on record: no
group/task-level source labels in the ledger.
