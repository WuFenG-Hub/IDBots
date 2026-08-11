#!/usr/bin/env node
/**
 * GasFee traffic-ization E2E against the backend test instance (mainnet).
 *
 * Runs the full closed loop with real code paths from this repo (compiled
 * dist-electron modules; run `npm run compile:electron` first):
 *   identity/bot keygen -> traffic account ensure -> bot dust UTXO init ->
 *   bind -> mock recharge (+idempotent re-confirm) -> real sponsored MetaID
 *   pin via sponsor v2 pre/commit with trafficAccount -> deduction checks
 *   (balance/ledger/usage/admin).
 *
 * Env:
 *   ASSIST_BASE_URL     default http://47.76.58.120:7882 (no secret; the
 *                       /assist-open-api suffix is appended when missing)
 *   ASSIST_ADMIN_TOKEN  admin bearer token for the /v1/admin/* spot checks
 *
 * Secrets policy: mnemonics/private keys are never printed or persisted;
 * request signatures are never printed either (only verification results).
 * Only addresses, GlobalMetaIDs, txids and order ids appear in the output.
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
const {
  fetchMvcAddressUtxos,
  getEstimatedBaseTxSize,
  getOpReturnScriptSize,
} = await import(path.join(DIST_MAIN, 'services/mvcSponsorClient.js'));
const { runMvcSponsorCreatePin } = await import(path.join(DIST_MAIN, 'services/mvcSponsorCreatePin.js'));
const { assembleMvcPinTransaction } = await import(path.join(DIST_MAIN, 'libs/createPinWorker.js'));

// ---------------------------------------------------------------------------

// The production deployment serves the API under /assist-open-api (reverse
// proxy); the test instance serves the same routes at the root, so the base
// URL is used verbatim (pass https://www.metaso.network/assist-open-api to
// point at production).
const API_BASE = (process.env.ASSIST_BASE_URL || 'http://47.76.58.120:7882').replace(/\/+$/, '');
const ADMIN_TOKEN = (process.env.ASSIST_ADMIN_TOKEN || '').trim();
const WALLET_PATH = "m/44'/10001'/0'/0/0";
const RECHARGE_PLAN_ID = 'cny_10_100mb';

function step(title) {
  console.log(`\n=== ${title} ===`);
}

function printJson(label, value) {
  console.log(`${label}:`, JSON.stringify(value, null, 2));
}

function fail(stepName, error) {
  console.error(`\n[E2E FAIL] ${stepName}: ${error instanceof Error ? error.message : String(error)}`);
  if (error && typeof error === 'object') {
    const extra = {};
    for (const key of ['code', 'reason', 'stage', 'status', 'featureUnavailable', 'feeAssist']) {
      if (error[key] !== undefined) extra[key] = error[key];
    }
    if (Object.keys(extra).length > 0) {
      console.error('[E2E FAIL] error detail:', JSON.stringify(extra, null, 2));
    }
  }
  process.exitCode = 1;
  process.exit(1);
}

async function apiFetch(pathname, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${API_BASE}${pathname}`, {
    method,
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, json };
}

function deriveWallet(mnemonic) {
  const network = mvc.Networks.livenet;
  const child = mvc.Mnemonic.fromString(mnemonic).toHDPrivateKey('', network).deriveChild(WALLET_PATH);
  const address = child.publicKey.toAddress(network).toString();
  return { address, globalMetaId: convertToGlobalMetaId(address) };
}

async function waitForUtxos(address, attempts = 20, delayMs = 3000) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const utxos = await fetchMvcAddressUtxos(address);
      if (utxos.length > 0) return utxos;
    } catch (error) {
      console.log(`  utxo poll ${attempt}/${attempts}: ${error instanceof Error ? error.message : error}`);
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return [];
}

// ---------------------------------------------------------------------------

async function runE2E() {
  console.log(`API base: ${API_BASE}`);
  console.log(`Admin token: ${ADMIN_TOKEN ? '[provided]' : '[missing — admin checks will be skipped]'}`);

  step('0. Preflight: GET /v1/traffic/pricing');
  const pricing = await apiFetch('/v1/traffic/pricing');
  if (pricing.status !== 200 || pricing.json?.code !== 0) {
    fail('preflight pricing', new Error(`unexpected response: HTTP ${pricing.status} ${JSON.stringify(pricing.json)}`));
  }
  printJson('plans', pricing.json.data);

  step('1. Generate test identity + bot wallets (fresh, throwaway)');
  const identityWallet = deriveWallet(IDENTITY_MNEMONIC_REF.value);
  const botWallet = deriveWallet(BOT_MNEMONIC_REF.value);
  console.log('identity address:', identityWallet.address);
  console.log('identity globalMetaId:', identityWallet.globalMetaId);
  console.log('bot address:', botWallet.address);
  console.log('bot globalMetaId:', botWallet.globalMetaId);
  console.log('(mnemonics/keys intentionally not printed)');

  step('2. Init traffic account service against a throwaway SQLite store');
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'idbots-traffic-e2e-'));
  const store = await SqliteStore.create(tmpDir);
  store.set('traffic.mode', 'traffic');
  const fakeUserIdentityStore = {
    get: () => ({
      id: 1,
      mnemonic: IDENTITY_MNEMONIC_REF.value,
      path: WALLET_PATH,
      mvc_address: identityWallet.address,
      globalmetaid: identityWallet.globalMetaId,
      name: 'E2E Identity',
    }),
  };
  const fakeMetabotStore = {
    listMetabots: () => [{ id: 1, mvc_address: botWallet.address, wallet_id: 1 }],
    getMetabotWalletById: (walletId) => (
      walletId === 1 ? { id: 1, mnemonic: BOT_MNEMONIC_REF.value, path: WALLET_PATH } : null
    ),
  };
  trafficAccountService.initTrafficAccountService({
    getStore: () => store,
    getMetabotStore: () => fakeMetabotStore,
    getUserIdentityStore: () => fakeUserIdentityStore,
    baseUrl: API_BASE,
  });
  console.log('service initialized (traffic.mode=traffic, kv backed by', tmpDir, ')');

  step('3. Ensure traffic account (identity-signed get-or-create)');
  let account;
  try {
    account = await trafficAccountService.ensureTrafficAccount();
  } catch (error) {
    fail('ensureTrafficAccount', error);
  }
  printJson('account', account);
  console.log('accountId matches locally derived globalMetaId:', account.accountId === identityWallet.globalMetaId);

  step('4. Bot dust UTXOs via /v1/assist/gas/mvc/address-init-v2');
  let initOk = false;
  for (const endpoint of ['address-init-v2', 'address-init']) {
    const res = await apiFetch(`/v1/assist/gas/mvc/${endpoint}`, {
      method: 'POST',
      body: { address: botWallet.address, gasChain: 'mvc' },
    });
    console.log(`${endpoint}: HTTP ${res.status}`, JSON.stringify(res.json?.code !== undefined ? { code: res.json.code, message: res.json.message ?? res.json.msg } : res.json));
    if (res.status === 200 && res.json?.code === 0) {
      printJson(`${endpoint} data`, res.json.data);
      initOk = true;
      break;
    }
  }
  if (!initOk) {
    fail('address-init', new Error('both address-init-v2 and address-init failed; refusing to self-fund'));
  }
  console.log('waiting for the init UTXOs to appear on the indexer…');
  const utxos = await waitForUtxos(botWallet.address);
  if (utxos.length === 0) {
    fail('utxo poll', new Error('init UTXOs did not appear on the Metalet indexer in time'));
  }
  printJson('bot utxos', utxos.map((u) => ({ txId: u.txId, outputIndex: u.outputIndex, satoshis: u.satoshis, height: u.height })));

  step('5. Bind bot + identity addresses (dual-signed)');
  const bindSummary = await trafficAccountService.bindAllLocalBots();
  printJson('bind summary', bindSummary);
  if (bindSummary.failedCount > 0 || bindSummary.conflictCount > 0) {
    fail('bindAllLocalBots', new Error(`unexpected bind outcome: ${JSON.stringify(bindSummary.results)}`));
  }

  step('6. Mock recharge ¥10 -> 100,000,000 bytes (+ idempotent re-confirm)');
  const balanceBeforeRecharge = (await trafficAccountService.getTrafficBalance({ forceRefresh: true })).balanceBytes;
  console.log('balance before recharge:', balanceBeforeRecharge);
  const order = await trafficAccountService.createRechargeOrder(RECHARGE_PLAN_ID);
  printJson('created order', order);
  const confirm1 = await trafficAccountService.mockConfirmRechargeOrder(order.orderId);
  printJson('mock-confirm #1', confirm1);
  const confirm2 = await trafficAccountService.mockConfirmRechargeOrder(order.orderId);
  printJson('mock-confirm #2 (idempotency check)', confirm2);
  const balanceAfterRecharge = (await trafficAccountService.getTrafficBalance({ forceRefresh: true })).balanceBytes;
  console.log('balance after recharge:', balanceAfterRecharge);
  const credited = balanceAfterRecharge - balanceBeforeRecharge;
  console.log(`credited bytes: ${credited} (expected ${order.trafficBytes}; idempotent re-confirm must not double it)`);
  if (credited !== order.trafficBytes) {
    fail('recharge credit', new Error(`balance delta ${credited} != order trafficBytes ${order.trafficBytes}`));
  }

  step('7. Real sponsored MetaID pin via sponsor v2 + trafficAccount');
  const pinPayload = `gasfee-flow e2e ${Date.now()}`;
  const opReturnParts = ['metaid', 'create', '/protocols/simplebuzz', '0', '1.0', 'text/plain;utf-8', Buffer.from(pinPayload, 'utf8')];
  const addressObj = new mvc.Address(botWallet.address, mvc.Networks.livenet);
  const assembled = assembleMvcPinTransaction({
    addressObj,
    opReturnParts,
    usableUtxos: utxos,
    feeRate: 1,
    estimatedTxSizeWithoutInputs: getEstimatedBaseTxSize(getOpReturnScriptSize(opReturnParts)),
    excludedOutpoints: new Set(),
    preferredOutpoints: new Set(),
    deductMinerFeeFromChange: false,
  });
  const draftOutputs = assembled.txComposer.tx.outputs;
  const draftChangeSatoshis = Number(draftOutputs[draftOutputs.length - 1]?.satoshis);
  const draftResult = {
    txids: [],
    pinId: '',
    totalCost: 0,
    spentOutpoints: assembled.picked.map((utxo) => `${utxo.txId}:${utxo.outputIndex}`),
    changeUtxo: null,
    draft: {
      unsignedTxHex: assembled.txComposer.getRawHex(),
      estimatedTxSize: getEstimatedBaseTxSize(getOpReturnScriptSize(opReturnParts)) + (assembled.picked.length + 1) * 148,
      feeRate: 1,
      userInputs: assembled.picked,
      changeOutput: draftOutputs.length > 1 && draftChangeSatoshis >= 600
        ? { outputIndex: draftOutputs.length - 1, satoshis: draftChangeSatoshis }
        : null,
    },
  };
  console.log('draft built:', {
    inputs: draftResult.spentOutpoints,
    estimatedTxSize: draftResult.draft.estimatedTxSize,
    changeOutput: draftResult.draft.changeOutput,
    payload: pinPayload,
  });

  const balanceBeforePin = (await trafficAccountService.getTrafficBalance({ forceRefresh: true })).balanceBytes;
  let pinResult;
  try {
    pinResult = await runMvcSponsorCreatePin(
      {
        metabotId: 1,
        mnemonic: BOT_MNEMONIC_REF.value,
        walletPath: WALLET_PATH,
        mvcAddress: botWallet.address,
        feeRate: 1,
        fallbackPolicy: 'strict',
        baseUrl: API_BASE,
      },
      {
        runDraftWorker: async () => draftResult,
        runBroadcastWorker: async () => {
          throw new Error('self-pay broadcast fallback must not run in the E2E (strict policy)');
        },
        recordSpentOutpoints: (outpoints) => console.log('session: spent outpoints recorded', outpoints),
        replacePendingFundingUtxos: (utxo) => console.log('session: pending change utxo', utxo),
        resolveTrafficAccount: ({ challengeId }) => trafficAccountService.resolveSponsorTrafficAccount({
          botAddress: botWallet.address,
          challengeId,
          botMnemonic: BOT_MNEMONIC_REF.value,
          botWalletPath: WALLET_PATH,
        }),
      },
    );
  } catch (error) {
    fail('sponsored pin', error);
  }
  printJson('pin result', {
    txids: pinResult.txids,
    pinId: pinResult.pinId,
    totalCost: pinResult.totalCost,
    feeAssist: pinResult.feeAssist,
  });

  step('8. Deduction verification (balance / ledger / usage / admin)');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const balanceAfterPin = (await trafficAccountService.getTrafficBalance({ forceRefresh: true })).balanceBytes;
  const deducted = balanceBeforePin - balanceAfterPin;
  const txSize = pinResult.feeAssist?.txSize ?? 0;
  console.log(`balance before pin: ${balanceBeforePin}; after pin: ${balanceAfterPin}; deducted: ${deducted}; commit txSize: ${txSize}`);
  console.log('deduction matches txSize:', deducted === txSize);

  const ledger = await trafficAccountService.getTrafficLedger({ limit: 20 });
  printJson('ledger entries (latest first)', ledger.entries.map((entry) => ({
    direction: entry.direction,
    amountBytes: entry.amountBytes,
    sourceType: entry.sourceType,
    sourceId: entry.sourceId,
    remark: entry.remark,
    balanceAfter: entry.balanceAfter,
  })));

  const usage = await trafficAccountService.getTrafficDailyUsage({});
  printJson('usage/daily rows', usage);

  const journal = trafficAccountService.listLocalTrafficJournal({ limit: 5 });
  printJson('local spend journal', journal);

  if (ADMIN_TOKEN) {
    const headers = { Authorization: `Bearer ${ADMIN_TOKEN}` };
    const overview = await apiFetch('/v1/admin/traffic/overview', { headers });
    console.log('admin overview: HTTP', overview.status);
    printJson('admin overview data', overview.json?.data);
    const adminAccount = await apiFetch(`/v1/admin/traffic/accounts/${encodeURIComponent(account.accountId)}`, { headers });
    console.log('admin account detail: HTTP', adminAccount.status);
    printJson('admin account data', adminAccount.json?.data);
  } else {
    console.log('ASSIST_ADMIN_TOKEN not set; skipping admin spot checks.');
  }

  console.log('\n[E2E OK] all steps completed.');
}

// Mnemonic refs are populated just before the run and live behind closure
// holders so they never appear in module scope logs or error stacks.
const IDENTITY_MNEMONIC_REF = { value: '' };
const BOT_MNEMONIC_REF = { value: '' };

async function main() {
  IDENTITY_MNEMONIC_REF.value = bip39.generateMnemonic(wordlist, 128);
  BOT_MNEMONIC_REF.value = bip39.generateMnemonic(wordlist, 128);
  await runE2E();
}

main().catch((error) => fail('unexpected', error));
