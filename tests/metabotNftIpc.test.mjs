import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let nftIpc;
try {
  nftIpc = require('../dist-electron/main/services/metabotNftIpc.js');
} catch {
  nftIpc = null;
}

test('registerMetabotNftIpcHandlers exposes the NFT list and transfer handlers', async () => {
  assert.equal(
    typeof nftIpc?.registerMetabotNftIpcHandlers,
    'function',
    'registerMetabotNftIpcHandlers() should be exported',
  );

  const handlers = {};

  nftIpc.registerMetabotNftIpcHandlers({
    registerIpcHandler(name, fn) {
      handlers[name] = fn;
    },
    getMetabotStore: () => ({ fake: true }),
    getMetabotNftItems: async (_store, input) => [
      { kind: input.kind, key: 'k1', name: 'One', collectionName: 'Series', raw: {} },
    ],
    transferMetabotMvcNft: async (_store, input) => ({ txId: 'mvc-nft-txid', rawTx: 'raw' }),
    transferMetabotMrc721: async (_store, input) => ({
      txId: 'mrc721-txid',
      pinId: input.pinId,
      toAddress: input.toAddress,
      spentOutpoint: 'outpoint',
      outputValue: 1000,
    }),
  });

  assert.equal(typeof handlers['idbots:getMetabotNfts'], 'function');
  assert.equal(typeof handlers['idbots:transferMetabotMvcNft'], 'function');
  assert.equal(typeof handlers['idbots:transferMetabotMrc721'], 'function');

  const items = await handlers['idbots:getMetabotNfts']({}, { metabotId: 7, kind: 'mrc721' });
  assert.deepEqual(items, {
    success: true,
    items: [{ kind: 'mrc721', key: 'k1', name: 'One', collectionName: 'Series', raw: {} }],
  });

  const badKind = await handlers['idbots:getMetabotNfts']({}, { metabotId: 7, kind: 'nope' });
  assert.deepEqual(badKind, { success: false, error: "kind must be 'mrc721' or 'metacontract'" });

  const badId = await handlers['idbots:getMetabotNfts']({}, { metabotId: 0, kind: 'mrc721' });
  assert.equal(badId.success, false);
  assert.match(badId.error, /metabotId/);

  const mvcTransfer = await handlers['idbots:transferMetabotMvcNft']({}, {
    metabotId: 7,
    genesis: 'gen',
    codehash: 'hash',
    tokenIndex: '3',
    toAddress: 'mvc-dest',
    feeRate: 1,
  });
  assert.deepEqual(mvcTransfer, { success: true, result: { txId: 'mvc-nft-txid', rawTx: 'raw' } });

  const mrc721Transfer = await handlers['idbots:transferMetabotMrc721']({}, {
    metabotId: 7,
    pinId: 'pin…i0',
    toAddress: 'mvc-dest',
    feeRate: 1,
  });
  assert.deepEqual(mrc721Transfer, {
    success: true,
    result: { txId: 'mrc721-txid', pinId: 'pin…i0', toAddress: 'mvc-dest', spentOutpoint: 'outpoint', outputValue: 1000 },
  });
});

test('registerMetabotNftIpcHandlers surfaces NFT errors as failure payloads', async () => {
  const handlers = {};

  nftIpc.registerMetabotNftIpcHandlers({
    registerIpcHandler(name, fn) {
      handlers[name] = fn;
    },
    getMetabotStore: () => ({ fake: true }),
    getMetabotNftItems: async () => {
      throw new Error('nft boom');
    },
    transferMetabotMvcNft: async () => {
      throw new Error('mvc transfer boom');
    },
    transferMetabotMrc721: async () => {
      throw new Error('mrc721 transfer boom');
    },
  });

  await assert.doesNotReject(async () => {
    const items = await handlers['idbots:getMetabotNfts']({}, { metabotId: 1, kind: 'mrc721' });
    const mvcTransfer = await handlers['idbots:transferMetabotMvcNft']({}, { metabotId: 1 });
    const mrc721Transfer = await handlers['idbots:transferMetabotMrc721']({}, { metabotId: 1 });

    assert.deepEqual(items, { success: false, error: 'nft boom' });
    assert.deepEqual(mvcTransfer, { success: false, error: 'mvc transfer boom' });
    assert.deepEqual(mrc721Transfer, { success: false, error: 'mrc721 transfer boom' });
  });
});

// ---------------------------------------------------------------------------
// metabot:setNftAvatar — "use this NFT as the avatar"
// ---------------------------------------------------------------------------

function registerAvatarHarness(overrides = {}) {
  const handlers = {};
  const calls = { updates: [] };
  nftIpc.registerMetabotNftIpcHandlers({
    registerIpcHandler(name, fn) {
      handlers[name] = fn;
    },
    getMetabotStore: () => ({ fake: true }),
    getMetabotNftItems: async () => [],
    transferMetabotMvcNft: async () => ({ txId: 'tx', rawTx: 'raw' }),
    transferMetabotMrc721: async () => ({
      txId: 'tx', pinId: 'pin', toAddress: 'addr', spentOutpoint: 'out', outputValue: 1,
    }),
    normalizeAvatar: async (source) => ({
      ok: true,
      dataUrl: `data:image/jpeg;base64,${Buffer.from(`snapshot:${source}`).toString('base64')}`,
      mime: 'image/jpeg',
      bytes: 13_250,
      source: 'metafile',
    }),
    updateMetabotAvatar: async (metabotId, input) => {
      calls.updates.push({ metabotId, input });
      return { success: true, metabot: { id: metabotId, name: 'Bot', avatar: input.avatar }, sync: { skipped: false, success: true } };
    },
    ...overrides,
  });
  return { handlers, calls };
}

test('metabot:setNftAvatar normalizes the NFT reference and reuses the metabot-update path', async () => {
  const { handlers, calls } = registerAvatarHarness();
  assert.equal(typeof handlers['metabot:setNftAvatar'], 'function');

  const pinId = '14158a127fa1d7b66d821413abad64bc833cf145e7abd2b40838fde703609b45i0';
  const result = await handlers['metabot:setNftAvatar']({}, { metabotId: 7, imageRef: `metafile://${pinId}.jpg` });

  assert.equal(result.success, true);
  assert.deepEqual(result.avatar, { mime: 'image/jpeg', bytes: 13_250, source: 'metafile' });
  assert.equal(result.metabot.id, 7);
  assert.equal(calls.updates.length, 1, 'exactly one metabot update is attempted');
  assert.equal(calls.updates[0].metabotId, 7);
  assert.match(calls.updates[0].input.avatar, /^data:image\/jpeg;base64,/, 'the stored avatar is a data-URL snapshot');
  assert.equal(result.sync.success, true);
});

test('metabot:setNftAvatar returns the structured normalize failure and never touches the bot', async () => {
  const { handlers, calls } = registerAvatarHarness({
    normalizeAvatar: async () => ({
      ok: false,
      reason: 'too-large',
      detail: 'Avatar is 877125 bytes, over the 204800 byte avatar cap.',
    }),
  });

  const result = await handlers['metabot:setNftAvatar']({}, {
    metabotId: 7,
    imageRef: 'metafile://14158a127fa1d7b66d821413abad64bc833cf145e7abd2b40838fde703609b45i0.jpg',
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, 'too-large');
  assert.match(result.error, /too-large: Avatar is 877125 bytes/);
  assert.equal(calls.updates.length, 0, 'a failed normalization must not mutate the bot');
});

test('metabot:setNftAvatar surfaces update failures and rejects bad input without throwing', async () => {
  const { handlers } = registerAvatarHarness({
    updateMetabotAvatar: async () => ({ success: false, error: 'chain publish refused' }),
  });

  const failed = await handlers['metabot:setNftAvatar']({}, { metabotId: 7, imageRef: 'https://example.com/art.png' });
  assert.deepEqual(
    { success: failed.success, reason: failed.reason, error: failed.error },
    { success: false, reason: 'update-failed', error: 'chain publish refused' },
  );

  const empty = await handlers['metabot:setNftAvatar']({}, { metabotId: 7, imageRef: '   ' });
  assert.equal(empty.success, false);
  assert.equal(empty.reason, 'empty');

  const badId = await handlers['metabot:setNftAvatar']({}, { metabotId: 0, imageRef: 'metafile://x' });
  assert.equal(badId.success, false);
  assert.match(badId.error, /metabotId/);

  const throwing = registerAvatarHarness({
    normalizeAvatar: async () => {
      throw new Error('normalizer exploded');
    },
  });
  const crashed = await throwing.handlers['metabot:setNftAvatar']({}, { metabotId: 7, imageRef: 'x' });
  assert.deepEqual(crashed, { success: false, error: 'normalizer exploded' });
});
