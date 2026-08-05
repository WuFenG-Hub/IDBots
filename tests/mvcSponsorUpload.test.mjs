import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const {
  buildMvcFileInscriptionDraft,
  createMvcSponsorV2Client,
  uploadMvcSponsorDirectFile,
} = await import('../dist-electron/main/services/mvcSponsorUpload.js');

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const WALLET_PATH = "m/44'/10001'/0'/0/0";
const TEST_TXID = '11'.repeat(32);
const COMMIT_TXID = 'aa'.repeat(32);

async function makeTestFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idbots-sponsor-test-'));
  const filePath = path.join(dir, 'sponsor-test.bin');
  await fs.writeFile(filePath, 'test-file-bytes');
  return { dir, filePath };
}

function envelope(data) {
  return JSON.stringify({ code: 0, data });
}

function createFetchStub(routes) {
  return async (url, init = {}) => {
    const text = String(url);
    for (const [suffix, responder] of routes) {
      if (text.includes(suffix)) {
        const body = typeof responder === 'function' ? responder(init) : responder;
        const raw = typeof body === 'string'
          ? body
          : body && typeof body === 'object' && 'code' in body
            ? JSON.stringify(body)
            : envelope(body);
        return {
          ok: true,
          status: 200,
          json: async () => JSON.parse(raw),
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({ code: 404, msg: 'not found' }) };
  };
}

async function buildTestDraft(mvcAddress) {
  const draft = await buildMvcFileInscriptionDraft({
    mnemonic: MNEMONIC,
    walletPath: WALLET_PATH,
    mvcAddress,
    request: {
      operation: 'create',
      path: '/file',
      encryption: '0',
      version: '1.0',
      contentType: 'image/png;binary',
      payload: Buffer.from('test-file-bytes'),
    },
    utxos: [
      { txId: TEST_TXID, outputIndex: 0, satoshis: 50000, address: mvcAddress, height: 1 },
    ],
    feeRate: 1,
    deductMinerFeeFromChange: false,
  });
  return draft;
}

test('uploadMvcSponsorDirectFile succeeds through the sponsor flow and marks feeAssist used', async () => {
  const { filePath } = await makeTestFile();
  let selfPaidCalls = 0;
  const mvcAddress = '1K9eUW4vED3qfWmr4Fcre64sU7D38QM1tX';
  const draft = await buildTestDraft(mvcAddress);

  const fetchImpl = createFetchStub([
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
    ['/v2/assist/gas/mvc/pre', {
      preparedTxHex: draft.unsignedTxHex,
      orderId: 'order-1',
      minerFee: 100,
      userInputIndexes: [0],
    }],
    ['/v2/assist/gas/mvc/commit', { txId: COMMIT_TXID, minerFee: 100, txSize: 300 }],
  ]);

  const result = await uploadMvcSponsorDirectFile({
    filePath,
    fileName: 'sponsor-test.bin',
    contentType: 'application/octet-stream;binary',
    bytes: 16,
    extension: '.bin',
    mnemonic: MNEMONIC,
    walletPath: WALLET_PATH,
    mvcAddress,
    globalMetaId: 'gmid-sponsor',
    selfPaidUpload: async () => {
      selfPaidCalls += 1;
      return { success: true, pinId: 'selfpaid-i0' };
    },
    fetchImpl,
    fetchUtxos: async () => [
      { txId: TEST_TXID, outputIndex: 0, satoshis: 50000, address: mvcAddress, height: 1 },
    ],
  });

  assert.equal(selfPaidCalls, 0);
  assert.equal(result.pinId, `${COMMIT_TXID}i0`);
  assert.deepEqual(result.txids, [COMMIT_TXID]);
  assert.equal(result.network, 'mvc');
  assert.equal(result.feeAssist.used, true);
  assert.equal(result.feeAssist.mode, 'mvc_sponsor_v2');
  assert.equal(result.feeAssist.stage, 'done');
  assert.equal(result.feeAssist.orderId, 'order-1');
  assert.equal(result.feeAssist.sponsoredMinerFee, 100);
  assert.equal(result.feeAssist.savedFee, 100);
  assert.equal(result.feeAssist.quotaBefore.availableAmount, 5000);
});

test('uploadMvcSponsorDirectFile falls back to self-paid when sponsor service is unavailable', async () => {
  const fetchImpl = createFetchStub([
    ['/v2/assist/gas/address/info', () => ({ code: 1, msg: 'service down' })],
  ]);
  const { filePath } = await makeTestFile();
  let selfPaidFeeAssist = null;
  const result = await uploadMvcSponsorDirectFile({
    filePath,
    fileName: 'sponsor-test.bin',
    contentType: 'application/octet-stream;binary',
    bytes: 16,
    extension: '.bin',
    mnemonic: MNEMONIC,
    walletPath: WALLET_PATH,
    mvcAddress: '1K9eUW4vED3qfWmr4Fcre64sU7D38QM1tX',
    selfPaidUpload: async (feeAssist) => {
      selfPaidFeeAssist = feeAssist;
      return { success: true, pinId: 'selfpaid-i0' };
    },
    fetchImpl,
    fetchUtxos: async () => [],
  });

  assert.equal(result.pinId, 'selfpaid-i0');
  assert.ok(selfPaidFeeAssist);
  assert.equal(selfPaidFeeAssist.attempted, true);
  assert.equal(selfPaidFeeAssist.used, false);
  assert.equal(selfPaidFeeAssist.mode, 'self_paid');
  assert.equal(selfPaidFeeAssist.reason, 'service_unavailable');
  assert.equal(selfPaidFeeAssist.stage, 'address_info');
});

test('uploadMvcSponsorDirectFile hard-fails with insufficient_quota when the sponsor pre rejects quota', async () => {
  const mvcAddress = '1K9eUW4vED3qfWmr4Fcre64sU7D38QM1tX';
  const draft = await buildTestDraft(mvcAddress);
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
    ['/v2/assist/gas/mvc/challenge', { challengeId: 'challenge-1', message: 'sign this message' }],
    ['/v2/assist/gas/mvc/pre', () => ({ code: 1, msg: 'available amount not enough' })],
  ]);
  const { filePath } = await makeTestFile();

  await assert.rejects(
    uploadMvcSponsorDirectFile({
      filePath,
      fileName: 'sponsor-test.bin',
      contentType: 'application/octet-stream;binary',
      bytes: 16,
      extension: '.bin',
      mnemonic: MNEMONIC,
      walletPath: WALLET_PATH,
      mvcAddress,
      selfPaidUpload: async () => ({ success: true, pinId: 'selfpaid-i0' }),
      fetchImpl,
      fetchUtxos: async () => [
        { txId: TEST_TXID, outputIndex: 0, satoshis: 50000, address: mvcAddress, height: 1 },
      ],
    }),
    (error) => {
      assert.equal(error.code, 'mvc_fee_assist_pre_failed');
      assert.equal(error.data.feeAssist.used, false);
      assert.equal(error.data.feeAssist.reason, 'insufficient_quota');
      assert.equal(error.data.feeAssist.stage, 'pre');
      return true;
    },
  );
});

test('uploadMvcSponsorDirectFile hard-fails with feeAssist diagnostics on commit failure', async () => {
  const mvcAddress = '1K9eUW4vED3qfWmr4Fcre64sU7D38QM1tX';
  const draft = await buildTestDraft(mvcAddress);
  const fetchImpl = createFetchStub([
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
    ['/v2/assist/gas/mvc/pre', {
      preparedTxHex: draft.unsignedTxHex,
      orderId: 'order-1',
      minerFee: 100,
      userInputIndexes: [0],
    }],
    ['/v2/assist/gas/mvc/commit', () => ({ code: 1, msg: 'commit rejected' })],
    ['/v2/assist/gas/mvc/order/', () => ({ code: 1, msg: 'order unavailable' })],
  ]);
  const { filePath } = await makeTestFile();

  await assert.rejects(
    uploadMvcSponsorDirectFile({
      filePath,
      fileName: 'sponsor-test.bin',
      contentType: 'application/octet-stream;binary',
      bytes: 16,
      extension: '.bin',
      mnemonic: MNEMONIC,
      walletPath: WALLET_PATH,
      mvcAddress,
      selfPaidUpload: async () => ({ success: true, pinId: 'selfpaid-i0' }),
      fetchImpl,
      fetchUtxos: async () => [
        { txId: TEST_TXID, outputIndex: 0, satoshis: 50000, address: mvcAddress, height: 1 },
      ],
    }),
    (error) => {
      assert.equal(error.code, 'mvc_fee_assist_commit_failed');
      assert.equal(error.data.feeAssist.used, false);
      assert.equal(error.data.feeAssist.reason, 'commit_failed');
      assert.equal(error.data.feeAssist.stage, 'commit');
      assert.equal(error.data.feeAssist.orderId, 'order-1');
      return true;
    },
  );
});

test('createMvcSponsorV2Client unwraps the code-0 envelope and normalizes fields', async () => {
  const client = createMvcSponsorV2Client({
    baseUrl: 'https://sponsor.test',
    fetchImpl: createFetchStub([
      ['/v2/assist/gas/address/info', {
        exists: true,
        balance: 10,
        grantedAmount: 20,
        reservedAmount: 5,
        spentAmount: 5,
        availableAmount: 10,
        status: 'active',
      }],
    ]),
  });
  const info = await client.getAddressInfo({ address: '1K9eUW4vED3qfWmr4Fcre64sU7D38QM1tX' });
  assert.equal(info.exists, true);
  assert.equal(info.availableAmount, 10);
  assert.equal(info.status, 'active');
});
