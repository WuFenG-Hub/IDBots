import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

const FIXTURE_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const FIXTURE_PATH = "m/44'/10001'/0'/0/0";
const FIXTURE_GLOBAL_META_ID = 'idq1970463ym8fqmgawe4lylktne97ahhw4kqehkch';

test('compile:electron preserves the root Electron entry layout', () => {
  // The root entry must stay at dist-electron/main.js (flat layout, not nested
  // under dist-electron/main/). Assert the source-level contract instead of the
  // built artifact so the test is independent of how dist-electron was produced
  // (tsc-only worktree builds do not emit the vite electron-plugin bundles).
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.main, 'dist-electron/main.js');

  const viteConfig = readFileSync(path.join(REPO_ROOT, 'vite.config.ts'), 'utf8');
  assert.match(viteConfig, /entry:\s*['"]src\/main\/main\.ts['"]/);
  assert.match(viteConfig, /entry:\s*['"]src\/main\/preload\.ts['"]/);
  const electronBlocks = viteConfig.split(/entry:\s*['"]src\/main\/(?:main|preload)\.ts['"]/);
  for (const block of electronBlocks.slice(1)) {
    assert.match(block, /outDir:\s*['"]dist-electron['"]/);
  }

  const mainSource = readFileSync(path.join(REPO_ROOT, 'src', 'main', 'main.ts'), 'utf8');
  assert.match(mainSource, /path\.join\(__dirname,\s*'\.\.\/dist-electron\/preload\.js'\)/);
});

test('createMetaBotWallet preserves the extracted shared identity semantics', async () => {
  const { createMetaBotWallet } = require('../dist-electron/main/services/metabotWalletService.js');
  const result = await createMetaBotWallet({
    mnemonic: FIXTURE_MNEMONIC,
    path: FIXTURE_PATH,
  });

  assert.deepEqual(result, {
    mnemonic: FIXTURE_MNEMONIC,
    path: FIXTURE_PATH,
    public_key: '0321e4ffeaea35361f12a676a7f48f24bc2b292fdb20d5980fafcc86bc3780370a',
    chat_public_key: '04f6b1d713f8e4a00515996cd2e0fd1f00460c08aa17793bd39d53c15ef6b10531c2485f34c37189e85e7723c90598111a845f31871f3b1bf6d080e60f3e929773',
    mvc_address: '15Lofqw6Kpa6P8WnTYXKvmPyw3UZvvQWrB',
    btc_address: '15Lofqw6Kpa6P8WnTYXKvmPyw3UZvvQWrB',
    doge_address: 'D9UuD6sjdEUNv8hPC8WtUXZapBCsFn67jo',
    metaid: '1dde986762a582142fa908419eed375c76d683c0414ed67bb08cbea8c0fe2b4f',
    globalmetaid: FIXTURE_GLOBAL_META_ID,
    chat_public_key_pin_id: '',
  });
});

test('normalizeRawGlobalMetaId continues to use the shared normalization path', () => {
  const { normalizeRawGlobalMetaId } = require('../dist-electron/main/shared/globalMetaId.js');
  assert.equal(normalizeRawGlobalMetaId(`  ${FIXTURE_GLOBAL_META_ID.toUpperCase()}  `), FIXTURE_GLOBAL_META_ID);
  assert.equal(normalizeRawGlobalMetaId(`metaid:${FIXTURE_GLOBAL_META_ID}`), null);
});
