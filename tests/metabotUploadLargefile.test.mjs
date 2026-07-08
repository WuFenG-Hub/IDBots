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
} = require('../dist-electron/main/services/metaFileUploadShared.js');

const MIB = 1024 * 1024;

test('selectUploadMode keeps files below 5 MiB direct and switches at 5 MiB', () => {
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
    'chunked',
  );

  assert.equal(
    selectUploadMode({
      sizeBytes: 5 * MIB + 1,
    }),
    'chunked',
  );
});

test('validateUploadSize rejects files at or above the 50 MiB hard ceiling', () => {
  assert.equal(validateUploadSize({ sizeBytes: 50 * MIB - 1 }), 50 * MIB - 1);

  assert.throws(
    () =>
      validateUploadSize({
        sizeBytes: 50 * MIB,
      }),
    /50 MiB/,
  );

  assert.throws(
    () =>
      validateUploadSize({
        sizeBytes: 50 * MIB + 1,
      }),
    /50 MiB/,
  );
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

test('buildUploadSuccessPayload returns pinId, metafile URI, and preview URL', () => {
  assert.deepEqual(
    buildUploadSuccessPayload({
      pinId: 'abc123i0',
      fileName: 'demo.png',
      size: 123,
      contentType: 'image/png',
      uploadMode: 'chunked',
    }),
    {
      success: true,
      pinId: 'abc123i0',
      metafileUri: 'metafile://abc123i0.png',
      previewUrl: 'https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/abc123i0',
      fallbackUrl: 'https://file.metaid.io/metafile-indexer/api/v1/files/content/abc123i0',
      fileName: 'demo.png',
      size: 123,
      contentType: 'image/png',
      uploadMode: 'chunked',
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
  });

  assert.equal(payload.success, true);
  assert.equal(payload.pinId, 'pin123i0');
  assert.equal(payload.metafileUri, 'metafile://pin123i0.mp4');
  assert.equal(
    payload.previewUrl,
    'https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/pin123i0',
  );
  assert.equal(
    payload.fallbackUrl,
    'https://file.metaid.io/metafile-indexer/api/v1/files/content/pin123i0',
  );
  assert.equal(payload.fileName, 'clip.mp4');
  assert.equal(payload.size, 1048577);
  assert.equal(payload.contentType, 'video/mp4');
  assert.equal(payload.uploadMode, 'chunked');
});
