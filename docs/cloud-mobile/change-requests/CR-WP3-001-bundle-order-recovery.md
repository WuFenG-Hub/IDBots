# CR-WP3-001 — Bundle Order Idempotency and Recovery

- **Status:** Proposed; not approved and not implemented as a contract change
- **Date:** 2026-10-27
- **Contracts:** C4 Bundle Orders in `01-interface-contracts.md`; `bundle:createOrder` and `bundle:getOrder` in `02-ipc-allowlist-v1.md`
- **Affected parties:** WS-A, WS-D, WS-E, acceptance
- **Compatibility:** Backward-compatible additive fields and one additive read channel; no existing field or channel is removed

## Current Text

`POST /v1/bundle/orders` accepts `{ planId, gateway }` and returns the order ID, payment handoff parameters, and `expiresAt`. `GET /v1/bundle/orders/{orderId}` returns status but no client request ID, payment handoff parameters, or expiry. The IPC surface can create an order or read it by order ID, but cannot find an order whose creation result was lost.

## Problem

A connection loss after the server accepts creation but before the client receives the result leaves the client without an order ID. Retrying can create a second order. A reload can recover a locally recorded order ID, but the current status response cannot restore the QR handoff or original expiry when those values were not persisted by the client. Clients therefore need a server-authoritative, exactly-once creation and recovery mechanism rather than blind retries.

## Proposed Change

1. Add optional `clientRequestId` to C4 creation and `bundle:createOrder`. The value is a client-generated opaque string, 16–64 characters, scoped to the identity and stored with the order. The same identity + `clientRequestId` returns the original order without creating another one.
2. Add C4 `GET /v1/bundle/orders?clientRequestId={id}` with the same identity authentication as creation. It returns the matching order or `404 ORDER_NOT_FOUND`; it never lists another identity's orders.
3. Include `clientRequestId`, `expiresAt`, and the current payment `gatewayParams` required for handoff in both the creation and status responses. Do not include internal merchant credentials or webhook payloads.
4. Add additive IPC `bundle:findOrder` with `[{ clientRequestId }]` and the same result shape as `bundle:getOrder`. Tier it P1 through the normal contract-version and allowlist CR process.
5. Define `expiresAt`, `paidAt`, and `creditedAt` explicitly as Unix seconds everywhere. Keep status codes 1–4 unchanged and preserve the backend's exactly-once crediting transaction.

## Client Behavior Until Approval

The PWA records only its current order handoff and an unresolved local creation attempt, validates order IDs and operation generations, and never reuses a QR from another order. It does not automatically retry an uncertain create. This local recovery is a compatibility measure, not a claim of server-side idempotency or exactly-once payment acceptance.

## Migration and Acceptance

Existing orders without a client request ID continue to work by order ID. New tests must cover repeated creation with one request ID, lost-result lookup, reload/foreground recovery, QR/order binding, stale response rejection, expiry units, and exactly one traffic/LLM credit. Real Alipay acceptance remains separate from mock or fixture evidence.
