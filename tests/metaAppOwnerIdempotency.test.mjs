/**
 * Issue #9: metaapp publish chain idempotency + per-app concurrency lock.
 *
 * Verifies on the REAL metaAppOwnerService (compiled) with the ONLY chain
 * boundary mocked — createPin from metaidCore is intercepted via Module._load
 * so no write ever touches a chain; everything else (MetabotStore SQLite,
 * owner cache, protocol payload builders, fingerprinting, lock queue) runs
 * for real.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// --- mock createPin (the only chain boundary) ---
const createPinCalls = [];
let pinCounter = 0;
async function mockCreatePin(_store, _metabotId, metaidData, _options) {
  pinCounter += 1;
  createPinCalls.push(metaidData);
  const pinId = `a${String(pinCounter).padStart(64, '0')}i0`;
  return { pinId, txids: [`tx-${pinCounter}`], totalCost: 1000 };
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
  if (request === 'electron') {
    return {
      app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() },
    };
  }
  if (request === './metaidCore') {
    return { createPin: mockCreatePin };
  }
  return originalLoad.call(this, request, ...rest);
};

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { MetabotStore } = require('../dist-electron/main/metabotStore.js');
const {
  publishMetaApp,
  updateMetaApp,
  removeMetaApp,
} = require('../dist-electron/main/services/metaAppOwnerService.js');
Module._load = originalLoad;

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-metaapp-owner-'));

const insertWallet = (db, id) => {
  db.run(
    `INSERT INTO metabot_wallets (id, mnemonic, path, created_at)
     VALUES (?, ?, ?, ?)`,
    [id, `abandon ability able about above absent absorb abstract absurd abuse access accident ${id}`, "m/44'/10001'/0'/0/0", 1700000000000 + id],
  );
};

const insertMetabot = (db, id) => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
      name, enabled, metaid, globalmetaid, metabot_type, created_by, role, soul,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, id, `mvc-${id}`, `btc-${id}`, `doge-${id}`, `public-${id}`, `chat-public-${id}`,
      'Publish Bot', 1, `metaid-${id}`, `gmid-${id}`, 'worker', '0000', 'role', 'soul',
      1700000000000 + id, 1700000000000 + id,
    ],
  );
};

const openHarness = async () => {
  const tempDir = makeTempDir();
  const store = await SqliteStore.create(tempDir);
  const db = store.getDatabase();
  const metabotStore = new MetabotStore(db, store.getSaveFunction());
  insertWallet(db, 1);
  insertMetabot(db, 1);
  return {
    store, db, metabotStore,
    reset: () => {
      createPinCalls.length = 0;
      pinCounter = 0;
    },
    cleanup: () => store.close(),
  };
};

test.beforeEach(() => {
  createPinCalls.length = 0;
  pinCounter = 0;
});

const MANIFEST_A = {
  title: 'Hello App', appName: 'hello', runtime: 'browser', version: 'v1.0.0',
  contentType: 'text/html', content: 'metafile://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaai0.zip',
};
const MANIFEST_B = {
  title: 'Other App', appName: 'other', runtime: 'browser', version: 'v1.0.0',
  contentType: 'text/html', content: 'metafile://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbi0.zip',
};
const TARGET_PIN = 'c'.repeat(64) + 'i0';

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

test('Issue #9: create — same content twice dedupes to ONE chain write (idempotent)', async () => {
  const h = await openHarness();
  try {
    const first = await publishMetaApp(h.metabotStore, 1, MANIFEST_A, { confirm: true });
    const second = await publishMetaApp(h.metabotStore, 1, MANIFEST_A, { confirm: true });
    assert.equal(createPinCalls.length, 1, 'exactly one chain write for the same create');
    assert.equal(first.idempotent, false);
    assert.equal(second.idempotent, true, 'repeat call reported as idempotent');
    assert.equal(second.pinId, first.pinId, 'reused pin');
    assert.deepEqual(second.chainWrite.txids, first.chainWrite.txids, 'reused txids');
  } finally {
    h.cleanup();
  }
});

test('Issue #9: create — concurrent same-content calls (same-second duplicate) produce ONE chain write', async () => {
  const h = await openHarness();
  try {
    const results = await Promise.all([
      publishMetaApp(h.metabotStore, 1, MANIFEST_A, { confirm: true }),
      publishMetaApp(h.metabotStore, 1, MANIFEST_A, { confirm: true }),
    ]);
    assert.equal(createPinCalls.length, 1, 'same-second double create => one chain write');
    assert.equal(results[0].pinId, results[1].pinId, 'both calls resolve to the same pin');
    assert.equal(results.filter((r) => r.idempotent).length, 1, 'exactly one call was deduped');
  } finally {
    h.cleanup();
  }
});

test('Issue #9: create — different content is never deduped (both publish)', async () => {
  const h = await openHarness();
  try {
    const a = await publishMetaApp(h.metabotStore, 1, MANIFEST_A, { confirm: true });
    const b = await publishMetaApp(h.metabotStore, 1, MANIFEST_B, { confirm: true });
    assert.equal(createPinCalls.length, 2, 'different content => two chain writes');
    assert.equal(a.idempotent, false);
    assert.equal(b.idempotent, false);
    assert.notEqual(a.pinId, b.pinId);
  } finally {
    h.cleanup();
  }
});

test('Issue #9: create — idempotency window expires, a later same-content publish writes again', async () => {
  const h = await openHarness();
  try {
    const first = await publishMetaApp(h.metabotStore, 1, MANIFEST_A, { confirm: true });
    assert.equal(first.idempotent, false);
    // Age the cache row past the 60s window (real DB row, direct update).
    h.db.run('UPDATE metaapp_owner_cache SET created_at = created_at - 120000 WHERE operation = ?', ['create']);
    const second = await publishMetaApp(h.metabotStore, 1, MANIFEST_A, { confirm: true });
    assert.equal(second.idempotent, false, 'outside the window => fresh chain write');
    assert.equal(createPinCalls.length, 2);
    assert.notEqual(second.pinId, first.pinId);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// modify
// ---------------------------------------------------------------------------

test('Issue #9: modify — same target + same content twice dedupes to ONE chain write', async () => {
  const h = await openHarness();
  try {
    const first = await updateMetaApp(h.metabotStore, 1, TARGET_PIN, MANIFEST_A, { confirm: true, firstPinId: TARGET_PIN });
    const second = await updateMetaApp(h.metabotStore, 1, TARGET_PIN, MANIFEST_A, { confirm: true, firstPinId: TARGET_PIN });
    assert.equal(createPinCalls.length, 1, 'duplicate modify => one chain write');
    assert.equal(second.idempotent, true);
    assert.equal(second.pinId, first.pinId);
  } finally {
    h.cleanup();
  }
});

test('Issue #9: modify — two concurrent DIFFERENT-content modifies of the same app both write, serialized', async () => {
  const h = await openHarness();
  try {
    const results = await Promise.all([
      updateMetaApp(h.metabotStore, 1, TARGET_PIN, MANIFEST_A, { confirm: true, firstPinId: TARGET_PIN }),
      updateMetaApp(h.metabotStore, 1, TARGET_PIN, MANIFEST_B, { confirm: true, firstPinId: TARGET_PIN }),
    ]);
    // The per-app lock serializes them; BOTH are legitimate writes (different
    // content), so neither is dropped — the issue-#9 failure mode was two
    // in-flight modifies racing, not two sequential modifies.
    assert.equal(createPinCalls.length, 2, 'different content modifies => two chain writes');
    assert.equal(results.filter((r) => r.idempotent).length, 0);
    assert.notEqual(results[0].pinId, results[1].pinId);
  } finally {
    h.cleanup();
  }
});

test('Issue #9: modify — without firstPinId, targetPinId scopes the lock/idempotency', async () => {
  const h = await openHarness();
  try {
    const first = await updateMetaApp(h.metabotStore, 1, TARGET_PIN, MANIFEST_A, { confirm: true });
    const second = await updateMetaApp(h.metabotStore, 1, TARGET_PIN, MANIFEST_A, { confirm: true });
    assert.equal(createPinCalls.length, 1, 'same target (no firstPinId) still dedupes');
    assert.equal(second.idempotent, true);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// revoke
// ---------------------------------------------------------------------------

test('Issue #9: revoke — duplicate remove dedupes to ONE chain write', async () => {
  const h = await openHarness();
  try {
    const first = await removeMetaApp(h.metabotStore, 1, TARGET_PIN, { confirm: true, firstPinId: TARGET_PIN });
    const second = await removeMetaApp(h.metabotStore, 1, TARGET_PIN, { confirm: true, firstPinId: TARGET_PIN });
    assert.equal(createPinCalls.length, 1, 'duplicate revoke => one chain write');
    assert.equal(second.idempotent, true);
    assert.equal(second.pinId, first.pinId);
  } finally {
    h.cleanup();
  }
});

test('Issue #9: modify and revoke of the SAME app share the per-app lock (no interleaved in-flight writes)', async () => {
  const h = await openHarness();
  try {
    const results = await Promise.all([
      updateMetaApp(h.metabotStore, 1, TARGET_PIN, MANIFEST_A, { confirm: true, firstPinId: TARGET_PIN }),
      removeMetaApp(h.metabotStore, 1, TARGET_PIN, { confirm: true, firstPinId: TARGET_PIN }),
    ]);
    // Both are legitimate distinct operations on the same app: the lock
    // serializes them; neither is dropped.
    assert.equal(createPinCalls.length, 2, 'modify + revoke both write, serialized');
    assert.equal(results.filter((r) => r.idempotent).length, 0);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// cross-call isolation
// ---------------------------------------------------------------------------

test('Issue #9: different apps do not share a lock (parallel, both write)', async () => {
  const h = await openHarness();
  try {
    const targetB = 'd'.repeat(64) + 'i0';
    const results = await Promise.all([
      updateMetaApp(h.metabotStore, 1, TARGET_PIN, MANIFEST_A, { confirm: true, firstPinId: TARGET_PIN }),
      updateMetaApp(h.metabotStore, 1, targetB, MANIFEST_B, { confirm: true, firstPinId: targetB }),
    ]);
    assert.equal(createPinCalls.length, 2, 'different apps are never blocked by each other');
    assert.equal(results.filter((r) => r.idempotent).length, 0);
  } finally {
    h.cleanup();
  }
});
