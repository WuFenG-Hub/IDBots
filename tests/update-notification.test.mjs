import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Module from 'node:module';
import { createSqliteStore } from './memoryTestUtils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const require = Module.createRequire(import.meta.url);
function loadCompiled(modulePath) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') return { app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() } };
    return originalLoad.call(this, request, ...rest);
  };
  try { return require(modulePath); } finally { Module._load = originalLoad; }
}
const notificationStore = loadCompiled('../dist-electron/main/updateNotificationStore.js');

describe('Update Notification System', () => {
  test('update-notifications.json exists and is valid JSON', () => {
    const filePath = path.join(__dirname, '..', 'update-notifications.json');
    assert.ok(fs.existsSync(filePath), 'update-notifications.json should exist');

    const content = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(content);

    assert.ok(data.notifications, 'Should have notifications array');
    assert.ok(Array.isArray(data.notifications), 'notifications should be an array');
  });

  test('notification structure is valid', () => {
    const filePath = path.join(__dirname, '..', 'update-notifications.json');
    const content = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(content);

    if (data.notifications.length > 0) {
      const notification = data.notifications[0];

      assert.ok(notification.version, 'Should have version');
      assert.ok(notification.minShowVersion, 'Should have minShowVersion');
      assert.ok(notification.title, 'Should have title');
      assert.ok(notification.title.zh, 'Should have Chinese title');
      assert.ok(notification.title.en, 'Should have English title');
      assert.ok(notification.content, 'Should have content');
      assert.ok(notification.content.zh, 'Should have Chinese content');
      assert.ok(notification.content.en, 'Should have English content');
      assert.ok(notification.type, 'Should have type');
    }
  });

  test('version format is valid', () => {
    const filePath = path.join(__dirname, '..', 'update-notifications.json');
    const content = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(content);

    if (data.notifications.length > 0) {
      const notification = data.notifications[0];
      const versionRegex = /^\d+\.\d+\.\d+$/;

      assert.ok(
        versionRegex.test(notification.version),
        `Version ${notification.version} should match semver format`
      );
      assert.ok(
        versionRegex.test(notification.minShowVersion),
        `minShowVersion ${notification.minShowVersion} should match semver format`
      );
    }
  });
});

describe('first-install version resolution (store-level)', () => {
  const TWIN_WALLET = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
  const INSERT_METABOT = [
    "INSERT INTO metabot_wallets (id, mnemonic, path, created_at) VALUES (1, ?, ?, 1)",
    `INSERT INTO metabots (id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key, name, enabled, metaid, globalmetaid, metabot_type, created_by, role, soul, boss_global_metaid, llm_id, allow_chat_skills, bio, goal, created_at, updated_at)
     VALUES (1, 1, 'm','b','d','p','c','Twin',1,'mi','gm','twin','0','r','s','o',NULL,'[]',NULL,NULL,1,1)`,
  ];

  test('a fresh install seeds at the current version', async () => {
    const { store, cleanup } = await createSqliteStore();
    try {
      assert.equal(notificationStore.resolveFirstInstallVersion(store, '1.0.8'), '1.0.8');
      // Seeded exactly once: the second read is stable.
      assert.equal(notificationStore.resolveFirstInstallVersion(store, '1.0.8'), '1.0.8');
    } finally {
      cleanup();
    }
  });

  test('an upgrading user (prior data, no recorded key) seeds at the legacy floor', async () => {
    const { store, cleanup } = await createSqliteStore();
    try {
      const raw = store.getDatabase();
      raw.run(INSERT_METABOT[0], [TWIN_WALLET, "m/44'/10001'/0'/0/0"]);
      raw.run(INSERT_METABOT[1]);
      // Without the evidence probe this user would be misseeded as a fresh
      // 1.0.8 install and never see any upgrade notice.
      assert.equal(notificationStore.resolveFirstInstallVersion(store, '1.0.8'), '1.0.0');
    } finally {
      cleanup();
    }
  });

  test('an existing first_install_version wins over evidence', async () => {
    const { store, cleanup } = await createSqliteStore();
    try {
      store.set('first_install_version', '1.0.3');
      assert.equal(notificationStore.resolveFirstInstallVersion(store, '1.0.8'), '1.0.3');
    } finally {
      cleanup();
    }
  });

  test('viewed markers round-trip per version', async () => {
    const { store, cleanup } = await createSqliteStore();
    try {
      assert.equal(notificationStore.hasViewedNotification(store, '1.0.8'), false);
      notificationStore.markNotificationAsViewed(store, '1.0.8');
      assert.equal(notificationStore.hasViewedNotification(store, '1.0.8'), true);
      assert.equal(notificationStore.hasViewedNotification(store, '1.0.9'), false);
    } finally {
      cleanup();
    }
  });
});
