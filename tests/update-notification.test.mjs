import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
