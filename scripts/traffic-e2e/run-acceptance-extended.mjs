#!/usr/bin/env node
/**
 * Extended acceptance E2E for the gasfee traffic-ization backend (Spec §9).
 * Covers the clauses not exercised by run-traffic-e2e.mjs:
 *   §9.5  concurrent pres/commits from two bots on one account stay consistent
 *   §9.6  expiring an open order releases the reservation (ledger release)
 *   §9.8a zero-balance trafficAccount pre -> TRAFFIC_INSUFFICIENT envelope
 *   §9.8b same bot without trafficAccount -> legacy quota path still works
 *   §9.10 admin fee-rate change applies to subsequent orders (bytes billing)
 *   §9.11 admin plan create -> public pricing; archive -> disappears
 *   §9.12 admin manual grant idempotency (applied=false on replay)
 *
 * Env: ASSIST_BASE_URL (default http://47.76.58.120:7882, used verbatim),
 *      ASSIST_ADMIN_TOKEN (required for §9.10-12 admin operations).
 * Secrets policy: mnemonics/keys/signatures are never printed or persisted.
 *
 * Prereq: `npm run compile:electron` (this script loads dist-electron output).
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_MAIN = path.resolve(__dirname, '../../dist-electron/main');

const { TxComposer, mvc } = require('meta-contract');
const bip39 = require('@scure/bip39');
const { wordlist } = require('@scure/bip39/wordlists/english');

const { SqliteStore } = require(path.join(DIST_MAIN, 'sqliteStore.js'));
const { convertToGlobalMetaId } = await import(path.join(DIST_MAIN, 'services/globalMetaid.js'));
const trafficAccountService = await import(path.join(DIST_MAIN, 'services/trafficAccountService.js'));
const {
  createMvcSponsorV2Client,
  fetchMvcAddressUtxos,
  getEstimatedBaseTxSize,
  getMvcSponsorCommitMessage,
  getOpReturnScriptSize,
  signMvcAddressMessage,
  signMvcPreparedUserInputs,
} = await import(path.join(DIST_MAIN, 'services/mvcSponsorClient.js'));

const API_BASE = (process.env.ASSIST_BASE_URL || 'http://47.76.58.120:7882').replace(/\/+$/, '');
const ADMIN_TOKEN = (process.env.ASSIST_ADMIN_TOKEN || '').trim();
const WALLET_PATH = "m/44'/10001'/0'/0/0";
const RECHARGE_PLAN_ID = 'cny_10_100mb';

const results = [];
function record(clause, pass, evidence) {
  results.push({ clause, pass, evidence });
  console.log(`\n[CLAUSE ${clause}] ${pass ? 'PASS' : 'FAIL'} — ${evidence}`);
}

function step(title) {
  console.log(`\n=== ${title} ===`);
}

function printJson(label, value) {
  console.log(`${label}:`, JSON.stringify(value));
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

const adminHeaders = () => ({ Authorization: `Bearer ${ADMIN_TOKEN}` });

function deriveWallet(mnemonic) {
  const network = mvc.Networks.livenet;
  const child = mvc.Mnemonic.fromString(mnemonic).toHDPrivateKey('', network).deriveChild(WALLET_PATH);
  const address = child.publicKey.toAddress(network).toString();
  return { address, globalMetaId: convertToGlobalMetaId(address), mnemonic };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retry sponsor calls when the instance's per-IP sliding-window limiter trips. */
async function withRateLimitRetry(label, fn, maxAttempts = 5) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/rate limit/i.test(message) || attempt === maxAttempts) throw error;
      const waitMs = 15_000 * attempt;
      console.log(`[throttle] ${label}: rate limited (attempt ${attempt}/${maxAttempts}); backing off ${waitMs / 1000}s`);
      await sleep(waitMs);
    }
  }
  throw new Error('unreachable');
}

/** Build an unsigned pin draft; input sum is chosen so the change stays >= 600 sats. */
function buildPinDraft(botAddress, inputUtxos, payloadText) {
  const addressObj = new mvc.Address(botAddress, mvc.Networks.livenet);
  const opReturnParts = ['metaid', 'create', '/protocols/simplebuzz', '0', '1.0', 'text/plain;utf-8', Buffer.from(payloadText, 'utf8')];
  const txComposer = new TxComposer();
  txComposer.appendP2PKHOutput({ address: addressObj, satoshis: 1 });
  txComposer.appendOpReturnOutput(opReturnParts);
  const totalOutput = txComposer.tx.outputs.reduce((sum, output) => sum + output.satoshis, 0);
  for (const utxo of inputUtxos) {
    txComposer.appendP2PKHInput({
      address: addressObj,
      txId: utxo.txId,
      outputIndex: utxo.outputIndex,
      satoshis: utxo.satoshis,
    });
  }
  const changeAmount = inputUtxos.reduce((sum, utxo) => sum + utxo.satoshis, 0) - totalOutput;
  if (changeAmount > 0) {
    txComposer.appendP2PKHOutput({ address: addressObj, satoshis: changeAmount });
  }
  const estimatedBase = getEstimatedBaseTxSize(getOpReturnScriptSize(opReturnParts));
  return {
    unsignedTxHex: txComposer.getRawHex(),
    estimatedTxSize: estimatedBase + (inputUtxos.length + 1) * 148,
    userInputs: inputUtxos,
    changeSatoshis: changeAmount,
  };
}

/** Take utxos from the pool whose sum yields a >=600-sat change (reusable). */
function takeInputs(pool) {
  pool.sort((a, b) => b.satoshis - a.satoshis);
  const single = pool.findIndex((utxo) => utxo.satoshis >= 602);
  if (single >= 0) {
    return pool.splice(single, 1);
  }
  pool.sort((a, b) => a.satoshis - b.satoshis);
  const picked = [];
  let sum = 0;
  while (pool.length > 0 && sum < 602) {
    const utxo = pool.shift();
    picked.push(utxo);
    sum += utxo.satoshis;
  }
  if (sum < 602) {
    throw new Error(`utxo pool exhausted (sum ${sum} < 602)`);
  }
  return picked;
}

async function sponsorPre(client, { botAddress, botMnemonic, draft, useTrafficAccount }) {
  const challenge = await client.getChallenge();
  const challengeSig = await signMvcAddressMessage({ mnemonic: botMnemonic, path: WALLET_PATH, message: challenge.message });
  const trafficAccount = useTrafficAccount
    ? await trafficAccountService.resolveSponsorTrafficAccount({
      botAddress,
      challengeId: challenge.challengeId,
      botMnemonic,
      botWalletPath: WALLET_PATH,
    })
    : undefined;
  const pre = await client.preSponsor({
    address: botAddress,
    txHex: draft.unsignedTxHex,
    challengeId: challenge.challengeId,
    publicKey: challengeSig.publicKey,
    signature: challengeSig.signature,
    trafficAccount,
  });
  return pre;
}

async function sponsorCommit(client, { botMnemonic, botAddress, draft, pre }) {
  const signedTxHex = (await signMvcPreparedUserInputs({
    mnemonic: botMnemonic,
    walletPath: WALLET_PATH,
    mvcAddress: botAddress,
    preparedTxHex: pre.preparedTxHex,
    userInputs: draft.userInputs,
    userInputIndexes: pre.userInputIndexes,
  })).txHex;
  const commitMessage = getMvcSponsorCommitMessage({ orderId: pre.orderId, signedTxHex });
  const commitSig = await signMvcAddressMessage({ mnemonic: botMnemonic, path: WALLET_PATH, message: commitMessage });
  return client.commitSponsor({
    orderId: pre.orderId,
    signedTxHex,
    publicKey: commitSig.publicKey,
    signature: commitSig.signature,
  });
}

async function waitForUtxos(address, attempts = 20, delayMs = 3000) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const utxos = await fetchMvcAddressUtxos(address);
      if (utxos.length > 0) return utxos;
    } catch {
      // keep polling
    }
    await sleep(delayMs);
  }
  return [];
}

async function ensureDust(botAddress) {
  const res = await apiFetch('/v1/assist/gas/mvc/address-init-v2', {
    method: 'POST',
    body: { address: botAddress, gasChain: 'mvc' },
  });
  if (res.status !== 200 || res.json?.code !== 0) {
    throw new Error(`address-init-v2 failed for ${botAddress}: HTTP ${res.status} ${JSON.stringify(res.json)}`);
  }
  const utxos = await waitForUtxos(botAddress);
  if (utxos.length === 0) {
    throw new Error(`init UTXOs for ${botAddress} not indexed in time`);
  }
  return utxos.map((u) => ({ txId: u.txId, outputIndex: u.outputIndex, satoshis: u.satoshis, address: botAddress, height: u.height }));
}

// ---------------------------------------------------------------------------

async function main() {
  if (!ADMIN_TOKEN) {
    throw new Error('ASSIST_ADMIN_TOKEN is required for the admin clauses (10/11/12)');
  }
  console.log(`API base: ${API_BASE}`);

  step('Setup: funded account F with bots F1/F2 (ensure + dust + bind + recharge)');
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'idbots-traffic-accept-'));
  const store = await SqliteStore.create(tmpDir);
  store.set('traffic.mode', 'traffic');

  const identity = deriveWallet(bip39.generateMnemonic(wordlist, 128));
  const botF1 = deriveWallet(bip39.generateMnemonic(wordlist, 128));
  const botF2 = deriveWallet(bip39.generateMnemonic(wordlist, 128));
  const botWallets = new Map([[botF1.address, botF1], [botF2.address, botF2]]);
  console.log('identity:', identity.address, identity.globalMetaId);
  console.log('bot F1:', botF1.address);
  console.log('bot F2:', botF2.address);

  trafficAccountService.initTrafficAccountService({
    getStore: () => store,
    getMetabotStore: () => ({
      listMetabots: () => [botF1, botF2].map((bot, index) => ({ id: index + 1, mvc_address: bot.address, wallet_id: index + 1 })),
      getMetabotWalletById: (walletId) => {
        const bot = [botF1, botF2][walletId - 1];
        return bot ? { id: walletId, mnemonic: bot.mnemonic, path: WALLET_PATH } : null;
      },
    }),
    getUserIdentityStore: () => ({
      get: () => ({
        id: 1,
        mnemonic: identity.mnemonic,
        path: WALLET_PATH,
        mvc_address: identity.address,
        globalmetaid: identity.globalMetaId,
        name: 'Acceptance Identity',
      }),
    }),
    baseUrl: API_BASE,
  });

  const account = await trafficAccountService.ensureTrafficAccount();
  printJson('account', { accountId: account.accountId, balanceBytes: account.balanceBytes });

  const pools = new Map();
  pools.set(botF1.address, await ensureDust(botF1.address));
  pools.set(botF2.address, await ensureDust(botF2.address));
  console.log('dust ready: F1', pools.get(botF1.address).length, 'utxos; F2', pools.get(botF2.address).length, 'utxos');

  const bindSummary = await trafficAccountService.bindAllLocalBots();
  printJson('bind', { bound: bindSummary.boundCount, conflict: bindSummary.conflictCount, failed: bindSummary.failedCount });
  if (bindSummary.failedCount > 0) throw new Error('bind failures: ' + JSON.stringify(bindSummary.results));

  const order = await trafficAccountService.createRechargeOrder(RECHARGE_PLAN_ID);
  await trafficAccountService.mockConfirmRechargeOrder(order.orderId);
  const balance0 = (await trafficAccountService.getTrafficBalance({ forceRefresh: true })).balanceBytes;
  console.log('balance after recharge:', balance0);

  const sponsorClient = createMvcSponsorV2Client({ baseUrl: API_BASE });
  const makeDraft = (bot, pool, tag) => buildPinDraft(bot.address, takeInputs(pool), `accept ${tag} ${Date.now()}`);

  // ------------------------------------------------------------------
  step('Clause 12: admin manual grant idempotency');
  let grantedTotal = 0;
  try {
    const grantBody = { amountBytes: 1000, reason: 'acceptance e2e grant', idempotencyKey: `e2e-grant-${Date.now()}` };
    const grant1 = await apiFetch(`/v1/admin/traffic/accounts/${encodeURIComponent(account.accountId)}/grants`, {
      method: 'POST', body: grantBody, headers: adminHeaders(),
    });
    const balanceAfterGrant1 = (await trafficAccountService.getTrafficBalance({ forceRefresh: true })).balanceBytes;
    const grant2 = await apiFetch(`/v1/admin/traffic/accounts/${encodeURIComponent(account.accountId)}/grants`, {
      method: 'POST', body: grantBody, headers: adminHeaders(),
    });
    const balanceAfterGrant2 = (await trafficAccountService.getTrafficBalance({ forceRefresh: true })).balanceBytes;
    printJson('grant #1', grant1.json?.data);
    printJson('grant #2 (replay)', grant2.json?.data);
    console.log(`balance: ${balance0} -> ${balanceAfterGrant1} -> ${balanceAfterGrant2}`);
    const ok = grant1.json?.data?.applied === true
      && grant2.json?.data?.applied === false
      && balanceAfterGrant1 === balance0 + 1000
      && balanceAfterGrant2 === balanceAfterGrant1;
    grantedTotal = 1000;
    const ledgerAfterGrants = await trafficAccountService.getTrafficLedger({ limit: 5 });
    const grantEntry = ledgerAfterGrants.entries.find((entry) => entry.sourceType === 'admin_grant');
    printJson('admin_grant ledger entry', grantEntry ?? null);
    record('9.12', ok && !!grantEntry, `applied=true then replay applied=false; balance +1000 exactly once; ledger admin_grant present (${grantEntry?.remark ?? 'n/a'})`);
  } catch (error) {
    record('9.12', false, `error: ${error instanceof Error ? error.message : error}`);
  }
  const balanceAfterGrants = balance0 + grantedTotal;

  // ------------------------------------------------------------------
  step('Clause 6 setup: open an order on F2 and let it expire (timer starts now)');
  let clause6 = null;
  try {
    const draft6 = makeDraft(botF2, pools.get(botF2.address), 'clause6-expiry');
    const pre6 = await withRateLimitRetry('c6-pre', () => sponsorPre(sponsorClient, {
      botAddress: botF2.address,
      botMnemonic: botF2.mnemonic,
      draft: draft6,
      useTrafficAccount: true,
    }));
    const orderInfo6 = await sponsorClient.getSponsorOrder(pre6.orderId);
    const balanceDuring6 = await trafficAccountService.getTrafficBalance({ forceRefresh: true });
    clause6 = {
      orderId: pre6.orderId,
      expiresAt: pre6.expiresAt ? Number(pre6.expiresAt) : Date.now() + 600_000,
      reservedExpected: pre6.minerFee,
      observedReserved: balanceDuring6.reservedBytes,
      orderStatus: orderInfo6.status,
    };
    printJson('clause6 open order', { orderId: pre6.orderId, expiresAt: clause6.expiresAt, reservedBytes: clause6.observedReserved, minerFee: pre6.minerFee });
    console.log(`order expires at ${new Date(clause6.expiresAt).toISOString()}; release check runs at the end of the script`);
  } catch (error) {
    record('9.6', false, `setup error: ${error instanceof Error ? error.message : error}`);
  }

  // ------------------------------------------------------------------
  step('Clause 5: 20 pres+commits across F1/F2 (waves of 3+2 parallel, open-order cap aware)');
  try {
    const waves = 4;
    const perWave = { f1: 3, f2: 2 }; // F2 keeps one open slot for the clause-6 order
    let totalPres = 0;
    const orderIds = [];
    for (let wave = 1; wave <= waves; wave += 1) {
      const jobs = [];
      const plan = [
        { bot: botF1, count: perWave.f1 },
        { bot: botF2, count: perWave.f2 },
      ];
      const drafts = [];
      for (const { bot, count } of plan) {
        const pool = pools.get(bot.address);
        for (let i = 0; i < count; i += 1) {
          drafts.push({ bot, draft: makeDraft(bot, pool, `c5-w${wave}-${bot.address.slice(-4)}-${i}`) });
        }
      }
      for (const item of drafts) {
        jobs.push(async () => {
          const pre = await withRateLimitRetry('c5-pre', () => sponsorPre(sponsorClient, {
            botAddress: item.bot.address,
            botMnemonic: item.bot.mnemonic,
            draft: item.draft,
            useTrafficAccount: true,
          }));
          return { ...item, pre };
        });
      }
      const pres = await Promise.all(jobs.map((job) => job()));
      totalPres += pres.length;
      const commits = await Promise.all(pres.map((item) => (async () => {
        const commit = await withRateLimitRetry('c5-commit', () => sponsorCommit(sponsorClient, {
          botMnemonic: item.bot.mnemonic,
          botAddress: item.bot.address,
          draft: item.draft,
          pre: item.pre,
        }));
        return { ...item, commit };
      })()));
      for (const item of commits) {
        orderIds.push(item.pre.orderId);
        if (item.draft.changeSatoshis >= 600 && item.commit.txId) {
          pools.get(item.bot.address).push({
            txId: item.commit.txId,
            outputIndex: 2, // pin(0) + opreturn(1) + change(2)
            satoshis: item.draft.changeSatoshis,
            address: item.bot.address,
            height: -1,
          });
        }
      }
      const midBalance = await trafficAccountService.getTrafficBalance({ forceRefresh: true });
      console.log(`wave ${wave}: ${pres.length} pres+commits done; balance=${midBalance.balanceBytes} reserved=${midBalance.reservedBytes}`);
      if (midBalance.balanceBytes < 0) {
        throw new Error(`balance went negative after wave ${wave}`);
      }
      await sleep(1000); // be gentle with the instance between waves
    }

    await sleep(1500);
    const balanceAfterC5 = await trafficAccountService.getTrafficBalance({ forceRefresh: true });
    const ledger = await trafficAccountService.getTrafficLedger({ limit: 100 });
    const spendSum = ledger.entries
      .filter((entry) => entry.direction === 2 && orderIds.includes(entry.sourceId))
      .reduce((sum, entry) => sum + entry.amountBytes, 0);
    const reserveSum = ledger.entries
      .filter((entry) => entry.direction === 3 && orderIds.includes(entry.sourceId))
      .reduce((sum, entry) => sum + entry.amountBytes, 0);
    const expectedReserved = clause6 ? clause6.observedReserved : 0;
    const ok = totalPres === 20
      && spendSum > 0
      && balanceAfterGrants - balanceAfterC5.balanceBytes === spendSum + expectedReserved
      && reserveSum === spendSum
      && balanceAfterC5.reservedBytes === expectedReserved;
    printJson('clause5 sums', {
      totalPres,
      spendSum,
      reserveSum,
      balanceDrop: balanceAfterGrants - balanceAfterC5.balanceBytes,
      reservedAfter: balanceAfterC5.reservedBytes,
      expectedReserved,
    });
    record('9.5', ok, `20 pres across 2 bots in 4 parallel waves; spend Σ == reserve Σ == ${spendSum}; balance drop == spend Σ + held reservation (${spendSum}+${expectedReserved}); never negative`);
  } catch (error) {
    record('9.5', false, `error: ${error instanceof Error ? error.message : error}`);
  }

  // ------------------------------------------------------------------
  step('Clause 8: zero-balance account — TRAFFIC_INSUFFICIENT (8a) + legacy quota regression (8b)');
  await sleep(20_000); // let the 60s per-IP sponsor window slide after clause 5
  try {
    const identityZ = deriveWallet(bip39.generateMnemonic(wordlist, 128));
    const botZ = deriveWallet(bip39.generateMnemonic(wordlist, 128));
    console.log('zero-balance identity:', identityZ.address, identityZ.globalMetaId);
    console.log('zero-balance bot:', botZ.address);

    const zStore = await SqliteStore.create(await fs.mkdtemp(path.join(os.tmpdir(), 'idbots-traffic-accept-z-')));
    zStore.set('traffic.mode', 'traffic');
    trafficAccountService.initTrafficAccountService({
      getStore: () => zStore,
      getMetabotStore: () => ({
        listMetabots: () => [{ id: 1, mvc_address: botZ.address, wallet_id: 1 }],
        getMetabotWalletById: (walletId) => (walletId === 1 ? { id: 1, mnemonic: botZ.mnemonic, path: WALLET_PATH } : null),
      }),
      getUserIdentityStore: () => ({
        get: () => ({
          id: 1,
          mnemonic: identityZ.mnemonic,
          path: WALLET_PATH,
          mvc_address: identityZ.address,
          globalmetaid: identityZ.globalMetaId,
          name: 'Zero Identity',
        }),
      }),
      baseUrl: API_BASE,
    });
    const accountZ = await trafficAccountService.ensureTrafficAccount();
    const poolZ = await ensureDust(botZ.address);
    const bindZ = await trafficAccountService.bindAllLocalBots();
    printJson('zero account', { accountId: accountZ.accountId, balanceBytes: accountZ.balanceBytes, bound: bindZ.boundCount });

    // 8a: pre WITH trafficAccount on a zero-balance account.
    const rawBodies = [];
    const tapFetch = async (url, init) => {
      const response = await fetch(url, init);
      const text = await response.text();
      rawBodies.push(text);
      return { ok: response.ok, status: response.status, json: async () => JSON.parse(text) };
    };
    const clientZ = createMvcSponsorV2Client({ baseUrl: API_BASE, fetchImpl: tapFetch });
    const draftZ = buildPinDraft(botZ.address, takeInputs(poolZ), `accept clause8a ${Date.now()}`);
    let error8a = null;
    try {
      await withRateLimitRetry('c8a-pre', () => sponsorPre(clientZ, {
        botAddress: botZ.address,
        botMnemonic: botZ.mnemonic,
        draft: draftZ,
        useTrafficAccount: true,
      }));
    } catch (error) {
      error8a = error;
    }
    const raw8a = rawBodies.map((text) => {
      try { return JSON.parse(text); } catch { return null; }
    }).find((body) => body && body.code !== 0);
    printJson('8a raw error envelope', raw8a ?? null);
    const ok8a = !!error8a
      && error8a.reason === 'insufficient_traffic'
      && raw8a?.data?.errorCode === 'TRAFFIC_INSUFFICIENT';
    record('9.8a', ok8a, `pre with trafficAccount on zero balance -> envelope code=${raw8a?.code}, data.errorCode=${raw8a?.data?.errorCode}; client classified reason=${error8a?.reason}`);

    // 8b: same bot WITHOUT trafficAccount -> legacy quota path, then commit.
    const draftZ2 = buildPinDraft(botZ.address, takeInputs(poolZ), `accept clause8b ${Date.now()}`);
    const pre8b = await withRateLimitRetry('c8b-pre', () => sponsorPre(clientZ, {
      botAddress: botZ.address,
      botMnemonic: botZ.mnemonic,
      draft: draftZ2,
      useTrafficAccount: false,
    }));
    const commit8b = await withRateLimitRetry('c8b-commit', () => sponsorCommit(clientZ, {
      botMnemonic: botZ.mnemonic,
      botAddress: botZ.address,
      draft: draftZ2,
      pre: pre8b,
    }));
    printJson('8b legacy commit', { txId: commit8b.txId, txSize: commit8b.txSize, minerFee: commit8b.minerFee });
    const balanceZ = await trafficAccountService.getTrafficBalance({ forceRefresh: true });
    const ok8b = !!commit8b.txId && balanceZ.balanceBytes === 0;
    record('9.8b', ok8b, `legacy quota pre+commit succeeded on the same bot (txid ${commit8b.txId}); traffic balance untouched at ${balanceZ.balanceBytes}`);
  } catch (error) {
    record('9.8', false, `error: ${error instanceof Error ? error.message : error}`);
  }

  // ------------------------------------------------------------------
  step('Clause 10: dynamic fee rate (admin PUT 2 -> orders use it -> PUT back 1)');
  await sleep(20_000); // let the per-IP sponsor window slide after clause 8
  try {
    // Re-init the service against the FUNDED account fixtures.
    trafficAccountService.initTrafficAccountService({
      getStore: () => store,
      getMetabotStore: () => ({
        listMetabots: () => [botF1, botF2].map((bot, index) => ({ id: index + 1, mvc_address: bot.address, wallet_id: index + 1 })),
        getMetabotWalletById: (walletId) => {
          const bot = [botF1, botF2][walletId - 1];
          return bot ? { id: walletId, mnemonic: bot.mnemonic, path: WALLET_PATH } : null;
        },
      }),
      getUserIdentityStore: () => ({
        get: () => ({
          id: 1,
          mnemonic: identity.mnemonic,
          path: WALLET_PATH,
          mvc_address: identity.address,
          globalmetaid: identity.globalMetaId,
          name: 'Acceptance Identity',
        }),
      }),
      baseUrl: API_BASE,
    });

    const rateBefore = await apiFetch('/v1/admin/traffic/fee-rate', { headers: adminHeaders() });
    printJson('fee-rate before', rateBefore.json?.data);

    const runRatedPin = async (tag) => {
      const draft = makeDraft(botF1, pools.get(botF1.address), tag);
      // Measure before the pre: the reservation already moves balance->reserved
      // at pre time; the commit then settles reserved->spent without touching
      // the balance, so the deduction is only visible across the whole flow.
      const balanceBefore = await trafficAccountService.getTrafficBalance({ forceRefresh: true });
      const pre = await withRateLimitRetry('c10-pre', () => sponsorPre(sponsorClient, {
        botAddress: botF1.address,
        botMnemonic: botF1.mnemonic,
        draft,
        useTrafficAccount: true,
      }));
      const commit = await withRateLimitRetry('c10-commit', () => sponsorCommit(sponsorClient, {
        botMnemonic: botF1.mnemonic,
        botAddress: botF1.address,
        draft,
        pre,
      }));
      if (draft.changeSatoshis >= 600 && commit.txId) {
        pools.get(botF1.address).push({
          txId: commit.txId,
          outputIndex: 2,
          satoshis: draft.changeSatoshis,
          address: botF1.address,
          height: -1,
        });
      }
      const balanceAfter = await trafficAccountService.getTrafficBalance({ forceRefresh: true });
      return { pre, commit, deducted: balanceBefore.balanceBytes - balanceAfter.balanceBytes };
    };

    const pinRate1 = await runRatedPin('clause10-rate1');
    printJson('rate=1 pin', { minerFee: pinRate1.pre.minerFee, txSize: pinRate1.commit.txSize, deducted: pinRate1.deducted, txId: pinRate1.commit.txId });

    const put2 = await apiFetch('/v1/admin/traffic/fee-rate', {
      method: 'PUT', body: { 'mvc.fee_rate': 2 }, headers: adminHeaders(),
    });
    const rateMid = await apiFetch('/v1/admin/traffic/fee-rate', { headers: adminHeaders() });
    printJson('fee-rate after PUT 2', rateMid.json?.data);

    const pinRate2 = await runRatedPin('clause10-rate2');
    printJson('rate=2 pin', { minerFee: pinRate2.pre.minerFee, txSize: pinRate2.commit.txSize, deducted: pinRate2.deducted, txId: pinRate2.commit.txId });
    const orderInfo2 = await sponsorClient.getSponsorOrder(pinRate2.pre.orderId);
    printJson('rate=2 order (public)', { orderId: orderInfo2.orderId, status: orderInfo2.status, txSize: orderInfo2.txSize, minerFee: orderInfo2.minerFee, rawHasFeeRate: 'networkFeeRate' in orderInfo2.raw });

    const put1 = await apiFetch('/v1/admin/traffic/fee-rate', {
      method: 'PUT', body: { 'mvc.fee_rate': 1 }, headers: adminHeaders(),
    });
    const rateAfter = await apiFetch('/v1/admin/traffic/fee-rate', { headers: adminHeaders() });
    printJson('fee-rate restored', rateAfter.json?.data);

    const ratio = pinRate2.pre.minerFee / pinRate1.pre.minerFee;
    const ok = put2.json?.code === 0
      && put1.json?.code === 0
      && ratio >= 1.8 && ratio <= 2.2
      && pinRate1.deducted === pinRate1.commit.txSize
      && pinRate2.deducted === pinRate2.commit.txSize
      && (rateAfter.json?.data?.feeRate === 1 || rateAfter.json?.data?.['mvc.fee_rate'] === 1);
    record('9.10', ok, `minerFee rate1=${pinRate1.pre.minerFee} -> rate2=${pinRate2.pre.minerFee} (ratio ${ratio.toFixed(2)}); deductions == txSize bytes in both (${pinRate1.deducted}/${pinRate2.deducted}); rate restored to 1 (PUT codes ${put2.json?.code}/${put1.json?.code})`);
  } catch (error) {
    // Best-effort restore on failure so the instance is not left at rate 2.
    await apiFetch('/v1/admin/traffic/fee-rate', { method: 'PUT', body: { 'mvc.fee_rate': 1 }, headers: adminHeaders() }).catch(() => {});
    record('9.10', false, `error: ${error instanceof Error ? error.message : error} (fee-rate restore attempted)`);
  }

  // ------------------------------------------------------------------
  step('Clause 11: admin plan create -> public pricing; archive -> disappears');
  const testPlanId = `test_1cny_1mb_${Date.now().toString(36)}`;
  try {
    const createRes = await apiFetch('/v1/admin/traffic/plans', {
      method: 'POST',
      body: { planId: testPlanId, chain: 'mvc', payCurrency: 'CNY', payAmount: 1, trafficBytes: 1048576, remark: 'acceptance e2e' },
      headers: adminHeaders(),
    });
    const pricingWith = await trafficAccountService.getTrafficPricing();
    const visibleAfterCreate = pricingWith.some((plan) => plan.planId === testPlanId);
    const archiveRes = await apiFetch(`/v1/admin/traffic/plans/${encodeURIComponent(testPlanId)}/archive`, {
      method: 'POST', headers: adminHeaders(),
    });
    const pricingWithout = await trafficAccountService.getTrafficPricing();
    const visibleAfterArchive = pricingWithout.some((plan) => plan.planId === testPlanId);
    const adminPlans = await apiFetch('/v1/admin/traffic/plans', { headers: adminHeaders() });
    const adminEntry = (adminPlans.json?.data?.plans ?? adminPlans.json?.data?.list ?? []).find?.((plan) => plan.planId === testPlanId)
      ?? (Array.isArray(adminPlans.json?.data) ? adminPlans.json.data.find((plan) => plan.planId === testPlanId) : null);
    printJson('plan lifecycle', {
      createCode: createRes.json?.code,
      visibleAfterCreate,
      archiveCode: archiveRes.json?.code,
      visibleAfterArchive,
      adminStatus: adminEntry?.status,
      seedStillPresent: pricingWithout.some((plan) => plan.planId === RECHARGE_PLAN_ID),
    });
    const ok = createRes.json?.code === 0
      && visibleAfterCreate
      && archiveRes.json?.code === 0
      && !visibleAfterArchive
      && adminEntry?.status === 2
      && pricingWithout.some((plan) => plan.planId === RECHARGE_PLAN_ID);
    record('9.11', ok, `plan ${testPlanId}: public after create, gone after archive, admin status=2 (archived); seed plan untouched`);
  } catch (error) {
    record('9.11', false, `error: ${error instanceof Error ? error.message : error}`);
  }

  // ------------------------------------------------------------------
  step('Clause 6: reservation release after order expiry');
  if (!clause6) {
    record('9.6', false, 'skipped: clause-6 setup failed earlier');
  } else {
    try {
      const deadline = clause6.expiresAt + 180_000; // TTL + maintenance-job slack
      let released = false;
      let lastBalance = null;
      let lastOrder = null;
      while (Date.now() < deadline) {
        lastOrder = await sponsorClient.getSponsorOrder(clause6.orderId).catch(() => null);
        lastBalance = await trafficAccountService.getTrafficBalance({ forceRefresh: true }).catch(() => null);
        if (lastOrder && lastOrder.final && lastOrder.status === 'expired'
          && lastBalance && lastBalance.reservedBytes === 0) {
          released = true;
          break;
        }
        const waitMs = Math.min(20_000, Math.max(2_000, clause6.expiresAt - Date.now() + 15_000));
        console.log(`waiting for expiry... order=${lastOrder?.status ?? '?'} reserved=${lastBalance?.reservedBytes ?? '?'} next check in ${Math.round(waitMs / 1000)}s`);
        await sleep(waitMs);
      }
      const ledger = await trafficAccountService.getTrafficLedger({ limit: 100 });
      const releaseEntry = ledger.entries.find((entry) => entry.direction === 4 && entry.sourceId === clause6.orderId);
      printJson('clause6 final', {
        orderStatus: lastOrder?.status,
        orderFinal: lastOrder?.final,
        reservedBytes: lastBalance?.reservedBytes,
        balanceBytes: lastBalance?.balanceBytes,
        releaseEntry: releaseEntry ?? null,
      });
      const expectedBalance = balanceAfterGrants - (ledger.entries
        .filter((entry) => entry.direction === 2)
        .reduce((sum, entry) => sum + entry.amountBytes, 0));
      const ok = released
        && !!releaseEntry
        && lastBalance.balanceBytes === expectedBalance;
      record('9.6', ok, `order ${clause6.orderId} expired -> reserved back to 0, release ledger entry present (release ${releaseEntry?.amountBytes ?? 'n/a'} bytes), balance ${lastBalance?.balanceBytes} == grants - Σspend (${expectedBalance})`);
    } catch (error) {
      record('9.6', false, `error: ${error instanceof Error ? error.message : error}`);
    }
  }

  // ------------------------------------------------------------------
  step('Summary');
  for (const row of results) {
    console.log(`  §${row.clause}: ${row.pass ? 'PASS' : 'FAIL'} — ${row.evidence}`);
  }
  const failed = results.filter((row) => !row.pass);
  console.log(failed.length === 0 ? '\n[ACCEPTANCE OK] all clauses passed.' : `\n[ACCEPTANCE] ${failed.length} clause(s) FAILED`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('\n[ACCEPTANCE ABORT]', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
