import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildMetafileUri,
  selectUploadMode,
  validateUploadSize,
  buildUploadSuccessPayload,
  normalizeRpcUploadResult,
  normalizeUploadNetwork,
} = require('../dist-electron/main/services/metaFileUploadShared.js');

const MIB = 1024 * 1024;

test('selectUploadMode keeps files at or below 5 MiB direct and switches above 5 MiB', () => {
  assert.equal(
    selectUploadMode({
      sizeBytes: 5 * MIB - 1,
    }),
    'direct',
  );

  assert.equal(
    selectUploadMode({
      sizeBytes: 5 * MIB,
    }),
    'direct',
  );

  assert.equal(
    selectUploadMode({
      sizeBytes: 5 * MIB + 1,
    }),
    'chunked',
  );
});

test('validateUploadSize accepts files up to the 50 MiB ceiling and rejects above', () => {
  assert.equal(validateUploadSize({ sizeBytes: 50 * MIB - 1 }), 50 * MIB - 1);
  assert.equal(validateUploadSize({ sizeBytes: 50 * MIB }), 50 * MIB);

  assert.throws(
    () =>
      validateUploadSize({
        sizeBytes: 50 * MIB + 1,
      }),
    /File exceeds maximum upload size/,
  );
});

test('normalizeUploadNetwork accepts mvc, btc, and opcat and rejects doge', () => {
  assert.equal(normalizeUploadNetwork(), 'mvc');
  assert.equal(normalizeUploadNetwork('mvc'), 'mvc');
  assert.equal(normalizeUploadNetwork('BTC'), 'btc');
  assert.equal(normalizeUploadNetwork('opcat'), 'opcat');
  assert.throws(() => normalizeUploadNetwork('doge'), /DOGE is not supported for file upload/);
});

test('buildMetafileUri appends an extension from file name or content type', () => {
  assert.equal(
    buildMetafileUri('abc123i0', { fileName: 'demo.png', contentType: 'application/octet-stream' }),
    'metafile://abc123i0.png',
  );
  assert.equal(
    buildMetafileUri('abc123i0', { contentType: 'text/html; charset=utf-8' }),
    'metafile://abc123i0.html',
  );
  assert.equal(
    buildMetafileUri('abc123i0.zip', { contentType: 'application/zip' }),
    'metafile://abc123i0.zip',
  );
  assert.equal(buildMetafileUri('abc123i0'), 'metafile://abc123i0');
});

test('buildUploadSuccessPayload returns the canonical OAC-aligned result shape', () => {
  assert.deepEqual(
    buildUploadSuccessPayload({
      pinId: 'abc123i0',
      fileName: 'demo.png',
      size: 123,
      contentType: 'image/png',
      uploadMode: 'chunked',
      network: 'mvc',
      txids: ['tx1', 'tx2'],
      totalCost: 55,
      globalMetaId: 'gmid1',
    }),
    {
      success: true,
      pinId: 'abc123i0',
      metafileUri: 'metafile://abc123i0.png',
      previewUrl: 'https://file.metaid.io/metafile-indexer/api/v1/files/content/abc123i0',
      downloadUrl: 'https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/abc123i0',
      metawebUrl: 'https://openagentinternet.org/browser/metafile/abc123i0',
      fileName: 'demo.png',
      size: 123,
      bytes: 123,
      extension: '.png',
      contentType: 'image/png',
      uploadMode: 'chunked',
      network: 'mvc',
      txids: ['tx1', 'tx2'],
      totalCost: 55,
      globalMetaId: 'gmid1',
    },
  );
});

test('normalizeRpcUploadResult preserves the backend JSON contract for the skill script', () => {
  const payload = normalizeRpcUploadResult({
    pinId: 'pin123i0',
    fileName: 'clip.mp4',
    size: 1048577,
    contentType: 'video/mp4',
    uploadMode: 'chunked',
    network: 'mvc',
    txids: ['txid123'],
  });

  assert.equal(payload.success, true);
  assert.equal(payload.pinId, 'pin123i0');
  assert.equal(payload.metafileUri, 'metafile://pin123i0.mp4');
  assert.equal(
    payload.previewUrl,
    'https://file.metaid.io/metafile-indexer/api/v1/files/content/pin123i0',
  );
  assert.equal(
    payload.downloadUrl,
    'https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/pin123i0',
  );
  assert.equal(payload.metawebUrl, 'https://openagentinternet.org/browser/metafile/pin123i0');
  assert.equal(payload.fileName, 'clip.mp4');
  assert.equal(payload.size, 1048577);
  assert.equal(payload.bytes, 1048577);
  assert.equal(payload.extension, '.mp4');
  assert.equal(payload.contentType, 'video/mp4');
  assert.equal(payload.uploadMode, 'chunked');
  assert.equal(payload.network, 'mvc');
  assert.deepEqual(payload.txids, ['txid123']);
  assert.equal('totalCost' in payload, false);
  assert.equal('fallbackUrl' in payload, false);
});
