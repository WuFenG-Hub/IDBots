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

- `[ ]` M1.1 Spec reviewed & accepted by backend team (we deliver `backend-spec.md`)
- `[ ]` M1.2 Traffic account + address binding + ledger implemented
- `[ ]` M1.3 Sponsor flow integration: `pre` resolves traffic account, reserve by
  estimated bytes; `commit` success deducts actual `txSize`; expiry/failure releases
- `[ ]` M1.4 Recharge orders + mock payment confirm + pricing table API
- `[ ]` M1.5 Usage APIs (balance, ledger paged, per-address per-day aggregation)
- `[ ]` M1.6 Admin console: pricing plans, dynamic fee rate, usage dashboard,
  account lookup, manual grants (backend-spec §10)
- `[ ]` M1.7 Deployed to testnet/staging, verified end-to-end with IDBots

**Acceptance**: against `backend-spec.md` acceptance criteria; an IDBots client
can bind, recharge (mock), spend traffic on real on-chain pins, and read usage.

---

## Phase 2 — IDBots: Generalize Sponsor to All On-Chain Writes

**Goal**: every `createPin()` (private/group chat, buzz, info pins, protocol pins,
files) can be paid from the traffic pool via the sponsor protocol, with self-pay
fallback. Fee-rate injection unified.

**Milestones**:

- `[ ]` M2.1 Reusable sponsor protocol client extracted (challenge/pre/sign/commit)
- `[ ]` M2.2 `createPinWorker` supports "build unsigned draft" mode
- `[ ]` M2.3 `createPin()` traffic-mode branch + self-pay fallback + toggle setting
- `[ ]` M2.4 Fee rate explicitly threaded through all createPin call sites
- `[ ]` M2.5 Tests: sponsor path for chat pins; fallback matrix

**Acceptance**: with traffic mode on and a funded pool, a bot can chat/buzz/upload
with zero wallet balance; with traffic exhausted it cleanly falls back or errors
per the toggle policy.

---

## Phase 3 — IDBots: Recharge Entry & Traffic Center UI

**Goal**: user-facing recharge flow (mock payment), pricing table display,
traffic balance, and per-bot/day usage views.

**Milestones**:

- `[ ]` M3.1 Traffic account service client (ensure account, bind bots, balance/usage)
- `[ ]` M3.2 Settings "Traffic" tab: pricing table + recharge flow (mock pay)
- `[ ]` M3.3 Traffic center: balance, ledger, per-bot daily usage
- `[ ]` M3.4 Traffic/self-pay toggle UI; low-balance & insufficient-traffic UX
- `[ ]` M3.5 Account binding automation: bind all local bot addresses to the user account

**Acceptance**: a fresh user can complete: see pricing → recharge ¥10 (mock) →
see 100 MB balance → send messages → watch per-bot usage update.

---

## Phase 4 — Real Payment Integration

**Goal**: replace mock gateway with Stripe + Alipay (both together), after company
qualifications are ready.

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

Phase 0 complete. Next: deliver `backend-spec.md` to the backend team for review
(Phase 1 M1.1), and start Phase 2 prep (sponsor client extraction can proceed in
parallel — it is purely client-side and useful regardless of backend timeline).
