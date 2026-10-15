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
const { UserIdentityStore } = require('../dist-electron/main/userIdentityStore.js');
const { deriveBackupKey, encryptJson, objectId } = require('../dist-electron/main/services/chainBackupCrypto.js');
const { extractBackupObjects } = require('../dist-electron/main/services/chainBackupData.js');
const { CHAIN_BACKUP_CIPHER, CHAIN_BACKUP_KDF, CHAIN_BACKUP_MANIFEST_PATH } = require('../dist-electron/main/services/chainBackupService.js');
const { runChainBackupRestore } = require('../dist-electron/main/services/chainBackupRestoreService.js');

/**
 * Chain-backup restore regression tests: discovery must ride the
 * metaid-scoped pin listing (not the platform-global path feed), and a dead
 * segment pin degrades to a partial restore instead of failing the whole
 * bot. Run `pnpm run compile:electron` first.
 */

const USER_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const USER_GID = 'idqtestuserglobalmetaid0000000000000001';
const BOT_GID = 'idqtestbotglobalmetaid0000000000000000001';
const BOT2_GID = 'idqtestbotglobalmetaid0000000000000000002';

async function openStore(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const sqliteStore = await SqliteStore.create(dir);
  const db = sqliteStore.getDatabase();
  const save = sqliteStore.getSaveFunction();
  new MetaIDKnowledgeStore(db, save);
  new DreamStore(db, save);
  const metabotStore = new MetabotStore(db, save);
  return { sqliteStore, db, metabotStore };
}

function createBot(metabotStore, name, gid, mnemonic = USER_MNEMONIC) {
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

function insertUserIdentity(db, save) {
  const store = new UserIdentityStore(db, save);
  store.insert({
    mnemonic: USER_MNEMONIC,
    mvc_address: 'mvc-user',
    btc_address: 'btc-user',
    doge_address: 'doge-user',
    public_key: 'pub-user',
    chat_public_key: 'chat-user',
    metaid: 'metaid-user',
    globalmetaid: USER_GID,
    name: 'tester',
  });
  return store;
}

/** One encrypted segment pin body for the given slice of backup objects. */
function buildSegmentEnvelope(backupKey, botGid, objects) {
  const plaintext = {
    version: 1,
    bot: botGid,
    createdAt: Math.floor(Date.now() / 1000),
    objects: objects.map((o) => ({ id: o.id, kind: o.kind, data: o.data })),
  };
  return {
    envelopeText: JSON.stringify({
      version: 1,
      bot: botGid,
      segment: objectId(plaintext),
      cipher: CHAIN_BACKUP_CIPHER,
      kdf: CHAIN_BACKUP_KDF,
      payload: encryptJson(backupKey, plaintext).toString('base64'),
    }),
    segmentId: objectId(plaintext),
    ref: (pinId) => ({
      pinId,
      segment: objectId(plaintext),
      bytes: 1024,
      kinds: objects.map((o) => o.kind),
      objectIds: objects.map((o) => o.id),
    }),
  };
}

/**
 * Stub the manapi indexer on globalThis.fetch. `pins` maps pin id → body
 * text (or `null` for HTTP 404). Scoped listings return the newest pin for
 * the requested metaid+path; the platform-global path feed returns an empty
 * page and records that it was touched.
 */
function stubIndexer(pins, scopedListings) {
  const calls = { globalPathList: 0 };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    const respond = (status, body, contentType = 'application/json') => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      headers: { get: () => contentType },
    });
    const scoped = href.match(/\/api\/metaid\/pin\/list\/([^/?]+)\?/);
    if (scoped) {
      const metaid = decodeURIComponent(scoped[1]);
      const list = (scopedListings[`${metaid}|${new URL(href).searchParams.get('path')}`] ?? [])
        .map((pinId) => ({ id: pinId, timestamp: Math.floor(Date.now() / 1000) }));
      return respond(200, { code: 1, data: { list } });
    }
    if (href.includes('/api/pin/path/list')) {
      calls.globalPathList += 1;
      return respond(200, { code: 1, data: { list: [], cursor: null } });
    }
    // restoreMetabotFromMnemonicCore pulls the on-chain /info profile: the
    // local-node probe answers with a semantic miss (no name), the remote
    // indexer serves the profile the skeleton is built from.
    if (href.includes('/api/v1/users/info/address/')) {
      return respond(200, { code: 1, data: {} });
    }
    if (href.includes('/api/v1/info/address/')) {
      return respond(200, { code: 1, data: { name: 'restored-from-chain' } });
    }
    const content = href.match(/\/content\/([^/?]+)/);
    if (content) {
      const pinId = decodeURIComponent(content[1]);
      const body = pins[pinId];
      if (body == null) return respond(404, { code: 0, message: 'not found' });
      return respond(200, body, 'text/plain');
    }
    throw new Error(`unexpected fetch in test: ${href} ${JSON.stringify(init ?? {})}`);
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

async function seedSourceBot(source, gid, name) {
  const bot = createBot(source.metabotStore, name, gid);
  const now = Date.now();
  source.db.run(
    `INSERT INTO user_memories (id, metabot_id, text, fingerprint, confidence, is_explicit, status, scope_kind, scope_key, usage_class, visibility, origin, importance, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0.9, 1, 'created', 'owner', 'owner:self', 'profile_fact', 'local_only', 'conversation', 0.9, ?, ?)`,
    [`mem-${name}`, bot.id, `user fact for ${name}`, `fp-${name}`, now, now],
  );
  const wallet = source.metabotStore.getMetabotWalletByMetabotId(bot.id);
  return { bot, objects: extractBackupObjects(source.db, bot.id, wallet) };
}

test('discovery rides the metaid-scoped listing; a dead segment degrades to a partial restore', async () => {
  const source = await openStore('idbots-restore-src-');
  const { objects: botObjects } = await seedSourceBot(source, BOT_GID, 'alpha');

  const backupKey = deriveBackupKey(USER_MNEMONIC, USER_GID);
  // Segment 1: key envelope + memory (everything needed to rebuild the bot).
  const seg1Objects = botObjects.filter((o) => o.kind === 'key_envelope' || o.kind === 'memory');
  // Segment 2: would carry nothing here — model it as a dead pin the
  // manifest still advertises (the manifest only ever grows).
  const seg1 = buildSegmentEnvelope(backupKey, BOT_GID, seg1Objects);
  const deadPinId = 'pin-seg-alpha-dead';
  const manifest = {
    bot: BOT_GID,
    botName: 'alpha',
    updatedAt: Math.floor(Date.now() / 1000),
    segments: [seg1.ref('pin-seg-alpha-1'), {
      pinId: deadPinId,
      segment: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      bytes: 512,
      kinds: ['knowledge'],
      objectIds: ['kn-dead'],
    }],
  };

  const stub = stubIndexer(
    {
      'pin-bots': JSON.stringify({ bots: [{ globalMetaId: BOT_GID, name: 'alpha', type: 'worker', mvcAddress: 'mvc-alpha' }] }),
      'pin-manifest-alpha': JSON.stringify(manifest),
      'pin-seg-alpha-1': seg1.envelopeText,
    },
    {
      [`${USER_GID}|/info/bots`]: ['pin-bots'],
      [`${BOT_GID}|${CHAIN_BACKUP_MANIFEST_PATH}`]: ['pin-manifest-alpha'],
    },
  );

  try {
    const target = await openStore('idbots-restore-dst-');
    const userStore = insertUserIdentity(target.db, target.sqliteStore.getSaveFunction());
    const result = await runChainBackupRestore({
      db: target.db,
      metabotStore: target.metabotStore,
      userStore,
      baseUrl: 'http://stub.test',
    });

    // Discovery never touched the platform-global path feed.
    assert.equal(stub.calls.globalPathList, 0, 'discovery must use the metaid-scoped listing');
    assert.equal(result.success, true);
    assert.equal(result.bots.length, 1);
    const bot = result.bots[0];
    assert.equal(bot.restored, true, 'skeleton is rebuilt from the live segment');
    assert.equal(bot.imported, 1, 'the live segment memory imports');
    assert.equal(bot.skipped, 1, 'the key envelope is counted as skipped');
    assert.ok((bot.warnings?.length ?? 0) === 1 && bot.warnings[0].includes(deadPinId),
      'the dead segment is reported as a warning');
    assert.equal(bot.error, undefined);

    // A partial restore must NOT adopt the on-chain manifest as the local
    // journal baseline — the next full backup re-publishes a complete set.
    const journal = target.db.exec(
      'SELECT bot_globalmetaid FROM chain_backup_state WHERE bot_globalmetaid = ?',
      [BOT_GID],
    );
    assert.equal(journal[0].values.length, 0, 'no journal baseline for a partial restore');

    // The restored bot exists with its memory row.
    const memories = target.db.exec(
      `SELECT text FROM user_memories WHERE fingerprint = ?`,
      ['fp-alpha'],
    );
    assert.equal(memories[0].values.length, 1);
  } finally {
    stub.restore();
  }
});

test('a fully verified restore rebuilds the journal baseline', async () => {
  const source = await openStore('idbots-restore-src2-');
  const { objects: botObjects } = await seedSourceBot(source, BOT2_GID, 'beta');

  const backupKey = deriveBackupKey(USER_MNEMONIC, USER_GID);
  const seg = buildSegmentEnvelope(backupKey, BOT2_GID, botObjects);
  const manifest = {
    bot: BOT2_GID,
    botName: 'beta',
    updatedAt: Math.floor(Date.now() / 1000),
    segments: [seg.ref('pin-seg-beta-1')],
  };

  const stub = stubIndexer(
    {
      'pin-bots': JSON.stringify({ bots: [{ globalMetaId: BOT2_GID, name: 'beta', type: 'worker', mvcAddress: 'mvc-beta' }] }),
      'pin-manifest-beta': JSON.stringify(manifest),
      'pin-seg-beta-1': seg.envelopeText,
    },
    {
      [`${USER_GID}|/info/bots`]: ['pin-bots'],
      [`${BOT2_GID}|${CHAIN_BACKUP_MANIFEST_PATH}`]: ['pin-manifest-beta'],
    },
  );

  try {
    const target = await openStore('idbots-restore-dst2-');
    const userStore = insertUserIdentity(target.db, target.sqliteStore.getSaveFunction());
    const result = await runChainBackupRestore({
      db: target.db,
      metabotStore: target.metabotStore,
      userStore,
      baseUrl: 'http://stub.test',
    });

    assert.equal(result.success, true);
    const bot = result.bots[0];
    assert.equal(bot.restored, true);
    assert.equal(bot.warnings, undefined);
    const journal = target.db.exec(
      'SELECT manifest_pinid FROM chain_backup_state WHERE bot_globalmetaid = ?',
      [BOT2_GID],
    );
    assert.equal(journal[0].values[0][0], 'pin-manifest-beta');
  } finally {
    stub.restore();
  }
});
