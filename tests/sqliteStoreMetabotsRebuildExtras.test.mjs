import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-rebuild-extras-'));

test('buildMetabotsRebuildExtrasDdl carries unknown columns with type/nullability/default', async () => {
  const { buildMetabotsRebuildExtrasDdl } = require('../dist-electron/main/sqliteStore.js');

  // Base columns are skipped (they are written explicitly by the rebuild DDL).
  assert.equal(buildMetabotsRebuildExtrasDdl([[0, 'id', 'INTEGER', 1, null, 1]]), '');
  assert.equal(buildMetabotsRebuildExtrasDdl([[26, 'updated_at', 'INTEGER', 1, null, 0]]), '');
  assert.equal(buildMetabotsRebuildExtrasDdl([]), '');

  // Unknown columns are appended verbatim: quoted name, declared type,
  // NOT NULL and DEFAULT preserved from PRAGMA table_info.
  assert.equal(
    buildMetabotsRebuildExtrasDdl([
      [27, 'heartbeat_enabled', 'INTEGER', 0, null, 0],
      [28, 'llm_provider', 'TEXT', 0, null, 0],
      [29, 'tools_extra', 'TEXT', 1, "'[]'", 0],
    ]),
    ', "heartbeat_enabled" INTEGER, "llm_provider" TEXT, "tools_extra" TEXT NOT NULL DEFAULT \'[]\'',
  );

  // A missing type falls back to TEXT so the fragment is always valid SQL.
  assert.equal(buildMetabotsRebuildExtrasDdl([[30, 'mystery', '', 0, null, 0]]), ', "mystery" TEXT');
});

test('welcome-type rebuild succeeds when metabots carries columns this build does not know', async () => {
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
      name, enabled, metaid, metabot_type, created_by, role, soul, llm_id, llm_provider, llm_effort,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [1, 1, 'mvc-1', 'btc-1', 'doge-1', 'pub-1', 'chat-1', 'Bot One', 1, 'metaid-1', 'worker', '0000', 'r', 's',
      'deepseek-chat', 'deepseek', 'high', 1700000000000, 1700000000000]
  );

  // Simulate the production failure shape: the live table carries columns the
  // rebuild migrations never heard of (heartbeat_enabled came from an older
  // build; it exists in no current source file), and the migration flag is
  // unset because the previous run kept failing on INSERT ... SELECT.
  db.run('ALTER TABLE metabots ADD COLUMN heartbeat_enabled INTEGER');
  db.run('UPDATE metabots SET heartbeat_enabled = 1 WHERE id = 1');
  store.set('metabot_welcome_type_migrated', false);
  store.save();
  store.close();

  const reopened = await SqliteStore.create(tempDir);
  const rdb = reopened.getDatabase();

  // The migration completed and recorded its flag instead of warning every launch.
  assert.equal(reopened.get('metabot_welcome_type_migrated'), true);

  // Unknown columns survived the rebuild with their values intact.
  const cols = rdb.exec('PRAGMA table_info(metabots)')[0].values.map((row) => row[1]);
  for (const name of ['heartbeat_enabled', 'llm_provider', 'llm_effort', 'fallback_llm_provider', 'fallback_llm_effort']) {
    assert.equal(cols.includes(name), true, `column ${name} must survive the rebuild`);
  }
  assert.deepEqual(
    rdb.exec('SELECT name, heartbeat_enabled, llm_provider, llm_effort FROM metabots WHERE id = 1')[0].values,
    [['Bot One', 1, 'deepseek', 'high']],
  );

  // No rebuild debris left behind.
  assert.equal(
    rdb.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='metabots_new'")[0]?.values.length ?? 0,
    0,
  );
  reopened.close();

  // Third open: flag set, migration skips, schema and data stay intact.
  const third = await SqliteStore.create(tempDir);
  assert.equal(third.get('metabot_welcome_type_migrated'), true);
  assert.deepEqual(
    third.getDatabase().exec('SELECT name, heartbeat_enabled FROM metabots WHERE id = 1')[0].values,
    [['Bot One', 1]],
  );
  third.close();
});
