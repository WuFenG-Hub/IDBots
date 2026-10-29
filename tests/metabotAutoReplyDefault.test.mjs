// Store-level pins for the per-bot A2A auto-reply default: a bot created
// without the toggle has no stored value (NULL) and every layer treats that
// as ON; partial updates never imply a flip. Run `pnpm run compile:electron`
// first (mirrors chainBackupRestore.test.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { MetabotStore } = require('../dist-electron/main/metabotStore.js');
const { createMetaBotWallet } = require('../dist-electron/main/services/metabotWalletService.js');

const BOT_MNEMONICS = [
  'legal winner thank year wave sausage worth useful legal winner thank yellow',
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
];

async function openStore(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const sqliteStore = await SqliteStore.create(dir);
  const db = sqliteStore.getDatabase();
  const save = sqliteStore.getSaveFunction();
  const metabotStore = new MetabotStore(db, save);
  return { db, metabotStore, dir };
}

async function createBot(metabotStore, name, suffix, metabotType = 'worker') {
  const mnemonic = BOT_MNEMONICS[suffix % BOT_MNEMONICS.length];
  const derived = await createMetaBotWallet({
    mnemonic,
    path: `m/44'/10001'/0'/0/${suffix}`,
  });
  const wallet = metabotStore.insertMetabotWallet({ mnemonic, path: `m/44'/10001'/0'/0/${suffix}` });
  return metabotStore.createMetabot({
    wallet_id: wallet.id,
    mvc_address: derived.mvc_address,
    btc_address: derived.btc_address,
    doge_address: derived.doge_address,
    public_key: derived.public_key,
    chat_public_key: derived.chat_public_key,
    name,
    enabled: true,
    metaid: derived.metaid,
    globalmetaid: derived.globalmetaid,
    metabot_type: metabotType,
    created_by: '0000',
    role: 'tester',
    soul: 'test soul',
  });
}

const storedColumn = (db, id) => {
  const row = db.exec(`SELECT a2a_auto_reply_enabled FROM metabots WHERE id = ${id}`);
  return row[0]?.values?.[0]?.[0];
};

test('createMetabot stores no auto-reply value (NULL = default on) for every bot type', async () => {
  const { db, metabotStore, dir } = await openStore('idbots-a2a-default-');
  try {
    for (const [index, type] of ['worker', 'twin'].entries()) {
      const bot = await createBot(metabotStore, `${type}-bot`, index, type);
      assert.equal(storedColumn(db, bot.id), null, `${type} must be created with a NULL auto-reply column`);
      assert.equal(bot.metabot_type, type);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('updateMetabot preserves the stored auto-reply value unless the field is sent', async () => {
  const { db, metabotStore, dir } = await openStore('idbots-a2a-preserve-');
  try {
    const bot = await createBot(metabotStore, 'preserve-bot', 0);
    assert.equal(storedColumn(db, bot.id), null);

    // A partial update that does not mention the toggle keeps NULL (default on).
    metabotStore.updateMetabot(bot.id, { role: 'updated role' });
    assert.equal(storedColumn(db, bot.id), null);

    // A partial update on a bot stored off must not silently re-enable it…
    metabotStore.updateMetabot(bot.id, { a2a_auto_reply_enabled: false });
    assert.equal(storedColumn(db, bot.id), 0);
    metabotStore.updateMetabot(bot.id, { role: 'second update' });
    assert.equal(storedColumn(db, bot.id), 0);

    // …and only an explicit write moves it back (true or null both mean on).
    metabotStore.updateMetabot(bot.id, { a2a_auto_reply_enabled: true });
    assert.equal(storedColumn(db, bot.id), 1);
    metabotStore.updateMetabot(bot.id, { a2a_auto_reply_enabled: null });
    assert.equal(storedColumn(db, bot.id), 1);

    // The mapped row exposes boolean | null for readers.
    const mapped = metabotStore.getMetabotById(bot.id);
    assert.equal(mapped.a2a_auto_reply_enabled, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
