import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  METAAPP_PIN_ID_PATTERN,
  METAAPP_METAFILE_REFERENCE_PATTERN,
  METAAPP_RUNTIME_OPTIONS,
  buildMetaAppProtocolPayload,
  buildMetaAppCreateWrite,
  buildMetaAppModifyWrite,
  buildMetaAppRevokeWrite,
  bumpVersionValue,
} from '../dist-electron/main/services/metaAppProtocol.js';

test('pin id pattern matches 64-hex + i0', () => {
  assert.ok(METAAPP_PIN_ID_PATTERN.test('a'.repeat(64) + 'i0'));
  assert.ok(!METAAPP_PIN_ID_PATTERN.test('shorti0'));
});

test('metafile reference pattern allows optional extension', () => {
  assert.ok(METAAPP_METAFILE_REFERENCE_PATTERN.test('a'.repeat(64) + 'i0'));
  assert.ok(METAAPP_METAFILE_REFERENCE_PATTERN.test('a'.repeat(64) + 'i0.zip'));
  assert.ok(!METAAPP_METAFILE_REFERENCE_PATTERN.test('notapin'));
});

test('buildMetaAppProtocolPayload requires appName', () => {
  assert.throws(() => buildMetaAppProtocolPayload({ content: 'metafile://abc' }), /appName is required/);
});

test('buildMetaAppProtocolPayload requires content', () => {
  assert.throws(() => buildMetaAppProtocolPayload({ appName: 'X' }), /content is required/);
});

test('content accepts bare pin, metafile://pin, and metafile://pin.ext', () => {
  const pin = 'a'.repeat(64) + 'i0';
  // bare pin
  assert.equal(buildMetaAppProtocolPayload({ appName: 'A', content: pin }).content, `metafile://${pin}`);
  // metafile:// prefixed (what the upload form stores)
  assert.equal(buildMetaAppProtocolPayload({ appName: 'A', content: `metafile://${pin}` }).content, `metafile://${pin}`);
  // metafile:// prefixed with extension
  assert.equal(
    buildMetaAppProtocolPayload({ appName: 'A', content: `metafile://${pin}.zip` }).content,
    `metafile://${pin}.zip`,
  );
  // bare pin with extension
  assert.equal(
    buildMetaAppProtocolPayload({ appName: 'A', content: `${pin}.zip` }).content,
    `metafile://${pin}.zip`,
  );
});

test('image refs accept metafile:// prefixed values too', () => {
  const pin = 'a'.repeat(64) + 'i0';
  const m = buildMetaAppProtocolPayload({
    appName: 'A', content: pin,
    icon: `metafile://${pin}`, coverImg: `metafile://${pin}.png`,
  });
  assert.equal(m.icon, `metafile://${pin}`);
  assert.equal(m.coverImg, `metafile://${pin}.png`);
});

test('buildMetaAppProtocolPayload normalizes defaults', () => {
  const m = buildMetaAppProtocolPayload({
    appName: 'MyApp',
    content: 'a'.repeat(64) + 'i0',
  });
  assert.equal(m.appName, 'MyApp');
  assert.equal(m.title, 'MyApp');
  assert.equal(m.runtime, 'browser');
  assert.equal(m.contentType, 'application/zip');
  assert.equal(m.content, 'metafile://' + 'a'.repeat(64) + 'i0');
  assert.deepEqual(m.tags, []);
  assert.equal(m.disabled, false);
});

test('buildMetaAppProtocolPayload serializes runtime array joined by /', () => {
  const m = buildMetaAppProtocolPayload({
    appName: 'A', content: 'a'.repeat(64) + 'i0', runtime: ['browser', 'ios', 'browser'],
  });
  assert.equal(m.runtime, 'browser/ios');
});

test('buildMetaAppProtocolPayload rejects invalid contentType', () => {
  assert.throws(
    () => buildMetaAppProtocolPayload({ appName: 'A', content: 'a'.repeat(64) + 'i0', contentType: 'bad/type' }),
    /contentType/,
  );
});

test('buildMetaAppCreateWrite shapes create operation', () => {
  const m = { appName: 'A' };
  const w = buildMetaAppCreateWrite(m);
  assert.equal(w.operation, 'create');
  assert.equal(w.path, '/protocols/metaapp');
  assert.equal(w.contentType, 'application/json');
  assert.equal(w.payload, JSON.stringify(m));
});

test('buildMetaAppModifyWrite shapes modify at @target', () => {
  const pin = 'a'.repeat(64) + 'i0';
  const w = buildMetaAppModifyWrite(pin, { appName: 'A' });
  assert.equal(w.operation, 'modify');
  assert.equal(w.path, '@' + pin);
  assert.equal(w.payload, JSON.stringify({ appName: 'A' }));
});

test('buildMetaAppModifyWrite rejects invalid target', () => {
  assert.throws(() => buildMetaAppModifyWrite('bad', { appName: 'A' }), /targetPinId/);
});

test('buildMetaAppRevokeWrite shapes revoke with empty payload', () => {
  const pin = 'a'.repeat(64) + 'i0';
  const w = buildMetaAppRevokeWrite(pin);
  assert.equal(w.operation, 'revoke');
  assert.equal(w.path, '@' + pin);
  assert.equal(w.payload, '');
});

test('bumpVersionValue increments last numeric segment', () => {
  assert.equal(bumpVersionValue('v1.0.0'), 'v1.0.1');
  assert.equal(bumpVersionValue('v2'), 'v3');
  assert.equal(bumpVersionValue('v1.2.3'), 'v1.2.4');
  assert.equal(bumpVersionValue('noversion'), 'noversion.1');
  assert.equal(bumpVersionValue(''), 'v1.0.1');
});

test('runtime options include the six values', () => {
  assert.deepEqual(METAAPP_RUNTIME_OPTIONS, ['browser', 'android', 'ios', 'windows', 'macOS', 'linux']);
});
