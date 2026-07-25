import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = Module.createRequire(import.meta.url);
const {
  forkMetaAppToWorkspace,
  parseMetaAppPinIdFromUri,
  readMetaAppForkMarker,
  METAAPP_FORK_MARKER,
} = require('../dist-electron/main/services/botBrowserMetaAppForkService.js');

const PIN_ID = 'a'.repeat(64) + 'i0';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-fork-test-'));
}

function writeFile(root, relative, content) {
  const filePath = path.join(root, relative);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test('parseMetaAppPinIdFromUri accepts metaapp:// URIs and bare pin ids', () => {
  assert.equal(parseMetaAppPinIdFromUri(`metaapp://${PIN_ID}`), PIN_ID);
  assert.equal(parseMetaAppPinIdFromUri(`metaapp://${PIN_ID.toUpperCase()}`), PIN_ID);
  assert.equal(parseMetaAppPinIdFromUri(PIN_ID), PIN_ID);
  assert.equal(parseMetaAppPinIdFromUri('metaid://abc'), '');
  assert.equal(parseMetaAppPinIdFromUri('metaapp://not-a-pin'), '');
  assert.equal(parseMetaAppPinIdFromUri(''), '');
  assert.equal(parseMetaAppPinIdFromUri(null), '');
});

test('fork from a locally installed MetaApp copies source and writes the marker', async () => {
  const appRoot = makeTempDir();
  const workspace = makeTempDir();
  writeFile(appRoot, 'index.html', '<html>local</html>');
  writeFile(appRoot, 'assets/app.js', 'console.log(1)');
  writeFile(appRoot, METAAPP_FORK_MARKER, '{"sourcePinId":"stale"}');

  const result = await forkMetaAppToWorkspace({
    pinId: PIN_ID,
    workspaceDir: workspace,
    listMetaApps: () => [{ sourcePinId: PIN_ID, appRoot, entry: 'index.html', name: 'My Game' }],
    resolveMetaAppPin: async () => { throw new Error('should not be called'); },
    getMetaAppArtifactDir: async () => { throw new Error('should not be called'); },
  });

  assert.equal(result.title, 'My Game');
  assert.equal(result.sourceUri, `metaapp://${PIN_ID}`);
  assert.equal(fs.readFileSync(path.join(result.dir, 'index.html'), 'utf-8'), '<html>local</html>');
  assert.equal(fs.readFileSync(path.join(result.dir, 'assets/app.js'), 'utf-8'), 'console.log(1)');
  // Stale fork marker must not be copied; a fresh one is written instead.
  const marker = JSON.parse(fs.readFileSync(path.join(result.dir, METAAPP_FORK_MARKER), 'utf-8'));
  assert.equal(marker.sourcePinId, PIN_ID);
  assert.ok(result.dir.startsWith(path.join(workspace, 'metaapp-forks')));
});

test('fork from chain uses the cache artifact after resolving the pin', async () => {
  const artifactDir = makeTempDir();
  const workspace = makeTempDir();
  writeFile(artifactDir, 'index.html', '<html>chain</html>');

  const calls = [];
  const result = await forkMetaAppToWorkspace({
    pinId: PIN_ID,
    workspaceDir: workspace,
    listMetaApps: () => [],
    resolveMetaAppPin: async (pinId) => {
      calls.push(pinId);
      return { ok: true, data: { title: 'Chain App' } };
    },
    getMetaAppArtifactDir: async () => ({ artifactDir, indexFile: 'index.html' }),
  });

  assert.deepEqual(calls, [PIN_ID]);
  assert.equal(result.title, 'Chain App');
  assert.equal(fs.readFileSync(path.join(result.dir, 'index.html'), 'utf-8'), '<html>chain</html>');
});

test('fork fails clearly when the chain MetaApp cannot be resolved', async () => {
  const workspace = makeTempDir();
  await assert.rejects(
    forkMetaAppToWorkspace({
      pinId: PIN_ID,
      workspaceDir: workspace,
      listMetaApps: () => [],
      resolveMetaAppPin: async () => ({ ok: false, code: 'browser_resource_not_found', message: 'nope' }),
      getMetaAppArtifactDir: async () => null,
    }),
    /not found on chain/,
  );
});

test('readMetaAppForkMarker round-trips and tolerates missing markers', async () => {
  const dir = makeTempDir();
  assert.equal(await readMetaAppForkMarker(dir), null);
  fs.writeFileSync(path.join(dir, METAAPP_FORK_MARKER), JSON.stringify({
    sourcePinId: PIN_ID,
    sourceUri: `metaapp://${PIN_ID}`,
    title: 'X',
    forkedAt: 123,
  }));
  const marker = await readMetaAppForkMarker(dir);
  assert.equal(marker?.sourcePinId, PIN_ID);
  assert.equal(marker?.forkedAt, 123);
});
