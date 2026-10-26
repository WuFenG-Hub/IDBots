import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { UserIdentityStore } = require('../dist-electron/main/userIdentityStore.js');
const { probeChainBackupAvailability } = require('../dist-electron/main/services/chainBackupRestoreService.js');

const USER_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const USER_GID = 'idqtestuserglobalmetaid0000000000000001';
const MANIFEST_PATH = '/protocols/metabot-backup/manifest';

async function makeUserStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-import-guide-'));
  const sqliteStore = await SqliteStore.create(dir);
  const store = new UserIdentityStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
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
  return { store, sqliteStore };
}

function stubIndexer(pins, scopedListings, bots) {
  const originalFetch = globalThis.fetch;
  const ownerByAddress = { 'mvc-user': USER_GID };
  for (const bot of bots) ownerByAddress[bot.mvcAddress] = bot.globalMetaId;
  globalThis.fetch = async (url) => {
    const href = String(url);
    const respond = (status, body, contentType = 'application/json') => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => typeof body === 'string' ? body : JSON.stringify(body),
      headers: { get: () => contentType },
    });
    if (href.includes('/api/pin/path/list')) {
      if (scopedListings.__failGlobal) return respond(200, { code: 500, message: 'indexer unavailable' });
      return respond(200, { code: 1, data: { list: [], nextCursor: null } });
    }
    const addressScoped = href.match(/\/api\/address\/pin\/list\/([^/?]+)\?/);
    if (addressScoped) {
      const address = decodeURIComponent(addressScoped[1]);
      const owner = ownerByAddress[address];
      const path = new URL(href).searchParams.get('path');
      if (address === 'mvc-error') return respond(200, { code: 500, message: 'indexer unavailable' });
      const list = (scopedListings[`${owner}|${path}`] ?? []).map((pinId) => ({
        id: pinId,
        timestamp: Math.floor(Date.now() / 1000),
        address,
        globalMetaId: owner,
        modify_history: [pinId],
      }));
      return respond(200, { code: 1, data: { list, nextCursor: null } });
    }
    const content = href.match(/\/content\/([^/?]+)/);
    if (content) {
      const pinId = decodeURIComponent(content[1]);
      const body = pins[pinId];
      if (body == null) return respond(404, { code: 0, message: 'not found' });
      return respond(200, body, 'text/plain');
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
  return () => { globalThis.fetch = originalFetch; };
}

function manifest(bot, segments) {
  return JSON.stringify({ bot, botName: bot, updatedAt: 1, segments });
}

function segment(pinId) {
  return { pinId, segment: `hash-${pinId}`, bytes: 1, kinds: ['memory'], objectIds: [`object-${pinId}`] };
}

const BOT_A = { globalMetaId: 'gid-a', name: 'A', type: 'worker', mvcAddress: 'mvc-a' };
const BOT_B = { globalMetaId: 'gid-b', name: 'B', type: 'worker', mvcAddress: 'mvc-b' };
const bots = [BOT_A, BOT_B];

test('probe reports only non-empty backup manifests with bounded concurrency', async () => {
  const { store, sqliteStore } = await makeUserStore();
  const pins = {
    'pin-bots': JSON.stringify({ bots }),
    'pin-manifest-a': manifest('gid-a', [segment('segment-a')]),
    'pin-manifest-b': manifest('gid-b', []),
  };
  const restoreFetch = stubIndexer(pins, {
    [`${USER_GID}|/info/bots`]: ['pin-bots'],
    [`gid-a|${MANIFEST_PATH}`]: ['pin-manifest-a'],
    [`gid-b|${MANIFEST_PATH}`]: ['pin-manifest-b'],
  }, bots);
  try {
    const result = await probeChainBackupAvailability({ userStore: store, baseUrl: 'http://stub.test' });
    assert.deepEqual(result, { success: true, hasBackup: true, botCount: 2, backupBotCount: 1 });
  } finally {
    restoreFetch();
    sqliteStore.close();
  }
});

test('empty manifests and a missing bots manifest do not trigger the restore guide', async () => {
  const first = await makeUserStore();
  const pins = {
    'pin-bots': JSON.stringify({ bots }),
    'pin-manifest-a': manifest('gid-a', []),
    'pin-manifest-b': manifest('gid-b', []),
  };
  const restoreEmpty = stubIndexer(pins, {
    [`${USER_GID}|/info/bots`]: ['pin-bots'],
    [`gid-a|${MANIFEST_PATH}`]: ['pin-manifest-a'],
    [`gid-b|${MANIFEST_PATH}`]: ['pin-manifest-b'],
  }, bots);
  try {
    const result = await probeChainBackupAvailability({ userStore: first.store, baseUrl: 'http://stub.test' });
    assert.deepEqual(result, { success: true, hasBackup: false, botCount: 2, backupBotCount: 0 });
  } finally {
    restoreEmpty();
    first.sqliteStore.close();
  }

  const second = await makeUserStore();
  const restoreMissing = stubIndexer({}, {}, []);
  try {
    const result = await probeChainBackupAvailability({ userStore: second.store, baseUrl: 'http://stub.test' });
    assert.deepEqual(result, { success: true, hasBackup: false, botCount: 0, backupBotCount: 0 });
  } finally {
    restoreMissing();
    second.sqliteStore.close();
  }
});

test('indexer failure is distinguished from no backup', async () => {
  const { store, sqliteStore } = await makeUserStore();
  const failingBot = { globalMetaId: 'gid-error', name: 'bad', type: 'worker', mvcAddress: 'mvc-error' };
  const restoreFetch = stubIndexer(
    { 'pin-bots': JSON.stringify({ bots: [failingBot] }) },
    { [`${USER_GID}|/info/bots`]: ['pin-bots'], __failGlobal: true },
    [failingBot],
  );
  try {
    const result = await probeChainBackupAvailability({ userStore: store, baseUrl: 'http://stub.test' });
    assert.equal(result.success, false, JSON.stringify(result));
    assert.equal(result.hasBackup, false);
    assert.ok(result.error);
  } finally {
    restoreFetch();
    sqliteStore.close();
  }
});

test('restore prompt count placeholders and import integration are wired without a second confirmation', () => {
  const promptSource = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/user/ChainBackupRestorePrompt.tsx'), 'utf8');
  assert.ok(promptSource.includes(".replace('{backup}', String(backupBotCount))"));
  assert.ok(promptSource.includes(".replace('{total}', String(botCount))"));
  assert.ok(promptSource.includes("userSettingsChainBackupImportGuideConfirm"));

  const settingsSource = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/user/UserSettings.tsx'), 'utf8');
  assert.ok(settingsSource.includes('result.chainBackup?.success && result.chainBackup.hasBackup'));
  assert.ok(settingsSource.includes('setChainRestorePrompt(null);\n              void handleChainRestore(true);'));
  assert.ok(settingsSource.includes('if (!skipConfirm && !window.confirm'));

  const i18nSource = fs.readFileSync(path.join(process.cwd(), 'src/renderer/services/i18n.ts'), 'utf8');
  assert.ok(i18nSource.includes("userSettingsChainBackupImportGuideTitle: '发现链上备份'"));
  assert.ok(i18nSource.includes("userSettingsChainBackupImportGuideTitle: 'Chain backup found'"));
});
