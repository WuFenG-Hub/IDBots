import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { getSqlJs } from './memoryTestUtils.mjs';

const require = createRequire(import.meta.url);

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');

// Old (pre-migration) group_chat_messages shape: no msg_index column.
const LEGACY_DDL = `
  CREATE TABLE group_chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pin_id TEXT UNIQUE NOT NULL,
    tx_id TEXT,
    group_id TEXT NOT NULL,
    channel_id TEXT,
    sender_metaid TEXT NOT NULL,
    sender_global_metaid TEXT,
    sender_address TEXT,
    sender_name TEXT,
    sender_avatar TEXT,
    sender_chat_pubkey TEXT,
    protocol TEXT NOT NULL,
    content TEXT,
    content_type TEXT,
    encryption TEXT,
    reply_pin TEXT,
    mention TEXT,
    chain_timestamp INTEGER,
    chain TEXT,
    raw_data TEXT,
    is_processed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
`;

const insertLegacyRow = (db, pinId, rawData) => {
  db.run(
    `INSERT INTO group_chat_messages (
      pin_id, tx_id, group_id, channel_id, sender_metaid, sender_global_metaid, sender_address,
      sender_name, sender_avatar, sender_chat_pubkey, protocol, content, content_type, encryption,
      reply_pin, mention, chain_timestamp, chain, raw_data, is_processed
    ) VALUES (?, ?, ?, NULL, ?, NULL, NULL, '', '', '', ?, ?, NULL, NULL, '', '[]', NULL, 'mvc', ?, 0)`,
    [pinId, pinId.replace(/-i0$/, ''), 'group-legacy', 'metaid-sender', '/protocols/simplegroupchat', 'content', rawData],
  );
};

const getColumns = (db, tableName) => {
  const result = db.exec(`PRAGMA table_info(${tableName})`);
  return (result[0]?.values || []).map((row) => String(row[1]));
};

const getMsgIndex = (db, pinId) => {
  const result = db.exec('SELECT msg_index FROM group_chat_messages WHERE pin_id = ?', [pinId]);
  return result[0]?.values?.[0]?.[0] ?? null;
};

test('migration: msg_index column added to legacy DB and backfilled from raw_data.index', async () => {
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-msg-index-migration-'));
  try {
    db.run(LEGACY_DDL);
    insertLegacyRow(db, 'pin-old-1-i0', JSON.stringify({ index: 42, pinId: 'pin-old-1-i0' }));
    insertLegacyRow(db, 'pin-old-2-i0', JSON.stringify({ pinId: 'pin-old-2-i0' }));
    insertLegacyRow(db, 'pin-old-3-i0', 'not-valid-json');

    assert.ok(!getColumns(db, 'group_chat_messages').includes('msg_index'), 'precondition: no msg_index');

    const store = new SqliteStore(db, path.join(userDataPath, 'test.sqlite'));
    store.initializeTables(userDataPath);

    assert.ok(getColumns(db, 'group_chat_messages').includes('msg_index'), 'column added');
    assert.equal(getMsgIndex(db, 'pin-old-1-i0'), 42, 'numeric index backfilled from raw_data');
    assert.equal(getMsgIndex(db, 'pin-old-2-i0'), null, 'missing index stays NULL');
    assert.equal(getMsgIndex(db, 'pin-old-3-i0'), null, 'unparseable raw_data skipped, stays NULL');

    // new tables created by the same open path
    for (const table of ['group_tasks', 'group_task_members', 'group_task_deliverables']) {
      assert.ok(getColumns(db, table).includes('id'), `${table} created`);
    }

    // idempotent: reopening the same DB must not fail or clobber backfilled values
    const store2 = new SqliteStore(db, path.join(userDataPath, 'test.sqlite'));
    store2.initializeTables(userDataPath);
    assert.equal(getMsgIndex(db, 'pin-old-1-i0'), 42);
  } finally {
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
});
