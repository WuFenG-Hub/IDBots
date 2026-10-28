import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let mvcNftService;
try {
  mvcNftService = require('../dist-electron/main/services/mvcNftService.js');
} catch {
  mvcNftService = null;
}

function createStore() {
  return {
    getMetabotWalletByMetabotId(id) {
      if (id !== 1) return null;
      return {
        mnemonic: 'test mnemonic',
        path: "m/44'/10001'/0'/0/0",
      };
    },
  };
}

const SELL_TXID = 'a'.repeat(64);
const BUYER_TXID = 'b'.repeat(64);

test('normalizeMvcNftSellOrderRow maps the wallet-api PascalCase sell row', () => {
  assert.ok(mvcNftService, 'mvcNftService should be compiled');
  const row = {
    Address: '1Seller11111111111111111111111111',
    ContractAddress: '1Contract111111111111111111111111',
    TxId: SELL_TXID,
    TxIndex: 0,
    CodeHash: 'c'.repeat(40),
    Genesis: 'd'.repeat(40),
    TokenIndex: '5421',
    Price: '100000',
    Satoshi: 4101,
    IsReady: true,
    Height: 196051,
  };
  const order = mvcNftService.normalizeMvcNftSellOrderRow(row);
  assert.equal(order.address, '1Seller11111111111111111111111111');
  assert.equal(order.txId, SELL_TXID);
  assert.equal(order.outputIndex, 0);
  assert.equal(order.tokenIndex, '5421');
  assert.equal(order.priceSats, 100000);
  assert.equal(order.satoshis, 4101);
  assert.equal(order.isReady, true);
  assert.equal(order.height, 196051);
});

test('normalizeMvcNftSellOrderRow rejects rows without a valid txid', () => {
  assert.ok(mvcNftService);
  assert.equal(mvcNftService.normalizeMvcNftSellOrderRow({ TxId: 'nothex', TxIndex: 0 }), null);
  assert.equal(mvcNftService.normalizeMvcNftSellOrderRow({}), null);
});

test('normalizeMvcNftSellOrderRow parses IsReady string and number variants', () => {
  assert.ok(mvcNftService);
  const base = { TxId: BUYER_TXID, TxIndex: '1' };
  assert.equal(mvcNftService.normalizeMvcNftSellOrderRow({ ...base, IsReady: 'true' }).isReady, true);
  assert.equal(mvcNftService.normalizeMvcNftSellOrderRow({ ...base, IsReady: 1 }).isReady, true);
  assert.equal(mvcNftService.normalizeMvcNftSellOrderRow({ ...base, IsReady: 'false' }).isReady, false);
  assert.equal(mvcNftService.normalizeMvcNftSellOrderRow({ ...base }).isReady, false);
});

test('getMvcNftSellOrders filters malformed rows and reports the count', async () => {
  assert.ok(mvcNftService);
  const orders = await mvcNftService.getMvcNftSellOrders('1Addr', {
    fetchSellUtxoList: async () => [
      { TxId: SELL_TXID, TxIndex: 0, Address: '1Seller', Price: 100000, TokenIndex: 5421 },
      { TxId: 'bad', TxIndex: 1 },
    ],
  });
  assert.equal(orders.count, 1);
  assert.equal(orders.orders[0].txId, SELL_TXID);
});

function buildTradeDeps(overrides = {}) {
  const calls = { builds: [], broadcasts: [] };
  const deps = {
    buildTradeRawTx: async (_store, params) => {
      calls.builds.push(params);
      return {
        funding_raw_tx: 'FUNDING_HEX',
        funding_txid: 'fundingtxid',
        raw_tx: 'FINAL_HEX',
        txid: 'finaltxid',
        funding_spent_outpoints: ['aa'.repeat(32) + ':0'],
        spent_outpoints: ['aa'.repeat(32) + ':0', 'bb'.repeat(32) + ':1'],
      };
    },
    broadcastTx: async (rawTx) => {
      calls.broadcasts.push(rawTx);
      return 'broadcast-' + calls.broadcasts.length;
    },
    ...overrides,
  };
  return { deps, calls };
}

function sellInput(overrides = {}) {
  return {
    metabotId: 1,
    action: 'sell',
    genesis: '005d69cba8c80e6978157e146f998c21288a9d49',
    codehash: 'e205939ad9956673ce7da9fbd40514b30f66dc35',
    tokenIndex: '5421',
    priceSats: 100000,
    feeRate: 2,
    ...overrides,
  };
}

test('executeMvcNftTrade broadcasts stage 1 then stage 2 and returns both txids', async () => {
  assert.ok(mvcNftService);
  const { deps, calls } = buildTradeDeps();
  const result = await mvcNftService.executeMvcNftTrade(createStore(), sellInput(), deps);
  assert.deepEqual(calls.broadcasts, ['FUNDING_HEX', 'FINAL_HEX']);
  assert.equal(result.txId, 'finaltxid');
  assert.equal(result.fundingTxId, 'fundingtxid');
  assert.equal(result.action, 'sell');
  assert.equal(result.rawTx, 'FINAL_HEX');
});

test('executeMvcNftTrade rejects sell prices below the NftManager floor before building', async () => {
  assert.ok(mvcNftService);
  const { deps, calls } = buildTradeDeps();
  await assert.rejects(
    () => mvcNftService.executeMvcNftTrade(createStore(), sellInput({ priceSats: 21999 }), deps),
    /22000/,
  );
  assert.equal(calls.builds.length, 0, 'no worker build should happen for an invalid price');
});

test('executeMvcNftTrade rebuilds with excluded funding outpoints when stage 1 hits a stale-input broadcast', async () => {
  assert.ok(mvcNftService);
  let broadcastCount = 0;
  const { deps, calls } = buildTradeDeps({
    broadcastTx: async (rawTx) => {
      broadcastCount += 1;
      calls.broadcasts.push(rawTx);
      if (broadcastCount === 1) throw new Error('missing inputs for stale utxo');
      return 'broadcast';
    },
  });
  const result = await mvcNftService.executeMvcNftTrade(createStore(), sellInput(), deps);
  assert.equal(result.txId, 'finaltxid');
  assert.equal(calls.builds.length, 2, 'stage-1 retryable failure must rebuild the pair');
  assert.deepEqual(
    calls.builds[1].excludeOutpoints,
    ['aa'.repeat(32) + ':0'],
    'the second build must exclude the funding tx wallet inputs',
  );
  assert.deepEqual(calls.broadcasts, ['FUNDING_HEX', 'FUNDING_HEX', 'FINAL_HEX']);
});

test('executeMvcNftTrade re-broadcasts the same stage-2 hex on retryable stage-2 failures', async () => {
  assert.ok(mvcNftService);
  let broadcastCount = 0;
  const { deps, calls } = buildTradeDeps({
    broadcastTx: async (rawTx) => {
      broadcastCount += 1;
      calls.broadcasts.push(rawTx);
      if (broadcastCount === 2) throw new Error('inputs missing/spent (stage-2 not indexed yet)');
      return 'broadcast';
    },
  });
  const result = await mvcNftService.executeMvcNftTrade(createStore(), sellInput(), deps);
  assert.equal(result.txId, 'finaltxid');
  assert.equal(calls.builds.length, 1, 'stage-2 retries must NOT rebuild (stage 1 is already broadcast)');
  assert.deepEqual(
    calls.broadcasts,
    ['FUNDING_HEX', 'FINAL_HEX', 'FINAL_HEX'],
    'funding broadcasts once; the same stage-2 hex goes out again after the retryable failure',
  );
});

test('executeMvcNftTrade preserves the stage-2 hex in the error when stage 2 fails for good', async () => {
  assert.ok(mvcNftService);
  const { deps, calls } = buildTradeDeps({
    broadcastTx: async (rawTx) => {
      calls.broadcasts.push(rawTx);
      if (rawTx === 'FINAL_HEX') throw new Error('tx-already-in-chain absurd rejection');
      return 'broadcast';
    },
  });
  await assert.rejects(
    () => mvcNftService.executeMvcNftTrade(createStore(), sellInput(), deps),
    (error) => {
      const message = String(error?.message || error);
      return message.includes('fundingtxid') && message.includes('FINAL_HEX');
    },
    'the error must carry the funding txid and the preserved stage-2 hex',
  );
  assert.equal(calls.builds.length, 1);
});

test('executeMvcNftTrade validates the sellUtxo reference for buy', async () => {
  assert.ok(mvcNftService);
  const { deps, calls } = buildTradeDeps();
  await assert.rejects(
    () => mvcNftService.executeMvcNftTrade(
      createStore(),
      sellInput({ action: 'buy', priceSats: undefined, sellUtxo: { txId: 'bad', outputIndex: 0 } }),
      deps,
    ),
    /sellUtxo/,
  );
  assert.equal(calls.builds.length, 0);
});
