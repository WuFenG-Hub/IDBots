import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isActiveOrder,
  isCurrentOrderOperation,
  isDefinitiveCreateRejection,
  isOrderCreationBlocked,
  isOrderExpired,
  isUncertainCreateBlocked,
  isUnsettledOrder,
  loadRechargeRecovery,
  makeCreationAttempt,
  persistCreationAttempt,
  persistRechargeOrder,
  type RechargeOrderView,
} from '../src/mobile/app/services/rechargeRecovery.ts';

function installStorage(t: test.TestContext) {
  const values = new Map<string, string>();
  Object.assign(globalThis, {
    window: {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    },
  });
  t.after(() => values.clear());
  return values;
}

function makeOrder(overrides: Partial<RechargeOrderView> = {}): RechargeOrderView {
  return {
    orderId: 'bo_current',
    qrCode: 'https://qr.alipay.com/current-order',
    plan: {
      planId: 'bundle_basic_cny',
      name: 'Basic',
      nameEn: 'Basic',
      payCurrency: 'CNY',
      payAmount: '19.90',
      trafficBytes: 104857600,
      llmQuota: 2000000,
      llmQuotaUnit: 'tokens',
      status: 1,
      sort: 10,
      remark: '',
    },
    expiresAt: Math.floor(Date.now() / 1000) + 900,
    status: 1,
    createdAtMs: Date.now(),
    ...overrides,
  };
}

test('recharge recovery restores the exact current order, plan, QR, expiry and status', (t) => {
  installStorage(t);
  const order = makeOrder({ status: 2 });
  persistRechargeOrder(order);
  const attempt = makeCreationAttempt(order.plan.planId);
  persistCreationAttempt(attempt);

  const recovered = loadRechargeRecovery();
  assert.deepEqual(recovered.order, order);
  assert.deepEqual(recovered.creationAttempt, attempt);
  assert.equal(recovered.order?.qrCode, 'https://qr.alipay.com/current-order');
  assert.equal(isActiveOrder(recovered.order), true);
  assert.equal(isUncertainCreateBlocked(recovered.creationAttempt), true);
});

test('recharge recovery does not invent a QR and fails closed on malformed order data', (t) => {
  const values = installStorage(t);
  persistRechargeOrder(makeOrder({ qrCode: '' }));
  assert.equal(loadRechargeRecovery().order?.qrCode, '');
  assert.equal(loadRechargeRecovery().invalidOrder, false);
  values.set('idbots.mobile.bundleOrder.v1', JSON.stringify({ orderId: 'bo_missing_fields' }));
  assert.equal(loadRechargeRecovery().order, null);
  assert.equal(loadRechargeRecovery().invalidOrder, true);
  values.set('idbots.mobile.bundleOrder.v1', '{not json');
  assert.equal(loadRechargeRecovery().order, null);
  assert.equal(loadRechargeRecovery().invalidOrder, true);
});

test('terminal orders do not block creation, while expired unsettled orders and attempts do', (t) => {
  installStorage(t);
  const now = Date.now();
  assert.equal(isActiveOrder(makeOrder({ status: 3 }), now), false);
  assert.equal(isActiveOrder(makeOrder({ status: 4 }), now), false);
  assert.equal(isUnsettledOrder(makeOrder({ status: 3 })), false);
  assert.equal(isOrderCreationBlocked({ order: makeOrder({ status: 4 }), creationAttempt: null }, now), false);
  assert.equal(isActiveOrder(makeOrder({ expiresAt: Math.floor(now / 1000) - 1 }), now), false);
  assert.equal(isUnsettledOrder(makeOrder({ expiresAt: Math.floor(now / 1000) - 1 })), true);
  assert.equal(isOrderCreationBlocked({ order: makeOrder({ expiresAt: Math.floor(now / 1000) - 1 }), creationAttempt: null }, now), true);
  assert.equal(isUncertainCreateBlocked(makeCreationAttempt('bundle_basic_cny', now), now), true);
  assert.equal(isUncertainCreateBlocked(makeCreationAttempt('bundle_basic_cny', now - 25 * 60 * 60 * 1000), now), false);
  persistCreationAttempt(null);
  assert.equal(loadRechargeRecovery().creationAttempt, null);
});

test('only the current order ID and operation generation may apply a terminal result', () => {
  const current = makeOrder({ orderId: 'bo_new' });
  assert.equal(isCurrentOrderOperation(current, 2, 'bo_new', 2), true);
  assert.equal(isCurrentOrderOperation(current, 2, 'bo_old', 2), false);
  assert.equal(isCurrentOrderOperation(current, 2, 'bo_new', 1), false);
  assert.equal(isCurrentOrderOperation(null, 2, 'bo_new', 2), false);
});

test('invalid expiry still allows server reconciliation but blocks another order', (t) => {
  installStorage(t);
  persistRechargeOrder(makeOrder({ expiresAt: 0 }));
  const recovered = loadRechargeRecovery();
  assert.equal(recovered.invalidOrder, false);
  assert.ok(recovered.order);
  assert.equal(isOrderExpired(recovered.order.expiresAt), true);
  assert.equal(isActiveOrder(recovered.order), false);
  assert.equal(isUnsettledOrder(recovered.order), true);
  assert.equal(isOrderCreationBlocked(recovered), true);
});

test('invalid creation-attempt recovery data fails closed', (t) => {
  const values = installStorage(t);
  values.set('idbots.mobile.bundleCreateAttempt.v1', '{invalid');
  const recovered = loadRechargeRecovery();
  assert.equal(recovered.creationAttempt, null);
  assert.equal(recovered.invalidCreationAttempt, true);
  assert.equal(isOrderCreationBlocked(recovered), true);
});

test('only an authoritative business rejection can clear an uncertain create attempt', () => {
  assert.equal(isDefinitiveCreateRejection({ errorCode: 'BUNDLE_ORDER_REJECTED' }), true);
  assert.equal(isDefinitiveCreateRejection({ errorCode: 'BUNDLE_ORDER_OUTCOME_UNCERTAIN' }), false);
  assert.equal(isDefinitiveCreateRejection({}), false);
  assert.equal(isDefinitiveCreateRejection(undefined), false);
});
