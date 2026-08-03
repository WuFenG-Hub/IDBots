import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { MetabotStore } = require('../dist-electron/main/metabotStore.js');

const TWIN_BACKFILL_MIGRATION_KEY = 'metabot_twin_backfill_migrated';

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-twin-type-'));

const insertWallet = (db, id) => {
  db.run(
    `INSERT INTO metabot_wallets (id, mnemonic, path, created_at)
     VALUES (?, ?, ?, ?)`,
    [id, `abandon ability able about above absent absorb abstract absurd abuse access accident ${id}`, "m/44'/10001'/0'/0/0", 1700000000000 + id]
  );
};

const insertMetabot = (db, { id, walletId, name, type = 'worker', createdAt }) => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
      name, enabled, metaid, metabot_type, created_by, role, soul,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      walletId,
      `mvc-${id}`,
      `btc-${id}`,
      `doge-${id}`,
      `public-${id}`,
      `chat-public-${id}`,
      name,
      1,
      `metaid-${id}`,
      type,
      '0000',
      `${name} role`,
      `${name} soul`,
      createdAt,
      createdAt,
    ]
  );
};

const createMetabotInput = (walletId, overrides = {}) => ({
  wallet_id: walletId,
  mvc_address: `mvc-created-${Math.random().toString(36).slice(2)}`,
  btc_address: `btc-created-${Math.random().toString(36).slice(2)}`,
  doge_address: `doge-created-${Math.random().toString(36).slice(2)}`,
  public_key: `public-created-${Math.random().toString(36).slice(2)}`,
  chat_public_key: `chat-public-created-${Math.random().toString(36).slice(2)}`,
  chat_public_key_pin_id: null,
  name: `Created Bot ${Math.random().toString(36).slice(2, 8)}`,
  avatar: null,
  enabled: true,
  metaid: `metaid-created-${Math.random().toString(36).slice(2)}`,
  globalmetaid: null,
  metabot_info_pinid: null,
  metabot_type: 'worker',
  created_by: '0000',
  role: 'Created role',
  soul: 'Created soul',
  goal: null,
  bio: null,
  boss_id: null,
  boss_global_metaid: null,
  llm_id: 'openai',
  tools: [],
  skills: [],
  allow_chat_skills: [],
  ...overrides,
});

const openStores = async (tempDir) => {
  const store = await SqliteStore.create(tempDir);
  const metabotStore = new MetabotStore(store.getDatabase(), store.getSaveFunction());
  return { store, metabotStore, db: store.getDatabase() };
};

const countTwins = (db) =>
  db.exec("SELECT COUNT(*) FROM metabots WHERE metabot_type = 'twin'")[0].values[0][0];

test('updateMetabot promoting a worker to twin demotes the previous twin', async () => {
  const tempDir = makeTempDir();
  const { store, metabotStore, db } = await openStores(tempDir);
  try {
    insertWallet(db, 1);
    insertMetabot(db, { id: 1, walletId: 1, name: 'First Twin', type: 'twin', createdAt: 1000 });
    insertMetabot(db, { id: 2, walletId: 1, name: 'Worker Bot', type: 'worker', createdAt: 2000 });

    metabotStore.updateMetabot(2, { metabot_type: 'twin' });

    assert.equal(metabotStore.getMetabotById(2)?.metabot_type, 'twin');
    assert.equal(metabotStore.getMetabotById(1)?.metabot_type, 'worker');
    assert.equal(countTwins(db), 1);
  } finally {
    store.close();
  }
});

test('createMetabot inserting a twin demotes the existing twin', async () => {
  const tempDir = makeTempDir();
  const { store, metabotStore, db } = await openStores(tempDir);
  try {
    insertWallet(db, 1);
    insertMetabot(db, { id: 1, walletId: 1, name: 'Old Twin', type: 'twin', createdAt: 1000 });

    const created = metabotStore.createMetabot(createMetabotInput(1, { metabot_type: 'twin' }));

    assert.equal(created.metabot_type, 'twin');
    assert.equal(metabotStore.getMetabotById(created.id)?.metabot_type, 'twin');
    assert.equal(metabotStore.getMetabotById(1)?.metabot_type, 'worker');
    assert.equal(countTwins(db), 1);
  } finally {
    store.close();
  }
});

test('worker to twin to another bot twin keeps exactly one twin', async () => {
  const tempDir = makeTempDir();
  const { store, metabotStore, db } = await openStores(tempDir);
  try {
    insertWallet(db, 1);
    insertMetabot(db, { id: 1, walletId: 1, name: 'Bot One', type: 'worker', createdAt: 1000 });
    insertMetabot(db, { id: 2, walletId: 1, name: 'Bot Two', type: 'worker', createdAt: 2000 });

    metabotStore.updateMetabot(1, { metabot_type: 'twin' });
    assert.equal(metabotStore.getMetabotById(1)?.metabot_type, 'twin');
    assert.equal(countTwins(db), 1);

    metabotStore.updateMetabot(2, { metabot_type: 'twin' });
    assert.equal(metabotStore.getMetabotById(2)?.metabot_type, 'twin');
    assert.equal(metabotStore.getMetabotById(1)?.metabot_type, 'worker');
    assert.equal(countTwins(db), 1);
  } finally {
    store.close();
  }
});

test('migration normalizes unknown metabot_type values to worker', async () => {
  const tempDir = makeTempDir();
  const { store, db } = await openStores(tempDir);
  try {
    insertWallet(db, 1);
    // The legacy-value branch of the backfill: a row whose metabot_type is not
    // in ('twin', 'worker'). The NOT NULL column constraint blocks inserting
    // NULL, so the unknown-value branch is exercised via a CHECK bypass; the
    // same UPDATE statement covers IS NULL.
    db.run('PRAGMA ignore_check_constraints = ON');
    insertMetabot(db, { id: 1, walletId: 1, name: 'Untyped Bot', type: 'bot', createdAt: 2000 });
    db.run('PRAGMA ignore_check_constraints = OFF');
    // Earlier-created valid worker: the no-twin branch promotes this one,
    // leaving the normalized row as worker.
    insertMetabot(db, { id: 2, walletId: 1, name: 'Oldest Worker', type: 'worker', createdAt: 1000 });
    // Simulate an upgraded pre-backfill DB: clear the one-shot flag so the
    // migration runs again on reopen.
    store.delete(TWIN_BACKFILL_MIGRATION_KEY);
  } finally {
    store.close();
  }

  const reopened = await openStores(tempDir);
  try {
    assert.equal(reopened.metabotStore.getMetabotById(1)?.metabot_type, 'worker');
    assert.equal(reopened.metabotStore.getMetabotById(2)?.metabot_type, 'twin');
    assert.equal(countTwins(reopened.db), 1);
  } finally {
    reopened.store.close();
  }
});

test('migration promotes the earliest-created bot when no twin exists', async () => {
  const tempDir = makeTempDir();
  const { store, db } = await openStores(tempDir);
  try {
    insertWallet(db, 1);
    insertMetabot(db, { id: 1, walletId: 1, name: 'Newer Worker', type: 'worker', createdAt: 3000 });
    insertMetabot(db, { id: 2, walletId: 1, name: 'Older Worker', type: 'worker', createdAt: 1000 });
    store.delete(TWIN_BACKFILL_MIGRATION_KEY);
  } finally {
    store.close();
  }

  const reopened = await openStores(tempDir);
  try {
    assert.equal(reopened.metabotStore.getMetabotById(2)?.metabot_type, 'twin');
    assert.equal(reopened.metabotStore.getMetabotById(1)?.metabot_type, 'worker');
    assert.equal(countTwins(reopened.db), 1);
  } finally {
    reopened.store.close();
  }
});

test('migration keeps the earliest twin and demotes duplicates', async () => {
  const tempDir = makeTempDir();
  const { store, db } = await openStores(tempDir);
  try {
    insertWallet(db, 1);
    insertMetabot(db, { id: 1, walletId: 1, name: 'Newer Twin', type: 'twin', createdAt: 2000 });
    insertMetabot(db, { id: 2, walletId: 1, name: 'Older Twin', type: 'twin', createdAt: 1000 });
    insertMetabot(db, { id: 3, walletId: 1, name: 'Plain Worker', type: 'worker', createdAt: 3000 });
    store.delete(TWIN_BACKFILL_MIGRATION_KEY);
  } finally {
    store.close();
  }

  const reopened = await openStores(tempDir);
  try {
    assert.equal(reopened.metabotStore.getMetabotById(2)?.metabot_type, 'twin');
    assert.equal(reopened.metabotStore.getMetabotById(1)?.metabot_type, 'worker');
    assert.equal(reopened.metabotStore.getMetabotById(3)?.metabot_type, 'worker');
    assert.equal(countTwins(reopened.db), 1);
  } finally {
    reopened.store.close();
  }
});

test('migration does not re-run after the user transfers the twin manually', async () => {
  const tempDir = makeTempDir();
  const { store, db } = await openStores(tempDir);
  try {
    insertWallet(db, 1);
    insertMetabot(db, { id: 1, walletId: 1, name: 'Bot One', type: 'worker', createdAt: 1000 });
    insertMetabot(db, { id: 2, walletId: 1, name: 'Bot Two', type: 'worker', createdAt: 2000 });
    store.delete(TWIN_BACKFILL_MIGRATION_KEY);
  } finally {
    store.close();
  }

  // First reopen: backfill promotes the earliest bot (Bot One) to twin.
  const migrated = await openStores(tempDir);
  try {
    assert.equal(migrated.metabotStore.getMetabotById(1)?.metabot_type, 'twin');
    // The user then transfers the Twin role to Bot Two.
    migrated.metabotStore.updateMetabot(2, { metabot_type: 'twin' });
    assert.equal(migrated.metabotStore.getMetabotById(2)?.metabot_type, 'twin');
    assert.equal(migrated.metabotStore.getMetabotById(1)?.metabot_type, 'worker');
  } finally {
    migrated.store.close();
  }

  // Second reopen: the one-shot flag must prevent the migration from
  // "restoring" Bot One as twin; the user's manual choice survives.
  const reopened = await openStores(tempDir);
  try {
    assert.equal(reopened.metabotStore.getMetabotById(2)?.metabot_type, 'twin');
    assert.equal(reopened.metabotStore.getMetabotById(1)?.metabot_type, 'worker');
    assert.equal(countTwins(reopened.db), 1);
  } finally {
    reopened.store.close();
  }
});
