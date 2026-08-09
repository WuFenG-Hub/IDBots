import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { MetabotStore } = require('../dist-electron/main/metabotStore.js');
const {
  RENDERER_METABOT_SETTING_KEYS,
  getRendererMetabotSetting,
  setRendererMetabotSetting,
} = require('../dist-electron/main/services/metabotSettingsService.js');
const {
  OPENTEAM_ALLOW_REMOTE_COLLAB_KEY,
} = require('../dist-electron/main/services/openTeamGuestService.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-metabot-settings-service-test-'));
}

async function openStores(tempDir) {
  const store = await SqliteStore.create(tempDir);
  const metabotStore = new MetabotStore(store.getDatabase(), store.getSaveFunction());
  return { store, metabotStore, db: store.getDatabase() };
}

function seedMetabot(db) {
  db.run(
    `INSERT INTO metabot_wallets (id, mnemonic, path, created_at)
     VALUES (?, ?, ?, ?)`,
    [1, 'abandon ability able about above absent absorb abstract absurd abuse access accident 1', "m/44'/10001'/0'/0/0", Date.now()],
  );
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
      name, enabled, metaid, metabot_type, created_by, role, soul,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      1, 1, 'mvc-1', 'btc-1', 'doge-1', 'public-1', 'chat-public-1',
      'test-bot', 1, 'metaid-1', 'worker', '0000', 'role', 'soul',
      Date.now(), Date.now(),
    ],
  );
}

test('whitelist exposes exactly the OpenTeam remote-collab key', () => {
  assert.deepEqual(RENDERER_METABOT_SETTING_KEYS, ['openteam.allowRemoteCollab']);
  assert.equal(RENDERER_METABOT_SETTING_KEYS[0], OPENTEAM_ALLOW_REMOTE_COLLAB_KEY);
});

test('renderer setting bridge rejects keys outside the whitelist', async () => {
  const tempDir = makeTempDir();
  const { store, metabotStore, db } = await openStores(tempDir);
  try {
    seedMetabot(db);
    assert.throws(
      () => getRendererMetabotSetting(metabotStore, 1, 'chain.defaultWriteNetwork'),
      /not allowed/,
    );
    assert.throws(
      () => setRendererMetabotSetting(metabotStore, 1, 'chain.defaultWriteNetwork', 'opcat'),
      /not allowed/,
    );
    assert.throws(() => getRendererMetabotSetting(metabotStore, 1, ''), /not allowed/);
    assert.throws(() => getRendererMetabotSetting(metabotStore, 1, undefined), /not allowed/);
    // Rejected writes must not leak into the kv store.
    assert.equal(metabotStore.getMetabotSetting(1, 'chain.defaultWriteNetwork'), null);
  } finally {
    store.close();
  }
});

test('OpenTeam remote-collab toggle round-trips with guestService semantics', async () => {
  const tempDir = makeTempDir();
  const { store, metabotStore, db } = await openStores(tempDir);
  try {
    seedMetabot(db);
    // No record = allowed (on); the renderer maps null -> true.
    assert.equal(getRendererMetabotSetting(metabotStore, 1, OPENTEAM_ALLOW_REMOTE_COLLAB_KEY), null);

    // Accepted input shapes normalize to '1'/'0' ('0' is the guestService "off" marker).
    assert.equal(setRendererMetabotSetting(metabotStore, 1, OPENTEAM_ALLOW_REMOTE_COLLAB_KEY, true), '1');
    assert.equal(getRendererMetabotSetting(metabotStore, 1, OPENTEAM_ALLOW_REMOTE_COLLAB_KEY), '1');
    assert.equal(setRendererMetabotSetting(metabotStore, 1, OPENTEAM_ALLOW_REMOTE_COLLAB_KEY, '0'), '0');
    assert.equal(getRendererMetabotSetting(metabotStore, 1, OPENTEAM_ALLOW_REMOTE_COLLAB_KEY), '0');
    assert.equal(setRendererMetabotSetting(metabotStore, 1, OPENTEAM_ALLOW_REMOTE_COLLAB_KEY, false), '0');
    assert.equal(setRendererMetabotSetting(metabotStore, 1, OPENTEAM_ALLOW_REMOTE_COLLAB_KEY, '1'), '1');
    assert.equal(getRendererMetabotSetting(metabotStore, 1, OPENTEAM_ALLOW_REMOTE_COLLAB_KEY), '1');

    // Invalid values are rejected and leave the previous value untouched.
    assert.throws(
      () => setRendererMetabotSetting(metabotStore, 1, OPENTEAM_ALLOW_REMOTE_COLLAB_KEY, 'yes'),
      /Invalid value/,
    );
    assert.throws(
      () => setRendererMetabotSetting(metabotStore, 1, OPENTEAM_ALLOW_REMOTE_COLLAB_KEY, null),
      /Invalid value/,
    );
    assert.equal(getRendererMetabotSetting(metabotStore, 1, OPENTEAM_ALLOW_REMOTE_COLLAB_KEY), '1');

    // Store-level validation still applies through the bridge.
    assert.throws(
      () => getRendererMetabotSetting(metabotStore, 0, OPENTEAM_ALLOW_REMOTE_COLLAB_KEY),
      /positive integer/,
    );
  } finally {
    store.close();
  }
});
