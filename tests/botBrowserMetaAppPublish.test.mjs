import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

const require = Module.createRequire(import.meta.url);

function loadCompiledModule(modulePath) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-publish-test-userdata-')),
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

const { publishMetaAppFromDirectory } = loadCompiledModule('../dist-electron/main/services/botBrowserMetaAppPublishService.js');
const { METAAPP_FORK_MARKER } = loadCompiledModule('../dist-electron/main/services/botBrowserMetaAppForkService.js');

const SOURCE_PIN = 'b'.repeat(64) + 'i0';
const ZIP_PIN = 'c'.repeat(64) + 'i0';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-publish-test-'));
}

function writeAppDir(workspace, marker = null) {
  const dir = path.join(workspace, 'metaapp-forks', 'game');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<html>v2</html>');
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log(2)');
  if (marker) {
    fs.writeFileSync(path.join(dir, METAAPP_FORK_MARKER), JSON.stringify(marker));
  }
  return dir;
}

function makeDeps(calls) {
  return {
    uploadMetaFile: async (_store, params) => {
      calls.upload = params;
      return { pinId: ZIP_PIN };
    },
    publishMetaApp: async (_store, _metabotId, manifest, options) => {
      calls.manifest = manifest;
      calls.options = options;
      return {
        pinId: 'd'.repeat(64) + 'i0',
        chainWrite: { txids: ['tx'], pinId: 'd'.repeat(64) + 'i0', totalCost: 1234 },
        metaappUri: `metaapp://${'d'.repeat(64)}i0`,
        metawebUrl: 'https://metaweb.world/metaapp/x',
      };
    },
  };
}

test('publish zips the directory, excludes the fork marker, and maps manifest fields', async () => {
  const workspace = makeTempDir();
  const dir = writeAppDir(workspace, {
    sourcePinId: SOURCE_PIN,
    sourceUri: `metaapp://${SOURCE_PIN}`,
    title: 'Cool Game',
    indexFile: 'index.html',
    forkedAt: 1,
  });

  const calls = {};
  const result = await publishMetaAppFromDirectory({
    dir,
    workspaceDir: workspace,
    metabotId: 1,
    prompt: 'make it dark mode',
    metabotStore: {},
    confirmPublish: async (details) => {
      calls.confirmDetails = details;
      return true;
    },
    deps: makeDeps(calls),
  });

  // Confirmation dialog saw the right summary
  assert.equal(calls.confirmDetails.title, 'Cool Game');
  assert.equal(calls.confirmDetails.forkedFrom, SOURCE_PIN);

  // Zip uploaded with the marker excluded
  const zip = new AdmZip(calls.upload.data);
  const entries = zip.getEntries().map((entry) => entry.entryName).sort();
  assert.deepEqual(entries, ['assets/app.js', 'index.html']);

  // Manifest maps provenance and prompt
  assert.equal(calls.manifest.forkedFrom, SOURCE_PIN);
  assert.equal(calls.manifest.prompt, 'make it dark mode');
  assert.equal(calls.manifest.content, `metafile://${ZIP_PIN}.zip`);
  assert.equal(calls.manifest.indexFile, 'index.html');
  assert.equal(calls.manifest.title, 'Cool Game');
  assert.deepEqual(calls.options, { confirm: true });
  assert.equal(result.totalCost, 1234);
});

test('publish aborts cleanly when the user cancels the confirmation dialog', async () => {
  const workspace = makeTempDir();
  const dir = writeAppDir(workspace);
  const calls = {};
  await assert.rejects(
    publishMetaAppFromDirectory({
      dir,
      workspaceDir: workspace,
      metabotId: 1,
      metabotStore: {},
      confirmPublish: async () => false,
      deps: makeDeps(calls),
    }),
    /user_cancelled/,
  );
  assert.equal(calls.upload, undefined);
  assert.equal(calls.manifest, undefined);
});

test('publish refuses directories outside the session workspace', async () => {
  const workspace = makeTempDir();
  const outside = writeAppDir(makeTempDir());
  await assert.rejects(
    publishMetaAppFromDirectory({
      dir: outside,
      workspaceDir: workspace,
      metabotId: 1,
      metabotStore: {},
      confirmPublish: async () => true,
      deps: makeDeps({}),
    }),
    /inside the session workspace/,
  );
});

test('publish requires the entry file to exist', async () => {
  const workspace = makeTempDir();
  const dir = path.join(workspace, 'empty-app');
  fs.mkdirSync(dir, { recursive: true });
  await assert.rejects(
    publishMetaAppFromDirectory({
      dir,
      workspaceDir: workspace,
      metabotId: 1,
      metabotStore: {},
      confirmPublish: async () => true,
      deps: makeDeps({}),
    }),
    /Entry file not found/,
  );
});
