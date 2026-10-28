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

test('normalizeMvcNftSellOrderRow maps the live wallet-api sell row (mainnet 2026-10-28 shape)', () => {
  assert.ok(mvcNftService, 'mvcNftService should be compiled');
  // Verbatim shape captured from
  // /wallet-api/v4/mvc/address/contract/nft/sell/utxo-list during the S2
  // live-fire listing of #5421: camelCase keys, no outputIndex, no price.
  const row = {
    address: '1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx',
    txId: SELL_TXID,
    codeHash: 'e205939ad9956673ce7da9fbd40514b30f66dc35',
    genesis: '005d69cba8c80e6978157e146f998c21288a9d49',
    tokenIndex: 5421,
    satoshi: 2032,
    satoshiString: '2032',
    height: -1,
    sensibleId: '4e7a7d3e3e748c09f1eff46fe504c5fdc389014eab3e316685004d770225ea5300000000',
    metaTxId: '75deacd324703979a5024dea3549666cc6146a022cccc1c103f21a031aacd78f',
    tokenSupply: 9560,
    flag: '0',
    name: 'MetaBot Avatar - Legs 8',
    icon: 'metafile://00d03bb3ae744bc1a8a233ab7bec728e5552efedc25eecbbbd4e284741b7172f.png',
    seriesName: 'MetaBot Avatar',
  };
  const order = mvcNftService.normalizeMvcNftSellOrderRow(row);
  assert.equal(order.address, '1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx');
  assert.equal(order.txId, SELL_TXID);
  // No txIndex on the wire: the NftManager places the sell-contract output at
  // vout 0, cross-checked against open-api-mvc txIndex during the drill.
  assert.equal(order.outputIndex, 0);
  assert.equal(order.tokenIndex, '5421');
  assert.equal(order.satoshis, 2032);
  assert.equal(order.priceSats, undefined, 'ask price is not exposed by this endpoint');
  assert.equal(order.isReady, undefined, 'IsReady is absent on this endpoint');
  assert.equal(order.height, undefined, 'unconfirmed rows must not report height 0');
  assert.equal(order.name, 'MetaBot Avatar - Legs 8');
  assert.equal(order.seriesName, 'MetaBot Avatar');
});

test('normalizeMvcNftSellOrderRow rejects rows without a valid txid', () => {
  assert.ok(mvcNftService);
  assert.equal(mvcNftService.normalizeMvcNftSellOrderRow({ txId: 'nothex', txIndex: 0 }), null);
  assert.equal(mvcNftService.normalizeMvcNftSellOrderRow({}), null);
});

test('normalizeMvcNftSellOrderRow accepts explicit txIndex and IsReady variants', () => {
  assert.ok(mvcNftService);
  const base = { txId: BUYER_TXID, txIndex: '1' };
  assert.equal(mvcNftService.normalizeMvcNftSellOrderRow(base).outputIndex, 1);
  assert.equal(mvcNftService.normalizeMvcNftSellOrderRow({ ...base, IsReady: 'true' }).isReady, true);
  assert.equal(mvcNftService.normalizeMvcNftSellOrderRow({ ...base, IsReady: 1 }).isReady, true);
  assert.equal(mvcNftService.normalizeMvcNftSellOrderRow({ ...base, IsReady: 'false' }).isReady, false);
  const confirmed = mvcNftService.normalizeMvcNftSellOrderRow({ ...base, height: 196051, Price: '100000' });
  assert.equal(confirmed.height, 196051);
  assert.equal(confirmed.priceSats, 100000, 'Price is honored when a richer row carries it');
});

test('getMvcNftSellOrders filters malformed rows and reports the count', async () => {
  assert.ok(mvcNftService);
  const orders = await mvcNftService.getMvcNftSellOrders('1Addr', {
    fetchSellUtxoList: async () => [
      { txId: SELL_TXID, address: '1Seller', tokenIndex: 5421, satoshi: 2032 },
      { txId: 'bad', txIndex: 1 },
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
