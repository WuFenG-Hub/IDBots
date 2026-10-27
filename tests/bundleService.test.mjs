import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/**
 * REQ-A-24 — bundle service unit tests (C4 Metaso bundle API).
 *
 * Covers the local stub (plan shape per the C4 example, order creation with a
 * fake QR, first-poll crediting), the real-mode HTTP layer (identity headers
 * on the signed endpoints, unsigned reads per C4), and the getMeters key
 * hygiene (no API key may leak into the result).
 */

const require = createRequire(import.meta.url);
const { mvc } = require('meta-contract');

const {
  BUNDLE_ORDER_STATUS,
  getBundleMeters,
  getBundleOrder,
  getBundlePlans,
  createBundleOrder,
  initBundleService,
  isBundleStubMode,
  resetBundleServiceForTests,
  resolveBundleApiBaseUrl,
} = require('../dist-electron/main/services/bundleService.js');

const IDENTITY_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const WALLET_PATH = "m/44'/10001'/0'/0/0";
const IDENTITY_GMID = 'idq1localidentity';

function deriveAddress(mnemonic) {
  const network = mvc.Networks.livenet;
  const child = mvc.Mnemonic.fromString(mnemonic).toHDPrivateKey('', network).deriveChild(WALLET_PATH);
  return child.publicKey.toAddress(network).toString();
}

const IDENTITY_ADDRESS = deriveAddress(IDENTITY_MNEMONIC);

function verifyMessage(address, message, signature) {
  try {
    return mvc.Message(message).verify(address, signature);
  } catch {
    return false;
  }
}

function envelope(data) {
  return JSON.stringify({ code: 0, message: 'ok', data });
}

function createFetchStub(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const text = String(url);
    calls.push({ url: text, init });
    for (const [suffix, responder] of routes) {
      if (text.includes(suffix)) {
        const body = await (typeof responder === 'function' ? responder(init) : responder);
        if (body && typeof body === 'object' && typeof body.__httpStatus === 'number') {
          return { ok: false, status: body.__httpStatus, json: async () => body.__body };
        }
        const raw = typeof body === 'string'
          ? body
          : body && typeof body === 'object' && 'code' in body
            ? JSON.stringify(body)
            : envelope(body);
        return { ok: true, status: 200, json: async () => JSON.parse(raw) };
      }
    }
    return { ok: false, status: 404, json: async () => ({ code: 1, message: 'not found' }) };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function callsToPath(fetchImpl, pathName) {
  return fetchImpl.calls.filter((call) => {
    try {
      return new URL(call.url).pathname === pathName;
    } catch {
      return false;
    }
  });
}

function makeIdentityStore() {
  return {
    get: () => ({
      id: 1,
      mnemonic: IDENTITY_MNEMONIC,
      path: WALLET_PATH,
      mvc_address: IDENTITY_ADDRESS,
      globalmetaid: IDENTITY_GMID,
      name: 'Owner',
    }),
  };
}

/** Init the service with env hygiene: stub/base env vars are saved and restored. */
function initService(options = {}) {
  const saved = {
    stub: process.env.IDBOTS_BUNDLE_STUB,
    base: process.env.IDBOTS_METASO_API_BASE,
  };
  delete process.env.IDBOTS_BUNDLE_STUB;
  delete process.env.IDBOTS_METASO_API_BASE;
  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      process.env[key] = value;
    }
  }
  resetBundleServiceForTests();
  initBundleService({
    getStore: () => options.store ?? null,
    getUserIdentityStore: () => makeIdentityStore(),
    fetchImpl: options.fetchImpl,
    baseUrl: options.baseUrl,
    getTrafficBalanceImpl: options.getTrafficBalanceImpl,
  });
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetBundleServiceForTests();
  };
}

// ---------------------------------------------------------------------------
// Local stub mode
// ---------------------------------------------------------------------------

test('stub plans list matches the C4 example (stub://local)', async (t) => {
  const restore = initService({ baseUrl: 'stub://local' });
  t.after(restore);

  assert.equal(isBundleStubMode(), true);
  const plans = await getBundlePlans();
  assert.equal(plans.length, 2);

  const basic = plans.find((plan) => plan.planId === 'bundle_basic_cny');
  assert.deepEqual(basic, {
    planId: 'bundle_basic_cny',
    name: '基础包',
    nameEn: 'Basic',
    payCurrency: 'CNY',
    payAmount: '19.90',
    trafficBytes: 104857600,
    llmQuota: 2000000,
    llmQuotaUnit: 'tokens',
    status: 1,
    sort: 10,
    remark: '',
  });

  const testPlan = plans.find((plan) => plan.planId === 'bundle_test_cny');
  assert.ok(testPlan);
  assert.equal(testPlan.payAmount, '0.01');
  assert.equal(testPlan.payCurrency, 'CNY');
});

test('stub mode is forced by IDBOTS_BUNDLE_STUB=1 even with an https base', async (t) => {
  const fetchImpl = createFetchStub([]);
  const restore = initService({
    baseUrl: 'https://bundle.test',
    fetchImpl,
    env: { IDBOTS_BUNDLE_STUB: '1' },
  });
  t.after(restore);

  assert.equal(isBundleStubMode(), true);
  const plans = await getBundlePlans();
  assert.equal(plans.length, 2);
  assert.equal(fetchImpl.calls.length, 0, 'stub mode must not hit the network');
});

test('stub order carries a fake QR and credits on the first poll', async (t) => {
  const restore = initService({ baseUrl: 'stub://local' });
  t.after(restore);

  const order = await createBundleOrder({ planId: 'bundle_basic_cny' });
  assert.match(order.orderId, /^bo_stub_/);
  assert.equal(order.planId, 'bundle_basic_cny');
  assert.equal(order.payAmount, '19.90');
  assert.ok(order.gatewayParams.qrCode, 'stub order must return a fake gatewayParams.qrCode');
  assert.ok(order.expiresAt > Date.now() / 1000);

  // First poll reports credited (stub payment confirms immediately) and the
  // credited state is stable across further polls.
  const first = await getBundleOrder({ orderId: order.orderId });
  assert.equal(first.status, BUNDLE_ORDER_STATUS.CREDITED);
  assert.ok(first.paidAt > 0 && first.creditedAt > 0);
  const second = await getBundleOrder({ orderId: order.orderId });
  assert.equal(second.status, BUNDLE_ORDER_STATUS.CREDITED);
});

test('stub getMeters reflects credited purchases without exposing any key', async (t) => {
  const restore = initService({
    baseUrl: 'stub://local',
    getTrafficBalanceImpl: async () => ({
      accountId: 'acct-stub',
      identityAddress: IDENTITY_ADDRESS,
      balanceBytes: 4096,
      reservedBytes: 0,
      grantedBytesTotal: 4096,
      spentBytesTotal: 0,
      status: 1,
    }),
  });
  t.after(restore);

  const before = await getBundleMeters();
  assert.equal(before.traffic.balanceBytes, 4096);
  assert.equal(before.llm.quotaPurchased, 0);
  assert.equal(before.llm.unit, 'tokens');

  const order = await createBundleOrder({ planId: 'bundle_basic_cny' });
  await getBundleOrder({ orderId: order.orderId });

  const after = await getBundleMeters();
  assert.equal(after.llm.quotaPurchased, 2000000);
  assert.equal(after.llm.quotaTotal, after.llm.quotaFree + after.llm.quotaPurchased);
  assert.equal(after.llm.quotaRemaining, after.llm.quotaTotal - after.llm.quotaUsed);
  assert.ok(!JSON.stringify(after).includes('apiKey'));

  await getBundleOrder({ orderId: order.orderId });
  await getBundleOrder({ orderId: order.orderId });
  const repeated = await getBundleMeters();
  assert.deepEqual(repeated.llm, after.llm, 'repeated order polls must not credit the plan again');
});

// ---------------------------------------------------------------------------
// Real mode (mocked fetch)
// ---------------------------------------------------------------------------

test('real mode: plans are unsigned, createOrder signs bundle-order:<accountId>:<planId>:<ts>', async (t) => {
  let orderCapture = null;
  const fetchImpl = createFetchStub([
    ['/v1/bundle/plans', [{ planId: 'bundle_basic_cny', name: '基础包', nameEn: 'Basic', payCurrency: 'CNY', payAmount: '19.90', trafficBytes: 104857600, llmQuota: 2000000, llmQuotaUnit: 'tokens', status: 1, sort: 10, remark: '' }]],
    ['/v1/bundle/orders', (init) => {
      orderCapture = { headers: init.headers, body: JSON.parse(init.body) };
      return {
        orderId: 'bo_real_1',
        planId: 'bundle_basic_cny',
        payAmount: '19.90',
        payCurrency: 'CNY',
        trafficBytes: 104857600,
        llmQuota: 2000000,
        gatewayParams: { qrCode: 'https://qr.alipay.com/real', alipayOutTradeNo: 'out-1' },
        expiresAt: 1760000000,
      };
    }],
  ]);
  const restore = initService({ baseUrl: 'https://bundle.test', fetchImpl });
  t.after(restore);

  assert.equal(isBundleStubMode(), false);

  const plans = await getBundlePlans();
  assert.equal(plans.length, 1);
  const plansCalls = callsToPath(fetchImpl, '/v1/bundle/plans');
  assert.equal(plansCalls.length, 1);
  assert.ok(!('X-Identity-Address' in plansCalls[0].init.headers), 'C4: GET /v1/bundle/plans carries no signature');

  const order = await createBundleOrder({ planId: 'bundle_basic_cny' });
  assert.equal(order.orderId, 'bo_real_1');
  assert.equal(order.gatewayParams.qrCode, 'https://qr.alipay.com/real');
  assert.equal(callsToPath(fetchImpl, '/v1/bundle/orders').length, 1);

  assert.equal(orderCapture.body.planId, 'bundle_basic_cny');
  assert.equal(orderCapture.body.gateway, 'alipay', 'CNY bundle orders default to the Alipay gateway');
  assert.equal(orderCapture.headers['X-Identity-Address'], IDENTITY_ADDRESS);
  const timestamp = Number(orderCapture.headers['X-Timestamp']);
  assert.ok(Number.isInteger(timestamp) && timestamp > 0);
  assert.ok(
    verifyMessage(
      IDENTITY_ADDRESS,
      `bundle-order:${IDENTITY_GMID}:bundle_basic_cny:${timestamp}`,
      orderCapture.headers['X-Signature'],
    ),
    'X-Signature must verify against bundle-order:<accountId>:<planId>:<ts>',
  );
});

test('real mode: getOrder reads the unsigned status endpoint', async (t) => {
  const fetchImpl = createFetchStub([
    ['/v1/bundle/orders/bo_real_1', {
      orderId: 'bo_real_1',
      planId: 'bundle_basic_cny',
      status: 2,
      payAmount: '19.90',
      payCurrency: 'CNY',
      trafficBytes: 104857600,
      llmQuota: 2000000,
      paidAt: 1760000000,
    }],
  ]);
  const restore = initService({ baseUrl: 'https://bundle.test', fetchImpl });
  t.after(restore);

  const status = await getBundleOrder({ orderId: 'bo_real_1' });
  assert.equal(status.status, BUNDLE_ORDER_STATUS.PAID);
  assert.equal(status.paidAt, 1760000000);
  const calls = callsToPath(fetchImpl, '/v1/bundle/orders/bo_real_1');
  assert.equal(calls.length, 1);
  assert.ok(!('X-Identity-Address' in calls[0].init.headers), 'C4: GET /v1/bundle/orders/{id} carries no signature');
});

const SECRET_KEY_VALUE = 'sk-relay-secret-key-value';

test('getMeters rebuilds the C4 quota shape and never exposes an API key', async (t) => {
  let quotaCapture = null;
  const fetchImpl = createFetchStub([
    ['/v2/assist/llm/quota', (init) => {
      quotaCapture = { headers: init.headers };
      // The backend payload carries relay credential material alongside the
      // C4 quota fields; getMeters must rebuild the shape and drop all of it.
      return {
        apiKey: SECRET_KEY_VALUE,
        keyPrefix: 'mf-abc',
        baseUrl: 'https://relay.internal/',
        quotaTotal: 2100000,
        quotaUsed: 100000,
        quotaRemaining: 2000000,
        quotaFree: 100000,
        quotaPurchased: 2000000,
        unit: 'tokens',
      };
    }],
  ]);
  const trafficRecord = {
    accountId: 'acct-real',
    identityAddress: IDENTITY_ADDRESS,
    balanceBytes: 8192,
    reservedBytes: 0,
    grantedBytesTotal: 8192,
    spentBytesTotal: 0,
    status: 1,
  };
  let trafficOptions;
  const restore = initService({
    baseUrl: 'https://bundle.test',
    fetchImpl,
    getTrafficBalanceImpl: async (options) => {
      trafficOptions = options;
      return trafficRecord;
    },
  });
  t.after(restore);

  const meters = await getBundleMeters();
  assert.deepEqual(trafficOptions, { forceRefresh: true });
  assert.deepEqual(meters.traffic, trafficRecord);
  assert.deepEqual(meters.llm, {
    quotaTotal: 2100000,
    quotaUsed: 100000,
    quotaRemaining: 2000000,
    quotaFree: 100000,
    quotaPurchased: 2000000,
    unit: 'tokens',
  });

  const serialized = JSON.stringify(meters);
  assert.ok(!serialized.includes(SECRET_KEY_VALUE), 'no API key may appear in getMeters output');
  assert.ok(!serialized.includes('keyPrefix'));
  assert.ok(!serialized.includes('relay.internal'));

  assert.equal(quotaCapture.headers['X-Identity-Address'], IDENTITY_ADDRESS);
  const timestamp = Number(quotaCapture.headers['X-Timestamp']);
  assert.ok(
    verifyMessage(
      IDENTITY_ADDRESS,
      `llm-relay-quota:${IDENTITY_ADDRESS}:${timestamp}`,
      quotaCapture.headers['X-Signature'],
    ),
    'quota read signs llm-relay-quota:<identityAddress>:<ts> (C4 sibling of the ledger convention)',
  );
});

test('getMeters degrades traffic to null when the traffic read fails', async (t) => {
  const fetchImpl = createFetchStub([
    ['/v2/assist/llm/quota', { quotaTotal: 100000, quotaUsed: 0, quotaRemaining: 100000, quotaFree: 100000, quotaPurchased: 0, unit: 'tokens' }],
  ]);
  const restore = initService({
    baseUrl: 'https://bundle.test',
    fetchImpl,
    getTrafficBalanceImpl: async () => {
      throw new Error('traffic offline');
    },
  });
  t.after(restore);

  const meters = await getBundleMeters();
  assert.equal(meters.traffic, null);
  assert.equal(meters.llm.quotaTotal, 100000);
});

// ---------------------------------------------------------------------------
// Base-URL resolution
// ---------------------------------------------------------------------------

test('base URL precedence: IDBOTS_METASO_API_BASE env beats the injected override', async (t) => {
  const restore = initService({
    baseUrl: 'https://injected.test',
    env: { IDBOTS_METASO_API_BASE: 'https://env.test/' },
  });
  t.after(restore);
  assert.equal(resolveBundleApiBaseUrl(), 'https://env.test');
});
