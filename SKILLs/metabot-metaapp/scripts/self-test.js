#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');

const {
  buildShareLinks,
  normalizeMetadataObject,
  prepareCreateRequest,
  prepareHomepagePayload,
  prepareUpdateRequest,
  publishPrepared,
  setHomepageMetaApp,
} = require('./index');

const PIN_A = `${'a'.repeat(64)}i0`;
const PIN_B = `${'b'.repeat(64)}i0`;
const PIN_C = `${'c'.repeat(64)}i0`;
const TXID_D = 'd'.repeat(64);

async function testPrepareCreateRequest() {
  const prepared = await prepareCreateRequest({
    appName: 'demo-app',
    runtime: ['browser', 'ios', 'invalid'],
    tags: 'metaapp, demo, metaapp',
    metadata: '{"theme":"dark"}',
    content: './content-placeholder',
    icon: './icon-placeholder.png',
  }, 7, 'mvc', {
    resolveZipResourceFn: async (_request, key) => (
      key === 'content'
        ? { uri: `metafile://${PIN_A}.zip`, localFile: '', packaged: true }
        : { uri: '', localFile: '', packaged: false }
    ),
    resolveImageResourceFn: async (_value, role) => (
      role === 'icon' ? `metafile://${PIN_B}.png` : ''
    ),
    nowIso: () => '2026-07-08T00:00:00.000Z',
  });

  assert.equal(prepared.operation, 'create');
  assert.equal(prepared.path, '/protocols/metaapp');
  assert.equal(prepared.manifest.title, 'demo-app');
  assert.equal(prepared.manifest.content, `metafile://${PIN_A}.zip`);
  assert.equal(prepared.manifest.icon, `metafile://${PIN_B}.png`);
  assert.equal(prepared.manifest.runtime, 'browser/ios');
  assert.equal(prepared.manifest.version, 'v1.0.0');
  assert.equal(prepared.manifest.indexFile, 'index.html');
  assert.deepEqual(prepared.manifest.tags, ['metaapp', 'demo']);
  assert.deepEqual(prepared.manifest.metadata, { theme: 'dark' });
  assert.equal(prepared.metaidData.operation, 'create');
  assert.equal(prepared.metaidData.path, '/protocols/metaapp');
}

async function testPrepareUpdateRequest() {
  const prepared = await prepareUpdateRequest({
    appName: 'demo-app',
    targetPinId: PIN_B,
    firstPinId: PIN_A,
    content: `metafile://${PIN_C}.zip`,
  }, 7, 'mvc', {
    resolveZipResourceFn: async (_request, key) => (
      key === 'content'
        ? { uri: `metafile://${PIN_C}.zip`, localFile: '', packaged: false }
        : { uri: '', localFile: '', packaged: false }
    ),
    resolveImageResourceFn: async () => '',
    nowIso: () => '2026-07-08T00:00:00.000Z',
  });

  assert.equal(prepared.operation, 'modify');
  assert.equal(prepared.path, `@${PIN_B}`);
  assert.equal(prepared.targetPinId, PIN_B);
  assert.equal(prepared.firstPinId, PIN_A);
  assert.equal(prepared.metaidData.operation, 'modify');
  assert.equal(prepared.metaidData.path, `@${PIN_B}`);
}

async function testContentRequired() {
  let failed = false;
  try {
    await prepareCreateRequest({
      appName: 'demo-app',
    }, 7, 'mvc', {
      resolveZipResourceFn: async () => ({ uri: '', localFile: '', packaged: false }),
      resolveImageResourceFn: async () => '',
    });
  } catch (err) {
    failed = /content is required/i.test(String(err && err.message ? err.message : err));
  }
  assert.equal(failed, true);
}

function testMetadataRules() {
  assert.deepEqual(normalizeMetadataObject({ ok: true }), { ok: true });
  assert.deepEqual(normalizeMetadataObject('{"ok":true}'), { ok: true });
  assert.equal(normalizeMetadataObject(''), undefined);

  let failed = false;
  try {
    normalizeMetadataObject('["bad"]');
  } catch (err) {
    failed = /metadata must be a json object/i.test(String(err && err.message ? err.message : err));
  }
  assert.equal(failed, true);
}

function testShareLinks() {
  const share = buildShareLinks(PIN_B, PIN_A);
  assert.equal(share.sharePinId, PIN_A);
  assert.equal(share.metaappUri, `metaapp://${PIN_A}`);
  assert.equal(share.currentMetaappUri, `metaapp://${PIN_B}`);
}

function testHomepagePayload() {
  const payload = prepareHomepagePayload(PIN_A);
  assert.equal(payload.path, '/info/homepage');
  assert.equal(payload.contentType, 'application/json');
  assert.equal(payload.homepage.uri, `metaapp://${PIN_A}`);
  assert.equal(payload.homepage.renderer, 'metaapp');
}

async function testSetHomepageMetaApp() {
  let seenBody = null;
  const result = await setHomepageMetaApp(PIN_A, 7, {
    postJsonFn: async (_url, body) => {
      seenBody = body;
      return {
        success: true,
        homepage: {
          uri: `metaapp://${PIN_A}`,
          renderer: 'metaapp',
          contentType: 'application/vnd.metaapp',
        },
        sync_requested: true,
        sync_result: {
          success: true,
          txids: [TXID_D],
          syncedSteps: ['homepage'],
        },
      };
    },
  });

  assert.ok(seenBody);
  assert.equal(seenBody.metabot_id, 7);
  assert.equal(seenBody.pin_id, PIN_A);
  assert.equal(seenBody.sync, true);
  assert.equal(result.kind, 'metaapp-homepage-selected');
  assert.equal(result.path, '/info/homepage');
  assert.equal(result.homepage.uri, `metaapp://${PIN_A}`);
  assert.deepEqual(result.txids, [TXID_D]);
  assert.deepEqual(result.syncedSteps, ['homepage']);
}

async function testPublishPrepared() {
  const prepared = await prepareCreateRequest({
    appName: 'demo-app',
    content: `metafile://${PIN_A}.zip`,
  }, 7, 'mvc', {
    resolveZipResourceFn: async (_request, key) => (
      key === 'content'
        ? { uri: `metafile://${PIN_A}.zip`, localFile: '', packaged: false }
        : { uri: '', localFile: '', packaged: false }
    ),
    resolveImageResourceFn: async () => '',
  });

  let seenBody = null;
  const result = await publishPrepared(prepared, 7, 'mvc', {
    postJsonFn: async (_url, body) => {
      seenBody = body;
      return {
        success: true,
        pinId: PIN_C,
        txid: TXID_D,
        txids: [TXID_D],
        totalCost: 1234,
      };
    },
  });

  assert.ok(seenBody);
  assert.equal(seenBody.metaidData.operation, 'create');
  assert.equal(seenBody.metaidData.path, '/protocols/metaapp');
  assert.equal(JSON.parse(seenBody.metaidData.payload).appName, 'demo-app');
  assert.equal(result.pinId, PIN_C);
  assert.equal(result.txid, TXID_D);
}

async function main() {
  await testPrepareCreateRequest();
  await testPrepareUpdateRequest();
  await testContentRequired();
  testMetadataRules();
  testShareLinks();
  testHomepagePayload();
  await testSetHomepageMetaApp();
  await testPublishPrepared();
  process.stdout.write('metabot-metaapp self-test passed\n');
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exitCode = 1;
});
