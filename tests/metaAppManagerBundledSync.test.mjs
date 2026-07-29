import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const { MetaAppManager } = require('../dist-electron/main/metaAppManager.js');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeAppDir(root, appId, frontmatter) {
  const dir = path.join(root, appId);
  fs.mkdirSync(dir, { recursive: true });
  const fm = Object.entries({ name: appId, entry: `/${appId}/index.html`, ...frontmatter })
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
  fs.writeFileSync(path.join(dir, 'APP.md'), `---\n${fm}\n---\n\n## When To Use\n`);
  fs.writeFileSync(path.join(dir, 'index.html'), `<html>${appId}</html>\n`);
  return dir;
}

function readUserConfig(userRoot) {
  const configPath = path.join(userRoot, 'metaapps.config.json');
  if (!fs.existsSync(configPath)) return null;
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function withMetaAppsRoot(userRoot, fn) {
  const previous = process.env.IDBOTS_METAAPPS_ROOT;
  if (userRoot == null) {
    delete process.env.IDBOTS_METAAPPS_ROOT;
  } else {
    process.env.IDBOTS_METAAPPS_ROOT = userRoot;
  }
  try {
    return fn();
  } finally {
    if (previous == null) {
      delete process.env.IDBOTS_METAAPPS_ROOT;
    } else {
      process.env.IDBOTS_METAAPPS_ROOT = previous;
    }
  }
}

function makeManager(bundledRoot, { isPackaged = false } = {}) {
  return new MetaAppManager({
    app: { isPackaged, getPath: () => '', getAppPath: () => '' },
    bundledMetaAppsRoot: bundledRoot,
  });
}

const BUNDLED_IDBOTS_APP = {
  version: '1.0.0',
  'creator-metaid': 'idbots',
  'source-type': 'bundled-idbots',
};

const COMMUNITY_APP = {
  version: '2.0.0',
  'creator-metaid': 'idq1communityauthor',
  'source-type': 'chain-community',
  'chain-pinid': 'pin-community-source',
  'chain-code-pinid': 'pin-community-code',
};

test('dev override seeds bundled-idbots and chain-community apps into the user root', (t) => {
  const bundledRoot = makeTempDir('idbots-bundled-');
  const userRoot = makeTempDir('idbots-user-');
  t.after(() => fs.rmSync(bundledRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(userRoot, { recursive: true, force: true }));
  makeAppDir(bundledRoot, 'app-bundled', BUNDLED_IDBOTS_APP);
  makeAppDir(bundledRoot, 'app-community', COMMUNITY_APP);

  withMetaAppsRoot(userRoot, () => {
    makeManager(bundledRoot).syncBundledMetaAppsToUserData();
  });

  assert.equal(fs.readFileSync(path.join(userRoot, 'app-bundled', 'index.html'), 'utf8'), '<html>app-bundled</html>\n');
  assert.equal(fs.readFileSync(path.join(userRoot, 'app-community', 'index.html'), 'utf8'), '<html>app-community</html>\n');
  const config = readUserConfig(userRoot);
  assert.equal(config.defaults['app-bundled']['source-type'], 'bundled-idbots');
  assert.equal(config.defaults['app-community']['source-type'], 'chain-community');
  assert.equal(config.defaults['app-community']['chain-pinid'], 'pin-community-source');
  assert.equal(config.defaults['app-community']['creator-metaid'], 'idq1communityauthor');
});

test('dev override never overwrites an existing community app or its config entry', (t) => {
  const bundledRoot = makeTempDir('idbots-bundled-');
  const userRoot = makeTempDir('idbots-user-');
  t.after(() => fs.rmSync(bundledRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(userRoot, { recursive: true, force: true }));
  makeAppDir(bundledRoot, 'app-community', COMMUNITY_APP);
  makeAppDir(userRoot, 'app-community', { ...COMMUNITY_APP, version: '9.9.9' });
  fs.writeFileSync(path.join(userRoot, 'app-community', 'index.html'), '<html>LOCAL</html>\n');

  withMetaAppsRoot(userRoot, () => {
    makeManager(bundledRoot).syncBundledMetaAppsToUserData();
  });

  assert.equal(fs.readFileSync(path.join(userRoot, 'app-community', 'index.html'), 'utf8'), '<html>LOCAL</html>\n');
  assert.equal(readUserConfig(userRoot), null);
});

test('dev without IDBOTS_METAAPPS_ROOT does not sync anything', (t) => {
  const bundledRoot = makeTempDir('idbots-bundled-');
  t.after(() => fs.rmSync(bundledRoot, { recursive: true, force: true }));
  makeAppDir(bundledRoot, 'app-bundled', BUNDLED_IDBOTS_APP);

  withMetaAppsRoot(null, () => {
    // Without the env override the dev root resolves next to the bundle; the
    // sync must stay a no-op instead of seeding a stray directory.
    makeManager(bundledRoot).syncBundledMetaAppsToUserData();
  });

  const strayRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'dist-electron', 'METAAPPs');
  assert.equal(fs.existsSync(strayRoot), false);
});

test('packaged mode syncs idbots-managed apps but never seeds chain-community apps', (t) => {
  const bundledRoot = makeTempDir('idbots-bundled-');
  const userRoot = makeTempDir('idbots-user-');
  t.after(() => fs.rmSync(bundledRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(userRoot, { recursive: true, force: true }));
  makeAppDir(bundledRoot, 'app-bundled', BUNDLED_IDBOTS_APP);
  makeAppDir(bundledRoot, 'app-community', COMMUNITY_APP);

  withMetaAppsRoot(userRoot, () => {
    makeManager(bundledRoot, { isPackaged: true }).syncBundledMetaAppsToUserData();
  });

  assert.ok(fs.existsSync(path.join(userRoot, 'app-bundled', 'index.html')));
  assert.equal(fs.existsSync(path.join(userRoot, 'app-community')), false);
  const config = readUserConfig(userRoot);
  assert.equal(config.defaults['app-bundled']['source-type'], 'bundled-idbots');
  assert.equal(config.defaults['app-community'], undefined);
});
