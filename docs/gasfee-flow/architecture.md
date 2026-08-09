# Architecture — Traffic-ized Gas Fee System

## 1. Components

```
┌──────────────────────────┐         ┌────────────────────────────────┐
│ IDBots (Electron client) │         │ assist-base-service (backend)  │
│                          │         │                                │
│  MetaBot wallets (n)     │ sponsor │  Traffic account (1 per user)  │
│  User identity wallet(1) │ protocol│  Recharge orders / ledger      │
│  Traffic settings & UI   │────────▶│  Sponsor gas pool (on-chain)   │
│  createPin choke point   │  HTTPS  │  Pricing config                │
└──────────────────────────┘         └───────────────┬────────────────┘
                                                     │ gRPC
                                            ┌────────▼────────┐
                                            │ asset-base / MVC │
                                            │ node (broadcast) │
                                            └─────────────────┘
        ┌──────────────────┐
        │ Payment gateways │  mock now; Stripe + Alipay later
        └──────────────────┘
```

Roles:

- **IDBots**: builds unsigned txs, signs user inputs, drives the sponsor protocol,
  owns all user-facing UX (recharge, traffic center, toggle). Never pays gas from
  bot wallets in traffic mode.
- **assist-base-service**: centralized traffic ledger + sponsor. Holds the gas
  pool private keys, co-signs and broadcasts sponsored txs, deducts traffic.
- **Payment gateway**: external money rail. Mock implementation first.
- **Chain (MVC)**: the ISP. Only the backend talks to it.

## 2. Account Model

### 2.1 Entities

- **TrafficAccount** — one per user, keyed by the user identity's **GlobalMetaID**
  (also resolvable to the identity MVC address). Balance is denominated in
  **traffic bytes**.
- **AddressBinding** — links a MetaBot MVC address to a TrafficAccount. All spend
  from any bound address draws from the same pool. Binding requires cryptographic
  proof (see §7.2).
- **TrafficLedger** — append-only ledger: every grant (recharge, promo, admin)
  and every deduction (sponsored tx) is an entry with idempotency keys.
- **RechargeOrder** — money → traffic purchase record, linked to a payment
  gateway transaction.
- **PricingPlan** — the public rate table (currency → bytes), admin-adjustable.

### 2.2 Why GlobalMetaID, not per-bot

Confirmed decision: one pool per IDBots user, shared by all bots. GlobalMetaID is
already the user-level identity in IDBots (single-row `user_identity`); bot
wallets are derived separately. Binding bot addresses to the user account keeps
the on-chain addressing unchanged while making billing user-dimension.

### 2.3 Relationship to the existing quota system

Today the sponsor service keeps **per-address quotas in sats**
(`tb_assist_address.granted/reserved/spent`), granted permissionlessly. The new
model adds a **user-dimension balance in bytes** checked *before* the legacy
quota:

1. Traffic account balance (bytes) — the paid pool. Primary path.
2. Legacy granted quota (sats) — retained during transition as a free tier /
   fallback; can be disabled by config once traffic mode is GA.

Reserve → spend/release semantics mirror the existing quota flow exactly, just
in a second currency (bytes).

## 3. Metering & Pricing Model

### 3.1 Unit definitions

- **Traffic byte**: 1 byte of final on-chain transaction size (`txSize` of the
  broadcast tx). What the user buys and what we deduct.
- **Chain cost (sats)**: `txSize × feeRate`. What the platform actually pays.
- At MVC's current `feeRate = 1 sat/byte`, 1 traffic byte costs the platform
  1 sat; 100 MB = 100,000,000 sats = 1 SPACE.

### 3.2 Why balance is bytes, not sats

User-visible balance must be stable and intuitive ("how many MB do I have left"),
independent of chain fee fluctuations. If the chain fee rate rises, the platform
adjusts the **price table** (fewer bytes per ¥10) rather than re-denominating
existing balances. Margin lives in the pricing layer.

### 3.3 Deduction lifecycle (mirrors sponsor quota flow)

```
pre     → reserve  estimatedBytes (upper bound from unsigned draft)
commit  → spend    actualTxSize; release (estimatedBytes − actualTxSize)
expire/fail → release estimatedBytes
```

`txSize` is already recorded per order (`tb_assist_gas_record.txSize`), so actual
bytes are known exactly at commit time.

### 3.4 Unit economics (baseline example)

| Item | Value |
|---|---|
| Retail price | ¥10 → 100 MB traffic |
| Platform chain cost @1 sat/byte | 100 MB → 1 SPACE |
| Break-even SPACE price | ¥10 / SPACE |
| Margin lever | buy SPACE below ¥10 (miners/OTC) and/or adjust price table |

Dynamic pricing inputs: chain fee rate, SPACE procurement cost, pool runway,
fx rates. The public rate table endpoint always reflects current pricing.

## 4. Core Flows

### 4.1 Recharge (mock payment)

```
IDBots Settings → choose plan (e.g. ¥10 / 100 MB)
  → POST /v1/traffic/recharge/orders        { accountId, planId }
  ← { orderId, mockPaymentToken }
IDBots "pays" via mock gateway
  → POST /v1/traffic/recharge/orders/:id/mock-confirm (dev/staging only)
  ← order status: paid
Backend credits ledger: +100,000,000 bytes → balance updates
IDBots polls GET /v1/traffic/accounts/:id/balance (or order status) → shows new balance
```

Real gateways later slot in behind the same order model via webhook
(`/v1/traffic/payment/webhook/:gateway`, idempotent on gateway txn id).

### 4.2 Spend (traffic-mode on-chain write)

```
IDBots createPin(payload)
  traffic mode ON:
    1. build unsigned tx draft locally (worker "draft mode") → estimatedBytes
    2. GET /v2/assist/gas/mvc/challenge (existing)
    3. POST /v2/assist/gas/mvc/pre { address, rawTx, accountAuth }
        backend: resolve address → TrafficAccount → reserve estimatedBytes
        (insufficient → 4xx; client falls back per toggle policy)
    4. sign user inputs locally
    5. POST /v2/assist/gas/mvc/commit
        backend: validate template, co-sign sponsor inputs, broadcast,
        spend actualTxSize from TrafficAccount, write ledger
  fallback (per policy): legacy self-pay path (bot wallet pays fee), or hard error
```

### 4.3 Address binding

```
For each local bot (and the identity address itself):
  1. identity key signs  "bind <botMvcAddress> to account <globalMetaId> @ <ts>"
  2. bot key signs       "I am <botMvcAddress>, accept binding @ <ts>"
  3. POST /v1/traffic/accounts/bindings { both signatures }
Backend verifies both, stores binding (unique on bot address).
```

Both keys live locally in IDBots, so binding can be fully automated at runtime
(lazy: on first traffic-mode use, or batch on toggle-on).

### 4.4 Usage readback

- Balance: `GET /v1/traffic/accounts/:id/balance` → `{ balanceBytes, reservedBytes, ... }`
- Ledger: `GET /v1/traffic/accounts/:id/ledger?cursor=...` → grants & deductions
- Per-bot daily: `GET /v1/traffic/accounts/:id/usage/daily?from&to` →
  rows `{ date, address, bytes, txCount }` powering the traffic center table.

## 5. Multi-ISP (later)

- Pricing table becomes per-chain: `{ chain, currency, bytesPerUnit }`.
- Traffic balances become chain-tagged (sub-balances), or separate accounts per
  chain — decided in Phase 6 design.
- Non-MVC chains need sponsor support on those chains (new work; Doge fee model
  differs significantly, e.g. ¥10 → 0.1 MB).
- Client gains an ISP picker at recharge and per-write routing.

## 6. Transition & Fallback Policy

- Toggle: `traffic.mode = traffic | selfpay` (per-installation, default
  `selfpay` until traffic mode is stable, then default `traffic`).
- In traffic mode, on `insufficient_traffic` / sponsor unavailable:
  - policy A (default during transition): fall back to self-pay if the bot wallet
    has balance, else surface a recharge prompt;
  - policy B (strict): hard error with recharge prompt. Configurable.
- The legacy free quota may remain as a small free tier for new users
  (configurable server-side).

## 7. Security & Abuse

### 7.1 Existing (already in assist-base-service)

One-time challenges, address↔pubkey binding, per-address/IP rate limits, open-order
caps, per-order max fee, row-level locking, outbox broadcast retry/compensation,
internal endpoints behind token + IP allowlist.

### 7.2 New requirements introduced by traffic accounts

- **Binding proof**: both identity and bot signatures required; bot address
  unique across accounts; unbind requires identity signature (and is rate-limited).
- **Spend authorization**: `pre` must carry an account authorization (identity
  signature over the challenge), proving the spender controls the account — not
  merely the bot address. Prevents spending someone else's pool by binding
  confusion.
- **Idempotency**: ledger entries keyed by `(accountId, sourceType, sourceId)`
  unique; payment webhooks idempotent on gateway txn id.
- **Reservation hygiene**: reserve TTLs (existing order TTL 10 min) auto-release
  bytes; abuse of reservations is capped by existing open-order limits.
- **Overdraft safety**: balance check + reserve happen in the same DB transaction
  with row locking (same pattern as current quota).

## 8. Data That Must Be Visible (operability)

- Per-account: balance, reserved, lifetime granted/spent.
- Per-order: bytes reserved/spent, txId, address, state.
- Aggregate: platform-wide bytes sold vs sats spent (margin), pool runway
  (extend existing `/v1/internal/gas/health`), daily active traffic accounts.
