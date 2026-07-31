import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-user-identity-'));

const makeInsert = (overrides = {}) => ({
  mnemonic: 'abandon ability able about above absent absorb abstract absurd abuse access accident',
  mvc_address: 'mvc-user-1',
  btc_address: 'btc-user-1',
  doge_address: 'doge-user-1',
  public_key: 'pub-user-1',
  chat_public_key: 'chat-pub-user-1',
  metaid: 'metaid-user-1',
  globalmetaid: 'id1userglobalmetaid',
  name: 'Alice',
  avatar: 'data:image/png;base64,AAAA',
  ...overrides,
});

test('user_identity table exists on fresh DB and starts empty', async () => {
  const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
  const { UserIdentityStore } = require('../dist-electron/main/userIdentityStore.js');
  const store = await SqliteStore.create(makeTempDir());
  const db = store.getDatabase();

  const columns = db.exec('PRAGMA table_info(user_identity)')[0].values.map((row) => row[1]);
  for (const col of ['id', 'mnemonic', 'path', 'mvc_address', 'chat_public_key', 'metaid', 'globalmetaid', 'name', 'avatar']) {
    assert.equal(columns.includes(col), true, `missing column ${col}`);
  }

  const users = new UserIdentityStore(db, () => {});
  assert.equal(users.get(), null);
  store.close();
});

test('insert + get roundtrip with defaults applied', async () => {
  const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
  const { UserIdentityStore } = require('../dist-electron/main/userIdentityStore.js');
  const store = await SqliteStore.create(makeTempDir());
  const users = new UserIdentityStore(store.getDatabase(), () => {});

  const created = users.insert(makeInsert());
  assert.equal(created.id, 1);
  assert.equal(created.path, "m/44'/10001'/0'/0/0");
  assert.equal(created.chat_public_key_pin_id, null);
  assert.equal(created.name, 'Alice');
  assert.equal(created.avatar, 'data:image/png;base64,AAAA');
  assert.equal(typeof created.created_at, 'number');

  const fetched = users.get();
  assert.deepEqual(fetched, created);
  store.close();
});

test('single-user constraint: second insert throws, CHECK (id = 1) holds at SQL level', async () => {
  const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
  const { UserIdentityStore } = require('../dist-electron/main/userIdentityStore.js');
  const store = await SqliteStore.create(makeTempDir());
  const db = store.getDatabase();
  const users = new UserIdentityStore(db, () => {});

  users.insert(makeInsert());
  assert.throws(() => users.insert(makeInsert({ mvc_address: 'mvc-user-2' })), /already exists/);
  assert.throws(
    () => db.run(
      `INSERT INTO user_identity (id, mnemonic, mvc_address, btc_address, doge_address, public_key, chat_public_key, metaid, name, created_at, updated_at)
       VALUES (2, 'x', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 1, 1)`,
    ),
    /constraint/i,
  );
  store.close();
});

test('update patches profile fields only', async () => {
  const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
  const { UserIdentityStore } = require('../dist-electron/main/userIdentityStore.js');
  const store = await SqliteStore.create(makeTempDir());
  const users = new UserIdentityStore(store.getDatabase(), () => {});

  users.insert(makeInsert());
  const updated = users.update({ name: 'Alice II', chat_public_key_pin_id: 'pin-123' });
  assert.equal(updated.name, 'Alice II');
  assert.equal(updated.chat_public_key_pin_id, 'pin-123');
  assert.equal(updated.globalmetaid, 'id1userglobalmetaid');
  assert.ok(updated.updated_at >= updated.created_at);

  const cleared = users.update({ avatar: null });
  assert.equal(cleared.avatar, null);
  store.close();
});

test('remove deletes the identity and allows re-insert (logout -> import)', async () => {
  const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
  const { UserIdentityStore } = require('../dist-electron/main/userIdentityStore.js');
  const store = await SqliteStore.create(makeTempDir());
  const users = new UserIdentityStore(store.getDatabase(), () => {});

  assert.equal(users.remove(), false);
  users.insert(makeInsert());
  assert.equal(users.remove(), true);
  assert.equal(users.get(), null);

  const reimported = users.insert(makeInsert({ name: 'Alice Reimported' }));
  assert.equal(reimported.name, 'Alice Reimported');
  store.close();
});

test('identity persists across store reopen', async () => {
  const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
  const { UserIdentityStore } = require('../dist-electron/main/userIdentityStore.js');
  const tempDir = makeTempDir();

  const store = await SqliteStore.create(tempDir);
  new UserIdentityStore(store.getDatabase(), () => store.save()).insert(makeInsert());
  store.save();
  store.close();

  const reopened = await SqliteStore.create(tempDir);
  const users = new UserIdentityStore(reopened.getDatabase(), () => {});
  assert.equal(users.get()?.name, 'Alice');
  reopened.close();
});
