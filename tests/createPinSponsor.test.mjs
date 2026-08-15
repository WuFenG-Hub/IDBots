import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mvc } = require('meta-contract');

const { assembleMvcPinTransaction } = await import('../dist-electron/main/libs/createPinWorker.js');
const {
  runMvcSponsorCreatePin,
  TrafficInsufficientError,
} = await import('../dist-electron/main/services/mvcSponsorCreatePin.js');
const { parseCreatePinWorkerResultForTests } = await import('../dist-electron/main/services/metaidCore.js');
const {
  getMvcSpendSessionSnapshot,
  recordMvcSpentOutpoints,
  replaceMvcPendingFundingUtxos,
  resetMvcSpendSessionStateForTests,
} = await import('../dist-electron/main/services/mvcSpendSessionState.js');
const {
  getTrafficFallbackPolicy,
  getTrafficPinMode,
  normalizeTrafficFallbackPolicy,
  normalizeTrafficPinMode,
} = await import('../dist-electron/main/services/trafficSettings.js');

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const WALLET_PATH = "m/44'/10001'/0'/0/0";
const TEST_TXID = '11'.repeat(32);
const COMMIT_TXID = 'aa'.repeat(32);

function deriveTestKeyPair() {
  const network = mvc.Networks.livenet;
  const mneObj = mvc.Mnemonic.fromString(MNEMONIC);
  const hdpk = mneObj.toHDPrivateKey('', network);
  const childPk = hdpk.deriveChild(WALLET_PATH);
  return {
    address: childPk.publicKey.toAddress(network).toString(),
    privateKey: childPk.privateKey,
  };
}

const TEST_ADDRESS = deriveTestKeyPair().address;
const TEST_UTXO = { txId: TEST_TXID, outputIndex: 0, satoshis: 50000, address: TEST_ADDRESS, height: 1 };

function envelope(data) {
  return JSON.stringify({ code: 0, data });
}

function createFetchStub(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const text = String(url);
    calls.push({ url: text, init });
    for (const [suffix, responder] of routes) {
      if (text.includes(suffix)) {
        const body = typeof responder === 'function' ? responder(init) : responder;
        const raw = typeof body === 'string'
          ? body
          : body && typeof body === 'object' && 'code' in body
            ? JSON.stringify(body)
            : envelope(body);
        return { ok: true, status: 200, json: async () => JSON.parse(raw) };
      }
    }
    return { ok: false, status: 404, json: async () => ({ code: 404, msg: 'not found' }) };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function callsTo(fetchImpl, suffix) {
  return fetchImpl.calls.filter((call) => call.url.includes(suffix));
}

const ADDRESS_INFO_ROUTE = ['/v2/assist/gas/address/info', {
  exists: true,
  balance: 5000,
  grantedAmount: 5000,
  reservedAmount: 0,
  spentAmount: 0,
  availableAmount: 5000,
  status: 'active',
}];
const CHALLENGE_ROUTE = ['/v2/assist/gas/mvc/challenge', { challengeId: 'challenge-1', message: 'sign this message' }];

function assembleTestPin({ deductMinerFeeFromChange }) {
  const addressObj = new mvc.Address(TEST_ADDRESS, mvc.Networks.livenet);
  const opReturnParts = ['metaid', 'create', '/test/sponsor', '0', '1.0', 'text/plain;utf-8', Buffer.from('hello sponsor')];
  const opReturnScriptSize = 1 + opReturnParts.reduce((sum, part) => {
    const len = Buffer.isBuffer(part) ? part.length : Buffer.byteLength(part, 'utf8');
    return sum + (len < 76 ? 1 + len : 2 + len);
  }, 0);
  const estimatedTxSizeWithoutInputs = 4 + 1 + 1 + 43 + (9 + opReturnScriptSize) + 4;
  const assembled = assembleMvcPinTransaction({
    addressObj,
    opReturnParts,
    usableUtxos: [TEST_UTXO],
    feeRate: 1,
    estimatedTxSizeWithoutInputs,
    excludedOutpoints: new Set(),
    preferredOutpoints: new Set(),
    deductMinerFeeFromChange,
  });
  return { ...assembled, estimatedTxSizeWithoutInputs };
}

function buildDraftWorkerResult() {
  const { txComposer, picked, estimatedTxSizeWithoutInputs } = assembleTestPin({ deductMinerFeeFromChange: false });
  const tx = txComposer.tx;
  const changeIndex = tx.outputs.length - 1;
  const changeSatoshis = Number(tx.outputs[changeIndex]?.satoshis);
  return {
    txids: [],
    pinId: '',
    totalCost: 0,
    spentOutpoints: picked.map((utxo) => `${utxo.txId}:${utxo.outputIndex}`),
    changeUtxo: null,
    draft: {
      unsignedTxHex: txComposer.getRawHex(),
      estimatedTxSize: estimatedTxSizeWithoutInputs + (picked.length + 1) * 148,
      feeRate: 1,
      userInputs: picked,
      changeOutput: tx.outputs.length > 1 && changeSatoshis >= 600
        ? { outputIndex: changeIndex, satoshis: changeSatoshis }
        : null,
    },
  };
}

function makeBroadcastWorker(returnValue = {}) {
  const state = { calls: 0 };
  const runBroadcastWorker = async () => {
    state.calls += 1;
    return {
      txids: ['ff'.repeat(32)],
      pinId: `${'ff'.repeat(32)}i0`,
      totalCost: 900,
      spentOutpoints: [`${TEST_TXID}:0`],
      changeUtxo: null,
      ...returnValue,
    };
  };
  return { runBroadcastWorker, state };
}

test('assembleMvcPinTransaction draft output matches the broadcast tx modulo signatures and fee', () => {
  const draft = assembleTestPin({ deductMinerFeeFromChange: false });
  const broadcast = assembleTestPin({ deductMinerFeeFromChange: true });

  const { privateKey } = deriveTestKeyPair();
  for (let index = 0; index < broadcast.txComposer.tx.inputs.length; index += 1) {
    broadcast.txComposer.unlockP2PKHInput(privateKey, index);
  }

  const draftTx = new mvc.Transaction(draft.txComposer.getRawHex());
  const broadcastTx = new mvc.Transaction(broadcast.txComposer.getRawHex());

  assert.equal(draftTx.inputs.length, 1);
  assert.equal(broadcastTx.inputs.length, 1);
  assert.deepEqual([...draftTx.inputs[0].prevTxId], [...broadcastTx.inputs[0].prevTxId]);
  assert.equal(draftTx.inputs[0].outputIndex, broadcastTx.inputs[0].outputIndex);
  // Draft keeps user inputs unsigned; the broadcast tx carries unlocking scripts.
  assert.equal(draftTx.inputs[0].script.toHex(), '');
  assert.ok(broadcastTx.inputs[0].script.toHex().length > 0);

  assert.equal(draftTx.outputs.length, broadcastTx.outputs.length);
  assert.equal(draftTx.outputs[0].satoshis, broadcastTx.outputs[0].satoshis);
  assert.equal(draftTx.outputs[0].script.toHex(), broadcastTx.outputs[0].script.toHex());
  assert.equal(draftTx.outputs[1].script.toHex(), broadcastTx.outputs[1].script.toHex());

  // Draft change is undeducted; the broadcast change is reduced by the miner fee.
  // Prevout satoshis live on the in-memory composer tx (a reparsed tx has no input.output).
  const broadcastInputTotal = broadcast.txComposer.tx.inputs.reduce((sum, inp) => sum + (inp.output?.satoshis || 0), 0);
  const broadcastOutputTotal = broadcast.txComposer.tx.outputs.reduce((sum, out) => sum + out.satoshis, 0);
  const broadcastFee = broadcastInputTotal - broadcastOutputTotal;
  assert.ok(broadcastFee > 0);
  const draftChange = draftTx.outputs[draftTx.outputs.length - 1].satoshis;
  const broadcastChange = broadcastTx.outputs[broadcastTx.outputs.length - 1].satoshis;
  assert.equal(draftChange - broadcastChange, broadcastFee);
});

test('parseCreatePinWorkerResultForTests parses draft-mode worker output', () => {
  const parsed = parseCreatePinWorkerResultForTests({
    stdout: JSON.stringify({
      success: true,
      mode: 'draft',
      unsignedTxHex: 'ab00',
      estimatedTxSize: 496,
      feeRate: 1,
      spentOutpoints: [`${TEST_TXID}:0`],
      userInputs: [TEST_UTXO],
      changeOutput: { outputIndex: 2, satoshis: 49999 },
    }),
    stderr: '',
    exitCode: 0,
  });
  assert.deepEqual(parsed.txids, []);
  assert.equal(parsed.draft.unsignedTxHex, 'ab00');
  assert.equal(parsed.draft.estimatedTxSize, 496);
  assert.deepEqual(parsed.draft.userInputs, [TEST_UTXO]);
  assert.deepEqual(parsed.draft.changeOutput, { outputIndex: 2, satoshis: 49999 });
  assert.deepEqual(parsed.spentOutpoints, [`${TEST_TXID}:0`]);

  assert.throws(
    () => parseCreatePinWorkerResultForTests({
      stdout: JSON.stringify({ success: true, mode: 'draft' }),
      stderr: '',
      exitCode: 0,
    }),
    /Worker failed/,
  );
});

test('runMvcSponsorCreatePin completes the sponsor flow and mirrors broadcast session state', async () => {
  resetMvcSpendSessionStateForTests();
  const metabotId = 9101;
  const draftResult = buildDraftWorkerResult();
  let infoCalls = 0;
  let commitBody = null;
  const fetchImpl = createFetchStub([
    ['/v2/assist/gas/address/info', () => {
      infoCalls += 1;
      return {
        exists: true,
        balance: 5000,
        grantedAmount: 5000,
        reservedAmount: 0,
        spentAmount: 0,
        availableAmount: infoCalls === 1 ? 5000 : 4900,
        status: 'active',
      };
    }],
    CHALLENGE_ROUTE,
    ['/v2/assist/gas/mvc/pre', {
      preparedTxHex: draftResult.draft.unsignedTxHex,
      orderId: 'order-1',
      minerFee: 100,
      userInputIndexes: [0],
    }],
    ['/v2/assist/gas/mvc/commit', (init) => {
      commitBody = JSON.parse(init.body);
      return { txId: COMMIT_TXID, txSize: 300, minerFee: 100 };
    }],
  ]);
  const { runBroadcastWorker, state: broadcastState } = makeBroadcastWorker();

  const result = await runMvcSponsorCreatePin(
    {
      metabotId,
      mnemonic: MNEMONIC,
      walletPath: WALLET_PATH,
      mvcAddress: TEST_ADDRESS,
      feeRate: 1,
      fallbackPolicy: 'selfpay',
      baseUrl: 'https://sponsor.test',
      fetchImpl,
    },
    {
      runDraftWorker: async () => draftResult,
      runBroadcastWorker,
      recordSpentOutpoints: (outpoints) => recordMvcSpentOutpoints(metabotId, outpoints),
      replacePendingFundingUtxos: (utxo) => replaceMvcPendingFundingUtxos(metabotId, utxo),
    },
  );

  assert.equal(broadcastState.calls, 0);
  assert.deepEqual(result.txids, [COMMIT_TXID]);
  assert.equal(result.pinId, `${COMMIT_TXID}i0`);
  assert.equal(result.totalCost, 100);
  assert.equal(result.feeAssist.used, true);
  assert.equal(result.feeAssist.mode, 'mvc_sponsor_v2');
  assert.equal(result.feeAssist.stage, 'done');
  assert.equal(result.feeAssist.orderId, 'order-1');
  assert.equal(result.feeAssist.sponsoredMinerFee, 100);
  assert.equal(result.feeAssist.savedFee, 100);
  assert.equal(result.feeAssist.txSize, 300);
  assert.equal(result.feeAssist.quotaBefore.availableAmount, 5000);
  assert.equal(result.feeAssist.quotaAfter.availableAmount, 4900);
  assert.ok(result.feeAssist.advisoryFeeEstimate > 0);

  // The committed tx carries the user's signature on the draft's input.
  assert.ok(commitBody);
  const committedTx = new mvc.Transaction(commitBody.signedTxHex);
  assert.ok(committedTx.inputs[0].script.toHex().length > 0);

  // Session state mirrors the broadcast path: draft inputs spent, change cached.
  const snapshot = getMvcSpendSessionSnapshot(metabotId);
  assert.deepEqual(snapshot.excludeOutpoints, [`${TEST_TXID}:0`]);
  assert.deepEqual(snapshot.preferredFundingUtxos, [{
    txId: COMMIT_TXID,
    outputIndex: draftResult.draft.changeOutput.outputIndex,
    satoshis: draftResult.draft.changeOutput.satoshis,
    address: TEST_ADDRESS,
    height: -1,
  }]);
});

test('runMvcSponsorCreatePin passes trafficAccount through to pre when provided', async () => {
  const draftResult = buildDraftWorkerResult();
  let preBody = null;
  const fetchImpl = createFetchStub([
    ADDRESS_INFO_ROUTE,
    CHALLENGE_ROUTE,
    ['/v2/assist/gas/mvc/pre', (init) => {
      preBody = JSON.parse(init.body);
      return {
        preparedTxHex: draftResult.draft.unsignedTxHex,
        orderId: 'order-1',
        minerFee: 100,
        userInputIndexes: [0],
      };
    }],
    ['/v2/assist/gas/mvc/commit', { txId: COMMIT_TXID, txSize: 300, minerFee: 100 }],
  ]);
  const trafficAccount = { accountId: 'gmid-account', authSignature: 'YXV0aA==', timestamp: 1730000000 };

  await runMvcSponsorCreatePin(
    {
      metabotId: 9102,
      mnemonic: MNEMONIC,
      walletPath: WALLET_PATH,
      mvcAddress: TEST_ADDRESS,
      feeRate: 1,
      fallbackPolicy: 'selfpay',
      baseUrl: 'https://sponsor.test',
      fetchImpl,
      trafficAccount,
    },
    {
      runDraftWorker: async () => draftResult,
      runBroadcastWorker: makeBroadcastWorker().runBroadcastWorker,
      recordSpentOutpoints: () => {},
      replacePendingFundingUtxos: () => {},
    },
  );

  assert.ok(preBody);
  assert.deepEqual(preBody.trafficAccount, trafficAccount);
});

test('runMvcSponsorCreatePin falls back to self-paid when the sponsor service is unavailable', async () => {
  const draftResult = buildDraftWorkerResult();
  const fetchImpl = createFetchStub([
    ['/v2/assist/gas/address/info', () => ({ code: 1, msg: 'service down' })],
  ]);
  const { runBroadcastWorker, state: broadcastState } = makeBroadcastWorker();

  const result = await runMvcSponsorCreatePin(
    {
      metabotId: 9103,
      mnemonic: MNEMONIC,
      walletPath: WALLET_PATH,
      mvcAddress: TEST_ADDRESS,
      feeRate: 1,
      fallbackPolicy: 'selfpay',
      baseUrl: 'https://sponsor.test',
      fetchImpl,
    },
    {
      runDraftWorker: async () => draftResult,
      runBroadcastWorker,
      recordSpentOutpoints: () => {},
      replacePendingFundingUtxos: () => {},
    },
  );

  assert.equal(broadcastState.calls, 1);
  assert.equal(result.pinId, `${'ff'.repeat(32)}i0`);
  assert.equal(result.feeAssist.used, false);
  assert.equal(result.feeAssist.mode, 'self_paid');
  assert.equal(result.feeAssist.reason, 'service_unavailable');
  assert.equal(result.feeAssist.stage, 'address_info');
});

test('runMvcSponsorCreatePin classifies draft balance failures as no_user_utxo', async () => {
  const fetchImpl = createFetchStub([ADDRESS_INFO_ROUTE]);
  const { runBroadcastWorker, state: broadcastState } = makeBroadcastWorker();

  const result = await runMvcSponsorCreatePin(
    {
      metabotId: 9104,
      mnemonic: MNEMONIC,
      walletPath: WALLET_PATH,
      mvcAddress: TEST_ADDRESS,
      feeRate: 1,
      fallbackPolicy: 'selfpay',
      baseUrl: 'https://sponsor.test',
      fetchImpl,
    },
    {
      runDraftWorker: async () => {
        throw new Error('Not enough balance');
      },
      runBroadcastWorker,
      recordSpentOutpoints: () => {},
      replacePendingFundingUtxos: () => {},
    },
  );

  assert.equal(broadcastState.calls, 1);
  assert.equal(result.feeAssist.reason, 'no_user_utxo');
});

test('runMvcSponsorCreatePin falls back with insufficient_quota before challenge when quota is too low', async () => {
  const draftResult = buildDraftWorkerResult();
  const fetchImpl = createFetchStub([
    ['/v2/assist/gas/address/info', {
      exists: true,
      balance: 1,
      grantedAmount: 1,
      reservedAmount: 0,
      spentAmount: 0,
      availableAmount: 1,
      status: 'active',
    }],
    CHALLENGE_ROUTE,
  ]);
  const { runBroadcastWorker, state: broadcastState } = makeBroadcastWorker();

  const result = await runMvcSponsorCreatePin(
    {
      metabotId: 9105,
      mnemonic: MNEMONIC,
      walletPath: WALLET_PATH,
      mvcAddress: TEST_ADDRESS,
      feeRate: 1,
      fallbackPolicy: 'selfpay',
      baseUrl: 'https://sponsor.test',
      fetchImpl,
    },
    {
      runDraftWorker: async () => draftResult,
      runBroadcastWorker,
      recordSpentOutpoints: () => {},
      replacePendingFundingUtxos: () => {},
    },
  );

  assert.equal(broadcastState.calls, 1);
  assert.equal(result.feeAssist.reason, 'insufficient_quota');
  assert.equal(result.feeAssist.stage, 'address_info');
  assert.equal(callsTo(fetchImpl, '/v2/assist/gas/mvc/challenge').length, 0);
});

test('runMvcSponsorCreatePin falls back on pre quota and traffic insufficiency', async () => {
  const cases = [
    { responder: { code: 1, msg: 'available amount not enough' }, reason: 'insufficient_quota' },
    { responder: { code: 'TRAFFIC_INSUFFICIENT', msg: 'traffic balance not enough' }, reason: 'insufficient_traffic' },
  ];
  for (const [index, testCase] of cases.entries()) {
    const draftResult = buildDraftWorkerResult();
    const fetchImpl = createFetchStub([
      ADDRESS_INFO_ROUTE,
      CHALLENGE_ROUTE,
      ['/v2/assist/gas/mvc/pre', testCase.responder],
    ]);
    const { runBroadcastWorker, state: broadcastState } = makeBroadcastWorker();

    const result = await runMvcSponsorCreatePin(
      {
        metabotId: 9110 + index,
        mnemonic: MNEMONIC,
        walletPath: WALLET_PATH,
        mvcAddress: TEST_ADDRESS,
        feeRate: 1,
        fallbackPolicy: 'selfpay',
        baseUrl: 'https://sponsor.test',
        fetchImpl,
      },
      {
        runDraftWorker: async () => draftResult,
        runBroadcastWorker,
        recordSpentOutpoints: () => {},
        replacePendingFundingUtxos: () => {},
      },
    );

    assert.equal(broadcastState.calls, 1);
    assert.equal(result.feeAssist.used, false);
    assert.equal(result.feeAssist.reason, testCase.reason);
    assert.equal(result.feeAssist.stage, 'pre');
  }
});

test('runMvcSponsorCreatePin hard-fails on pre_rejected and commit_failed under both policies', async () => {
  const cases = [
    {
      routes: (draftResult) => [
        ADDRESS_INFO_ROUTE,
        CHALLENGE_ROUTE,
        ['/v2/assist/gas/mvc/pre', { code: 1, msg: 'address not match' }],
      ],
      code: 'mvc_fee_assist_pre_failed',
      reason: 'pre_rejected',
      stage: 'pre',
    },
    {
      routes: (draftResult) => [
        ADDRESS_INFO_ROUTE,
        CHALLENGE_ROUTE,
        ['/v2/assist/gas/mvc/pre', {
          preparedTxHex: draftResult.draft.unsignedTxHex,
          orderId: 'order-1',
          minerFee: 100,
          userInputIndexes: [0],
        }],
        ['/v2/assist/gas/mvc/commit', () => ({ code: 1, msg: 'commit rejected' })],
      ],
      code: 'mvc_fee_assist_commit_failed',
      reason: 'commit_failed',
      stage: 'commit',
    },
  ];
  for (const fallbackPolicy of ['selfpay', 'strict']) {
    for (const [index, testCase] of cases.entries()) {
      const draftResult = buildDraftWorkerResult();
      const fetchImpl = createFetchStub(testCase.routes(draftResult));
      const { runBroadcastWorker, state: broadcastState } = makeBroadcastWorker();

      await assert.rejects(
        runMvcSponsorCreatePin(
          {
            metabotId: 9120 + index,
            mnemonic: MNEMONIC,
            walletPath: WALLET_PATH,
            mvcAddress: TEST_ADDRESS,
            feeRate: 1,
            fallbackPolicy,
            baseUrl: 'https://sponsor.test',
            fetchImpl,
          },
          {
            runDraftWorker: async () => draftResult,
            runBroadcastWorker,
            recordSpentOutpoints: () => {},
            replacePendingFundingUtxos: () => {},
          },
        ),
        (error) => {
          assert.equal(error.code, testCase.code);
          assert.equal(error.data.feeAssist.used, false);
          assert.equal(error.data.feeAssist.reason, testCase.reason);
          assert.equal(error.data.feeAssist.stage, testCase.stage);
          return true;
        },
      );
      assert.equal(broadcastState.calls, 0);
    }
  }
});

test('runMvcSponsorCreatePin throws TrafficInsufficientError under the strict policy', async () => {
  const cases = [
    {
      name: 'service unavailable',
      routes: [['/v2/assist/gas/address/info', () => ({ code: 1, msg: 'service down' })]],
      reason: 'service_unavailable',
    },
    {
      name: 'quota preflight',
      routes: [['/v2/assist/gas/address/info', {
        exists: true,
        balance: 1,
        grantedAmount: 1,
        reservedAmount: 0,
        spentAmount: 0,
        availableAmount: 1,
        status: 'active',
      }]],
      reason: 'insufficient_quota',
    },
    {
      name: 'traffic insufficient at pre',
      routes: [
        ADDRESS_INFO_ROUTE,
        CHALLENGE_ROUTE,
        ['/v2/assist/gas/mvc/pre', { code: 'TRAFFIC_INSUFFICIENT', msg: 'traffic balance not enough' }],
      ],
      reason: 'insufficient_traffic',
    },
  ];
  for (const [index, testCase] of cases.entries()) {
    const draftResult = buildDraftWorkerResult();
    const fetchImpl = createFetchStub(testCase.routes);
    const { runBroadcastWorker, state: broadcastState } = makeBroadcastWorker();

    await assert.rejects(
      runMvcSponsorCreatePin(
        {
          metabotId: 9130 + index,
          mnemonic: MNEMONIC,
          walletPath: WALLET_PATH,
          mvcAddress: TEST_ADDRESS,
          feeRate: 1,
          fallbackPolicy: 'strict',
          baseUrl: 'https://sponsor.test',
          fetchImpl,
        },
        {
          runDraftWorker: async () => draftResult,
          runBroadcastWorker,
          recordSpentOutpoints: () => {},
          replacePendingFundingUtxos: () => {},
        },
      ),
      (error) => {
        assert.ok(error instanceof TrafficInsufficientError, testCase.name);
        assert.equal(error.code, 'mvc_traffic_insufficient');
        assert.equal(error.reason, testCase.reason);
        assert.equal(error.feeAssist.used, false);
        return true;
      },
    );
    assert.equal(broadcastState.calls, 0);
  }
});

test('runMvcSponsorCreatePin classifies no_user_utxo under the strict policy', async () => {
  const fetchImpl = createFetchStub([ADDRESS_INFO_ROUTE]);
  const { runBroadcastWorker, state: broadcastState } = makeBroadcastWorker();

  await assert.rejects(
    runMvcSponsorCreatePin(
      {
        metabotId: 9140,
        mnemonic: MNEMONIC,
        walletPath: WALLET_PATH,
        mvcAddress: TEST_ADDRESS,
        feeRate: 1,
        fallbackPolicy: 'strict',
        baseUrl: 'https://sponsor.test',
        fetchImpl,
      },
      {
        runDraftWorker: async () => {
          throw new Error('MetaBot balance is insufficient for this chain write.');
        },
        runBroadcastWorker,
        recordSpentOutpoints: () => {},
        replacePendingFundingUtxos: () => {},
      },
    ),
    (error) => {
      assert.ok(error instanceof TrafficInsufficientError);
      assert.equal(error.reason, 'no_user_utxo');
      return true;
    },
  );
  assert.equal(broadcastState.calls, 0);
});

test('traffic settings default to account quota and tolerate unreadable stores', () => {
  assert.equal(normalizeTrafficPinMode(undefined), 'traffic');
  assert.equal(normalizeTrafficPinMode('traffic'), 'traffic');
  assert.equal(normalizeTrafficPinMode(' Traffic '), 'traffic');
  assert.equal(normalizeTrafficPinMode('selfpay'), 'selfpay');
  assert.equal(normalizeTrafficPinMode('other'), 'traffic');
  assert.equal(normalizeTrafficFallbackPolicy(undefined), 'selfpay');
  assert.equal(normalizeTrafficFallbackPolicy('strict'), 'selfpay');

  assert.equal(getTrafficPinMode(null), 'traffic');
  assert.equal(getTrafficPinMode({ get: () => 'selfpay' }), 'selfpay');
  assert.equal(getTrafficPinMode({ get: () => { throw new Error('closed'); } }), 'traffic');
  assert.equal(getTrafficFallbackPolicy({ get: () => 'strict' }), 'selfpay');
  assert.equal(getTrafficFallbackPolicy({ get: () => undefined }), 'selfpay');
});
