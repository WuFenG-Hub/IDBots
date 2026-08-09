import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mvc } = require('meta-contract');

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const {
  TrafficApiError,
  bindAllLocalBots,
  ensureTrafficAccount,
  getLocalTrafficAccount,
  getTrafficBalance,
  initTrafficAccountService,
  listLocalTrafficJournal,
  recordLocalTrafficSpend,
  resetTrafficAccountServiceForTests,
  resolveSponsorTrafficAccount,
} = await import('../dist-electron/main/services/trafficAccountService.js');
const { runMvcSponsorCreatePin } = await import('../dist-electron/main/services/mvcSponsorCreatePin.js');
const { assembleMvcPinTransaction } = await import('../dist-electron/main/libs/createPinWorker.js');

const IDENTITY_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const BOT1_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const BOT2_MNEMONIC =
  'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';
const WALLET_PATH = "m/44'/10001'/0'/0/0";
const IDENTITY_GMID = 'idq1localidentity';
const COMMIT_TXID = 'aa'.repeat(32);

function deriveAddress(mnemonic) {
  const network = mvc.Networks.livenet;
  const child = mvc.Mnemonic.fromString(mnemonic).toHDPrivateKey('', network).deriveChild(WALLET_PATH);
  return child.publicKey.toAddress(network).toString();
}

const IDENTITY_ADDRESS = deriveAddress(IDENTITY_MNEMONIC);
const BOT1_ADDRESS = deriveAddress(BOT1_MNEMONIC);
const BOT2_ADDRESS = deriveAddress(BOT2_MNEMONIC);
const SERVER_ACCOUNT_ID = 'idq1serverderived';

function verifyMessage(address, message, signature) {
  try {
    return mvc.Message(message).verify(address, signature);
  } catch {
    return false;
  }
}

function envelope(data) {
  return JSON.stringify({ code: 0, message: 'success', data });
}

function httpError(status, body = { code: 1, message: `HTTP ${status}` }) {
  return { __httpStatus: status, __body: body };
}

function createFetchStub(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const text = String(url);
    calls.push({ url: text, init });
    for (const [suffix, responder] of routes) {
      if (text.includes(suffix)) {
        const body = typeof responder === 'function' ? responder(init) : responder;
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

function callsTo(fetchImpl, suffix) {
  return fetchImpl.calls.filter((call) => call.url.includes(suffix));
}

function callsToPath(fetchImpl, pathName) {
  return fetchImpl.calls.filter((call) => new URL(call.url).pathname === pathName);
}

function accountPayload(overrides = {}) {
  return {
    accountId: SERVER_ACCOUNT_ID,
    identityAddress: IDENTITY_ADDRESS,
    balanceBytes: 1000,
    reservedBytes: 0,
    grantedBytesTotal: 1000,
    spentBytesTotal: 0,
    status: 1,
    ...overrides,
  };
}

async function makeServiceFixture(options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idbots-traffic-test-'));
  const store = await SqliteStore.create(dir);
  if (options.trafficMode) {
    store.set('traffic.mode', options.trafficMode);
  }
  const bots = options.bots ?? [
    { address: BOT1_ADDRESS, mnemonic: BOT1_MNEMONIC, walletId: 11 },
    { address: BOT2_ADDRESS, mnemonic: BOT2_MNEMONIC, walletId: 12 },
  ];
  const fakeMetabotStore = {
    listMetabots: () => bots.map((bot) => ({ mvc_address: bot.address, wallet_id: bot.walletId })),
    getMetabotWalletById: (walletId) => {
      const bot = bots.find((item) => item.walletId === walletId);
      return bot ? { id: bot.walletId, mnemonic: bot.mnemonic, path: WALLET_PATH } : null;
    },
  };
  const fakeIdentityStore = {
    get: () => ({
      id: 1,
      mnemonic: IDENTITY_MNEMONIC,
      path: WALLET_PATH,
      mvc_address: IDENTITY_ADDRESS,
      globalmetaid: IDENTITY_GMID,
      name: 'Owner',
    }),
  };
  resetTrafficAccountServiceForTests();
  initTrafficAccountService({
    getStore: () => store,
    getMetabotStore: () => fakeMetabotStore,
    getUserIdentityStore: () => fakeIdentityStore,
    fetchImpl: options.fetchImpl,
    baseUrl: 'https://traffic.test',
  });
  return { store, dir };
}

test('ensureTrafficAccount signs the canonical message and persists the server-returned accountId', async () => {
  let captured = null;
  const fetchImpl = createFetchStub([
    ['/v1/traffic/accounts', (init) => {
      captured = { headers: init.headers, body: JSON.parse(init.body) };
      return accountPayload();
    }],
  ]);
  await makeServiceFixture({ fetchImpl });

  const account = await ensureTrafficAccount();
  assert.equal(account.accountId, SERVER_ACCOUNT_ID);
  assert.equal(getLocalTrafficAccount().accountId, SERVER_ACCOUNT_ID);

  assert.ok(captured);
  assert.deepEqual(captured.body, { accountId: IDENTITY_GMID });
  assert.equal(captured.headers['X-Identity-Address'], IDENTITY_ADDRESS);
  const timestamp = Number(captured.headers['X-Timestamp']);
  assert.ok(Number.isInteger(timestamp) && timestamp > 0);
  assert.ok(
    verifyMessage(
      IDENTITY_ADDRESS,
      `traffic-account:${IDENTITY_GMID}:${timestamp}`,
      captured.headers['X-Signature'],
    ),
    'X-Signature must verify against traffic-account:<accountId>:<ts>',
  );
});

test('bindAllLocalBots binds bots + identity, reports conflicts, and stays idempotent', async () => {
  const bindBodies = new Map();
  const fetchImpl = createFetchStub([
    ['/v1/traffic/accounts/bindings', (init) => {
      const body = JSON.parse(init.body);
      bindBodies.set(body.botAddress, { body, headers: init.headers });
      if (body.botAddress === BOT2_ADDRESS) {
        return { code: 1, message: 'traffic address already bound to another account' };
      }
      return { botAddress: body.botAddress, accountId: SERVER_ACCOUNT_ID, status: 1, createdAt: 1 };
    }],
    ['/v1/traffic/accounts', accountPayload()],
  ]);
  await makeServiceFixture({ fetchImpl });

  const summary = await bindAllLocalBots();
  assert.equal(summary.accountId, SERVER_ACCOUNT_ID);
  assert.equal(summary.boundCount, 2);
  assert.equal(summary.conflictCount, 1);
  assert.equal(summary.failedCount, 0);
  assert.deepEqual(
    summary.results.find((item) => item.botAddress === BOT2_ADDRESS).status,
    'conflict',
  );

  const bot1Bind = bindBodies.get(BOT1_ADDRESS);
  assert.ok(bot1Bind);
  const parts = bot1Bind.body.bindMessage.split(':');
  assert.equal(parts[0], 'traffic-bind');
  assert.equal(parts[1], BOT1_ADDRESS);
  assert.equal(parts[2], SERVER_ACCOUNT_ID);
  const bindTs = Number(parts[3]);
  assert.equal(Number(bot1Bind.headers['X-Timestamp']), bindTs);
  assert.ok(verifyMessage(BOT1_ADDRESS, bot1Bind.body.bindMessage, bot1Bind.body.botSignature));
  assert.ok(verifyMessage(IDENTITY_ADDRESS, bot1Bind.body.bindMessage, bot1Bind.headers['X-Signature']));

  // Identity address is bound too, signed by the identity key on both sides.
  const identityBind = bindBodies.get(IDENTITY_ADDRESS);
  assert.ok(identityBind);
  assert.ok(verifyMessage(IDENTITY_ADDRESS, identityBind.body.bindMessage, identityBind.body.botSignature));

  // Re-run: same-account rebinds succeed, the conflict stays a conflict; nothing throws.
  const again = await bindAllLocalBots();
  assert.equal(again.boundCount, 2);
  assert.equal(again.conflictCount, 1);
});

test('getTrafficBalance caches for the TTL and local spends adjust the cache', async () => {
  const fetchImpl = createFetchStub([
    ['/v1/traffic/accounts/bindings', { botAddress: BOT1_ADDRESS, accountId: SERVER_ACCOUNT_ID, status: 1 }],
    ['/v1/traffic/accounts', (init) => {
      if (String(init.method) === 'GET') {
        return accountPayload({ balanceBytes: 650, spentBytesTotal: 350 });
      }
      return accountPayload();
    }],
  ]);
  const { store } = await makeServiceFixture({ fetchImpl });

  await ensureTrafficAccount();
  const first = await getTrafficBalance();
  assert.equal(first.balanceBytes, 1000);
  assert.equal(callsToPath(fetchImpl, '/v1/traffic/accounts').length, 1);
  assert.equal(callsToPath(fetchImpl, `/v1/traffic/accounts/${SERVER_ACCOUNT_ID}/balance`).length, 0);

  recordLocalTrafficSpend({
    txId: COMMIT_TXID,
    botAddress: BOT1_ADDRESS,
    orderId: 'order-1',
    txSize: 300,
    sponsoredMinerFee: 300,
    savedFee: 300,
    billedBy: 'traffic',
  });
  const afterSpend = await getTrafficBalance();
  assert.equal(afterSpend.balanceBytes, 700);
  assert.equal(afterSpend.spentBytesTotal, 300);
  assert.equal(callsToPath(fetchImpl, `/v1/traffic/accounts/${SERVER_ACCOUNT_ID}/balance`).length, 0);

  // Quota-billed spends never touch the traffic balance cache.
  recordLocalTrafficSpend({ txId: 'bb'.repeat(32), botAddress: BOT1_ADDRESS, txSize: 100, billedBy: 'quota' });
  assert.equal((await getTrafficBalance()).balanceBytes, 700);

  const refreshed = await getTrafficBalance({ forceRefresh: true });
  assert.equal(refreshed.balanceBytes, 650);
  assert.equal(callsToPath(fetchImpl, `/v1/traffic/accounts/${SERVER_ACCOUNT_ID}/balance`).length, 1);
  void store;
});

test('local spend journal writes and lists entries', async () => {
  await makeServiceFixture({ fetchImpl: createFetchStub([]) });

  recordLocalTrafficSpend({
    txId: COMMIT_TXID,
    botAddress: BOT1_ADDRESS,
    orderId: 'order-1',
    txSize: 300,
    sponsoredMinerFee: 100,
    savedFee: 100,
    billedBy: 'traffic',
  });
  recordLocalTrafficSpend({
    txId: 'cc'.repeat(32),
    botAddress: BOT2_ADDRESS,
    orderId: 'order-2',
    txSize: 250,
    sponsoredMinerFee: 90,
    savedFee: 90,
    billedBy: 'quota',
  });

  const all = listLocalTrafficJournal();
  assert.equal(all.length, 2);
  assert.equal(all[0].txId, 'cc'.repeat(32));
  assert.equal(all[0].billedBy, 'quota');
  assert.equal(all[1].txId, COMMIT_TXID);
  assert.equal(all[1].orderId, 'order-1');
  assert.equal(all[1].txSize, 300);
  assert.equal(all[1].billedBy, 'traffic');
  assert.ok(all[1].createdAt > 0);

  const filtered = listLocalTrafficJournal({ botAddress: BOT2_ADDRESS });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].botAddress, BOT2_ADDRESS);
});

test('resolveSponsorTrafficAccount stays undefined unless traffic mode is on', async () => {
  const fetchImpl = createFetchStub([['/v1/traffic/accounts', accountPayload()]]);
  await makeServiceFixture({ fetchImpl });

  const result = await resolveSponsorTrafficAccount({
    botAddress: BOT1_ADDRESS,
    challengeId: 'challenge-1',
    botMnemonic: BOT1_MNEMONIC,
    botWalletPath: WALLET_PATH,
  });
  assert.equal(result, undefined);
  assert.equal(fetchImpl.calls.length, 0);
});

test('resolveSponsorTrafficAccount lazily ensures + binds and signs traffic-pre', async () => {
  const fetchImpl = createFetchStub([
    ['/v1/traffic/accounts/bindings', (init) => {
      const body = JSON.parse(init.body);
      return { botAddress: body.botAddress, accountId: SERVER_ACCOUNT_ID, status: 1, createdAt: 1 };
    }],
    ['/v1/traffic/accounts', accountPayload()],
  ]);
  await makeServiceFixture({ fetchImpl, trafficMode: 'traffic' });

  const first = await resolveSponsorTrafficAccount({
    botAddress: BOT1_ADDRESS,
    challengeId: 'challenge-1',
    botMnemonic: BOT1_MNEMONIC,
    botWalletPath: WALLET_PATH,
  });
  assert.ok(first);
  assert.equal(first.accountId, SERVER_ACCOUNT_ID);
  assert.ok(Number.isInteger(first.timestamp) && first.timestamp > 0);
  assert.ok(
    verifyMessage(IDENTITY_ADDRESS, `traffic-pre:${SERVER_ACCOUNT_ID}:challenge-1`, first.authSignature),
    'authSignature must verify against traffic-pre:<accountId>:<challengeId>',
  );
  assert.equal(callsToPath(fetchImpl, '/v1/traffic/accounts').length, 1);
  assert.equal(callsToPath(fetchImpl, '/v1/traffic/accounts/bindings').length, 1);

  // Second call: account + binding are cached locally, no more HTTP.
  const second = await resolveSponsorTrafficAccount({
    botAddress: BOT1_ADDRESS,
    challengeId: 'challenge-2',
    botMnemonic: BOT1_MNEMONIC,
    botWalletPath: WALLET_PATH,
  });
  assert.ok(second);
  assert.ok(verifyMessage(IDENTITY_ADDRESS, `traffic-pre:${SERVER_ACCOUNT_ID}:challenge-2`, second.authSignature));
  assert.equal(callsToPath(fetchImpl, '/v1/traffic/accounts').length, 1);
  assert.equal(callsToPath(fetchImpl, '/v1/traffic/accounts/bindings').length, 1);
});

test('resolveSponsorTrafficAccount degrades to undefined on backend 404 (feature off)', async () => {
  const fetchImpl = createFetchStub([
    ['/v1/traffic/accounts', httpError(404, { code: 1, message: 'traffic disabled' })],
  ]);
  await makeServiceFixture({ fetchImpl, trafficMode: 'traffic' });

  const result = await resolveSponsorTrafficAccount({
    botAddress: BOT1_ADDRESS,
    challengeId: 'challenge-1',
    botMnemonic: BOT1_MNEMONIC,
    botWalletPath: WALLET_PATH,
  });
  assert.equal(result, undefined);

  await assert.rejects(ensureTrafficAccount(), (error) => {
    assert.ok(error instanceof TrafficApiError);
    assert.equal(error.featureUnavailable, true);
    return true;
  });
});

function buildSponsorDraft(botAddress) {
  const utxo = { txId: '11'.repeat(32), outputIndex: 0, satoshis: 50000, address: botAddress, height: 1 };
  const addressObj = new mvc.Address(botAddress, mvc.Networks.livenet);
  const opReturnParts = ['metaid', 'create', '/test/traffic', '0', '1.0', 'text/plain;utf-8', Buffer.from('traffic e2e')];
  const assembled = assembleMvcPinTransaction({
    addressObj,
    opReturnParts,
    usableUtxos: [utxo],
    feeRate: 1,
    estimatedTxSizeWithoutInputs: 200,
    excludedOutpoints: new Set(),
    preferredOutpoints: new Set(),
    deductMinerFeeFromChange: false,
  });
  const outputs = assembled.txComposer.tx.outputs;
  const changeSatoshis = Number(outputs[outputs.length - 1]?.satoshis);
  return {
    txids: [],
    pinId: '',
    totalCost: 0,
    spentOutpoints: [`${utxo.txId}:0`],
    changeUtxo: null,
    draft: {
      unsignedTxHex: assembled.txComposer.getRawHex(),
      estimatedTxSize: 200 + 2 * 148,
      feeRate: 1,
      userInputs: [utxo],
      changeOutput: outputs.length > 1 && changeSatoshis >= 600
        ? { outputIndex: outputs.length - 1, satoshis: changeSatoshis }
        : null,
    },
  };
}

function sponsorRoutes(draftResult, preCapture) {
  return [
    ['/v2/assist/gas/address/info', {
      exists: true,
      balance: 5000,
      grantedAmount: 5000,
      reservedAmount: 0,
      spentAmount: 0,
      availableAmount: 5000,
      status: 'active',
    }],
    ['/v2/assist/gas/mvc/challenge', { challengeId: 'challenge-1', message: 'sign this message' }],
    ['/v2/assist/gas/mvc/pre', (init) => {
      if (preCapture) preCapture(JSON.parse(init.body));
      return {
        preparedTxHex: draftResult.draft.unsignedTxHex,
        orderId: 'order-1',
        minerFee: 100,
        userInputIndexes: [0],
      };
    }],
    ['/v2/assist/gas/mvc/commit', { txId: COMMIT_TXID, txSize: 300, minerFee: 100 }],
  ];
}

function runSponsoredPin(fetchImpl, extraInput = {}) {
  const draftResult = buildSponsorDraft(BOT1_ADDRESS);
  return runMvcSponsorCreatePin(
    {
      metabotId: 9201,
      mnemonic: BOT1_MNEMONIC,
      walletPath: WALLET_PATH,
      mvcAddress: BOT1_ADDRESS,
      feeRate: 1,
      fallbackPolicy: 'selfpay',
      baseUrl: 'https://sponsor.test',
      fetchImpl,
      ...extraInput,
    },
    {
      runDraftWorker: async () => draftResult,
      runBroadcastWorker: async () => {
        throw new Error('broadcast fallback must not run in this test');
      },
      recordSpentOutpoints: () => {},
      replacePendingFundingUtxos: () => {},
      resolveTrafficAccount: ({ challengeId }) => resolveSponsorTrafficAccount({
        botAddress: BOT1_ADDRESS,
        challengeId,
        botMnemonic: BOT1_MNEMONIC,
        botWalletPath: WALLET_PATH,
      }),
    },
  );
}

test('sponsored createPin injects a verifiable trafficAccount into pre when traffic mode is on', async () => {
  let preBody = null;
  const fetchImpl = createFetchStub([
    ['/v1/traffic/accounts/bindings', (init) => {
      const body = JSON.parse(init.body);
      return { botAddress: body.botAddress, accountId: SERVER_ACCOUNT_ID, status: 1, createdAt: 1 };
    }],
    ['/v1/traffic/accounts', accountPayload()],
    ...sponsorRoutes(buildSponsorDraft(BOT1_ADDRESS), (body) => { preBody = body; }),
  ]);
  await makeServiceFixture({ fetchImpl, trafficMode: 'traffic' });

  const result = await runSponsoredPin(fetchImpl);
  assert.equal(result.feeAssist.used, true);
  assert.equal(result.pinId, `${COMMIT_TXID}i0`);

  assert.ok(preBody);
  assert.ok(preBody.trafficAccount);
  assert.equal(preBody.trafficAccount.accountId, SERVER_ACCOUNT_ID);
  assert.ok(
    verifyMessage(
      IDENTITY_ADDRESS,
      `traffic-pre:${SERVER_ACCOUNT_ID}:challenge-1`,
      preBody.trafficAccount.authSignature,
    ),
  );

  // Journal + balance cache reflect the traffic-billed spend.
  const journal = listLocalTrafficJournal();
  assert.equal(journal.length, 1);
  assert.equal(journal[0].billedBy, 'traffic');
  assert.equal(journal[0].txSize, 300);
  assert.equal((await getTrafficBalance()).balanceBytes, 700);
});

test('sponsored createPin omits trafficAccount when the traffic API is 404 (legacy quota path)', async () => {
  let preBody = null;
  const fetchImpl = createFetchStub([
    ['/v1/traffic/accounts', httpError(404, { code: 1, message: 'traffic disabled' })],
    ...sponsorRoutes(buildSponsorDraft(BOT1_ADDRESS), (body) => { preBody = body; }),
  ]);
  await makeServiceFixture({ fetchImpl, trafficMode: 'traffic' });

  const result = await runSponsoredPin(fetchImpl);
  assert.equal(result.feeAssist.used, true);
  assert.ok(preBody);
  assert.ok(!('trafficAccount' in preBody));

  const journal = listLocalTrafficJournal();
  assert.equal(journal.length, 1);
  assert.equal(journal[0].billedBy, 'quota');
});
