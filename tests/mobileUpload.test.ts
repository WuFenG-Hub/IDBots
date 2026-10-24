/**
 * REQ-E-6 upload unit tests (injected fake transport — no XHR, no canvas).
 * The decision helpers (`shouldReencodePhoto`, `resolveUploadName`) pin the
 * re-encode policy; browser canvas behavior is verified by the integration
 * suite.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_UPLOAD_URL,
  PHOTO_REENCODE_THRESHOLD_BYTES,
  UPLOAD_MAX_BYTES,
  UploadError,
  maybeReencodePhoto,
  resolveUploadName,
  shouldReencodePhoto,
  uploadFile,
  type UploadTransport,
  type UploadTransportRequest,
} from '../src/mobile/bridge/upload';

type TransportHandler = (
  request: UploadTransportRequest,
) => Promise<{ status: number; body: string }> | { status: number; body: string };

const makeFakeTransport = (handler?: TransportHandler) => {
  const requests: UploadTransportRequest[] = [];
  const transport: UploadTransport = {
    async upload(request) {
      requests.push(request);
      if (handler) return handler(request);
      return {
        status: 200,
        body: JSON.stringify({
          path: '/data/workspace/uploads/2026-10-24/uuid-test.png',
          size: request.body.size,
          mime: request.body.type || 'application/octet-stream',
        }),
      };
    },
  };
  return { transport, requests };
};

test('uploadFile refuses files over 25 MB before sending any bytes', async () => {
  const { transport, requests } = makeFakeTransport();
  const oversized = new Blob([new Uint8Array(UPLOAD_MAX_BYTES + 1)]);
  await assert.rejects(uploadFile(oversized, { fetchImpl: transport }), (error: unknown) => {
    assert.ok(error instanceof UploadError);
    assert.equal(error.code, 'TOO_LARGE');
    assert.equal(error.status, 0);
    return true;
  });
  assert.equal(requests.length, 0);
});

test('uploadFile accepts a file exactly at the 25 MB limit', async () => {
  const { transport, requests } = makeFakeTransport();
  const exactly = new Blob([new Uint8Array(0)]);
  Object.defineProperty(exactly, 'size', { value: UPLOAD_MAX_BYTES });
  const result = await uploadFile(exactly, { fetchImpl: transport });
  assert.equal(result.path, '/data/workspace/uploads/2026-10-24/uuid-test.png');
  assert.equal(requests.length, 1);
});

test('uploadFile posts raw bytes with the payload Content-Type and urlencoded name', async () => {
  const { transport, requests } = makeFakeTransport();
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const file = new File([bytes], 'quarterly report.png', { type: 'image/png' });

  const result = await uploadFile(file, { fetchImpl: transport });

  assert.deepEqual(result, {
    path: '/data/workspace/uploads/2026-10-24/uuid-test.png',
    size: 5,
    mime: 'image/png',
  });
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.method, 'POST');
  assert.equal(request.url, `${DEFAULT_UPLOAD_URL}?name=${encodeURIComponent('quarterly report.png')}`);
  assert.equal(request.headers['Content-Type'], 'image/png');
  assert.equal(request.body.size, 5);
  assert.deepEqual(new Uint8Array(await request.body.arrayBuffer()), bytes);
});

test('uploadFile honors an explicit name and url override verbatim', async () => {
  const { transport, requests } = makeFakeTransport();
  const file = new File([new Uint8Array([9])], 'ignored.png', { type: 'image/png' });
  await uploadFile(file, { fetchImpl: transport, name: 'custom name.bin', url: '/custom-upload' });
  assert.equal(
    requests[0].url,
    `/custom-upload?name=${encodeURIComponent('custom name.bin')}`,
  );
});

test('uploadFile falls back to application/octet-stream when the blob has no type', async () => {
  const { transport, requests } = makeFakeTransport();
  await uploadFile(new Blob([new Uint8Array([1])]), { fetchImpl: transport, name: 'x.bin' });
  assert.equal(requests[0].headers['Content-Type'], 'application/octet-stream');
});

test('uploadFile forwards transport progress events to onProgress', async () => {
  const progress: Array<[number, number]> = [];
  const { transport, requests } = makeFakeTransport((request) => {
    request.onProgress?.(40, 100);
    request.onProgress?.(100, 100);
    return { status: 200, body: JSON.stringify({ path: '/data/x', size: 1, mime: 'x/y' }) };
  });
  await uploadFile(new Blob([new Uint8Array([1])]), {
    fetchImpl: transport,
    name: 'a.bin',
    onProgress: (loaded, total) => progress.push([loaded, total]),
  });
  assert.deepEqual(progress, [[40, 100], [100, 100]]);
  assert.equal(requests.length, 1);
});

test('uploadFile maps 413/415/507 to typed UploadError codes with the status', async () => {
  const cases: Array<[number, string]> = [
    [413, 'TOO_LARGE'],
    [415, 'BLOCKED_TYPE'],
    [507, 'QUOTA_EXCEEDED'],
  ];
  for (const [status, code] of cases) {
    const { transport } = makeFakeTransport(() => ({ status, body: `error ${status}` }));
    await assert.rejects(
      uploadFile(new Blob([new Uint8Array([1])]), { fetchImpl: transport, name: 'a.bin' }),
      (error: unknown) => {
        assert.ok(error instanceof UploadError);
        assert.equal(error.code, code);
        assert.equal(error.status, status);
        return true;
      },
    );
  }
});

test('uploadFile maps other HTTP failures to UPLOAD_FAILED with the status', async () => {
  const { transport } = makeFakeTransport(() => ({ status: 500, body: 'boom' }));
  await assert.rejects(
    uploadFile(new Blob([new Uint8Array([1])]), { fetchImpl: transport, name: 'a.bin' }),
    (error: unknown) => {
      assert.ok(error instanceof UploadError);
      assert.equal(error.code, 'UPLOAD_FAILED');
      assert.equal(error.status, 500);
      return true;
    },
  );
});

test('uploadFile maps transport failures to UPLOAD_FAILED with status 0', async () => {
  const { transport } = makeFakeTransport(() => {
    throw new Error('socket hangup');
  });
  await assert.rejects(
    uploadFile(new Blob([new Uint8Array([1])]), { fetchImpl: transport, name: 'a.bin' }),
    (error: unknown) => {
      assert.ok(error instanceof UploadError);
      assert.equal(error.code, 'UPLOAD_FAILED');
      assert.equal(error.status, 0);
      return true;
    },
  );
});

test('uploadFile rejects a 200 with a malformed body as UPLOAD_FAILED', async () => {
  const { transport } = makeFakeTransport(() => ({ status: 200, body: 'not json' }));
  await assert.rejects(
    uploadFile(new Blob([new Uint8Array([1])]), { fetchImpl: transport, name: 'a.bin' }),
    (error: unknown) => {
      assert.ok(error instanceof UploadError);
      assert.equal(error.code, 'UPLOAD_FAILED');
      assert.equal(error.status, 200);
      return true;
    },
  );
});

test('shouldReencodePhoto re-encodes only raster images strictly over 4 MB', () => {
  const over = PHOTO_REENCODE_THRESHOLD_BYTES + 1;
  const at = PHOTO_REENCODE_THRESHOLD_BYTES;
  assert.equal(shouldReencodePhoto({ mime: 'image/png', size: over }), true);
  assert.equal(shouldReencodePhoto({ mime: 'image/jpeg', size: over }), true);
  assert.equal(shouldReencodePhoto({ mime: 'image/webp', size: over }), true);
  assert.equal(shouldReencodePhoto({ mime: 'image/png', size: at }), false);
  assert.equal(shouldReencodePhoto({ mime: 'image/png', size: 1024 }), false);
  // Animated GIFs keep their frames; SVGs keep their vector semantics.
  assert.equal(shouldReencodePhoto({ mime: 'image/gif', size: over }), false);
  assert.equal(shouldReencodePhoto({ mime: 'image/svg+xml', size: over }), false);
  assert.equal(shouldReencodePhoto({ mime: 'application/pdf', size: over }), false);
  assert.equal(shouldReencodePhoto({ mime: '', size: over }), false);
});

test('resolveUploadName honors explicit names and switches re-encoded photos to .jpg', () => {
  const photo = new File([new Uint8Array([1])], 'IMG_0001.HEIC', { type: 'image/heic' });
  assert.equal(resolveUploadName(photo, undefined, false), 'IMG_0001.HEIC');
  assert.equal(resolveUploadName(photo, undefined, true), 'IMG_0001.jpg');
  assert.equal(resolveUploadName(photo, 'keep.heic', true), 'keep.heic');
  const multiDot = new File([new Uint8Array([1])], 'archive.tar.gz', { type: 'image/png' });
  assert.equal(resolveUploadName(multiDot, undefined, true), 'archive.tar.jpg');
  const unnamed = new Blob([new Uint8Array([1])], { type: 'image/png' });
  assert.equal(resolveUploadName(unnamed, undefined, false), 'file');
  assert.equal(resolveUploadName(unnamed, undefined, true), 'file.jpg');
});

test('maybeReencodePhoto returns the same blob for every non-candidate input', async () => {
  const small = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' });
  assert.equal(await maybeReencodePhoto(small), small);
  const gif = new File(
    [new Uint8Array(PHOTO_REENCODE_THRESHOLD_BYTES + 1)],
    'a.gif',
    { type: 'image/gif' },
  );
  assert.equal(await maybeReencodePhoto(gif), gif);
  const pdf = new File(
    [new Uint8Array(PHOTO_REENCODE_THRESHOLD_BYTES + 1)],
    'a.pdf',
    { type: 'application/pdf' },
  );
  assert.equal(await maybeReencodePhoto(pdf), pdf);
});
