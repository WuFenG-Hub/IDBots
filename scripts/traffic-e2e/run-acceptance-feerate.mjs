#!/usr/bin/env node
/**
 * Focused re-verification for Spec §9.10 (dynamic fee rate), standalone.
 * Fixes the measurement point used in run-acceptance-extended.mjs run3: the
 * balance must be read BEFORE the pre (the reserve already moves
 * balance->reserved at pre time; the commit settles reserved->spent without
 * changing the balance), so deduction == txSize is only visible across the
 * whole pre+commit flow.
 *
 * Env: ASSIST_BASE_URL (default http://47.76.58.120:7882), ASSIST_ADMIN_TOKEN.
 * Secrets policy: mnemonics/keys/signatures are never printed or persisted.
 * Prereq: `npm run compile:electron`.
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function buildPinDraft(botAddress, inputUtxos, payloadText) {
  const addressObj = new mvc.Address(botAddress, mvc.Networks.livenet);
  const opReturnParts = ['metaid', 'create', '/protocols/simplebuzz', '0', '1.0', 'text/plain;utf-8', Buffer.from(payloadText, 'utf8')];
  const txComposer = new TxComposer();
  txComposer.appendP2PKHOutput({ address: addressObj, satoshis: 1 });
  txComposer.appendOpReturnOutput(opReturnParts);
  const totalOutput = txComposer.tx.outputs.reduce((sum, output) => sum + output.satoshis, 0);
  for (const utxo of inputUtxos) {
    txComposer.appendP2PKHInput({ address: addressObj, txId: utxo.txId, outputIndex: utxo.outputIndex, satoshis: utxo.satoshis });
  }
  const changeAmount = inputUtxos.reduce((sum, utxo) => sum + utxo.satoshis, 0) - totalOutput;
  if (changeAmount > 0) {
    txComposer.appendP2PKHOutput({ address: addressObj, satoshis: changeAmount });
  }
  return {
    unsignedTxHex: txComposer.getRawHex(),
    userInputs: inputUtxos,
    changeSatoshis: changeAmount,
  };
}

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

async function main() {
  if (!ADMIN_TOKEN) throw new Error('ASSIST_ADMIN_TOKEN required');
  console.log(`API base: ${API_BASE}`);

  const identity = deriveWallet(bip39.generateMnemonic(wordlist, 128));
  const bot = deriveWallet(bip39.generateMnemonic(wordlist, 128));
  console.log('identity:', identity.address, identity.globalMetaId);
  console.log('bot:', bot.address);

  const store = await SqliteStore.create(await fs.mkdtemp(path.join(os.tmpdir(), 'idbots-traffic-feerate-')));
  store.set('traffic.mode', 'traffic');
  trafficAccountService.initTrafficAccountService({
    getStore: () => store,
    getMetabotStore: () => ({
      listMetabots: () => [{ id: 1, mvc_address: bot.address, wallet_id: 1 }],
      getMetabotWalletById: (walletId) => (walletId === 1 ? { id: 1, mnemonic: bot.mnemonic, path: WALLET_PATH } : null),
    }),
    getUserIdentityStore: () => ({
      get: () => ({
        id: 1,
        mnemonic: identity.mnemonic,
        path: WALLET_PATH,
        mvc_address: identity.address,
        globalmetaid: identity.globalMetaId,
        name: 'FeeRate Identity',
      }),
    }),
    baseUrl: API_BASE,
  });

  const account = await trafficAccountService.ensureTrafficAccount();
  console.log('account:', account.accountId);

  await apiFetch('/v1/assist/gas/mvc/address-init-v2', { method: 'POST', body: { address: bot.address, gasChain: 'mvc' } });
  let pool = [];
  for (let attempt = 1; attempt <= 20 && pool.length === 0; attempt += 1) {
    pool = (await fetchMvcAddressUtxos(bot.address).catch(() => []))
      .map((u) => ({ txId: u.txId, outputIndex: u.outputIndex, satoshis: u.satoshis, address: bot.address, height: u.height }));
    if (pool.length === 0) await sleep(3000);
  }
  if (pool.length === 0) throw new Error('dust UTXOs not indexed in time');
  console.log('dust utxos:', pool.length);

  const bind = await trafficAccountService.bindAllLocalBots();
  console.log('bind bound:', bind.boundCount);
  const order = await trafficAccountService.createRechargeOrder('cny_10_100mb');
  await trafficAccountService.mockConfirmRechargeOrder(order.orderId);
  console.log('recharged balance:', (await trafficAccountService.getTrafficBalance({ forceRefresh: true })).balanceBytes);

  const client = createMvcSponsorV2Client({ baseUrl: API_BASE });

  const runRatedPin = async (tag) => {
    const inputs = [pool.shift(), pool.shift()].filter(Boolean);
    const draft = buildPinDraft(bot.address, inputs, `feerate ${tag} ${Date.now()}`);
    const balanceBefore = (await trafficAccountService.getTrafficBalance({ forceRefresh: true })).balanceBytes;
    const challenge = await client.getChallenge();
    const challengeSig = await signMvcAddressMessage({ mnemonic: bot.mnemonic, path: WALLET_PATH, message: challenge.message });
    const trafficAccount = await trafficAccountService.resolveSponsorTrafficAccount({
      botAddress: bot.address,
      challengeId: challenge.challengeId,
      botMnemonic: bot.mnemonic,
      botWalletPath: WALLET_PATH,
    });
    const pre = await withRateLimitRetry('pre', () => client.preSponsor({
      address: bot.address,
      txHex: draft.unsignedTxHex,
      challengeId: challenge.challengeId,
      publicKey: challengeSig.publicKey,
      signature: challengeSig.signature,
      trafficAccount,
    }));
    const signedTxHex = (await signMvcPreparedUserInputs({
      mnemonic: bot.mnemonic,
      walletPath: WALLET_PATH,
      mvcAddress: bot.address,
      preparedTxHex: pre.preparedTxHex,
      userInputs: draft.userInputs,
      userInputIndexes: pre.userInputIndexes,
    })).txHex;
    const commitMessage = getMvcSponsorCommitMessage({ orderId: pre.orderId, signedTxHex });
    const commitSig = await signMvcAddressMessage({ mnemonic: bot.mnemonic, path: WALLET_PATH, message: commitMessage });
    const commit = await withRateLimitRetry('commit', () => client.commitSponsor({
      orderId: pre.orderId,
      signedTxHex,
      publicKey: commitSig.publicKey,
      signature: commitSig.signature,
    }));
    const balanceAfter = (await trafficAccountService.getTrafficBalance({ forceRefresh: true })).balanceBytes;
    if (draft.changeSatoshis >= 600 && commit.txId) {
      pool.push({ txId: commit.txId, outputIndex: 2, satoshis: draft.changeSatoshis, address: bot.address, height: -1 });
    }
    return { pre, commit, deducted: balanceBefore - balanceAfter };
  };

  const rate0 = await apiFetch('/v1/admin/traffic/fee-rate', { headers: adminHeaders() });
  console.log('fee-rate baseline:', JSON.stringify(rate0.json?.data));

  const pin1 = await runRatedPin('rate1');
  console.log('rate=1 pin:', JSON.stringify({ minerFee: pin1.pre.minerFee, txSize: pin1.commit.txSize, deducted: pin1.deducted, txId: pin1.commit.txId }));

  const put2 = await apiFetch('/v1/admin/traffic/fee-rate', { method: 'PUT', body: { 'mvc.fee_rate': 2 }, headers: adminHeaders() });
  const rateMid = await apiFetch('/v1/admin/traffic/fee-rate', { headers: adminHeaders() });
  console.log('fee-rate after PUT 2:', JSON.stringify(rateMid.json?.data), 'put code', put2.json?.code);

  const pin2 = await runRatedPin('rate2');
  console.log('rate=2 pin:', JSON.stringify({ minerFee: pin2.pre.minerFee, txSize: pin2.commit.txSize, deducted: pin2.deducted, txId: pin2.commit.txId }));

  const put1 = await apiFetch('/v1/admin/traffic/fee-rate', { method: 'PUT', body: { 'mvc.fee_rate': 1 }, headers: adminHeaders() });
  const rateEnd = await apiFetch('/v1/admin/traffic/fee-rate', { headers: adminHeaders() });
  console.log('fee-rate restored:', JSON.stringify(rateEnd.json?.data), 'put code', put1.json?.code);

  const ratio = pin2.pre.minerFee / pin1.pre.minerFee;
  const checks = {
    ratioIsDouble: ratio >= 1.8 && ratio <= 2.2,
    pin1DeductedBytes: pin1.deducted === pin1.commit.txSize,
    pin2DeductedBytes: pin2.deducted === pin2.commit.txSize,
    rateRestored: rateEnd.json?.data?.['mvc.fee_rate'] === 1,
  };
  console.log('checks:', JSON.stringify(checks));
  const pass = Object.values(checks).every(Boolean);
  console.log(`\n[CLAUSE 9.10] ${pass ? 'PASS' : 'FAIL'} — minerFee ${pin1.pre.minerFee} -> ${pin2.pre.minerFee} (ratio ${ratio.toFixed(2)}) after admin PUT; deduction == txSize bytes at both rates (${pin1.deducted}/${pin2.deducted}); rate restored to 1`);
  process.exitCode = pass ? 0 : 1;
}

main().catch(async (error) => {
  await apiFetch('/v1/admin/traffic/fee-rate', { method: 'PUT', body: { 'mvc.fee_rate': 1 }, headers: adminHeaders() }).catch(() => {});
  console.error('[FEERATE FAIL]', error instanceof Error ? error.message : error, '(fee-rate restore attempted)');
  process.exitCode = 1;
});
