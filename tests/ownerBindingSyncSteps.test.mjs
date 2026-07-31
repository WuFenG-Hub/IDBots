import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  buildFullMetabotInfoSyncPlan,
  buildEditMetabotInfoSyncPlan,
  syncMetaBotToChain,
  syncMetaBotEditChangesToChain,
} = await import('../dist-electron/main/services/metaidCore.js');

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SIGNED_PAYLOAD = JSON.stringify({ version: 1, owner: 'idq1owner', ownerPublicKey: '02aa', signedMessage: 'metabot-owner-binding:idq1bot', signature: 'c2ln', algorithm: 'ecdsa-secp256k1-bitcoin-message' });

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-owner-sync-'));

const makeMetabot = async () => {
  const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
  const { MetabotStore } = require('../dist-electron/main/metabotStore.js');
  const store = await SqliteStore.create(makeTempDir());
  const metabotStore = new MetabotStore(store.getDatabase(), () => store.save());
  const wallet = metabotStore.insertMetabotWallet({ mnemonic: TEST_MNEMONIC, path: "m/44'/10001'/0'/0/0" });
  const metabot = metabotStore.createMetabot({
    wallet_id: wallet.id,
    mvc_address: 'mvc-1',
    btc_address: 'btc-1',
    doge_address: 'doge-1',
    public_key: 'pub-1',
    chat_public_key: 'chat-1',
    name: 'Bound Bot',
    enabled: true,
    metaid: 'metaid-1',
    globalmetaid: 'idq1bot',
    metabot_type: 'worker',
    created_by: '0000',
    role: 'r',
    soul: 's',
    boss_global_metaid: 'idq1owner',
  });
  return { store, metabotStore, metabot };
};

const makeCreatePinMock = () => {
  const calls = [];
  let n = 0;
  const fn = async (_store, _id, metaidData) => {
    n += 1;
    calls.push(metaidData);
    return { txids: [`tx-${n}`], pinId: `pin-${n}`, totalCost: 100 };
  };
  return { fn, calls };
};

const baseMetabot = {
  name: 'Bound Bot',
  avatar: '',
  chat_public_key: 'chat-1',
  chat_public_key_pin_id: 'already-pinned',
  role: 'r',
  soul: 's',
  homepage: null,
};

test('full sync plan appends the owner step only when a payload is provided', () => {
  const without = buildFullMetabotInfoSyncPlan(baseMetabot);
  assert.equal(without.some((s) => s.key === 'owner'), false);

  const withOwner = buildFullMetabotInfoSyncPlan(baseMetabot, { ownerBindingPayload: SIGNED_PAYLOAD });
  const ownerStep = withOwner.find((s) => s.key === 'owner');
  assert.ok(ownerStep);
  assert.equal(ownerStep.path, '/info/owner');
  assert.equal(ownerStep.contentType, 'application/json');
  assert.equal(ownerStep.payload, SIGNED_PAYLOAD);
  // Owner step comes after homepage (trailing).
  assert.equal(withOwner[withOwner.length - 1].key, 'owner');
});

test('edit sync plan supports bind and unbind owner steps', () => {
  const bind = buildEditMetabotInfoSyncPlan({ metabotId: 1, metabot: baseMetabot, syncOwner: true, ownerBindingPayload: SIGNED_PAYLOAD });
  assert.deepEqual(bind.map((s) => s.key), ['owner']);
  assert.equal(bind[0].payload, SIGNED_PAYLOAD);

  const unbind = buildEditMetabotInfoSyncPlan({ metabotId: 1, metabot: baseMetabot, syncOwner: true, ownerBindingPayload: null });
  assert.deepEqual(unbind.map((s) => s.key), ['owner']);
  assert.equal(unbind[0].payload, '');

  const noOwner = buildEditMetabotInfoSyncPlan({ metabotId: 1, metabot: baseMetabot, syncName: true });
  assert.equal(noOwner.some((s) => s.key === 'owner'), false);
});

test('syncMetaBotToChain publishes and persists the owner binding pin id', async () => {
  const { store, metabotStore, metabot } = await makeMetabot();
  const pinMock = makeCreatePinMock();

  const result = await syncMetaBotToChain(metabotStore, metabot.id, { createPin: pinMock.fn, sleep: async () => {} }, { ownerBindingPayload: SIGNED_PAYLOAD });

  assert.equal(result.success, true);
  const ownerCall = pinMock.calls.find((c) => c.path === '/info/owner');
  assert.ok(ownerCall);
  assert.equal(ownerCall.payload, SIGNED_PAYLOAD);

  const ownerPinIndex = pinMock.calls.findIndex((c) => c.path === '/info/owner');
  const updated = metabotStore.getMetabotById(metabot.id);
  assert.equal(updated.owner_binding_pinid, `pin-${ownerPinIndex + 1}`);
  store.close();
});

test('edit sync persists owner pin id on bind and clears it on unbind', async () => {
  const { store, metabotStore, metabot } = await makeMetabot();

  const bindMock = makeCreatePinMock();
  const bindResult = await syncMetaBotEditChangesToChain(
    metabotStore,
    { metabotId: metabot.id, syncOwner: true, ownerBindingPayload: SIGNED_PAYLOAD },
    { createPin: bindMock.fn, sleep: async () => {} },
  );
  assert.equal(bindResult.success, true);
  assert.deepEqual(bindResult.syncedSteps, ['owner']);
  assert.equal(metabotStore.getMetabotById(metabot.id).owner_binding_pinid, 'pin-1');

  const unbindMock = makeCreatePinMock();
  const unbindResult = await syncMetaBotEditChangesToChain(
    metabotStore,
    { metabotId: metabot.id, syncOwner: true, ownerBindingPayload: '' },
    { createPin: unbindMock.fn, sleep: async () => {} },
  );
  assert.equal(unbindResult.success, true);
  assert.equal(unbindMock.calls[0].payload, '');
  assert.equal(metabotStore.getMetabotById(metabot.id).owner_binding_pinid, null);
  store.close();
});
