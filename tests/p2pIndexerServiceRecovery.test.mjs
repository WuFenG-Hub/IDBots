import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');

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

function loadTestUtils() {
  const originalLoad = patchElectron();
  try {
    const mod = require('../dist-electron/main/services/p2pIndexerService.js');
    return mod.__p2pIndexerServiceTestUtils;
  } finally {
    Module._load = originalLoad;
  }
}

test('analyzeStartupFailure marks pebble WAL panic as recoverable local data corruption', () => {
  const utils = loadTestUtils();
  assert.ok(utils, 'Expected __p2pIndexerServiceTestUtils to be exported');

  const analysis = utils.analyzeStartupFailure({
    exitCode: 2,
    signal: null,
    logLines: [
      '2026/03/28 [JOB 1] WAL file C:\\Users\\x\\AppData\\Roaming\\IDBots\\man-p2p\\man_base_data_pebble\\pins_0\\db\\000004.log with log number 000004 stopped reading at offset: 0',
      'panic: runtime error: invalid memory address or nil pointer dereference',
      'github.com/cockroachdb/pebble.Open',
    ],
  });

  assert.equal(analysis.likelyDataCorruption, true);
  assert.match(analysis.summary, /corrupted local p2p data/i);
});

test('analyzeStartupFailure marks DB lock conflict (resource temporarily unavailable) as lock conflict, not corruption', () => {
  const utils = loadTestUtils();
  assert.ok(utils, 'Expected __p2pIndexerServiceTestUtils to be exported');

  const analysis = utils.analyzeStartupFailure({
    exitCode: 2,
    signal: null,
    logLines: [
      '========NEW PEBBLE DATABASE========',
      '2026/08/10 18:09:55 resource temporarily unavailable',
      'panic: runtime error: invalid memory address or nil pointer dereference',
      'man-p2p/pebblestore.(*Database).StatPinSortTable(0x0)',
    ],
  });

  assert.equal(analysis.likelyDataCorruption, false);
  assert.equal(analysis.likelyDbLockConflict, true);
  assert.match(analysis.summary, /another man-p2p instance/i);
});

test('analyzeStartupFailure marks explicit pebble lock-held message as lock conflict, not corruption', () => {
  const utils = loadTestUtils();
  assert.ok(utils, 'Expected __p2pIndexerServiceTestUtils to be exported');

  const analysis = utils.analyzeStartupFailure({
    exitCode: 1,
    signal: null,
    logLines: [
      'pebble: lock held by another process',
      'panic: runtime error: invalid memory address or nil pointer dereference',
    ],
  });

  assert.equal(analysis.likelyDataCorruption, false);
  assert.equal(analysis.likelyDbLockConflict, true);
});

test('analyzeStartupFailure does not mark generic timeout/network issue as data corruption', () => {
  const utils = loadTestUtils();
  assert.ok(utils, 'Expected __p2pIndexerServiceTestUtils to be exported');

  const analysis = utils.analyzeStartupFailure({
    exitCode: null,
    signal: null,
    logLines: [
      'bootstrap peer dial timeout',
      'retrying gossip sync',
    ],
  });

  assert.equal(analysis.likelyDataCorruption, false);
});

test('start adopts an existing healthy local man-p2p instead of spawning a duplicate', async () => {
  const originalLoad = patchElectron();
  const originalSpawn = require('node:child_process').spawn;
  const originalFetch = globalThis.fetch;
  let spawnCalled = false;
  try {
    require('node:child_process').spawn = () => {
      spawnCalled = true;
      throw new Error('start() must not spawn when a healthy man-p2p is already running');
    };
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.endsWith('/health')) {
        return { ok: true, status: 200, json: async () => ({ status: 'ok' }) };
      }
      if (href.endsWith('/api/p2p/status')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: 1,
            message: 'ok',
            data: { running: true, peerId: '12D3KooWNVkPhRvongDjRWn7CZXhZxdWcmu3XxpBHps3ousnbiBH', listenAddrs: [] },
          }),
        };
      }
      throw new Error('unexpected fetch: ' + href);
    };

    const mod = require('../dist-electron/main/services/p2pIndexerService.js');
    await mod.start(process.cwd(), process.cwd());

    assert.equal(spawnCalled, false, 'expected adoption to skip spawning');
    assert.equal(mod.getP2PStatus().running, true);
    await mod.stop();
  } finally {
    require('node:child_process').spawn = originalSpawn;
    globalThis.fetch = originalFetch;
    Module._load = originalLoad;
  }
});

test('recoverCorruptedPebbleDataDir moves pebble directory to timestamped backup', () => {
  const utils = loadTestUtils();
  assert.ok(utils, 'Expected __p2pIndexerServiceTestUtils to be exported');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-p2p-recover-'));
  const pebbleDir = path.join(root, 'man_base_data_pebble');
  fs.mkdirSync(path.join(pebbleDir, 'pins_0', 'db'), { recursive: true });
  fs.writeFileSync(path.join(pebbleDir, 'pins_0', 'db', '000004.log'), 'wal', 'utf8');

  const result = utils.recoverCorruptedPebbleDataDir(
    root,
    new Date('2026-04-01T02:03:04.000Z'),
  );

  assert.equal(result.recovered, true);
  assert.equal(fs.existsSync(pebbleDir), false);
  assert.ok(result.backupPath, 'Expected backupPath to be returned');
  assert.equal(fs.existsSync(result.backupPath), true);
  assert.match(path.basename(result.backupPath), /^man_base_data_pebble\.corrupt\./);
});
