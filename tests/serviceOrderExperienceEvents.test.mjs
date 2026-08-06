import test from 'node:test';
import assert from 'node:assert/strict';

import { getSqlJs } from './memoryTestUtils.mjs';

let ServiceOrderStore;
let ServiceOrderLifecycleService;
try {
  ({ ServiceOrderStore } = await import('../dist-electron/main/serviceOrderStore.js'));
  ({ ServiceOrderLifecycleService } = await import('../dist-electron/main/services/serviceOrderLifecycleService.js'));
} catch {
  ({ ServiceOrderStore } = await import('../dist-electron/serviceOrderStore.js'));
  ({ ServiceOrderLifecycleService } = await import('../dist-electron/services/serviceOrderLifecycleService.js'));
}

const OWNER = 'idq1owner';
const PEER = 'idq1peer';

function baseOrderInput(overrides = {}) {
  return {
    localMetabotId: 1,
    counterpartyGlobalMetaId: PEER,
    servicePinId: 'service-pin-1',
    orderPinId: 'order-pin-1',
    serviceName: 'Review service',
    paymentTxid: 'a'.repeat(64),
    paymentChain: 'mvc',
    paymentAmount: '1',
    paymentCurrency: 'SPACE',
    coworkSessionId: 'session-1',
    orderMessagePinId: 'order-message-pin-1',
    orderMessageTxid: 'b'.repeat(64),
    ...overrides,
  };
}

test('service-order lifecycle emits factual experience events without changing order semantics', async () => {
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  const store = new ServiceOrderStore(db, () => {});
  const events = [];
  let now = 1000;
  const lifecycle = new ServiceOrderLifecycleService(store, {
    now: () => now,
    resolveLocalMetabotGlobalMetaId: () => OWNER,
    onExperienceEvent: (event) => events.push([event.type, event.order.status]),
  });

  const buyer = lifecycle.createBuyerOrder(baseOrderInput());
  now = 1100;
  lifecycle.markBuyerOrderFirstResponseReceived({
    localMetabotId: 1,
    counterpartyGlobalMetaId: PEER,
    orderPinId: buyer.orderPinId,
  });
  now = 1200;
  lifecycle.markBuyerOrderDelivered({
    localMetabotId: 1,
    counterpartyGlobalMetaId: PEER,
    orderPinId: buyer.orderPinId,
    deliveryMessagePinId: 'delivery-pin-1',
  });
  now = 1300;
  lifecycle.markOrderRatingRequested('buyer', {
    localMetabotId: 1,
    counterpartyGlobalMetaId: PEER,
    orderPinId: buyer.orderPinId,
  });
  now = 1400;
  lifecycle.markOrderEnded('buyer', {
    localMetabotId: 1,
    counterpartyGlobalMetaId: PEER,
    orderPinId: buyer.orderPinId,
    reason: 'rating_complete',
  });

  assert.deepEqual(events, [
    ['created', 'awaiting_first_response'],
    ['first_response', 'in_progress'],
    ['delivered', 'rating_pending'],
    ['rating_requested', 'rating_pending'],
    ['order_ended', 'completed'],
  ]);
  assert.equal(store.getOrderById(buyer.id).status, 'completed');
});

test('seller failures emit a failed fact for later dream-time interpretation', async () => {
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  const store = new ServiceOrderStore(db, () => {});
  const events = [];
  const lifecycle = new ServiceOrderLifecycleService(store, {
    now: () => 2000,
    resolveLocalMetabotGlobalMetaId: () => OWNER,
    onExperienceEvent: (event) => events.push(event.type),
  });
  const seller = lifecycle.createSellerOrder(baseOrderInput({
    orderPinId: 'order-pin-2',
    paymentTxid: 'c'.repeat(64),
  }));
  lifecycle.markSellerOrderFailed({
    localMetabotId: 1,
    counterpartyGlobalMetaId: PEER,
    orderPinId: seller.orderPinId,
    failureReason: 'skill_scope_unresolved',
  });
  assert.deepEqual(events, ['created', 'failed']);
});
