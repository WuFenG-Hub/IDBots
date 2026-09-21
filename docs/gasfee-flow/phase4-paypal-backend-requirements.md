# Phase 4 — PayPal Recharge: Backend Requirements

> **Deliverable for the assist-base-service team.** IDBots team does not modify
> that repository. This document is the contract for adding **PayPal** as the
> first real payment gateway for traffic recharge, behind the existing
> `PaymentGateway` seam. Target service: `assist-base-service` (Go 1.22 + Gin +
> GORM/MySQL), deployed behind `https://www.metaso.network/assist-open-api`.

- Version: v1.0 (2026-09-20)
- Supersedes: the Stripe+Alipay phasing in `phase4-payment-plan.md` (PayPal
  ships first; Stripe/Alipay may still follow later behind the same interface).
- Depends on: the delivered recharge system (`backend-spec.md` v1.1) —
  `tb_traffic_recharge_order`, `PaymentGateway` interface
  (`service/traffic_service/recharge_service.go:22`), generic webhook route
  `POST /v1/traffic/payment/webhook/:gateway`
  (`controller/traffic_controller.go:258`), and the idempotent crediting path
  (`creditRechargeOrder`, `recharge_service.go:176`).

---

## 1. Background & Decision

The merchant (product owner) has a **PayPal business account** ready. PayPal
was selected as the first real gateway because merchant onboarding is already
done and it covers international users with USD settlement.

The merchant initially created a PayPal **hosted button** (hosted button id
`5WDDNUU4BQ8TL`, payment link `https://www.paypal.com/ncp/payment/5WDDNUU4BQ8TL`).
**This artifact is not usable for our flow and must not be integrated**: hosted
buttons/payment links carry a fixed product/amount and accept **no
per-transaction custom field**, so a payment can never be correlated back to a
specific traffic account for automatic crediting (only locale/country query
parameters are supported — see the
[PayPal payment-links FAQ](https://developer.paypal.com/payment-links-buttons/faq)).

The required integration is the **PayPal Orders REST API v2**, fully
server-side:

1. Our backend creates a PayPal order per recharge order, embedding our
   `orderId` as the passthrough field.
2. The user pays on PayPal's hosted checkout page (opened in the system
   browser by the IDBots client).
3. PayPal webhooks drive capture + crediting; the client polls our existing
   order-status endpoint.

## 2. Scope

In scope:

- A `PayPalGateway` implementing the existing `PaymentGateway` interface,
  registered in `paymentGateway()` (`recharge_service.go:38`) under the name
  **`paypal`**.
- Webhook handling for `POST /v1/traffic/payment/webhook/paypal` (route exists;
  verification logic must live inside the gateway's `VerifyWebhook`).
- PayPal config keys + a small static "payment finished" return page.
- Sandbox-first acceptance.

Out of scope (unchanged from Phase 4 plan): refunds, invoices, multi-currency
beyond USD, client-side PayPal SDK.

## 3. PayPal API Cheat Sheet (what you'll integrate against)

| Concern | PayPal API |
|---|---|
| API base URLs | sandbox `https://api-m.sandbox.paypal.com` · live `https://api-m.paypal.com` |
| Auth | `POST /v1/oauth2/token` (Basic `client_id:secret`, `grant_type=client_credentials`) → `access_token`; cache until expiry |
| Create order | `POST /v2/checkout/orders` |
| Capture order | `POST /v2/checkout/orders/{paypalOrderId}/capture` |
| Verify webhook | `POST /v1/notifications/verify-webhook-signature` |
| Webhook events | `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED` (plus `PAYMENT.CAPTURE.DENIED`/`.REFUNDED` for logging) |

Go SDK: there is no official PayPal Go SDK; plain HTTP+JSON is what most Go
services use here (and matches this repo's dependency-light style). Reuse the
existing outbound-HTTP patterns in the repo.

## 4. Order Creation Contract (what IDBots consumes)

Unchanged endpoint, new gateway value:

```
POST /v1/traffic/recharge/orders
Headers: X-Identity-Address / X-Timestamp / X-Signature  (unchanged)
Body:    { "planId": "usd_10_1gb", "gateway": "paypal" }
```

Response `data` (existing `TrafficRechargeCreateRespond` shape, no breaking
change — `gatewayParams` is `any`):

```jsonc
{
  "orderId": "trch_...",          // our internal recharge order id
  "payAmount": 10,
  "payCurrency": "USD",
  "trafficBytes": 1000000000,
  "gatewayParams": {
    "approvalUrl": "https://www.sandbox.paypal.com/checkoutnow?token=7FN...",
    "paypalOrderId": "7FN..."
  }
}
```

Rules:

- **Build the PayPal order strictly from the pricing-plan row**
  (`tb_traffic_pricing_plan`): amount = `payAmount`, currency = `payCurrency`.
  Never accept amount/currency/description from the client request.
- Create the PayPal order with:
  - `intent = "CAPTURE"`;
  - `purchase_units[0].custom_id = <our orderId>` **and**
    `invoice_id = <our orderId>` (both are returned on the capture resource;
    `custom_id` is the primary correlation key, `invoice_id` additionally
    gives free duplicate-invoice protection on PayPal's side);
  - `purchase_units[0].description` = human-readable plan label;
  - `application_context = { brand_name, user_action: "PAY_NOW",
    return_url, cancel_url }` (§7).
- Send an idempotency header (`PayPal-Request-Id = <our orderId>`) so client
  retries of order creation do not mint duplicate PayPal orders.
- Persist `paypalOrderId` on the recharge order row (e.g. in a
  `gateway_order_id` column or inside a JSON gateway-meta column — schema
  choice is yours; it is needed to reconcile APPROVED events and for the
  capture call).
- `gateway: "paypal"` with the feature disabled
  (`traffic.paypal.enabled=false`) must return the same style of envelope
  error as today's unsupported-gateway path — the client maps it to friendly
  "recharge unavailable" copy.

## 5. Webhook Contract (crediting path)

Route already exists: `POST /v1/traffic/payment/webhook/paypal`
(unauthenticated by design — **all trust comes from PayPal's signature
verification**, never from the payload).

### 5.1 Verification (mandatory before any state change)

For every delivery call `POST /v1/notifications/verify-webhook-signature`
with the transmission headers (`PAYPAL-TRANSMISSION-ID`,
`PAYPAL-TRANSMISSION-SIG`, `PAYPAL-TRANSMISSION-TIME`, `PAYPAL-AUTH-ALGO`,
`PAYPAL-CERT-URL`), the configured `webhook_id`, and the raw parsed event.
Proceed only when `verification_status == "SUCCESS"`; otherwise respond 4xx
and log. (Do not skip verification in any environment, including staging —
sandbox supports it fully.)

### 5.2 Event handling

| Event | Action |
|---|---|
| `CHECKOUT.ORDER.APPROVED` | Buyer approved on PayPal. Look up our order via the PayPal order id (`resource.id`), then call `POST /v2/checkout/orders/{id}/capture` (idempotency header = our orderId). Do **not** credit here. |
| `PAYMENT.CAPTURE.COMPLETED` | Credit path: correlate via `resource.custom_id` (= our `orderId`); `resource.id` (capture id) → `gatewayTxnId`. **Verify `resource.amount.value` + `resource.amount.currency_code` exactly equal the order row's `payAmount`/`payCurrency`; mismatch → log loud, do not credit, still 200 (or 4xx — but never credit).** Then run the existing idempotent `creditRechargeOrder` flow. |
| `PAYMENT.CAPTURE.DENIED` / `.REFUNDED` / `.REVERSED` | Log + alert only for v1 (refund policy is an open business question; do not auto-debit). |

### 5.3 Idempotency & responses

- Exactly-once crediting is already guaranteed by the delivered machinery:
  order status machine + `UNIQUE(gatewayTxnId)` + ledger unique key. Duplicate
  webhook deliveries (PayPal retries aggressively) must be a no-op → 200.
- Respond `200` promptly on accepted/idempotent events; `4xx` on verification
  failure or malformed payloads; `5xx` only when a retry from PayPal is
  actually wanted (e.g. DB down).

## 6. Order Expiry (recommended)

Recharge orders stuck in `created` (user abandoned the PayPal tab) should be
swept to `status = 4 (closed)` after ~24 h by a small periodic job, so the
admin order list stays meaningful and the client's poll has a terminal state.
`status=4` exists in the model today but nothing drives it.

## 7. Return Page (UX nicety, cheap)

`application_context.return_url` / `cancel_url` should point at a tiny static
page served by this service (e.g. `GET /v1/traffic/payment/return`) saying
"Payment finished — you can return to IDBots". After approving, the buyer's
browser lands there instead of a dead end. The page is **display-only**;
crediting never depends on it.

## 8. Config Additions

Extend `TrafficConfig` (`conf/init_conf.go:74`) and the yaml confs:

| Key | Default | Meaning |
|---|---|---|
| `traffic.paypal.enabled` | `false` | master switch for the paypal gateway |
| `traffic.paypal.env` | `sandbox` | `sandbox` or `live` — picks the API base URL |
| `traffic.paypal.client_id` | _(empty)_ | REST app client id (per env) |
| `traffic.paypal.secret` | _(empty)_ | REST app secret (per env) |
| `traffic.paypal.webhook_id` | _(empty)_ | webhook id from the PayPal dashboard (per env) |
| `traffic.paypal.brand_name` | `IDBots` | shown on PayPal checkout |
| `traffic.paypal.order_expire_hours` | `24` | janitor threshold (§6) |

Secrets live only in the (gitignored) conf yaml files, same as existing
tokens. Sandbox and live credentials are separate REST apps; keep both pairs
out of the repo.

## 9. Pricing Plans

No schema change: USD plans are ordinary rows in `tb_traffic_pricing_plan`,
created via the existing admin console (`payCurrency = "USD"`). Plans are
gateway-agnostic; the client sends `gateway: "paypal"`, so any active plan is
payable via PayPal. Suggested seed set for sandbox (ops decides live values):

| planId | payAmount | trafficBytes |
|---|---|---|
| `usd_5_500mb` | 5 USD | 500,000,000 |
| `usd_10_1gb` | 10 USD | 1,000,000,000 |
| `usd_20_2_5gb` | 20 USD | 2,500,000,000 |

PayPal amount formatting: send `value` as a 2-decimal string (`"10.00"`).

## 10. Merchant Checklist (account owner — already started)

Done: PayPal business account created. Still needed in the
[PayPal Developer Dashboard](https://developer.paypal.com/dashboard):

1. **Apps & Credentials → create REST app** (Sandbox first, later Live) →
   copy `client_id` + `secret` → hand to the backend team via a secret channel.
2. Same app → **Add webhook**:
   - URL: `https://www.metaso.network/assist-open-api/v1/traffic/payment/webhook/paypal`
     (must be publicly reachable — the production deployment is; for local
     backend development use a tunnel such as ngrok and a second webhook);
   - Events: `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`
     (optionally `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`);
   - copy the **Webhook ID** → backend config.
3. Sandbox testing uses the auto-generated sandbox **business** account
   (receives money) and **personal** account (pays) — both under
   "Testing Tools → Sandbox accounts".
4. Discard (or ignore) the hosted button created earlier; it plays no role in
   this integration.

## 11. Client Behavior Reference (how IDBots will consume this)

For capacity/pacing expectations — no backend action needed beyond keeping the
endpoints fast:

1. `GET /v1/traffic/pricing` (public) renders the plan list.
2. User picks a plan → `POST /v1/traffic/recharge/orders`
   `{planId, gateway:"paypal"}` → client opens `gatewayParams.approvalUrl` in
   the system browser.
3. Client polls `GET /v1/traffic/recharge/orders/:orderId` every 4 s for up to
   10 min while status is `created(1)`/`paid(2)`; terminal states:
   `credited(3)` → success UI + balance refresh; `closed(4)` → expired UI.
4. If the user closes the app mid-payment the webhook still credits; the next
   balance read reflects it. The client never calls PayPal directly and never
   marks anything paid by itself.

## 12. Acceptance Criteria (sandbox, end-to-end)

1. Create order with `gateway:"paypal"` → response carries a valid
   `approvalUrl`; opening it shows a PayPal checkout for exactly the plan's
   USD amount.
2. Pay with a sandbox buyer → within seconds
   `GET /v1/traffic/recharge/orders/:orderId` transitions
   `created → paid → credited`; balance increases by `trafficBytes`; ledger
   has a `grant` entry `source_type=recharge_order`.
3. Re-deliver the same webhook (PayPal dashboard resend) → still credited
   exactly once; `gatewayTxnId` unchanged.
4. Forge a webhook (no/invalid signature) → rejected, no state change.
5. Tamper test: capture amount ≠ order amount → not credited, alert logged.
6. `traffic.paypal.enabled=false` → create-order with `gateway:"paypal"`
   returns the standard unsupported/unavailable envelope error.
7. Abandoned order → swept to `closed` after the expiry window; client poll
   terminates with the expired UI.
8. Admin console order list shows the order with PayPal capture id and
   revenue in USD (existing admin surface should already cover this).

## 13. Open Questions (business, not blocking implementation)

- Refund policy: whether a refunded capture debits the traffic account (v1:
  log/alert only).
- Invoice/receipt requirements for fiat payments.
- Whether CNY plans should also be exposed via PayPal (PayPal settles
  cross-currency but with conversion fees — recommend USD-only for now).
