import test from 'node:test';
import assert from 'node:assert/strict';

const {
  buildMetafileContentUrls,
  verifyMetafileAvailability,
} = await import('../dist-electron/main/services/metafileVerifier.js');

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('buildMetafileContentUrls returns accelerate, content, and legacy content URLs', () => {
  assert.deepEqual(buildMetafileContentUrls('pin123i0'), [
    'https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/pin123i0',
    'https://file.metaid.io/metafile-indexer/api/v1/files/content/pin123i0',
    'https://file.metaid.io/metafile-indexer/content/pin123i0',
  ]);
});

test('verifyMetafileAvailability returns ok on first URL hit', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method || 'GET' });
    return { ok: true, status: 200 };
  };

  const result = await verifyMetafileAvailability({ pinId: 'pin123i0' });

  assert.equal(result.ok, true);
  assert.equal(
    result.url,
    'https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/pin123i0',
  );
  assert.equal(result.attempts, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'HEAD');
});

test('verifyMetafileAvailability falls back to GET on 405', async () => {
  let headCount = 0;
  globalThis.fetch = async (url, init) => {
    if ((init?.method || 'GET') === 'HEAD') {
      headCount += 1;
      return { ok: false, status: 405 };
    }
    return { ok: true, status: 200 };
  };

  const result = await verifyMetafileAvailability({ pinId: 'pin123i0', attempts: 1 });

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.equal(headCount, 1);
});

test('verifyMetafileAvailability fails after all attempts when every URL is unreachable', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 404 });

  const result = await verifyMetafileAvailability({ pinId: 'pin123i0', attempts: 2, delayMs: 1 });

  assert.equal(result.ok, false);
  assert.equal(result.url, null);
  assert.equal(result.attempts, 2);
  assert.match(result.error, /404/);
});
