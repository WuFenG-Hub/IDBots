# Backend Spec — assist-base-service: Traffic Account & Recharge System

> **Deliverable for the assist-base-service team.** IDBots team does not modify
> that repository. This document is the contract: API surface, data model,
> sponsor-flow integration, admin console, and a suggested implementation plan
> with acceptance criteria. IDBots (the requirement owner) performs final
> acceptance against §9; no spec-review cycle is required from the backend team —
> build to this document. Target service: `assist-base-service` (Go 1.22 + Gin +
> GORM/MySQL), deployed behind `https://www.metaso.network/assist-open-api`.

- Version: v1.1 (2026-08-09) — added Admin Console (§10), dynamic fee rate
- Depends on: existing sponsor v2 protocol (`challenge → pre → commit`),
  `tb_assist_address` quota model, `tb_assist_gas_record.txSize`

---

## 1. Background & Goal

Today sponsored gas is funded by a permissionless per-address quota (sats). We
are adding a **paid traffic model**:

- Users recharge money (mock gateway first, Stripe/Alipay later) and receive
  **traffic bytes** (1 byte = 1 byte of on-chain tx size).
- Traffic belongs to a **user account** (keyed by GlobalMetaID), shared by all
  the user's bound MetaBot addresses.
- When any bound address uses the sponsor flow, bytes (not the legacy sats
  quota) are reserved at `pre` and deducted at `commit` by actual `txSize`.
- Users can query balance, ledger, and per-address daily usage.
- Operators manage pricing, fee rate, and accounts through a simple **internal
  admin console** (§10).

Non-goals (this spec): real payment gateways (adapter interface only),
procurement automation (Phase 5), multi-chain traffic (Phase 6).

## 2. Data Model (new tables)

Naming follows existing `tb_assist_*` convention. All monetary/byte integer
fields `BIGINT UNSIGNED`. All tables get `id`, `createdAt`, `updatedAt` per
existing convention. Provide idempotent first-run migrations per
`sql/update.sql` practice.

### 2.1 `tb_traffic_account`

| Column | Type | Notes |
|---|---|---|
| `account_id` | VARCHAR(64) UNIQUE | user's GlobalMetaID (primary external key) |
| `identity_address` | VARCHAR(64) UNIQUE | identity MVC address |
| `balance_bytes` | BIGINT UNSIGNED | available traffic |
| `reserved_bytes` | BIGINT UNSIGNED | in-flight reservations (open sponsor orders) |
| `granted_bytes_total` | BIGINT UNSIGNED | lifetime grants (recharge/promo/admin) |
| `spent_bytes_total` | BIGINT UNSIGNED | lifetime spend |
| `status` | TINYINT | 1=active, 2=disabled |
| `version` | INT | optimistic lock, same pattern as `tb_assist_address` |

Invariant: `balance_bytes` never goes negative; spend = `balance_bytes -= n`
only inside the same transaction that updates the sponsor order (mirror
`reserveSponsorQuota`/spend semantics in `sponsor_flow.go`).

### 2.2 `tb_traffic_address_binding`

| Column | Type | Notes |
|---|---|---|
| `bot_address` | VARCHAR(64) UNIQUE | MetaBot MVC address; globally unique |
| `account_id` | VARCHAR(64) INDEX | owning account |
| `identity_signature` | TEXT | proof from identity key |
| `bot_signature` | TEXT | proof from bot key |
| `status` | TINYINT | 1=active, 2=unbound |

### 2.3 `tb_traffic_ledger`

Append-only. UNIQUE KEY `(account_id, source_type, source_id)` for idempotency.

| Column | Type | Notes |
|---|---|---|
| `account_id` | VARCHAR(64) INDEX | |
| `direction` | TINYINT | 1=grant, 2=spend, 3=reserve, 4=release |
| `amount_bytes` | BIGINT UNSIGNED | signed meaning by direction |
| `balance_after` | BIGINT UNSIGNED | post-entry balance |
| `source_type` | VARCHAR(32) | `recharge_order` / `sponsor_order` / `admin_grant` / `promo` |
| `source_id` | VARCHAR(64) | e.g. recharge order id, sponsor orderId, or admin idempotency key |
| `remark` | VARCHAR(255) | |

### 2.4 `tb_traffic_recharge_order`

| Column | Type | Notes |
|---|---|---|
| `order_id` | VARCHAR(64) UNIQUE | |
| `account_id` | VARCHAR(64) INDEX | |
| `plan_id` | VARCHAR(64) | references pricing plan |
| `pay_amount` | DECIMAL(20,8) | fiat amount |
| `pay_currency` | VARCHAR(8) | `CNY` / `USD` |
| `traffic_bytes` | BIGINT UNSIGNED | bytes to credit on payment success |
| `gateway` | VARCHAR(16) | `mock` / `stripe` / `alipay` |
| `gateway_txn_id` | VARCHAR(128) UNIQUE | idempotency anchor for webhooks |
| `status` | TINYINT | 1=created, 2=paid, 3=credited, 4=closed/expired |
| `paid_at` / `credited_at` | DATETIME | |

### 2.5 `tb_traffic_pricing_plan`

| Column | Type | Notes |
|---|---|---|
| `plan_id` | VARCHAR(64) UNIQUE | e.g. `cny_10_100mb` |
| `chain` | VARCHAR(16) | `mvc` now; multi-chain later |
| `pay_currency` | VARCHAR(8) | |
| `pay_amount` | DECIMAL(20,8) | |
| `traffic_bytes` | BIGINT UNSIGNED | |
| `status` | TINYINT | 1=active, 2=archived |
| `remark` | VARCHAR(255) | admin notes (cost basis etc.) |

Plans are **records, not formulas**: admins create/archive plans to change
pricing; client always renders the live table from the API.

### 2.6 `tb_traffic_config`

Tiny key-value table for operator-editable runtime config (fee rate etc.),
managed via the admin console:

| Column | Type | Notes |
|---|---|---|
| `config_key` | VARCHAR(64) UNIQUE | e.g. `mvc.fee_rate` |
| `config_value` | VARCHAR(255) | |
| `remark` | VARCHAR(255) | |

## 3. API Surface

Base path `/v1/traffic`. All mutating account APIs require an **identity
signature**: `X-Identity-Address`, `X-Timestamp`, `X-Signature` headers —
Bitcoin Signed Message (compact) over a canonical request string, verified with
the existing `VerifyTextSign` helper (`controller/auth/auth_common.go`), binding
signer to `identity_address`. Reuse the v2 challenge flow where replay matters.

Public response envelope unchanged: `{code, message, data, costTime}`.

### 3.1 Account & binding

| Method & path | Purpose | Request (data) | Response (data) |
|---|---|---|---|
| `POST /v1/traffic/accounts` | Get-or-create account for the calling identity | `{ }` (identity from headers) | `{ accountId, balanceBytes, reservedBytes, grantedBytesTotal, spentBytesTotal }` |
| `GET /v1/traffic/accounts/:accountId/balance` | Balance snapshot | — | same as above |
| `POST /v1/traffic/accounts/bindings` | Bind a bot address | `{ botAddress, botSignature, bindMessage }` | `{ botAddress, accountId, status }` |
| `DELETE /v1/traffic/accounts/bindings/:botAddress` | Unbind (identity-signed) | — | `{ status }` |
| `GET /v1/traffic/accounts/:accountId/bindings` | List bound addresses | — | `[{ botAddress, createdAt, status }]` |

Binding rules: `botSignature` = bot key signs `"traffic-bind:<botAddress>:<accountId>:<ts>"`;
identity signs the same message in `bindMessage` verification path. A bot address
already bound to another account → `409`.

### 3.2 Recharge

| Method & path | Purpose | Request | Response |
|---|---|---|---|
| `GET /v1/traffic/pricing` | Public rate table | — | `[{ planId, chain, payCurrency, payAmount, trafficBytes }]` (active only) |
| `POST /v1/traffic/recharge/orders` | Create order | `{ planId, gateway: "mock" }` | `{ orderId, payAmount, payCurrency, trafficBytes, gatewayParams }` |
| `GET /v1/traffic/recharge/orders/:orderId` | Order status | — | `{ orderId, status, creditedAt }` |
| `POST /v1/traffic/recharge/orders/:orderId/mock-confirm` | **Dev/staging only**: simulate gateway success | `{ gatewayTxnId }` | `{ status: "credited" }` |
| `POST /v1/traffic/payment/webhook/:gateway` | Real gateway callback (Phase 4; implement interface + verification hooks now) | gateway-specific | `200` on idempotent accept |

Rules:

- Order creation does not change balance. Credit happens exactly once, on
  transition `paid → credited`, writing a `grant` ledger entry with
  `source_type=recharge_order, source_id=order_id` (unique key enforces
  exactly-once).
- `mock-confirm` is gated by config (`traffic.mock_payment_enabled`, off in prod).

### 3.3 Usage

| Method & path | Purpose | Response |
|---|---|---|
| `GET /v1/traffic/accounts/:accountId/ledger?cursor&limit&direction` | Paged ledger | `{ entries: [...], nextCursor }` |
| `GET /v1/traffic/accounts/:accountId/usage/daily?from&to&botAddress?` | Per-day per-address aggregation of sponsor deductions | `[{ date, botAddress, bytes, txCount }]` |
| `GET /v1/traffic/accounts/:accountId/usage/summary` | Totals (today / 7d / 30d) | `{ todayBytes, weekBytes, monthBytes }` |

The daily aggregation joins `tb_traffic_ledger` (spend entries) with
`tb_assist_gas_record` (order → address, txId). Reuse the existing
`SponsorUsageBetween` query pattern (`models/assist_gas_record_model.go:167-189`).

## 4. Sponsor Flow Integration (the core change)

Current v2 flow stays byte-compatible for existing callers; traffic support is
**additive**.

### 4.1 `POST /v2/assist/gas/mvc/pre` — new optional field

```jsonc
{
  "address": "...",      // unchanged: first-input owner (the bot)
  "txHex": "...",        // unchanged: unsigned user draft (existing v2 field name — keep it)
  "trafficAccount": {    // NEW, optional
    "accountId": "<globalMetaId>",
    "authSignature": "...",   // identity key signs "traffic-pre:<accountId>:<challengeId>"
    "timestamp": 1730000000
  }
}
```

Behavior in `createSponsorOrder`:

1. If `trafficAccount` present:
   - Verify `authSignature` against the account's identity address (replay-bound
     to the v2 challenge id).
   - Resolve `address → tb_traffic_address_binding → account_id`; must equal
     `trafficAccount.accountId`, else `403`.
   - `estimateSponsorMinerFee` as today → `estimatedBytes = estimatedTxSize`
     (use the same size math; reserve in **bytes**, not sats).
   - In the reservation transaction: `balance_bytes >= estimatedBytes` else
     `TRAFFIC_INSUFFICIENT` (new error code, client falls back per policy);
     `balance_bytes -= estimatedBytes`, `reserved_bytes += estimatedBytes`;
     ledger `reserve` entry with `source_id = sponsorOrderId`.
   - Skip legacy quota reservation for this order (do not double-charge).
2. If absent → today's behavior unchanged (legacy quota path).

### 4.2 `commit` / finalize

In `finalizeSponsorCommit` (same transaction that marks the order broadcasting):

- If the order is traffic-paid: actual deduction = `txSize` of the final tx
  (already computed); `reserved_bytes -= estimatedBytes`;
  `balance_bytes += (estimatedBytes − actualTxSize)` (refund the over-reserve);
  `spent_bytes_total += actualTxSize`; ledger `spend` entry
  (`source_type=sponsor_order`, amount `actualTxSize`, `balance_after` updated).
- On order expiry/failure compensation (`compensateFailedSponsorOrderTx`
  path): release reservation — `reserved_bytes -= estimatedBytes`,
  `balance_bytes += estimatedBytes`, ledger `release` entry. Must be idempotent
  exactly like the existing quota release.

### 4.3 `GET /v2/assist/gas/address/info` — additive response

When the address is bound, include
`data.traffic = { accountId, balanceBytes, reservedBytes }` alongside the legacy
quota fields so the client can pre-flight with one call.

### 4.4 Interaction notes for the implementer

- Keep both reservations (traffic bytes vs legacy sats quota) mutually exclusive
  per order; record which one was used on `tb_assist_gas_record`
  (add `pay_source` TINYINT: 1=quota, 2=traffic) — needed for compensation and
  for usage aggregation joins.
- All balance mutations follow the existing pattern: row lock (`FOR UPDATE`) in
  transaction, optimistic `version` check, ledger written in same transaction.
- `max_fee_per_order` still applies in sats; the byte↔sat conversion uses the
  order's `networkFeeRate`.

## 5. Dynamic Fee Rate

Today `sponsorDefaultFeeRate int64 = 1` (`sponsor_flow.go:36`) is a hardcoded
constant used by pre-estimation, prepared-tx building, UTXO selection, and
auto-topup. Make it **operator-configurable**:

- Stored as `mvc.fee_rate` in `tb_traffic_config` (§2.6); seeded with `1`.
- Read through a small cached config getter (e.g. 30s cache) everywhere the
  constant is used today. The getter falls back to `1` when the row is missing.
- Each sponsor order continues to record the rate it used in `networkFeeRate` —
  historical orders are unaffected by later changes.
- Editable from the admin console (§10). Validation: integer ≥ 1, sane ceiling
  (e.g. ≤ 100) with an explicit confirm flag to override.

## 6. Mock Payment Gateway

Define a narrow interface now so Stripe/Alipay drop in later:

```go
type PaymentGateway interface {
    CreatePayment(order *TrafficRechargeOrder) (gatewayParams any, err error)
    VerifyWebhook(req *http.Request) (gatewayTxnId string, paid bool, err error)
}
```

- `MockGateway`: `CreatePayment` returns `{ mockToken }`; `VerifyWebhook` unused;
  confirmation via the dev-only `mock-confirm` endpoint.
- Webhook handler flow (all gateways): verify → find order by id → idempotent on
  `gateway_txn_id` → mark paid → credit (single transaction) → `200`.

## 7. Config Additions (`conf/init_conf.go` keys)

| Key | Default | Meaning |
|---|---|---|
| `traffic.enabled` | `false` | master switch; when off, all `/v1/traffic/*` → 404 and `pre` ignores `trafficAccount` |
| `traffic.mock_payment_enabled` | `false` | enable mock-confirm endpoint (staging only) |
| `traffic.max_reserve_bytes_per_order` | `8388608` (8 MB) | ceiling per sponsor order |
| `traffic.bind_rate_limit_per_day` | `50` | per account |
| `traffic.legacy_quota_fallback` | `true` | allow quota path when traffic absent/insufficient (transition) |
| `admin.enabled` | `false` | serve admin console (`/admin/*`) and admin APIs (`/v1/admin/*`) |
| `admin.token` | _(empty)_ | bearer token for admin console; console disabled while empty |

## 8. Implementation Plan (suggested)

Ordered steps, each independently testable (service follows existing
`service/gas_assist_service` layering: controller → service → models):

1. **Migrations & models**: 6 new tables + DAO (`models/`), `pay_source` column
   on `tb_assist_gas_record`. Idempotent `sql/update.sql` additions.
2. **Account & binding service + controller** (§3.1), signature verification
   reusing `VerifyTextSign`; unit tests for binding edge cases.
3. **Ledger service**: `grantBytes / reserveBytes / spendBytes / releaseBytes`
   transactional primitives with idempotency keys; unit tests for concurrency
   (double-reserve, spend-vs-release race).
4. **Sponsor integration** (§4): `pre` traffic branch, `commit` deduction,
   compensation release, `address/info` additive field; integration tests
   covering reserve→spend, expire→release, fail→compensate.
5. **Recharge & pricing** (§3.2): plans storage, order create/status,
   `PaymentGateway` interface + mock.
6. **Usage APIs** (§3.3) with aggregation queries + pagination.
7. **Dynamic fee rate** (§5): config table, cached getter, replace the
   hardcoded constant at all use sites.
8. **Admin console** (§10): admin APIs + embedded static UI.
9. **Ops**: extend `/v1/internal/gas/health` with traffic totals (accounts,
   bytes sold 24h, bytes spent 24h); Swagger annotations; config wiring.

## 9. Acceptance Criteria

End-to-end, on testnet, driven only through public APIs (+ admin console for
setup):

1. Create account → bind two bot addresses → both resolve to one account.
2. `GET pricing` returns the seeded table (incl. a ¥10→100 MB plan).
3. Create recharge order → `mock-confirm` → balance = 100,000,000 bytes;
   re-`mock-confirm` same txn → still credited exactly once.
4. Bot A sends a sponsored pin with `trafficAccount`: pre reserves, commit
   succeeds, balance decreased by actual `txSize`; ledger shows reserve + spend.
5. Bot B (same account) spends concurrently; balances remain consistent
   (no negative, no double-spend) under 20 parallel pres.
6. Let an order expire → reserved bytes released; ledger shows release.
7. `usage/daily` returns per-address rows matching the two bots' spend.
8. Insufficient balance → `TRAFFIC_INSUFFICIENT` at pre; legacy quota path
   untouched (existing v2 callers without `trafficAccount` behave exactly as
   before — regression suite passes).
9. `traffic.enabled=false` → traffic APIs 404, sponsor flow fully legacy.
10. Admin changes fee rate in console → subsequent sponsor orders use the new
    rate (visible in `networkFeeRate`); old orders keep theirs.
11. Plan created in console appears in public `GET /v1/traffic/pricing`;
    archived plan disappears.
12. Manual grant from console updates balance and writes an `admin_grant`
    ledger entry with the given reason; reusing the same idempotency key does
    not double-grant.
13. Admin endpoints/UI reject missing or wrong token (401).

## 10. Admin Console (Internal Web UI)

Goal: a simple internal web backend for operators — pricing plans, fee-rate
config, overall usage, account lookup, manual grants. Deliberately minimal:
internal users only, no polish requirements.

### 10.1 Placement & serving

- Lives **inside assist-base-service** (same process/binary): a hand-written
  static SPA (vanilla HTML/JS + `fetch`, no framework, no build step) embedded
  via `go:embed`, served at `GET /admin/*`. Keep it dependency-free so the
  Docker build stays unchanged.
- Auth: bearer token from `admin.token` config (reuse the
  `InternalAuthMiddleware` pattern; IP allowlist optional). The login page just
  stores the token in `localStorage` and sends `Authorization: Bearer` on every
  API call. Missing/wrong token → 401.

### 10.2 Admin APIs (`/v1/admin/*`, all behind admin auth)

| Method & path | Purpose | Notes |
|---|---|---|
| `GET /v1/admin/traffic/overview` | Dashboard totals | accounts count, bytes granted/spent today/7d/30d, revenue by currency, distinct spending accounts 24h |
| `GET /v1/admin/traffic/plans` | List pricing plans (incl. archived) | |
| `POST /v1/admin/traffic/plans` | Create plan | validates unique `plan_id`, positive amounts |
| `POST /v1/admin/traffic/plans/:planId/archive` | Archive plan | archived plans stop appearing in public pricing |
| `GET /v1/admin/traffic/fee-rate` | Current fee rate(s) | `{ "mvc.fee_rate": 1 }` + source (db/default) |
| `PUT /v1/admin/traffic/fee-rate` | Set fee rate | `{ "mvc.fee_rate": 2 }`; validation per §5 |
| `GET /v1/admin/traffic/accounts?query=` | Search accounts by accountId / identity / bot address | paged |
| `GET /v1/admin/traffic/accounts/:accountId` | Account detail | balance, totals, bound addresses, recent ledger |
| `POST /v1/admin/traffic/accounts/:accountId/grants` | Manual grant/adjust | `{ amountBytes (signed), reason, idempotencyKey }` → `admin_grant` ledger entry |
| `GET /v1/admin/traffic/recharge-orders?status&cursor` | Recharge order list + sums | |
| `GET /v1/admin/gas/health` | Proxy of existing `/v1/internal/gas/health` | so the console needs no internal-network access |

### 10.3 Pages (4, keep them plain)

1. **Dashboard**: overview cards (bytes sold/spent, revenue, accounts) + gas
   pool health summary.
2. **Pricing & Fee Rate**: plans table with create/archive forms; fee-rate
   editor with current value.
3. **Accounts**: search → detail (balance, bindings, ledger) → manual grant
   form.
4. **Orders**: recharge order list with status filter and revenue sums.

### 10.4 Notes

- All admin mutations write through the same transactional ledger primitives as
  user-facing flows (§8 step 3).
- Admin actions are audited via ledger `remark` (`admin_grant` entries carry the
  reason) — no separate audit table needed for v1.

## 11. Open Questions

1. `authSignature` canonical string format — align with existing v2 challenge
   message conventions (propose one in implementation; document it in Swagger).
2. Should `balance_bytes` live in Redis for read speed, or is MySQL row read at
   `pre` sufficient given current rate limits? (Recommend MySQL-only initially.)
3. ~~Admin tooling for plans/grants~~ — resolved: included as Admin Console, §10.
4. Timezone convention for `usage/daily` bucketing (recommend UTC, client
   renders local).
