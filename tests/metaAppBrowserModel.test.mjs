import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMetaAppBrowserUri,
  canOpenMetaAppInBrowser,
} from '../src/renderer/components/metaapps/metaAppLaunch.js';
import {
  localMetaAppToBrowserRecord,
  normalizeMetaAppSourcePinId,
} from '../src/renderer/features/botBrowser/metaAppBrowserModel.js';

test('canOpenMetaAppInBrowser accepts MetaApps with source pin ids', () => {
  assert.equal(canOpenMetaAppInBrowser({ sourcePinId: 'pin123i0' }), true);
});

test('canOpenMetaAppInBrowser rejects blank or missing source pin ids', () => {
  assert.equal(canOpenMetaAppInBrowser({ sourcePinId: '   ' }), false);
  assert.equal(canOpenMetaAppInBrowser({}), false);
  assert.equal(canOpenMetaAppInBrowser(null), false);
});

test('buildMetaAppBrowserUri builds a metaapp uri from the source pin id', () => {
  assert.equal(buildMetaAppBrowserUri({ sourcePinId: 'pin123i0' }), 'metaapp://pin123i0');
});

test('buildMetaAppBrowserUri canonicalizes source pin ids to lowercase', () => {
  assert.equal(buildMetaAppBrowserUri({ sourcePinId: ' PIN123I0 ' }), 'metaapp://pin123i0');
});

test('normalizeMetaAppSourcePinId returns the browser canonical source pin id', () => {
  assert.equal(normalizeMetaAppSourcePinId(' PIN123I0 '), 'pin123i0');
  assert.equal(normalizeMetaAppSourcePinId('   '), '');
  assert.equal(normalizeMetaAppSourcePinId(null), '');
});

test('localMetaAppToBrowserRecord maps an installed MetaApp to an ABC gallery record', () => {
  const app = {
    sourcePinId: ' PIN123I0 ',
    name: 'Demo App',
    creatorMetaId: 'idq1owner',
    prompt: 'Try the demo',
    icon: 'https://example.com/icon.png',
    cover: 'https://example.com/cover.png',
    description: 'Example MetaApp',
    version: '1.2.3',
    entry: 'index.html',
    codePinId: 'code123i0',
    updatedAt: 1_700_000_000_000,
    sourceType: 'community',
  };

  const record = localMetaAppToBrowserRecord(app, 'http://127.0.0.1:17878/metaapps/demo');

  assert.equal(record.pinId, 'pin123i0');
  assert.equal(record.firstPinId, 'pin123i0');
  assert.equal(record.operation, 'local-installed');
  assert.equal(record.title, 'Demo App');
  assert.equal(record.appName, 'Demo App');
  assert.equal(record.prompt, 'Try the demo');
  assert.equal(record.icon, 'https://example.com/icon.png');
  assert.equal(record.coverImg, 'https://example.com/cover.png');
  assert.equal(record.intro, 'Example MetaApp');
  assert.equal(record.version, '1.2.3');
  assert.equal(record.runtime, 'idbots-local');
  assert.equal(record.indexFile, 'index.html');
  assert.equal(record.code, 'metafile://code123i0');
  assert.equal(record.content, 'metafile://code123i0');
  assert.equal(record.codeType, 'application/zip');
  assert.deepEqual(record.tags, []);
  assert.equal(record.ownerGlobalMetaId, 'idq1owner');
  assert.equal(record.network, 'mvc');
  assert.equal(record.localUiUrl, 'http://127.0.0.1:17878/metaapps/demo');
  assert.equal(record.runUrl, 'http://127.0.0.1:17878/metaapps/demo');
  assert.equal(record.contentType, 'text/html');
  assert.equal(record.updatedAt, 1_700_000_000_000);
  assert.equal(record.source, 'community');
  assert.equal(record.raw.app, app);
  assert.equal(record.raw.browserUri, 'metaapp://pin123i0');
});

test('localMetaAppToBrowserRecord returns null without a usable source pin id or resolved url', () => {
  assert.equal(
    localMetaAppToBrowserRecord({ sourcePinId: '' }, 'http://127.0.0.1:17878/metaapps/demo'),
    null,
  );
  assert.equal(localMetaAppToBrowserRecord({ sourcePinId: 'pin123i0' }, '   '), null);
  assert.equal(localMetaAppToBrowserRecord({ sourcePinId: 'pin123i0' }), null);
});

test('localMetaAppToBrowserRecord rejects URLs ABC will not render', () => {
  assert.equal(localMetaAppToBrowserRecord({ sourcePinId: 'pin123i0' }, 'javascript:alert(1)'), null);
  assert.equal(localMetaAppToBrowserRecord({ sourcePinId: 'pin123i0' }, 'ftp://example.com/app'), null);
  assert.equal(localMetaAppToBrowserRecord({ sourcePinId: 'pin123i0' }, '//example.com/app'), null);
  assert.equal(localMetaAppToBrowserRecord({ sourcePinId: 'pin123i0' }, '/metaapps/demo')?.runUrl, '/metaapps/demo');
});
