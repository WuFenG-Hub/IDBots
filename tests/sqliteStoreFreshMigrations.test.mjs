import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-fresh-migrations-'));

test('fresh DB: pinid-optional migrations preserve homepage/boss_global_metaid and set flags', async () => {
  const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
  const tempDir = makeTempDir();

  const store = await SqliteStore.create(tempDir);
  const db = store.getDatabase();
  const columns = db.exec('PRAGMA table_info(metabots)')[0].values.map((row) => row[1]);

  // The rebuild migrations must not drop columns that later ALTER migrations added.
  assert.equal(columns.includes('homepage'), true);
  assert.equal(columns.includes('boss_global_metaid'), true);
  assert.equal(columns.includes('metabot_info_pinid'), true);
  assert.equal(columns.includes('chat_public_key_pin_id'), true);

  // On success both migrations record their KV flags; previously the missing
  // homepage column made INSERT ... SELECT fail so flags were never set and the
  // failing migration retried (and warned) on every launch.
  assert.equal(store.get('metabot_info_pinid_optional_migrated'), true);
  assert.equal(store.get('chat_public_key_pin_id_optional_migrated'), true);
  store.close();

  // Reopen: flags make migrations skip, schema stays intact.
  const reopened = await SqliteStore.create(tempDir);
  const recols = reopened.getDatabase().exec('PRAGMA table_info(metabots)')[0].values.map((row) => row[1]);
  assert.equal(recols.includes('homepage'), true);
  assert.equal(recols.includes('boss_global_metaid'), true);
  reopened.close();
});

test('rebuild migrations keep rows and homepage values intact', async () => {
  const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
  const tempDir = makeTempDir();
  const store = await SqliteStore.create(tempDir);
  const db = store.getDatabase();

  db.run(
    `INSERT INTO metabot_wallets (id, mnemonic, path, created_at) VALUES (?, ?, ?, ?)`,
    [1, 'abandon ability able about above absent absorb abstract absurd abuse access accident', "m/44'/10001'/0'/0/0", 1700000000000]
  );
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
      name, enabled, metaid, metabot_type, created_by, role, soul, homepage, boss_global_metaid,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [1, 1, 'mvc-1', 'btc-1', 'doge-1', 'pub-1', 'chat-1', 'Bot One', 1, 'metaid-1', 'worker', '0000', 'r', 's', '{"uri":"metaapp://x"}', 'id1owner', 1700000000000, 1700000000000]
  );

  // Force the rebuild migrations to run again against a populated table.
  store.set('metabot_info_pinid_optional_migrated', false);
  store.set('chat_public_key_pin_id_optional_migrated', false);
  store.close();

  const reopened = await SqliteStore.create(tempDir);
  const rows = reopened.getDatabase().exec('SELECT name, homepage, boss_global_metaid FROM metabots WHERE id = 1')[0].values;
  assert.deepEqual(rows, [['Bot One', '{"uri":"metaapp://x"}', 'id1owner']]);
  assert.equal(reopened.get('metabot_info_pinid_optional_migrated'), true);
  assert.equal(reopened.get('chat_public_key_pin_id_optional_migrated'), true);
  reopened.close();
});
