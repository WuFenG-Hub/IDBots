# Backend Spec v2 — Free-Grant Campaign & Recharge Codes

Addendum to `backend-spec.md` (traffic account & recharge system). Same repo,
same branch discipline, same conventions: error envelope uses `data.errorCode`
inside the standard `{code, message, data}` envelope; traffic endpoints use the
same signature auth as the existing `/v1/traffic/*` routes; admin routes sit
behind `/v1/admin/*` bearer-token auth; ledger integration is mandatory so the
client's existing balance/ledger UI picks the new entries up unchanged.

Date: 2026-08-13 · Status: draft for backend team review.

---

## Feature A — Free-Grant Campaign (免费领取 10M 流量)

### A.1 Goal

Every traffic account can claim a one-time free traffic grant (default 10 MB)
from the IDBots client. The amount is admin-configurable and the whole campaign
has an admin on/off switch. Primary purpose: onboarding — remove the gas-fee
entry barrier for brand-new users.

### A.2 Data model

New table `tb_traffic_free_grant`:

| column         | type        | notes                                        |
|----------------|-------------|----------------------------------------------|
| id             | BIGINT PK AI|                                              |
| account_id     | VARCHAR(64) | traffic account id; **UNIQUE** (one claim)   |
| grant_bytes    | BIGINT      | snapshot of configured amount at claim time  |
| source_client  | VARCHAR(32) | e.g. `idbots` (from request `clientApp`)     |
| created_at     | BIGINT      | unix ms                                      |

Campaign settings live in the existing `tb_traffic_config` key-value table
(see backend-spec §2.6):

- `free_grant_enabled` = `"true"` / `"false"` (default `false`)
- `free_grant_bytes` = integer string, default `10000000` (10 MB)
- `free_grant_client_allowlist` = comma-separated, default `idbots`
- `free_grant_client_token` = shared secret, default empty (disabled)

### A.3 API

`GET /v1/traffic/campaign/free-grant/status` — traffic-signature auth:

```json
data: {
  "enabled": true,
  "grantBytes": 10000000,
  "claimed": false,
  "claimable": true
}
```

`POST /v1/traffic/campaign/free-grant/claim` — traffic-signature auth:

- request: `{ "clientApp": "idbots", "clientVersion": "0.4.5" }`
- optional header `X-Client-Token` — only checked when `free_grant_client_token`
  is configured (see A.4)
- success: `data: { "grantId": 1, "grantBytes": 10000000, "balanceAfter": ... }`
- ledger entry: `direction=1` (credit), `sourceType="free_grant"`,
  `sourceId=grantId`, idempotency key `(accountId, credit, free_grant, grantId)`
- error codes (in `data.errorCode`): `CAMPAIGN_DISABLED`, `ALREADY_CLAIMED`,
  `CLIENT_NOT_ALLOWED`, `TRAFFIC_INSUFFICIENT` (n/a here, listed for envelope
  consistency)

Exactly-once: enforced by the UNIQUE(account_id) constraint inside a
transaction; the second attempt returns `ALREADY_CLAIMED` (no re-credit). The
ledger idempotency key guards the first attempt against retries.

### A.4 Anti-farming (honest, best-effort)

Layers, in order of strength:

1. Traffic-signature auth — the request must prove possession of the account's
   MVC key, same bar as every other traffic endpoint.
2. `clientApp` allow-list — only `idbots` by default; unknown values rejected.
3. Shared `X-Client-Token` header — optional, off by default; ship a value in
   the IDBots binary when farming is observed. **Documented limitation**: the
   token is extractable from the client; it raises the cost of casual farming,
   it is not a security boundary. Do not treat it as secret infrastructure.
4. Optional per-IP daily claim rate limit (e.g. 20/day/IP), off by default,
   config key `free_grant_ip_limit`. Admin can always disable the campaign
   outright.

### A.5 Admin

Extend the traffic admin console (one more page/section, keep it plain):

- GET `/v1/admin/traffic/campaign/free-grant` → current settings
- PUT `/v1/admin/traffic/campaign/free-grant` → set enabled / grantBytes /
  allowlist / token (never echo the token back)
- GET `/v1/admin/traffic/free-grants?accountId=&page=&pageSize=` → claims list
  (account, bytes, client, created_at), plus totals (claims count, bytes granted)

### A.6 Acceptance criteria

- A1: status returns `claimable=true` for a fresh account with campaign on.
- A2: claim credits exactly `free_grant_bytes`; balance & ledger agree; ledger
  row `sourceType=free_grant` visible via `/v1/traffic/ledger`.
- A3: second claim returns `ALREADY_CLAIMED`; concurrent double-claim (2
  parallel requests) credits exactly once (DB unique constraint).
- A4: campaign disabled → status `enabled=false`, claim returns
  `CAMPAIGN_DISABLED`.
- A5: admin changes amount → next claim uses the new value; `grant_bytes`
  snapshot stays the value at claim time.
- A6: `clientApp` not in allowlist → `CLIENT_NOT_ALLOWED`.
- A7: `go build ./... && go test ./...` green; unit tests for the credit math,
  unique-claim constraint, and error codes.
- A8: Swagger + `docs/traffic-deployment.md` updated (config keys, admin page).

---

## Feature B — Recharge Codes (充值码)

### B.1 Goal

Pre-payment bridge: users redeem a one-time code to receive the traffic amount
bound to that code. Admin can generate batches of codes with per-code amounts,
list/search them, and revoke batches. Each code is single-use; redeeming marks
it used.

### B.2 Data model

`tb_traffic_recharge_code`:

| column          | type        | notes                                   |
|-----------------|-------------|-----------------------------------------|
| id              | BIGINT PK AI|                                         |
| code            | VARCHAR(32) | **UNIQUE**, normalized uppercase        |
| traffic_bytes   | BIGINT      |                                         |
| status          | TINYINT     | 1=unused, 2=used, 3=disabled            |
| used_account_id | VARCHAR(64) | NULL until used                         |
| used_at         | BIGINT      | NULL until used                         |
| batch_id        | BIGINT      |                                         |
| remark          | VARCHAR(128)| optional note                           |
| expires_at      | BIGINT NULL | optional; NULL = never expires          |
| created_at      | BIGINT      |                                         |

Indexes: `(batch_id)`, `(status)`.

`tb_traffic_recharge_batch`:

| column       | type        | notes                          |
|--------------|-------------|--------------------------------|
| id           | BIGINT PK AI|                                |
| batch_no     | VARCHAR(32) | display id, unique             |
| code_count   | INT         |                                |
| traffic_bytes| BIGINT      | per-code amount (informational)|
| expires_at   | BIGINT NULL |                                |
| status       | TINYINT     | 1=active, 2=revoked            |
| note         | VARCHAR(128)|                                |
| created_by   | VARCHAR(64) | admin operator                 |
| created_at   | BIGINT      |                                |

Code format: `IDB-XXXX-XXXX-XXXX`, 12 payload chars from a Crockford-like
base32 alphabet (exclude `I L O 0 1`), uppercase. Regenerate on the rare
collision (UNIQUE constraint retry).

### B.3 API

`POST /v1/traffic/redeem-code` — traffic-signature auth:

- request: `{ "code": "IDB-XXXX-XXXX-XXXX" }` (server trims & uppercases)
- success: `data: { "codeId": 1, "trafficBytes": 100000000, "balanceAfter": ... }`
- ledger entry: `direction=1`, `sourceType="recharge_code"`, `sourceId=codeId`,
  idempotency key `(accountId, credit, recharge_code, codeId)`
- error codes: `CODE_NOT_FOUND`, `CODE_USED`, `CODE_DISABLED`, `CODE_EXPIRED`
- Idempotent re-confirm: if the code is `used` **and** `used_account_id` equals
  the requesting account, return the same success payload (mirrors the mock
  recharge confirm-idempotency behavior already shipped). Otherwise
  `CODE_USED`.

Redemption must be atomic: `SELECT ... FOR UPDATE` on the code row, check
status/expiry, mark used, write ledger, commit.

### B.4 Admin

New "Recharge Codes" page in the admin console (plain, same style):

- POST `/v1/admin/traffic/codes/generate`
  `{ "count": 100, "trafficBytes": 100000000, "expiresAt": null, "note": "" }`
  → batch + the generated codes (shown once; also exportable)
- GET `/v1/admin/traffic/codes?batchId=&status=&code=&page=&pageSize=`
  (filters optional) → paged codes with used-by/used-at
- GET `/v1/admin/traffic/codes/export?batchId=` → text/CSV download of unused
  codes of a batch
- POST `/v1/admin/traffic/codes/{id}/disable` → status=disabled (unused only)
- POST `/v1/admin/traffic/batches/{id}/revoke` → batch status=revoked and all
  its unused codes → disabled
- GET `/v1/admin/traffic/batches?page=&pageSize=` → batches with stats
- GET `/v1/admin/traffic/codes/stats` → totals: generated / unused / used /
  disabled, bytes outstanding (unused bytes sum)

### B.5 Acceptance criteria

- B1: generated codes are unique, well-formed (`IDB-XXXX-XXXX-XXXX`), and
  redeemable once.
- B2: redeem credits exactly the code's `traffic_bytes`; ledger row
  `sourceType=recharge_code`; balance agrees.
- B3: second redeem by a different account → `CODE_USED`; by the same account →
  idempotent success with the same amount, no double-credit.
- B4: unknown code → `CODE_NOT_FOUND`; disabled → `CODE_DISABLED`; expired →
  `CODE_EXPIRED`.
- B5: revoking a batch disables all its unused codes; used codes stay used.
- B6: export contains exactly the unused codes of the batch.
- B7: concurrent redeem of the same code by two accounts → exactly one wins
  (atomic `FOR UPDATE`), the other gets `CODE_USED`.
- B8: `go build ./... && go test ./...` green; unit tests for redemption math,
  single-use semantics, expiry, and error codes.
- B9: Swagger + `docs/traffic-deployment.md` updated.
- B10: admin page usable end-to-end: generate → export → redeem → see used
  state in the list.

---

## Ledger `sourceType` additions (client-facing)

`free_grant` and `recharge_code` are new `sourceType` values on ledger
direction=1 rows. No backend schema change beyond the above tables.

## Client plan (IDBots, our side — for context, not backend work)

- Settings → Traffic page, below the balance card: claim button labelled with
  the configured amount ("免费领取 10M 流量" / "Claim 10 MB free traffic"),
  visible only while `status.claimable` is true; after a successful claim the
  balance refreshes and the button disappears (`claimed=true`).
- Recharge flow: replace the plan-list + mock-pay stage with a code input +
  redeem button (pricing table stays as informational display). Dev/E2E keeps
  the existing mock-order path in code for scripts.
- New IPC: `traffic:campaignStatus`, `traffic:claimFreeGrant`,
  `traffic:redeemCode`; service functions in `trafficAccountService.ts`.
- Ledger friendly labels for `free_grant` / `recharge_code`; i18n symmetric.

## Open questions (defaults chosen, change cheaply)

1. "New user" = never-claimed account (chosen), regardless of existing
   balance. Alternative: require zero balance — not chosen (rewards actual
   users, punishes early adopters who already recharged).
2. Client token default off (chosen); enable only if farming is observed.
3. Code expiry: supported per-batch, NULL allowed (chosen default NULL).
4. Code amount unit: bytes (chosen) — admin UI may display B/KB/MB for
   readability.
