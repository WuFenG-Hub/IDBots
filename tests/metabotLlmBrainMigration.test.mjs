// metabots LLM-brain migration: llm_provider / llm_effort /
// fallback_llm_provider / fallback_llm_effort columns land idempotently on
// legacy databases (including through the welcome-type table rebuild).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { getSqlJs } from './memoryTestUtils.mjs';

const require = createRequire(import.meta.url);

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');

// Old metabots shape: has fallback_llm_id but none of the model-level brain
// columns, and still bakes the twin/worker-only CHECK (forces the welcome-type
// rebuild migration to run before our ALTERs).
const LEGACY_DDL = `
  CREATE TABLE metabots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_id INTEGER NOT NULL,
    mvc_address TEXT UNIQUE NOT NULL,
    btc_address TEXT UNIQUE NOT NULL,
    doge_address TEXT UNIQUE NOT NULL,
    public_key TEXT UNIQUE NOT NULL,
    chat_public_key TEXT UNIQUE NOT NULL,
    chat_public_key_pin_id TEXT,
    name TEXT UNIQUE NOT NULL,
    avatar BLOB,
    enabled INTEGER NOT NULL DEFAULT 1,
    metaid TEXT UNIQUE NOT NULL,
    globalmetaid TEXT UNIQUE,
    metabot_info_pinid TEXT,
    metabot_type TEXT CHECK(metabot_type IN ('twin', 'worker')) NOT NULL,
    created_by TEXT NOT NULL,
    role TEXT NOT NULL,
    soul TEXT NOT NULL,
    goal TEXT,
    bio TEXT,
    background TEXT,
    boss_id INTEGER,
    llm_id TEXT,
    fallback_llm_id TEXT,
    tools TEXT DEFAULT '[]',
    skills TEXT DEFAULT '[]',
    allow_chat_skills TEXT DEFAULT '[]',
    a2a_max_incoming_turns INTEGER,
    a2a_bye_cooldown_ms INTEGER,
    a2a_auto_reply_enabled INTEGER,
    homepage TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (wallet_id) REFERENCES metabot_wallets(id) ON DELETE RESTRICT,
    FOREIGN KEY (boss_id) REFERENCES metabots(id)
  );
`;

const getColumns = (db) => {
  const result = db.exec('PRAGMA table_info(metabots)');
  return (result[0]?.values || []).map((row) => String(row[1]));
};

test('migration: model-level brain columns added to legacy metabots and idempotent on reopen', async () => {
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-llm-brain-migration-'));
  try {
    // Wallet table must pre-exist for the FK (rebuild keeps the reference).
    db.run(`CREATE TABLE metabot_wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mnemonic TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );`);
    db.run(LEGACY_DDL);
    db.run(`INSERT INTO metabots (
      wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
      name, enabled, metaid, metabot_type, created_by, role, soul, llm_id, fallback_llm_id, created_at, updated_at
    ) VALUES (1, 'mvc1', 'btc1', 'doge1', 'pk1', 'cpk1', 'LegacyBot', 1, 'metaid1', 'worker', 'system', 'r', 's', 'deepseek', 'openai', 1, 1)`);

    const before = getColumns(db);
    for (const column of ['llm_provider', 'llm_effort', 'fallback_llm_provider', 'fallback_llm_effort']) {
      assert.ok(!before.includes(column), `precondition: no ${column}`);
    }

    const store = new SqliteStore(db, path.join(userDataPath, 'test.sqlite'));
    store.initializeTables(userDataPath);

    const after = getColumns(db);
    for (const column of ['llm_provider', 'llm_effort', 'fallback_llm_provider', 'fallback_llm_effort']) {
      assert.ok(after.includes(column), `${column} added`);
    }
    // Legacy brain values are preserved verbatim (no rewrite of provider keys).
    const row = db.exec('SELECT llm_id, fallback_llm_id, llm_effort FROM metabots WHERE id = 1');
    assert.equal(row[0].values[0][0], 'deepseek');
    assert.equal(row[0].values[0][1], 'openai');
    assert.equal(row[0].values[0][2], null);

    // Idempotent: reopening must not fail or duplicate columns.
    const store2 = new SqliteStore(db, path.join(userDataPath, 'test.sqlite'));
    store2.initializeTables(userDataPath);
    assert.equal(getColumns(db).filter((c) => c === 'llm_effort').length, 1);
  } finally {
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
});
