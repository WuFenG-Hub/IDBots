import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadCleanup() {
  return require('../dist-electron/main/services/legacyManP2pCleanup.js');
}

function makeUserData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-manp2p-cleanup-'));
}

test('findLegacyManP2pData returns null when no man-p2p directory exists', () => {
  const { findLegacyManP2pData } = loadCleanup();
  assert.equal(findLegacyManP2pData(makeUserData()), null);
});

test('findLegacyManP2pData sums real files and skips AppleDouble sidecars', () => {
  const { findLegacyManP2pData } = loadCleanup();
  const userData = makeUserData();
  const dir = path.join(userData, 'man-p2p');
  fs.mkdirSync(path.join(dir, 'man_base_data_pebble'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), 'x'.repeat(100));
  fs.writeFileSync(path.join(dir, 'man_base_data_pebble', '000001.log'), 'y'.repeat(2_048));
  fs.writeFileSync(path.join(dir, '._config.json'), 'sidecar'.repeat(50));

  const legacy = findLegacyManP2pData(userData);
  assert.ok(legacy);
  assert.equal(legacy.dir, dir);
  assert.equal(legacy.sizeBytes, 100 + 2_048);
});

test('findLegacyManP2pData ignores a directory holding only sidecar files', () => {
  const { findLegacyManP2pData } = loadCleanup();
  const userData = makeUserData();
  const dir = path.join(userData, 'man-p2p');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '._anything'), 'sidecar');

  assert.equal(findLegacyManP2pData(userData), null);
});

test('formatDataSize renders human-friendly sizes', () => {
  const { formatDataSize } = loadCleanup();
  assert.equal(formatDataSize(0), '0 MB');
  assert.equal(formatDataSize(-5), '0 MB');
  assert.equal(formatDataSize(5 * 1024 ** 2), '5 MB');
  assert.equal(formatDataSize(500 * 1024 ** 2), '500 MB');
  assert.equal(formatDataSize(1.5 * 1024 ** 3), '1.5 GB');
  assert.equal(formatDataSize(12.6 * 1024 ** 3), '13 GB');
});
