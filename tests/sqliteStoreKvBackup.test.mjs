// Rotating raw-value backups for protected kv keys (app_config): every
// overwrite snapshots the previous raw value into `<key>.bak.<writtenAtMs>`
// slots, newest KV_ROTATING_BACKUP_SLOTS kept. Born from the 2026-10-16
// missing-models incident — a defaults-based overwrite destroyed every LLM
// provider credential and the previous value survived only as sqlite
// free-page fragments. With the backups, any future bad write (even one we
// have not imagined) is recoverable by restoring the newest slot.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSqliteStore } from './memoryTestUtils.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('app_config overwrites rotate raw-value backups, newest slots kept', async () => {
  const sqlite = await createSqliteStore();
  try {
    const { store } = sqlite;
    store.set('app_config', { version: 1 });
    for (let version = 2; version <= 8; version += 1) {
      await sleep(2); // distinct backup timestamps across writes
      store.set('app_config', { version });
    }

    const backupKeys = store.keysWithPrefix('app_config.bak.').sort();
    assert.equal(backupKeys.length, 5, 'only the newest five slots survive');
    // Eight writes (v1..v8) produce previous-value snapshots v1..v7; the
    // newest five (v3..v7) stay, and no slot ever holds the value just
    // written — slots are the RAW PREVIOUS row, restored verbatim.
    const versions = backupKeys.map((key) => store.get(key).version);
    assert.deepEqual(versions, [3, 4, 5, 6, 7]);
    assert.equal(store.get('app_config').version, 8);
  } finally {
    sqlite.cleanup();
  }
});

test('an unparseable current value is backed up verbatim before the overwrite', async () => {
  const sqlite = await createSqliteStore();
  try {
    const { store, db } = sqlite;
    // Simulate transient corruption: a raw row sqliteStore.get() cannot
    // parse (it warns and returns undefined — the exact state the incident
    // exploitation path ran through).
    db.run("INSERT INTO kv (key, value, updated_at) VALUES ('app_config', '{not json', 1)");
    store.set('app_config', { providers: {} });

    const backupKeys = store.keysWithPrefix('app_config.bak.');
    assert.equal(backupKeys.length, 1);
    const raw = db.exec('SELECT value FROM kv WHERE key = ?', [backupKeys[0]]);
    assert.equal(raw[0].values[0][0], '{not json', 'the raw unparseable bytes survive for restore/forensics');
  } finally {
    sqlite.cleanup();
  }
});

test('ordinary keys write without any backup slots', async () => {
  const sqlite = await createSqliteStore();
  try {
    const { store } = sqlite;
    store.set('jevRelay.apiKey', 'mrk_x');
    store.set('jevRelay.apiKey', 'mrk_y');
    assert.equal(store.keysWithPrefix('jevRelay.apiKey.bak.').length, 0);
  } finally {
    sqlite.cleanup();
  }
});
