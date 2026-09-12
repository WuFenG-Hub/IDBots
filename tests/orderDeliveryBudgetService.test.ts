import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOrderDeliveryBudget,
  computeFundableDeliveryBytes,
  isSponsorUploadEnabledForMetabot,
  MIN_SELFPAID_DELIVERABLE_BYTES,
  resolveOrderDeliveryBudget,
} from '../src/main/services/orderDeliveryBudgetService';

const metabotStoreStub = {
  getMetabotSetting: () => null,
} as never;

test('computeFundableDeliveryBytes inverts the chunked upload estimate conservatively', () => {
  // 24M sats at feeRate 1 funds ~23.9 MB minus reserve/overhead.
  const bytes = computeFundableDeliveryBytes(24_000_000, 1);
  assert.ok(bytes > 20 * 1024 * 1024 && bytes < 24 * 1024 * 1024, `fundable ${bytes}`);

  // Higher fee rate shrinks capacity proportionally.
  const atRate5 = computeFundableDeliveryBytes(24_000_000, 5);
  assert.ok(atRate5 < bytes / 4, `rate-5 fundable ${atRate5} should be far smaller`);

  // The reserve means tiny balances fund nothing.
  assert.equal(computeFundableDeliveryBytes(10_000, 1), 0);
  assert.equal(computeFundableDeliveryBytes(0, 1), 0);
});

test('buildOrderDeliveryBudget rejects self-paid orders below the minimal capacity', () => {
  const hopeless = buildOrderDeliveryBudget({
    sponsorCoversDirectUpload: false,
    spendableSats: 100_000,
    feeRate: 1,
  });
  assert.equal(hopeless.shouldRejectOrder, true);
  assert.ok(hopeless.fundableBytes < MIN_SELFPAID_DELIVERABLE_BYTES);

  const viable = buildOrderDeliveryBudget({
    sponsorCoversDirectUpload: false,
    spendableSats: 3_000_000,
    feeRate: 1,
  });
  assert.equal(viable.shouldRejectOrder, false);
  assert.ok(viable.recommendedMaxBytes < viable.fundableBytes, 'headroom keeps the target below capacity');
});

test('buildOrderDeliveryBudget never rejects when the platform covers direct uploads', () => {
  const budget = buildOrderDeliveryBudget({
    sponsorCoversDirectUpload: true,
    spendableSats: 0,
    feeRate: 1,
  });
  assert.equal(budget.shouldRejectOrder, false);
  // Even with an empty wallet, ≤4MB deliverables stay deliverable via the sponsor.
  assert.ok(budget.recommendedMaxBytes >= 4 * 1024 * 1024 * 0.75);
});

test('resolveOrderDeliveryBudget skips text orders and fails open on query errors', async () => {
  const textOrder = await resolveOrderDeliveryBudget({
    metabotStore: metabotStoreStub,
    metabotId: 1,
    mvcAddress: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
    outputType: 'text',
    fetchConfirmedSats: async () => {
      throw new Error('must not be called for text orders');
    },
  });
  assert.equal(textOrder, null);

  const queryFailed = await resolveOrderDeliveryBudget({
    metabotStore: metabotStoreStub,
    metabotId: 1,
    mvcAddress: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
    outputType: 'video',
    fetchConfirmedSats: async () => {
      throw new Error('metalet api down');
    },
  });
  assert.equal(queryFailed, null);
});

test('resolveOrderDeliveryBudget builds a budget from injected deps', async () => {
  const budget = await resolveOrderDeliveryBudget({
    metabotStore: metabotStoreStub,
    metabotId: 1,
    mvcAddress: ' 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa ',
    outputType: 'video',
    fetchConfirmedSats: async () => 3_000_000,
    getFeeRate: () => 1,
    getTrafficPinMode: () => 'selfpay',
  });
  assert.ok(budget);
  assert.equal(budget.sponsorCoversDirectUpload, false);
  assert.equal(budget.spendableSats, 3_000_000);
  assert.equal(budget.shouldRejectOrder, false);
});

test('isSponsorUploadEnabledForMetabot defaults to enabled and honors false/0', () => {
  const storeWith = (value: string | null) => ({
    getMetabotSetting: () => value,
  } as never);
  assert.equal(isSponsorUploadEnabledForMetabot(storeWith(null), 1), true);
  assert.equal(isSponsorUploadEnabledForMetabot(storeWith('true'), 1), true);
  assert.equal(isSponsorUploadEnabledForMetabot(storeWith('false'), 1), false);
  assert.equal(isSponsorUploadEnabledForMetabot(storeWith('0'), 1), false);
});
