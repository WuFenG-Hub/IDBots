#!/usr/bin/env node
/**
 * GasFee traffic-ization — Phase 3b acceptance runner.
 *
 * Exercises the free-grant campaign (Feature A) and recharge codes (Feature B)
 * against a deployed assist-base-service instance, using the REAL client code
 * paths from this repo's compiled dist-electron modules plus admin API calls.
 * Spec: docs/gasfee-flow/backend-spec-v2.md (criteria A1–A8 / B1–B10).
 *
 * Run `npm run compile:electron` first (the script imports dist-electron).
 *
 * Env:
 *   ASSIST_BASE_URL     default http://47.76.58.120:7882 (no path suffix)
 *   ASSIST_ADMIN_TOKEN  admin bearer token (required; never write it into
 *                       the repo — pass it on the command line)
 *
 * Behavior: the script snapshots the campaign settings at start and restores
 * them at the end (even on failure), so the instance is left as found.
 * Test identities and codes are throwaway.
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
const svc = await import(path.join(DIST_MAIN, 'services/trafficAccountService.js'));
const { signMvcAddressMessage } = await import(path.join(DIST_MAIN, 'services/mvcSponsorClient.js'));

const API_BASE = (process.env.ASSIST_BASE_URL || 'http://47.76.58.120:7882').replace(/\/+$/, '');
const ADMIN_TOKEN = (process.env.ASSIST_ADMIN_TOKEN || '').trim();
const WALLET_PATH = "m/44'/10001'/0'/0/0";

// ---------------------------------------------------------------------------

let failures = 0;
function ok(cond, label, extra = '') {
  if (cond) {
    console.log(`  PASS  ${label}${extra ? ' — ' + extra : ''}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`);
  }
}
function step(title) {
  console.log(`\n=== ${title} ===`);
}
function printJson(label, value) {
  console.log(`${label}:`, JSON.stringify(value, null, 2));
}

function newMnemonic() {
  return bip39.generateMnemonic(wordlist, 128);
}
function deriveWallet(mnemonic) {
  const network = mvc.Networks.livenet;
  const child = mvc.Mnemonic.fromString(mnemonic).toHDPrivateKey('', network).deriveChild(WALLET_PATH);
  const address = child.publicKey.toAddress(network).toString();
  return { address, globalMetaId: convertToGlobalMetaId(address) };
}

async function apiFetch(pathname, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const res = await fetch(`${API_BASE}${pathname}`, {
    method,
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) {
    return { status: res.status, text: await res.text() };
  }
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}
const adminFetch = (pathname, opts = {}) =>
  apiFetch(pathname, { ...opts, headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, ...(opts.headers || {}) } });

async function initServiceFor(mnemonic) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idbots-3b-accept-'));
  const store = await SqliteStore.create(dir);
  store.set('traffic.mode', 'traffic');
  const wallet = deriveWallet(mnemonic);
  svc.resetTrafficAccountServiceForTests();
  svc.initTrafficAccountService({
    getStore: () => store,
    getMetabotStore: () => ({ listMetabots: () => [], getMetabotWalletById: () => null }),
    getUserIdentityStore: () => ({
      get: () => ({
        id: 1,
        mnemonic,
        path: WALLET_PATH,
        mvc_address: wallet.address,
        globalmetaid: wallet.globalMetaId,
        name: '3b-acceptance',
      }),
    }),
    baseUrl: API_BASE,
  });
  return { wallet, dir };
}

function codeStr(code) {
  return typeof code === 'string' ? code : code?.code ?? '';
}

async function readCampaignSettings() {
  const res = await adminFetch('/v1/admin/traffic/campaign/free-grant');
  if (res.status !== 200) {
    throw new Error(`campaign settings GET failed: HTTP ${res.status} ${JSON.stringify(res.json)}`);
  }
  return (res.json?.data ?? res.json) || {};
}

async function writeCampaignSettings(settings) {
  const res = await adminFetch('/v1/admin/traffic/campaign/free-grant', { method: 'PUT', body: settings });
  if (res.status !== 200) {
    throw new Error(`campaign settings PUT failed: HTTP ${res.status} ${JSON.stringify(res.json)}`);
  }
  return res;
}

async function expectErrorCode(action, expected, label) {
  let captured = null;
  try {
    await action();
  } catch (error) {
    captured = error;
  }
  console.log(`  ${label}: message=${captured?.message} errorCode=${captured?.errorCode}`);
  ok(Boolean(captured) && captured.errorCode === expected, label, `errorCode=${captured?.errorCode}`);
}

// ---------------------------------------------------------------------------

async function runAcceptance() {
  console.log(`API base: ${API_BASE}`);
  console.log(`Admin token: ${ADMIN_TOKEN ? '[provided]' : '[MISSING]'}`);
  if (!ADMIN_TOKEN) {
    console.error('ASSIST_ADMIN_TOKEN is required (admin endpoints are used).');
    process.exit(2);
  }

  step('0. Preflight: pricing + campaign settings snapshot');
  const pricing = await apiFetch('/v1/traffic/pricing');
  ok(pricing.status === 200 && pricing.json?.code === 0, 'pricing 200', `HTTP ${pricing.status}`);
  const originalSettings = await readCampaignSettings();
  printJson('original campaign settings', originalSettings);

  try {
    // ---------------- Feature A: free-grant campaign ----------------
    step('A-prep. Enable the campaign');
    await writeCampaignSettings({ ...originalSettings, enabled: true });
    const enabledSettings = await readCampaignSettings();
    ok(enabledSettings.enabled === true, 'campaign enabled', JSON.stringify(enabledSettings));
    const grantBytes = Number(enabledSettings.grantBytes ?? 10000000);
    console.log('configured grantBytes:', grantBytes);

    step('A1. Fresh identity: status shows claimable');
    await initServiceFor(newMnemonic());
    await svc.ensureTrafficAccount();
    const status1 = await svc.getFreeGrantCampaignStatus();
    printJson('status', status1);
    ok(status1.enabled === true && status1.claimed === false && status1.claimable === true, 'A1 status claimable=true');

    step('A2. Claim credits exactly grantBytes; ledger shows free_grant');
    const claim = await svc.claimFreeGrant();
    printJson('claim result', claim);
    ok(claim.grantBytes === grantBytes, 'A2 claim amount matches config', `${claim.grantBytes} vs ${grantBytes}`);
    ok(claim.balanceAfter === grantBytes, 'A2 fresh balance equals grant', String(claim.balanceAfter));
    const bal1 = await svc.getTrafficBalance({ forceRefresh: true });
    ok(bal1.balanceBytes === grantBytes, 'A2 balance endpoint agrees', String(bal1.balanceBytes));
    const ledger1 = await svc.getTrafficLedger({ limit: 20 });
    const freeRow = (ledger1.entries || []).find((entry) => entry.sourceType === 'free_grant');
    ok(Boolean(freeRow), 'A2 ledger has free_grant row');
    ok(freeRow && freeRow.amountBytes === grantBytes, 'A2 ledger amount matches', freeRow && String(freeRow.amountBytes));

    step('A3. Second claim → ALREADY_CLAIMED');
    await expectErrorCode(() => svc.claimFreeGrant(), 'ALREADY_CLAIMED', 'A3 second claim');

    step('A5. Admin changes amount → next claim uses the new value');
    await writeCampaignSettings({ ...enabledSettings, grantBytes: 1234567 });
    await initServiceFor(newMnemonic());
    await svc.ensureTrafficAccount();
    const statusA5 = await svc.getFreeGrantCampaignStatus();
    const claimA5 = await svc.claimFreeGrant();
    ok(statusA5.grantBytes === 1234567 && claimA5.grantBytes === 1234567, 'A5 amount change reflected', String(claimA5.grantBytes));
    await writeCampaignSettings({ ...enabledSettings, grantBytes });

    step('A6. Raw claim with non-allowlisted clientApp → CLIENT_NOT_ALLOWED');
    const evilMnemonic = newMnemonic();
    const evil = await initServiceFor(evilMnemonic);
    await svc.ensureTrafficAccount();
    const accountInfo = await svc.getLocalTrafficAccount();
    const ts = Math.floor(Date.now() / 1000);
    const evilMsg = `traffic-free-grant-claim:${accountInfo.accountId}:${ts}`;
    const { signature } = await signMvcAddressMessage({ mnemonic: evilMnemonic, path: WALLET_PATH, message: evilMsg });
    const evilRes = await apiFetch('/v1/traffic/campaign/free-grant/claim', {
      method: 'POST',
      headers: { 'X-Identity-Address': evil.wallet.address, 'X-Timestamp': String(ts), 'X-Signature': signature },
      body: { clientApp: 'evil-app', clientVersion: '0.0.1' },
    });
    const evilCode = evilRes.json?.data?.errorCode ?? evilRes.json?.errorCode;
    printJson('evil claim response', evilRes.json);
    ok(evilRes.status === 200 && evilCode === 'CLIENT_NOT_ALLOWED', 'A6 CLIENT_NOT_ALLOWED', `code=${evilCode}`);

    step('A4. Disable campaign → status false, fresh claim CAMPAIGN_DISABLED');
    await writeCampaignSettings({ ...enabledSettings, enabled: false });
    await initServiceFor(newMnemonic());
    await svc.ensureTrafficAccount();
    const statusOff = await svc.getFreeGrantCampaignStatus();
    ok(statusOff.enabled === false && statusOff.claimable === false, 'A4 status enabled=false');
    await expectErrorCode(() => svc.claimFreeGrant(), 'CAMPAIGN_DISABLED', 'A4 claim while disabled');

    // ---------------- Feature B: recharge codes ----------------
    step('B-prep. Admin generates a batch of 3 codes @ 5 MB');
    const gen = await adminFetch('/v1/admin/traffic/codes/generate', {
      method: 'POST',
      body: { count: 3, trafficBytes: 5000000, expiresAt: null, note: '3b acceptance run' },
    });
    printJson('generate result', gen.json?.data ?? gen.json);
    ok(gen.status === 200, 'B-prep generate HTTP 200');
    const genData = gen.json?.data ?? {};
    const codes = genData.codes ?? genData.list ?? [];
    const batchId = genData.batchId ?? genData.batch?.id ?? codes[0]?.batchId;
    const codeList = codes.map(codeStr);
    ok(codeList.length === 3 && codeList.every((c) => /^IDB-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(c)), 'B1 codes well-formed & unique', JSON.stringify(codeList));

    step('B6. Export contains the unused codes (before any revoke)');
    const exp = await adminFetch(`/v1/admin/traffic/codes/export?batchId=${batchId}`, { raw: true });
    ok(exp.status === 200 && codeList.slice(1).every((c) => exp.text.includes(c)), 'B6 export CSV contains unused codes', `HTTP ${exp.status}`);
    console.log('export text:', exp.text.replace(/\n/g, ' | '));

    step('B2. Redeem code #1 → credits exactly 5 MB');
    await initServiceFor(newMnemonic());
    await svc.ensureTrafficAccount();
    const red1 = await svc.redeemTrafficCode(codeList[0]);
    printJson('redeem #1', red1);
    ok(red1.trafficBytes === 5000000, 'B2 redeem amount', String(red1.trafficBytes));
    ok(red1.balanceAfter === 5000000, 'B2 balanceAfter', String(red1.balanceAfter));
    const ledgerB = await svc.getTrafficLedger({ limit: 20 });
    const codeRow = (ledgerB.entries || []).find((entry) => entry.sourceType === 'recharge_code');
    ok(Boolean(codeRow) && codeRow.amountBytes === 5000000, 'B2 ledger recharge_code row');

    step('B3. Same account redeems code #1 again → idempotent, no double credit');
    const red1b = await svc.redeemTrafficCode(codeList[0].toLowerCase());
    printJson('redeem #1 (retry)', red1b);
    ok(red1b.trafficBytes === 5000000 && red1b.balanceAfter === 5000000, 'B3 idempotent retry', `balance=${red1b.balanceAfter}`);

    step('B3b. Different account redeems code #1 → CODE_USED');
    await initServiceFor(newMnemonic());
    await svc.ensureTrafficAccount();
    await expectErrorCode(() => svc.redeemTrafficCode(codeList[0]), 'CODE_USED', 'B3b other account');

    step('B4. Bogus code → CODE_NOT_FOUND');
    await initServiceFor(newMnemonic());
    await svc.ensureTrafficAccount();
    await expectErrorCode(() => svc.redeemTrafficCode('IDB-ABCD-EFGH-JKLM'), 'CODE_NOT_FOUND', 'B4 bogus code');

    step('B5. Revoke batch → unused code #2 → CODE_DISABLED');
    const revoke = await adminFetch(`/v1/admin/traffic/batches/${batchId}/revoke`, { method: 'POST' });
    ok(revoke.status === 200, 'B5 revoke HTTP 200');
    await initServiceFor(newMnemonic());
    await svc.ensureTrafficAccount();
    await expectErrorCode(() => svc.redeemTrafficCode(codeList[1]), 'CODE_DISABLED', 'B5 revoked code');

    step('B7. Admin list + stats');
    const list = await adminFetch(`/v1/admin/traffic/codes?batchId=${batchId}&page=1&pageSize=20`);
    const listData = list.json?.data ?? {};
    const rows = Array.isArray(listData) ? listData : (listData.codes ?? listData.list ?? listData.rows ?? []);
    ok(list.status === 200 && rows.length === 3, 'B7 codes list HTTP 200 with 3 rows', `rows=${rows.length}`);
    const stats = await adminFetch('/v1/admin/traffic/codes/stats');
    printJson('stats', stats.json?.data ?? stats.json);
    ok(stats.status === 200, 'B7 stats HTTP 200');

    console.log('\n=================');
    console.log(`RESULT: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`);
  } finally {
    step('Cleanup. Restore original campaign settings');
    try {
      await writeCampaignSettings(originalSettings);
      console.log('campaign settings restored:', JSON.stringify(originalSettings));
    } catch (error) {
      console.error('[cleanup] failed to restore campaign settings:', error?.message ?? error);
      failures += 1;
    }
  }
  process.exit(failures === 0 ? 0 : 1);
}

runAcceptance().catch((error) => {
  console.error('[acceptance crash]', error);
  process.exit(1);
});
