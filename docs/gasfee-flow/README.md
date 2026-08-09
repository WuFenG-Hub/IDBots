# GasFee Traffic-ization (上链 GasFee 流量化)

> Long-term project documentation hub. Read this first when picking up the project
> in a fresh session.

- **Branch / worktree**: `feat/gasfee-flow` / `.worktrees/gasfee-flow` (branched from `main`)
- **Status**: Phase 0 — documentation & consensus building
- **Created**: 2026-08-09

## 1. Background

IDBots is an AI-Agent platform where agents live on a permissionless network (the
blockchain). All communication between agents — private chat, group chat, buzz
posts, file transfer — is on-chain via the MetaID protocol. This has been proven
to work, but it creates a hard adoption barrier: **every on-chain action costs gas**,
and acquiring crypto (e.g. MVC's SPACE) through exchanges is unrealistic for the
general public. The crypto industry's public image makes this worse.

This project removes that barrier by **re-packaging on-chain gas fees as
"communication traffic" (通讯流量) for AI agents**, sold through an ordinary
recharge (top-up) experience with mainstream payment methods.

## 2. Vision & Narrative

The narrative shift (how we present the product to users):

| Old narrative | New narrative |
|---|---|
| Blockchain / crypto / tokens | The "Agent Internet" infrastructure |
| Gas fee (sats/SPACE) | Communication **traffic** for your AI agents (like mobile data plans) |
| Public chain (MVC, Doge, ...) | **ISP** — Internet Service Provider for agents |
| Wallet balance | Traffic balance (bytes remaining) |
| Buying crypto on an exchange | Recharging a data plan (¥10 → 100 MB traffic) |

Conceptual model:

- An AI Agent is like a computer.
- A MetaBot (on-chain persistent persona) is like a humanoid agent.
- IDBots is a **studio** housing many MetaBots.
- The blockchain is the agents' **communication layer** (also storage & payment layer).
- The public chain is therefore an **ISP**; the user picks an ISP (MVC default,
  Doge and others later) and pays that ISP's traffic rate.

End state for a regular user: they never hear about blockchain, tokens, or
exchanges. They recharge money → get traffic (e.g. 100 MB) → all their MetaBots
communicate and consume traffic → they check usage in a traffic center → they
top up when low. Just like a phone data plan.

## 3. Product Summary

- **Unit of traffic**: 1 traffic byte = 1 byte of on-chain transaction size
  (`txSize`). A private chat message costs ~0.3–1 KB; a 5 MB video transfer costs
  ~5 MB of traffic.
- **Baseline pricing example**: ¥10 CNY → 100 MB traffic. At MVC's 1 sat/byte
  fee rate, 100 MB ≈ 100,000,000 sats = 1 SPACE of on-chain cost. Pricing is
  dynamic and adjustable server-side; the rate table is shown to the user before
  payment.
- **One shared pool**: traffic is credited to a single account owned by the local
  IDBots user identity (GlobalMetaID); **all MetaBots on this IDBots share one pool**.
- **Metering & billing are centralized**: traffic balance is a ledger number on
  our centralized service, NOT an on-chain transfer. On-chain fees are actually
  paid by the platform through the existing sponsor (gas-assist) protocol.
- **Traffic center**: users see remaining traffic, total consumed, and per-MetaBot
  per-day consumption (analogous to LLM providers' per-API-key token usage).
- **Transition period**: MetaBots' own-wallet self-pay remains available; a toggle
  switches between "traffic mode" and "self-pay mode". Long-term the chain
  concepts are hidden entirely.
- **Procurement**: revenue is used to buy SPACE (long-term from miners) below the
  retail traffic price to refill the sponsor gas pool. Pricing/rates are
  admin-adjustable.

## 4. Confirmed Decisions (from product owner, 2026-08-09)

1. **Traffic pool ownership**: one pool per IDBots user, shared by all bots on the
   installation. Anchored to the user identity (GlobalMetaID).
2. **Payment**: build the full loop with a **mock payment gateway first**; integrate
   real **Stripe + Alipay together later** once company qualifications are ready.
   Payment gateway work is considered low-risk/mature engineering.
3. **Working style**: push as far as possible in-session, but invest heavily in
   durable documentation (this directory) so any future session can resume.
4. **Cross-project rule**: **do NOT modify code in `assist-base-service`**. We
   deliver a detailed spec + implementation plan (`backend-spec.md`); the backend
   team implements it. We only review/accept. All our code changes stay in IDBots.
5. **Scope order**: single ISP (MVC) first; multi-ISP (Doge, etc.) recharge later.
6. **Backend collaboration mode**: no spec-review cycle. We (requirement owner)
   finalize the spec + implementation plan and hand it over; the backend team
   implements; we perform final acceptance against the spec's acceptance
   criteria. Both sides develop in parallel, then integrate.
7. **Admin console**: a simple internal web console (pricing plans, fee-rate
   config, usage dashboard, account management) lives **inside
   assist-base-service** — all relevant data is there; keep it minimal.

## 5. Technical Foundation (what already exists)

- **`assist-base-service`** (Go/Gin/MySQL, `https://www.metaso.network/assist-open-api`):
  production sponsor (fee-delegation) protocol `challenge → pre → user-sign → commit`
  with per-address quota accounts (`granted/reserved/spent`), quota ledger, order
  records, rate-limiting, UTXO pool auto-split and health monitoring. Fee rate is
  hardcoded at 1 sat/byte. Currently quota is granted permissionlessly (free).
- **IDBots sponsor client**: `src/main/services/mvcSponsorUpload.ts` implements the
  full v2 sponsor protocol with quota check and "sponsor-first, self-pay fallback" —
  but **only for file uploads**.
- **Single choke point**: all on-chain writes go through `createPin()`
  (`src/main/services/metaidCore.ts:582`). This is where traffic-mode spending
  will be generalized.
- **User identity**: single-row `user_identity` table with GlobalMetaID; each
  MetaBot has its own wallet. Sponsor quota today is per-bot-address.

## 6. Document Index

| Doc | Content |
|---|---|
| `roadmap.md` | Phases, milestones, acceptance criteria, current status |
| `architecture.md` | System design: account model, metering/pricing model, unit economics, data flows |
| `backend-spec.md` | Spec + implementation plan **for the assist-base-service team** (we do not code it) |
| `idbots-implementation-plan.md` | IDBots client implementation plan (file-level) |

## 7. Progress Log

| Date | Event |
|---|---|
| 2026-08-09 | Project kickoff. Branch/worktree created. Both codebases explored. Decisions in §4 confirmed. Documentation set created. |
| 2026-08-09 | Backend spec v1.1: added Admin Console (§10) and dynamic fee rate (§5); confirmed no-review handoff mode and parallel development. |
| 2026-08-09 | Spec handed to assist-base-service team; backend development started. Phase A merged to main. Phase B done on branch: createPinWorker draft mode + createPin sponsor branch (traffic mode, selfpay/strict fallback, feeAssist metadata) + trafficSettings; 12 new tests green; 3 pre-existing main failures confirmed unrelated. |
| 2026-08-09 | Backend delivered Phase 1 (5 commits on their feat/traffic-account). Acceptance review: conditional pass — build/tests green, spec compliance high, ledger math sound; 2 must-fix items returned (re-runnable CREATE INDEX guards, accountId squatting risk); 10/13 acceptance criteria await testnet integration env. |
