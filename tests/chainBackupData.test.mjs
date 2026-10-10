import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { MetabotStore } = require('../dist-electron/main/metabotStore.js');
const { MetaIDKnowledgeStore } = require('../dist-electron/main/metaidKnowledgeStore.js');
const { DreamStore } = require('../dist-electron/main/dreamStore.js');
const { deriveBackupKey, encryptJson, decryptJson, objectId } = require('../dist-electron/main/services/chainBackupCrypto.js');
const { extractBackupObjects, importBackupObjects } = require('../dist-electron/main/services/chainBackupData.js');

/**
 * Chain-backup data round-trip: extract from a source DB, encrypt/decrypt like
 * the on-chain segment does, import into a fresh DB with a remapped metabot id.
 * Run `pnpm run compile:electron` first.
 */

const TEST_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const TEST_GID = 'idqtestglobalmetaid00000000000000000000001';

async function openStore(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const sqliteStore = await SqliteStore.create(dir);
  const db = sqliteStore.getDatabase();
  const save = sqliteStore.getSaveFunction();
  // Knowledge/dream tables are created by their stores, not SqliteStore.
  new MetaIDKnowledgeStore(db, save);
  new DreamStore(db, save);
  const metabotStore = new MetabotStore(db, save);
  return { sqliteStore, db, metabotStore };
}

const MNEMONIC_B = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';

function createBot(metabotStore, name, gid, mnemonic = TEST_MNEMONIC) {
  const wallet = metabotStore.insertMetabotWallet({ mnemonic, path: "m/44'/10001'/0'/0/0" });
  return metabotStore.createMetabot({
    wallet_id: wallet.id,
    mvc_address: `mvc-${name}`,
    btc_address: `btc-${name}`,
    doge_address: `doge-${name}`,
    public_key: `pub-${name}`,
    chat_public_key: `chat-${name}`,
    name,
    enabled: true,
    metaid: `metaid-${name}`,
    globalmetaid: gid,
    metabot_type: 'worker',
    created_by: '0000',
    role: 'tester',
    soul: 'test soul',
  });
}

test('extract → encrypt → decrypt → import round-trip with metabot_id remap', async () => {
  const source = await openStore('idbots-backup-src-');
  const bot = createBot(source.metabotStore, 'src-bot', TEST_GID);
  const db = source.db;

  const now = Date.now();
  db.run(
    `INSERT INTO user_memories (id, metabot_id, text, fingerprint, confidence, is_explicit, status, scope_kind, scope_key, usage_class, visibility, origin, importance, created_at, updated_at)
     VALUES ('mem-1', ?, 'user likes tea', 'fp-tea', 0.9, 1, 'created', 'owner', 'owner:self', 'profile_fact', 'local_only', 'conversation', 0.9, ?, ?)`,
    [bot.id, now, now],
  );
  db.run(
    `INSERT INTO user_memories (id, metabot_id, text, fingerprint, confidence, is_explicit, status, scope_kind, scope_key, usage_class, visibility, origin, importance, created_at, updated_at)
     VALUES ('mem-si', ?, 'I am a careful tester bot', 'fp-self', 1.0, 0, 'created', 'owner', 'owner:self', 'self_identity', 'local_only', 'dream', 1.0, ?, ?)`,
    [bot.id, now, now],
  );
  db.run(
    `INSERT INTO user_memory_sources (id, memory_id, metabot_id, source_type, dream_date, created_at)
     VALUES ('src-1', 'mem-si', ?, 'dream', '2026-10-09', ?)`,
    [bot.id, now],
  );
  db.run(
    `INSERT INTO metabot_daily_summaries (id, metabot_id, summary_date, summary_text, created_at, updated_at)
     VALUES ('day-1', ?, '2026-10-09', 'Today I dreamed of tea.', ?, ?)`,
    [bot.id, now, now],
  );
  db.run(
    `INSERT INTO metaid_knowledge_entries (id, metabot_id, topic, topic_fingerprint, summary, kind, confidence, status, origin, version, created_at, updated_at)
     VALUES ('kn-1', ?, 'tea brewing', 'tfp-tea', 'steep 3 minutes', 'know_how', 0.8, 'active', 'dream', 1, ?, ?)`,
    [bot.id, now, now],
  );
  // deleted memories must not be extracted
  db.run(
    `INSERT INTO user_memories (id, metabot_id, text, fingerprint, confidence, is_explicit, status, scope_kind, scope_key, usage_class, visibility, origin, importance, created_at, updated_at)
     VALUES ('mem-del', ?, 'forgotten', 'fp-del', 0.5, 0, 'deleted', 'owner', 'owner:self', 'profile_fact', 'local_only', 'conversation', 0.5, ?, ?)`,
    [bot.id, now, now],
  );

  const wallet = source.metabotStore.getMetabotWalletByMetabotId(bot.id);
  const objects = extractBackupObjects(db, bot.id, wallet);

  const kinds = objects.map((o) => o.kind).sort();
  assert.deepEqual(kinds, ['dream_daily', 'key_envelope', 'knowledge', 'memory', 'memory']);
  assert.ok(!objects.some((o) => o.data.text === 'forgotten'));
  const envelope = objects.find((o) => o.kind === 'key_envelope');
  assert.equal(envelope.data.mnemonic, TEST_MNEMONIC);

  // Simulate the on-chain segment: encrypt the whole container, then decrypt.
  const key = deriveBackupKey(TEST_MNEMONIC, TEST_GID);
  const segmentPlaintext = {
    version: 1,
    bot: TEST_GID,
    createdAt: Math.floor(now / 1000),
    objects: objects.map((o) => ({ id: o.id, kind: o.kind, data: o.data })),
  };
  const onChainPayload = encryptJson(key, segmentPlaintext).toString('base64');
  const decrypted = decryptJson(deriveBackupKey(TEST_MNEMONIC, TEST_GID), Buffer.from(onChainPayload, 'base64'));
  assert.equal(objectId(decrypted), objectId(segmentPlaintext));

  // Import into a fresh device DB; an unrelated pre-existing bot forces the
  // restored bot onto a different local id, proving the metabot_id remap.
  const target = await openStore('idbots-backup-dst-');
  createBot(target.metabotStore, 'unrelated-bot', 'idqunrelated000000000000000000000000000', MNEMONIC_B);
  const restoredBot = createBot(target.metabotStore, 'src-bot-re', TEST_GID);
  assert.notEqual(restoredBot.id, bot.id);

  const importedObjects = decrypted.objects.map((o) => ({ id: o.id, kind: o.kind, data: o.data }));
  const first = importBackupObjects(target.db, restoredBot.id, importedObjects);
  assert.equal(first.imported, 5); // 2 memories + 1 source + 1 daily + 1 knowledge
  assert.equal(first.skipped, 1); // key_envelope is never imported as a row

  const memories = target.db.exec(`SELECT * FROM user_memories WHERE metabot_id = ?`, [restoredBot.id]);
  assert.equal(memories[0].values.length, 2);
  const selfIdentity = target.db.exec(
    `SELECT text FROM user_memories WHERE metabot_id = ? AND usage_class = 'self_identity'`,
    [restoredBot.id],
  );
  assert.equal(selfIdentity[0].values[0][0], 'I am a careful tester bot');
  const daily = target.db.exec(`SELECT summary_text FROM metabot_daily_summaries WHERE metabot_id = ?`, [restoredBot.id]);
  assert.equal(daily[0].values[0][0], 'Today I dreamed of tea.');
  const knowledge = target.db.exec(`SELECT summary FROM metaid_knowledge_entries WHERE metabot_id = ?`, [restoredBot.id]);
  assert.equal(knowledge[0].values[0][0], 'steep 3 minutes');
  const sources = target.db.exec(`SELECT dream_date FROM user_memory_sources WHERE metabot_id = ?`, [restoredBot.id]);
  assert.equal(sources[0].values[0][0], '2026-10-09');

  // Re-running the same import is a no-op (idempotent).
  const second = importBackupObjects(target.db, restoredBot.id, importedObjects);
  assert.equal(second.imported, 0);
  const memoriesAfter = target.db.exec(`SELECT COUNT(*) FROM user_memories WHERE metabot_id = ?`, [restoredBot.id]);
  assert.equal(memoriesAfter[0].values[0][0], 2);
});

test('journal rebuild from manifest: post-restore backup diffs to zero', async () => {
  const { readChainBackupState, rebuildChainBackupStateFromManifest } =
    require('../dist-electron/main/services/chainBackupData.js');

  const source = await openStore('idbots-journal-src-');
  const bot = createBot(source.metabotStore, 'journal-bot', TEST_GID);
  source.db.run(
    `INSERT INTO user_memories (id, metabot_id, text, fingerprint, confidence, is_explicit, status, scope_kind, scope_key, usage_class, visibility, origin, importance, created_at, updated_at)
     VALUES ('mem-j1', ?, 'journal memory', 'fp-journal', 0.9, 1, 'created', 'owner', 'owner:self', 'profile_fact', 'local_only', 'conversation', 0.9, 1, 1)`,
    [bot.id],
  );
  const wallet = source.metabotStore.getMetabotWalletByMetabotId(bot.id);
  const objects = extractBackupObjects(source.db, bot.id, wallet);

  // Pretend these were published on-chain in one segment.
  const manifest = {
    pinId: 'fakepinid' + '0'.repeat(56) + 'i0',
    segments: [{
      pinId: 'segpin' + '0'.repeat(58) + 'i0',
      segment: 'seg-hash',
      bytes: 1234,
      kinds: ['memory', 'key_envelope'],
      objectIds: objects.map((o) => o.id),
    }],
    updatedAt: 1760000000,
  };

  // Fresh device: restore imports the rows, then rebuilds the journal.
  const target = await openStore('idbots-journal-dst-');
  const restoredBot = createBot(target.metabotStore, 'journal-bot-re', TEST_GID);
  importBackupObjects(target.db, restoredBot.id, objects);
  rebuildChainBackupStateFromManifest(target.db, {
    botGlobalMetaId: TEST_GID,
    manifestPinId: manifest.pinId,
    segments: manifest.segments,
    manifestUpdatedAt: manifest.updatedAt,
  });

  const state = readChainBackupState(target.db, TEST_GID);
  assert.ok(state);
  assert.equal(state.manifest_pinid, manifest.pinId);
  assert.equal(state.last_backup_at, 1760000000 * 1000);
  const uploaded = new Set(JSON.parse(state.uploaded_object_ids_json));
  assert.equal(uploaded.size, objects.length);

  // The next backup's diff: re-extract on this device, drop already-uploaded
  // ids — nothing should remain (the restored rows hash to the same ids).
  const reExtracted = extractBackupObjects(target.db, restoredBot.id, null);
  const pending = reExtracted.filter((o) => !uploaded.has(o.id));
  assert.deepEqual(pending, []);
});
