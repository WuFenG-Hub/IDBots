import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadRuntimePathsWithElectronStub(exePath = process.execPath) {
  const originalLoad = Module._load;
  Module._load = function patchedModuleLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          getAppPath() {
            return process.cwd();
          },
          getPath() {
            return exePath;
          },
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve('../dist-electron/main/libs/runtimePaths.js')];
    return require('../dist-electron/main/libs/runtimePaths.js');
  } finally {
    Module._load = originalLoad;
  }
}

test('resolveMetabotDistModulePath climbs out of a worktree-like directory when sibling .worktrees/metabot lacks dist output', async () => {
  const runtimePaths = loadRuntimePathsWithElectronStub();
  assert.equal(
    typeof runtimePaths.resolveMetabotDistModulePath,
    'function',
    'resolveMetabotDistModulePath() should be exported',
  );

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-runtime-paths-'));
  const repoRoot = path.join(tempRoot, 'IDBots');
  const worktreeRoot = path.join(repoRoot, '.worktrees', 'feature-a');
  const existingMetabotFile = path.join(repoRoot, 'metabot', 'dist', 'core', 'orders', 'orderLifecycle.js');
  fs.mkdirSync(path.dirname(existingMetabotFile), { recursive: true });
  fs.writeFileSync(existingMetabotFile, 'module.exports = {};');
  fs.mkdirSync(path.join(repoRoot, '.worktrees', 'metabot'), { recursive: true });
  fs.mkdirSync(path.join(worktreeRoot, 'dist-electron'), { recursive: true });

  const resolved = runtimePaths.resolveMetabotDistModulePath('core/orders/orderLifecycle.js', {
    startDir: path.join(worktreeRoot, 'dist-electron'),
  });

  assert.equal(resolved, existingMetabotFile);
});

function withPlatform(platform, run) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return run();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
}

function createMacAppFixture() {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-mac-app-'));
  const mainExe = path.join(appRoot, 'Contents', 'MacOS', 'IDBots');
  const helperExe = path.join(appRoot, 'Contents', 'Frameworks', 'IDBots Helper.app', 'Contents', 'MacOS', 'IDBots Helper');
  fs.mkdirSync(path.dirname(mainExe), { recursive: true });
  fs.mkdirSync(path.dirname(helperExe), { recursive: true });
  fs.writeFileSync(mainExe, 'main');
  fs.writeFileSync(helperExe, 'helper');
  return { mainExe, helperExe };
}

test('macOS skill processes use the LSUIElement helper without changing the DSH executable', () => {
  const { mainExe, helperExe } = createMacAppFixture();
  const runtimePaths = loadRuntimePathsWithElectronStub(mainExe);
  withPlatform('darwin', () => {
    assert.equal(runtimePaths.resolveElectronSkillExecutablePath(), helperExe);
    assert.equal(runtimePaths.resolveElectronExecutablePath(), mainExe);
  });
});

test('macOS skill helper falls back to the main executable when the helper is missing', () => {
  const { mainExe, helperExe } = createMacAppFixture();
  fs.rmSync(helperExe);
  const runtimePaths = loadRuntimePathsWithElectronStub(mainExe);
  withPlatform('darwin', () => {
    assert.equal(runtimePaths.resolveElectronSkillExecutablePath(), mainExe);
  });
});

test('non-macOS skill processes keep the existing Electron executable', () => {
  const { mainExe } = createMacAppFixture();
  const runtimePaths = loadRuntimePathsWithElectronStub(mainExe);
  withPlatform('win32', () => {
    assert.equal(runtimePaths.resolveElectronSkillExecutablePath(), mainExe);
  });
});
