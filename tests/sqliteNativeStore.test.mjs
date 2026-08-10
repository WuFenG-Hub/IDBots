import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-sqlite-native-'));

const insertWallet = (db, id) => {
  db.run(
    `INSERT INTO metabot_wallets (id, mnemonic, path, created_at)
     VALUES (?, ?, ?, ?)`,
    [id, `abandon ability able about above absent absorb abstract absurd abuse access accident ${id}`, "m/44'/10001'/0'/0/0", 1700000000000 + id]
  );
};

const insertMetabot = (db, { id, walletId, name, type = 'worker', bossId = null, background = null }) => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key, chat_public_key_pin_id,
      name, avatar, enabled, metaid, globalmetaid, metabot_info_pinid, metabot_type, created_by,
      role, soul, goal, background, boss_id, boss_global_metaid, llm_id, tools, skills, allow_chat_skills,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      walletId,
      `mvc-${id}`,
      `btc-${id}`,
      `doge-${id}`,
      `public-${id}`,
      `chat-public-${id}`,
      null,
      name,
      null,
      1,
      `metaid-${id}`,
      `globalmetaid-${id}`,
      null,
      type,
      '0000',
      `${name} role`,
      `${name} soul`,
      null,
      background,
      bossId,
      null,
      'openai',
      '[]',
      '[]',
      '[]',
      1700000000000 + id,
      1700000000000 + id,
    ]
  );
};

test('SqliteStore uses native sqlite by default and persists without sql.js export', async () => {
  const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
  const tempDir = makeTempDir();

  const store = await SqliteStore.create(tempDir);
  assert.equal(store.getBackendKind(), 'native');
  store.set('native-store-test', { ok: true });
  store.close();

  const reopened = await SqliteStore.create(tempDir);
  assert.equal(reopened.getBackendKind(), 'native');
  assert.deepEqual(reopened.get('native-store-test'), { ok: true });
  reopened.close();
});

test('native sqlite adapter preserves sql.js exec and row-change behavior', async () => {
  const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
  const tempDir = makeTempDir();
  const store = await SqliteStore.create(tempDir);
  const db = store.getDatabase();

  db.run('CREATE TABLE adapter_test (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)');
  db.run('INSERT INTO adapter_test (name) VALUES (?)', ['alpha']);
  assert.equal(db.getRowsModified(), 1);

  const inserted = db.exec('SELECT last_insert_rowid() AS id');
  assert.equal(inserted[0].columns[0], 'id');
  assert.equal(inserted[0].values[0][0], 1);

  const rows = db.exec('SELECT id, name FROM adapter_test WHERE id = ?', [1]);
  assert.deepEqual(rows, [{
    columns: ['id', 'name'],
    values: [[1, 'alpha']],
  }]);

  store.close();
});

test('SqliteStore creates bio column and backfills deprecated MetaBot background', async () => {
  const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
  const { MetabotStore } = require('../dist-electron/main/metabotStore.js');
  const tempDir = makeTempDir();

  const store = await SqliteStore.create(tempDir);
  const db = store.getDatabase();
  const columns = db.exec('PRAGMA table_info(metabots)')[0].values.map((row) => row[1]);
  assert.equal(columns.includes('bio'), true);
  assert.equal(columns.includes('background'), true);

  insertWallet(db, 9);
  insertMetabot(db, { id: 9, walletId: 9, name: 'Legacy Bio Bot', background: 'Legacy public bio' });
  assert.deepEqual(
    db.exec('SELECT bio, background FROM metabots WHERE id = 9')[0].values[0],
    [null, 'Legacy public bio'],
  );
  store.close();

  const reopened = await SqliteStore.create(tempDir);
  assert.deepEqual(
    reopened.getDatabase().exec('SELECT bio, background FROM metabots WHERE id = 9')[0].values[0],
    ['Legacy public bio', 'Legacy public bio'],
  );

  const metabotStore = new MetabotStore(reopened.getDatabase(), reopened.getSaveFunction());
  const restored = metabotStore.getMetabotById(9);
  assert.equal(restored?.bio, 'Legacy public bio');
  reopened.close();
});

test('MetabotStore writes new public profile text to bio without populating deprecated background', async () => {
  const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
  const { MetabotStore } = require('../dist-electron/main/metabotStore.js');
  const tempDir = makeTempDir();

  const store = await SqliteStore.create(tempDir);
  const db = store.getDatabase();
  insertWallet(db, 10);

  const metabotStore = new MetabotStore(db, store.getSaveFunction());
  const created = metabotStore.createMetabot({
    wallet_id: 10,
    mvc_address: 'mvc-created',
    btc_address: 'btc-created',
    doge_address: 'doge-created',
    public_key: 'public-created',
    chat_public_key: 'chat-public-created',
    chat_public_key_pin_id: null,
    name: 'Created Bio Bot',
    avatar: null,
    enabled: true,
    metaid: 'metaid-created',
    globalmetaid: 'globalmetaid-created',
    metabot_info_pinid: null,
    metabot_type: 'worker',
    created_by: '0000',
    role: 'Created role',
    soul: 'Created soul',
    goal: null,
    bio: 'Created public bio',
    boss_id: null,
    boss_global_metaid: null,
    llm_id: 'openai',
    tools: [],
    skills: [],
    allow_chat_skills: [],
  });

  assert.equal(created.bio, 'Created public bio');
  assert.equal(created.background, null);
  assert.deepEqual(
    db.exec('SELECT bio, background FROM metabots WHERE id = ? LIMIT 1', [created.id])[0].values[0],
    ['Created public bio', null],
  );
  store.close();
});

test('SqliteStore.create() clears orphan MetaBot boss ids before native FK updates', async () => {
  const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
  const { MetabotStore } = require('../dist-electron/main/metabotStore.js');
  const tempDir = makeTempDir();

  const store = await SqliteStore.create(tempDir);
  const db = store.getDatabase();
  db.run('PRAGMA foreign_keys = OFF');
  insertWallet(db, 5);
  insertWallet(db, 7);
  insertMetabot(db, { id: 5, walletId: 5, name: 'AI WuFenG', bossId: 1 });
  insertMetabot(db, { id: 6, walletId: 7, name: 'Twin Bot', bossId: 1 });
  db.run('PRAGMA foreign_keys = ON');
  store.close();

  const reopened = await SqliteStore.create(tempDir);
  const rows = reopened.getDatabase().exec('SELECT id, boss_id FROM metabots ORDER BY id ASC')[0].values;
  assert.deepEqual(rows, [[5, null], [6, null]]);

  const metabotStore = new MetabotStore(reopened.getDatabase(), reopened.getSaveFunction());
  const updated = metabotStore.updateMetabot(6, { name: 'Twin Bot edited', boss_id: 1 });
  assert.equal(updated?.boss_id, null);
  assert.equal(updated?.name, 'Twin Bot edited');
  reopened.close();
});

test('deleting a MetaBot clears child boss ids instead of failing FK constraints', async () => {
  const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
  const { MetabotStore } = require('../dist-electron/main/metabotStore.js');
  const tempDir = makeTempDir();
  const store = await SqliteStore.create(tempDir);
  const db = store.getDatabase();
  insertWallet(db, 1);
  insertWallet(db, 2);
  insertMetabot(db, { id: 1, walletId: 1, name: 'Boss Bot', type: 'twin' });
  insertMetabot(db, { id: 2, walletId: 2, name: 'Worker Bot', bossId: 1 });

  const metabotStore = new MetabotStore(db, store.getSaveFunction());
  assert.equal(metabotStore.deleteMetabot(1), true);

  const childBossId = db.exec('SELECT boss_id FROM metabots WHERE id = 2')[0].values[0][0];
  assert.equal(childBossId, null);
  store.close();
});

// ---------------------------------------------------------------------------
// 清单 #11: concurrent-write safety on the native connection.
// The default SQLite settings (rollback journal, busy_timeout=0) make a write
// from a second connection fail instantly with SQLITE_BUSY ('database is
// locked') — reproduced live when a Twin session and a delegated worker
// session wrote the same database concurrently. The native connection must
// open with WAL + busy_timeout and wait out overlapping writers.
// ---------------------------------------------------------------------------
test('native connection opens with WAL journal mode + busy_timeout (清单 #11)', async () => {
  const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
  const tempDir = makeTempDir();
  const store = await SqliteStore.create(tempDir);
  try {
    const db = store.getDatabase();

    const journal = db.exec('PRAGMA journal_mode')[0];
    assert.equal(journal.columns[0], 'journal_mode');
    assert.equal(journal.values[0][0], 'wal', 'WAL journal must be active');

    const timeout = db.exec('PRAGMA busy_timeout')[0];
    assert.equal(timeout.columns[0], 'timeout');
    assert.equal(timeout.values[0][0], 5000, 'busy_timeout must be set');
  } finally {
    store.close();
  }

  // WAL persists in the database header: a reopened store keeps working and
  // the data written before close (checkpointed) is fully readable.
  const reopened = await SqliteStore.create(tempDir);
  try {
    reopened.set('wal-persist-check', { ok: true });
    assert.equal(reopened.get('wal-persist-check').ok, true);
    assert.equal(reopened.getDatabase().exec('PRAGMA journal_mode')[0].values[0][0], 'wal');
  } finally {
    reopened.close();
  }
});

test('concurrent writer waits via busy_timeout instead of throwing database is locked (清单 #11)', async () => {
  const { createNativeSqliteDatabase } = require('../dist-electron/main/nativeSqliteDatabase.js');
  const { Worker } = await import('node:worker_threads');
  const tempDir = makeTempDir();
  const dbPath = path.join(tempDir, 'concurrent.sqlite');

  // Second writer on its OWN event loop: takes the write lock (BEGIN IMMEDIATE),
  // signals 'locked', then commits after a short delay — its transaction
  // overlaps our connection's write.
  const holder = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData.dbPath);
    db.exec('PRAGMA busy_timeout = 0;');
    db.exec('BEGIN IMMEDIATE');
    parentPort.postMessage('locked');
    setTimeout(() => {
      db.exec('COMMIT');
      db.close();
      parentPort.postMessage('committed');
    }, workerData.commitAfterMs);
  `, {
    eval: true,
    workerData: { dbPath, commitAfterMs: 400 },
  });
  try {
    await new Promise((resolve, reject) => {
      holder.once('message', (message) => { if (message === 'locked') resolve(); });
      holder.once('error', reject);
    });

    // Our connection opens with busy_timeout=5000: the write must block until
    // the other writer's transaction commits instead of failing immediately
    // with 'database is locked'.
    const db = createNativeSqliteDatabase(dbPath);
    const started = Date.now();
    db.run('CREATE TABLE concurrent_t (id INTEGER PRIMARY KEY, v TEXT)');
    db.run("INSERT INTO concurrent_t (v) VALUES ('ok')");
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 300, `write waited for the other writer instead of failing (${elapsed}ms)`);
    const rows = db.exec('SELECT v FROM concurrent_t')[0].values;
    assert.deepEqual(rows, [['ok']]);
    db.close();
  } finally {
    await holder.terminate();
  }
});
