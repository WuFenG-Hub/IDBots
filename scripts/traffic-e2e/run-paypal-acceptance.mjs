#!/usr/bin/env node
/**
 * PayPal sandbox acceptance for the traffic recharge flow — drives
 * docs/gasfee-flow/phase4-paypal-backend-requirements.md §12 against the
 * production deployment (which currently runs PayPal in sandbox mode).
 *
 * Real client code paths (compiled dist-electron modules; run
 * `pnpm run compile:electron` first): throwaway identity keygen -> traffic
 * account ensure -> createRechargeOrder(planId, 'paypal') -> PayPal-side
 * order verification via the merchant Orders API (amount/currency/custom_id
 * must match the plan row exactly) -> human pays the printed approvalUrl with
 * a sandbox buyer account -> poll order status until credited -> balance and
 * ledger assertions.
 *
 * Env:
 *   ASSIST_BASE_URL       default https://www.metaso.network/assist-open-api
 *   PAYPAL_CLIENT_ID      sandbox REST app client id (step 5 only)
 *   PAYPAL_CLIENT_SECRET  sandbox REST app secret (step 5 only)
 *   PAYPAL_API_BASE       default https://api-m.sandbox.paypal.com
 *   RECHARGE_PLAN_ID      default usd_1_10mb
 *   POLL_MINUTES          default 10 — how long to wait for the human payment
 *   ORDER_ID              skip creation; resume polling this existing order
 *
 * The throwaway identity mnemonic is cached at .cowork-temp/
 * paypal-e2e-last-identity.json (gitignored, mode 0600) so an ORDER_ID resume
 * can re-attach the same account and still run the balance/ledger assertions.
 * The mnemonic is never printed. PayPal credentials stay in env vars only.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_MAIN = path.resolve(__dirname, '../../dist-electron/main');

const { mvc } = require('meta-contract');
const bip39 = require('@scure/bip39');
const { wordlist } = require('@scure/bip39/wordlists/english');

const { SqliteStore } = require(path.join(DIST_MAIN, 'sqliteStore.js'));
const { convertToGlobalMetaId } = await import(path.join(DIST_MAIN, 'services/globalMetaid.js'));
const trafficAccountService = await import(path.join(DIST_MAIN, 'services/trafficAccountService.js'));

// ---------------------------------------------------------------------------

const API_BASE = (process.env.ASSIST_BASE_URL || 'https://www.metaso.network/assist-open-api').replace(/\/+$/, '');
const PAYPAL_API_BASE = (process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com').replace(/\/+$/, '');
const PAYPAL_CLIENT_ID = (process.env.PAYPAL_CLIENT_ID || '').trim();
const PAYPAL_CLIENT_SECRET = (process.env.PAYPAL_CLIENT_SECRET || '').trim();
const RECHARGE_PLAN_ID = (process.env.RECHARGE_PLAN_ID || 'usd_1_10mb').trim();
const POLL_MINUTES = Math.max(1, Number(process.env.POLL_MINUTES || 10));
const RESUME_ORDER_ID = (process.env.ORDER_ID || '').trim();
const WALLET_PATH = "m/44'/10001'/0'/0/0";
const IDENTITY_CACHE = path.resolve(__dirname, '../../.cowork-temp/paypal-e2e-last-identity.json');

function step(title) {
  console.log(`\n=== ${title} ===`);
}

function printJson(label, value) {
  console.log(`${label}:`, JSON.stringify(value, null, 2));
}

function fail(stepName, error) {
  console.error(`\n[ACCEPTANCE FAIL] ${stepName}: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
  process.exit(1);
}

function assert(condition, stepName, message) {
  if (!condition) fail(stepName, new Error(message));
}

function deriveWallet(mnemonic) {
  const network = mvc.Networks.livenet;
  const child = mvc.Mnemonic.fromString(mnemonic).toHDPrivateKey('', network).deriveChild(WALLET_PATH);
  const address = child.publicKey.toAddress(network).toString();
  return { address, globalMetaId: convertToGlobalMetaId(address) };
}

async function paypalApi(pathname, { method = 'GET', token, body } = {}) {
  const headers = { accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';
  const response = await fetch(`${PAYPAL_API_BASE}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, json };
}

async function paypalAccessToken() {
  // OAuth token endpoint requires form encoding (not JSON).
  const response = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const json = await response.json().catch(() => null);
  assert(response.status === 200 && json?.access_token, 'paypal-auth', `OAuth failed: HTTP ${response.status}`);
  return json.access_token;
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(`API base: ${API_BASE}`);
  console.log(`PayPal API base: ${PAYPAL_API_BASE}`);
  console.log(`Plan: ${RECHARGE_PLAN_ID}`);

  step('1. Preflight: GET /v1/traffic/pricing shows the USD plan');
  const pricingRes = await fetch(`${API_BASE}/v1/traffic/pricing`);
  const pricing = await pricingRes.json().catch(() => null);
  assert(pricingRes.status === 200 && pricing?.code === 0, 'pricing', `unexpected response: HTTP ${pricingRes.status}`);
  const plan = (pricing.data ?? []).find((row) => row.planId === RECHARGE_PLAN_ID && row.status === 1);
  assert(plan, 'pricing', `plan ${RECHARGE_PLAN_ID} not active in the pricing table`);
  printJson('plan', plan);

  let order;
  let balanceBefore = null;

  const initThrowawayService = async (mnemonic) => {
    const phrase = mnemonic || bip39.generateMnemonic(wordlist, 128);
    const identityWallet = deriveWallet(phrase);
    console.log('identity address:', identityWallet.address);
    console.log('identity globalMetaId:', identityWallet.globalMetaId);
    console.log(mnemonic
      ? '(identity restored from the local cache file; mnemonic not printed)'
      : '(mnemonic intentionally not printed)');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'idbots-paypal-e2e-'));
    const store = await SqliteStore.create(tmpDir);
    store.set('traffic.mode', 'traffic');
    store.set('traffic.rechargeGateway', 'paypal');
    trafficAccountService.initTrafficAccountService({
      getStore: () => store,
      getMetabotStore: () => ({ listMetabots: () => [], getMetabotWalletById: () => null }),
      getUserIdentityStore: () => ({
        get: () => ({
          id: 1,
          mnemonic: phrase,
          path: WALLET_PATH,
          mvc_address: identityWallet.address,
          globalmetaid: identityWallet.globalMetaId,
          name: 'PayPal E2E Identity',
        }),
      }),
      baseUrl: API_BASE,
    });
    return { identityWallet, mnemonic: phrase };
  };

  if (RESUME_ORDER_ID) {
    step('2-5. Resuming an existing order (no new order creation)');
    let cached = null;
    try {
      cached = JSON.parse(await fs.readFile(IDENTITY_CACHE, 'utf8'));
    } catch {
      console.log(`no identity cache at ${IDENTITY_CACHE}`);
    }
    const reuse = Boolean(cached && cached.orderId === RESUME_ORDER_ID && typeof cached.mnemonic === 'string');
    if (!reuse) {
      console.log('original identity unavailable — balance/ledger assertions will be skipped (order-status transition still verified).');
    }
    await initThrowawayService(reuse ? cached.mnemonic : undefined);
    order = { orderId: RESUME_ORDER_ID, trafficBytes: plan.trafficBytes, payAmount: plan.payAmount, payCurrency: plan.payCurrency };
    if (reuse) {
      await trafficAccountService.ensureTrafficAccount().catch((error) => fail('ensureTrafficAccount', error));
      balanceBefore = (await trafficAccountService.getTrafficBalance({ forceRefresh: true })).balanceBytes;
      console.log('balance before credit (resumed identity):', balanceBefore);
    }
  } else {
    step('2. Generate throwaway identity + init the traffic account service');
    const identity = await initThrowawayService();

    step('3. Ensure traffic account + balance before');
    const account = await trafficAccountService.ensureTrafficAccount().catch((error) => fail('ensureTrafficAccount', error));
    printJson('account', account);
    balanceBefore = (await trafficAccountService.getTrafficBalance({ forceRefresh: true })).balanceBytes;
    console.log('balance before recharge:', balanceBefore);

    step('4. Create recharge order (gateway=paypal) — §12.1');
    order = await trafficAccountService.createRechargeOrder(RECHARGE_PLAN_ID, 'paypal')
      .catch((error) => fail('createRechargeOrder', error));
    printJson('created order', order);
    assert(order.orderId, 'createRechargeOrder', 'orderId missing');
    assert(Number(order.payAmount) === Number(plan.payAmount), 'createRechargeOrder', `payAmount ${order.payAmount} != plan ${plan.payAmount}`);
    assert(order.payCurrency === plan.payCurrency, 'createRechargeOrder', `payCurrency ${order.payCurrency} != plan ${plan.payCurrency}`);
    assert(Number(order.trafficBytes) === Number(plan.trafficBytes), 'createRechargeOrder', `trafficBytes ${order.trafficBytes} != plan ${plan.trafficBytes}`);
    const gatewayParams = order.gatewayParams && typeof order.gatewayParams === 'object' ? order.gatewayParams : {};
    const approvalUrl = String(gatewayParams.approvalUrl || '');
    assert(/^https:\/\/(www\.)?(sandbox\.)?paypal\.com\//.test(approvalUrl), 'createRechargeOrder', `approvalUrl is not a PayPal checkout URL: ${approvalUrl}`);
    assert(String(gatewayParams.paypalOrderId || ''), 'createRechargeOrder', 'paypalOrderId missing in gatewayParams');

    await fs.mkdir(path.dirname(IDENTITY_CACHE), { recursive: true });
    await fs.writeFile(IDENTITY_CACHE, JSON.stringify({ orderId: order.orderId, mnemonic: identity.mnemonic }, null, 2));
    await fs.chmod(IDENTITY_CACHE, 0o600);
    console.log(`identity cached at ${IDENTITY_CACHE} (gitignored, mode 0600) — an ORDER_ID resume reuses it for the balance/ledger assertions`);

    step('5. PayPal-side order verification via merchant Orders API — §12.1 amount');
    if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
      console.log('PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET not set; skipping PayPal-side verification.');
    } else {
      const accessToken = await paypalAccessToken();
      const orderRes = await paypalApi(`/v2/checkout/orders/${encodeURIComponent(String(gatewayParams.paypalOrderId))}`, { token: accessToken });
      assert(orderRes.status === 200 && orderRes.json?.id, 'paypal-order', `order fetch failed: HTTP ${orderRes.status} ${JSON.stringify(orderRes.json).slice(0, 300)}`);
      const ppOrder = orderRes.json;
      const unit = ppOrder.purchase_units?.[0] ?? {};
      printJson('paypal order', {
        id: ppOrder.id,
        intent: ppOrder.intent,
        status: ppOrder.status,
        amount: unit.amount,
        custom_id: unit.custom_id,
        invoice_id: unit.invoice_id,
      });
      assert(ppOrder.intent === 'CAPTURE', 'paypal-order', `intent ${ppOrder.intent} != CAPTURE`);
      assert(unit.amount?.currency_code === plan.payCurrency, 'paypal-order', `currency ${unit.amount?.currency_code} != ${plan.payCurrency}`);
      assert(
        Math.abs(Number(unit.amount?.value) - Number(plan.payAmount)) < 1e-9,
        'paypal-order',
        `amount ${unit.amount?.value} != plan ${plan.payAmount}`,
      );
      assert(unit.custom_id === order.orderId, 'paypal-order', `custom_id ${unit.custom_id} != our orderId ${order.orderId}`);
      assert(unit.invoice_id === order.orderId, 'paypal-order', `invoice_id ${unit.invoice_id} != our orderId ${order.orderId}`);
      console.log('PayPal-side fields match the plan row exactly (amount, currency, custom_id, invoice_id).');
    }

    console.log('\n>>> HUMAN ACTION NEEDED: pay this sandbox checkout with the sandbox BUYER account:');
    console.log(`>>> ${approvalUrl}`);
    console.log(`>>> (order ${order.orderId}; polling for up to ${POLL_MINUTES} min — re-run with ORDER_ID=${order.orderId} to resume)`);
  }

  step('6. Poll order status until credited — §12.2');
  const deadline = Date.now() + POLL_MINUTES * 60_000;
  let finalStatus = null;
  while (Date.now() < deadline) {
    const status = await trafficAccountService.getRechargeOrder(order.orderId)
      .catch((error) => { console.log('  poll error (retrying):', error instanceof Error ? error.message : error); return null; });
    if (status) {
      if (!finalStatus || finalStatus.status !== status.status) {
        printJson('order status', status);
        finalStatus = status;
      }
      if (status.status === 3 || status.status === 4) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  assert(finalStatus, 'poll', 'no status response within the poll window');
  assert(finalStatus.status !== 4, 'poll', 'order was CLOSED before payment (check the janitor / expiry config)');
  assert(finalStatus.status === 3, 'poll', `order not credited within ${POLL_MINUTES} min (last status ${finalStatus.status}); re-run with ORDER_ID=${order.orderId} to keep waiting`);

  step('7. Balance + ledger assertions — §12.2');
  if (balanceBefore === null) {
    console.log('resumed without the original identity: balance/ledger assertions skipped (the order-status transition above is still verified).');
  } else {
    const balanceAfter = (await trafficAccountService.getTrafficBalance({ forceRefresh: true })).balanceBytes;
    console.log(`balance after credit: ${balanceAfter} (before ${balanceBefore}, delta ${balanceAfter - balanceBefore})`);
    assert(balanceAfter - balanceBefore === Number(order.trafficBytes), 'balance', `delta ${balanceAfter - balanceBefore} != trafficBytes ${order.trafficBytes}`);
    const ledger = await trafficAccountService.getTrafficLedger({ limit: 20 });
    const grant = ledger.entries.find((entry) => entry.sourceType === 'recharge_order' && entry.sourceId === order.orderId && entry.direction === 1);
    printJson('recharge ledger entry', grant ?? '(not found)');
    assert(grant, 'ledger', `no grant ledger entry with sourceType=recharge_order sourceId=${order.orderId}`);
    assert(Number(grant.amountBytes) === Number(order.trafficBytes), 'ledger', `ledger amount ${grant.amountBytes} != trafficBytes ${order.trafficBytes}`);
  }

  console.log('\n[ACCEPTANCE OK] §12.1-§12.2 verified end-to-end (PayPal sandbox).');
  console.log('Note: §12.3 duplicate-webhook idempotency and §12.4 forged-webhook rejection were pre-verified online by the backend team; §12.7 (24h close of abandoned orders) is covered by their janitor, observed live at deploy time.');
}

main().catch((error) => fail('unexpected', error));
