/**
 * Regression test: the generated man-p2p runtime config must be owner-only (0600).
 *
 * `resolveRuntimeConfigPath()` generates `man-p2p-runtime-config.toml` inside the
 * p2p data dir. That file embeds the whole resolved man-p2p config, including
 * plaintext third-party RPC credentials, so it must be written 0600 — the same
 * convention the sibling `identity.key` already follows (see
 * `src/main/services/p2pIndexerService.ts`).
 *
 * These tests load the COMPILED electron main-process module
 * (`dist-electron/main/services/p2pIndexerService.js`), so the source must be
 * (re)compiled before running:
 *   npx --no-install tsc --project electron-tsconfig.json && node scripts/copy-electron-js.cjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const RUNTIME_CONFIG_FILE_NAME = 'man-p2p-runtime-config.toml';
const PEBBLE_DIR_NAME = 'man_base_data_pebble';
const EXPECTED_MODE = 0o600;
const WIDE_MODE = 0o644;

/**
 * File modes are a POSIX concept: on Windows `fs.statSync().mode` does not
 * reflect `chmod` at all (a plain file reports 0o666), so every assertion in
 * this file — including the self-control — is unobservable there. The shipped
 * fix still runs on Windows (its chmod is simply a no-op), so skipping the
 * whole file keeps it wired into the release gate on POSIX without turning
 * Windows CI red on an assertion the platform cannot express.
 */
const skipOnWindows = process.platform === 'win32'
  ? 'POSIX file modes are not observable on Windows'
  : false;

function patchElectron() {
  const originalLoad = Module._load;
  Module._load = function patchedModuleLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => process.cwd(),
          on: () => {},
        },
        BrowserWindow: {
          getAllWindows: () => [],
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };
  return originalLoad;
}

function loadService() {
  const originalLoad = patchElectron();
  try {
    return require('../dist-electron/main/services/p2pIndexerService.js');
  } finally {
    Module._load = originalLoad;
  }
}

function modeOf(filePath) {
  return fs.statSync(filePath).mode & 0o777;
}

/**
 * `fs.writeFileSync` applies `mode & ~umask`, so the observable default mode
 * depends on the ambient umask. Pin it to the common 0022 to make the red/green
 * signal deterministic instead of host-dependent.
 */
function withFixedUmask(run) {
  const previous = process.umask(0o022);
  try {
    return run();
  } finally {
    process.umask(previous);
  }
}

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-p2p-runtime-mode-'));
  return {
    root,
    dataDir: path.join(root, 'man-p2p'),
    baseConfigPath: path.join(root, 'config.toml'),
  };
}

function writeBaseConfig(baseConfigPath, dirValue) {
  const baseConfig = [
    `dir = "${dirValue}"`,
    'port = "127.0.0.1:7281"',
    '',
  ].join('\n');
  fs.writeFileSync(baseConfigPath, baseConfig, { encoding: 'utf8', mode: WIDE_MODE });
  return baseConfig;
}

test('control: the mode assertion can observe a 0644 file (assertion is not vacuous)', { skip: skipOnWindows }, () => {
  // Self-control for the assertion machinery: if a plain writeFileSync under
  // umask 0022 were to already report 0600, the regression tests below would not
  // prove anything.
  withFixedUmask(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-p2p-mode-control-'));
    const controlPath = path.join(root, 'control.toml');
    fs.writeFileSync(controlPath, 'dir = "/tmp"\n', 'utf8');
    assert.equal(modeOf(controlPath), WIDE_MODE);
  });
});

test('resolveRuntimeConfigPath writes a freshly generated man-p2p runtime config with mode 0600', { skip: skipOnWindows }, () => {
  const { resolveRuntimeConfigPath } = loadService();
  withFixedUmask(() => {
    const { dataDir, baseConfigPath } = makeRoot();
    writeBaseConfig(baseConfigPath, '/opt/man-p2p/data');

    const runtimeConfigPath = resolveRuntimeConfigPath(baseConfigPath, dataDir, {});

    assert.notEqual(
      runtimeConfigPath,
      baseConfigPath,
      'precondition: the base config needed an override, so a runtime config must have been generated',
    );
    assert.equal(runtimeConfigPath, path.join(dataDir, RUNTIME_CONFIG_FILE_NAME));
    assert.equal(fs.existsSync(runtimeConfigPath), true, 'expected the runtime config to exist');
    assert.equal(modeOf(runtimeConfigPath), EXPECTED_MODE);
  });
});

test('resolveRuntimeConfigPath tightens a pre-existing world-readable runtime config to 0600', { skip: skipOnWindows }, () => {
  const { resolveRuntimeConfigPath } = loadService();
  withFixedUmask(() => {
    const { dataDir, baseConfigPath } = makeRoot();
    writeBaseConfig(baseConfigPath, '/opt/man-p2p/data');

    // Simulate an install that already leaked the file before the fix landed.
    const runtimeConfigPath = path.join(dataDir, RUNTIME_CONFIG_FILE_NAME);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(runtimeConfigPath, 'dir = "/stale"\n', { encoding: 'utf8', mode: WIDE_MODE });
    assert.equal(modeOf(runtimeConfigPath), WIDE_MODE, 'precondition: stale file is 0644');

    const returned = resolveRuntimeConfigPath(baseConfigPath, dataDir, {});

    assert.equal(returned, runtimeConfigPath);
    assert.equal(modeOf(runtimeConfigPath), EXPECTED_MODE);
  });
});

test('resolveRuntimeConfigPath leaves the user-provided base config untouched when no runtime override is needed', { skip: skipOnWindows }, () => {
  const { resolveRuntimeConfigPath } = loadService();
  withFixedUmask(() => {
    const { dataDir, baseConfigPath } = makeRoot();
    // `dir` already points at the derived pebble dir, so nothing needs rewriting.
    const baseConfig = writeBaseConfig(baseConfigPath, path.join(dataDir, PEBBLE_DIR_NAME));

    const returned = resolveRuntimeConfigPath(baseConfigPath, dataDir, {});

    assert.equal(returned, baseConfigPath, 'no override is needed, so the base config path is returned');
    assert.equal(
      fs.existsSync(path.join(dataDir, RUNTIME_CONFIG_FILE_NAME)),
      false,
      'no runtime config must be generated',
    );
    assert.equal(fs.readFileSync(baseConfigPath, 'utf8'), baseConfig, 'base config content must be untouched');
    assert.equal(modeOf(baseConfigPath), WIDE_MODE, 'base config mode must be untouched');
  });
});
