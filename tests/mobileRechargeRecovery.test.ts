import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isActiveOrder,
  isCurrentOrderOperation,
  isUncertainCreateBlocked,
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

test('recharge recovery does not invent a QR or accept malformed order data', (t) => {
  const values = installStorage(t);
  persistRechargeOrder(makeOrder({ qrCode: '' }));
  assert.equal(loadRechargeRecovery().order?.qrCode, '');
  values.set('idbots.mobile.bundleOrder.v1', JSON.stringify({ orderId: 'bo_missing_fields' }));
  assert.equal(loadRechargeRecovery().order, null);
  values.set('idbots.mobile.bundleOrder.v1', '{not json');
  assert.equal(loadRechargeRecovery().order, null);
});

test('terminal or expired orders do not block creation, while an unresolved attempt does', (t) => {
  installStorage(t);
  const now = Date.now();
  assert.equal(isActiveOrder(makeOrder({ status: 3 }), now), false);
  assert.equal(isActiveOrder(makeOrder({ status: 4 }), now), false);
  assert.equal(isActiveOrder(makeOrder({ expiresAt: Math.floor(now / 1000) - 1 }), now), false);
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
