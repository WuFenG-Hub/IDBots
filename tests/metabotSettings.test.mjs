import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { MetabotStore } = require('../dist-electron/main/metabotStore.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-metabot-settings-test-'));
}

async function openStores(tempDir) {
  const store = await SqliteStore.create(tempDir);
  const metabotStore = new MetabotStore(store.getDatabase(), store.getSaveFunction());
  return { store, metabotStore, db: store.getDatabase() };
}

test('getMetabotSetting defaults to null and setMetabotSetting persists per metabot', async () => {
  const tempDir = makeTempDir();
  const { store, metabotStore, db } = await openStores(tempDir);
  try {
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

    assert.equal(metabotStore.getMetabotSetting(1, 'chain.defaultWriteNetwork'), null);
    assert.equal(
      metabotStore.setMetabotSetting(1, 'chain.defaultWriteNetwork', 'opcat'),
      'opcat',
    );
    assert.equal(metabotStore.getMetabotSetting(1, 'chain.defaultWriteNetwork'), 'opcat');
    assert.equal(metabotStore.getMetabotSetting(1, 'chain.mvcSponsorUploadEnabled'), null);

    metabotStore.setMetabotSetting(1, 'chain.mvcSponsorUploadEnabled', 'false');
    assert.equal(metabotStore.getMetabotSetting(1, 'chain.mvcSponsorUploadEnabled'), 'false');

    assert.throws(() => metabotStore.getMetabotSetting(0, 'chain.defaultWriteNetwork'), /positive integer/);
    assert.throws(() => metabotStore.getMetabotSetting(1, ''), /key is required/);
  } finally {
    store.close();
  }
});
