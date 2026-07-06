import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  clearResolvedPinAssetCache,
  extractPinIdFromReference,
  resolveMetaidAvatarReference,
  resolvePinAssetSource,
} = require('../dist-electron/main/services/pinAssetService.js');

const ERIC_AVATAR_PIN_ID = '92fcff9ceada16c20d26322748e877b2d48dee54cf09770768bb8b27998b90f9i0';

test('resolvePinAssetSource preserves image data URLs returned as text content', async () => {
  clearResolvedPinAssetCache();
  const originalFetch = global.fetch;
  const returnedDataUrl = 'data:image/png;base64,iVBORw==';
  const fetchedUrls = [];

  global.fetch = async (url) => {
    const href = String(url);
    fetchedUrls.push(href);
    if (href.includes('/metafile-indexer/content/')) {
      return new Response(returnedDataUrl, {
        headers: {
          'content-type': 'text/plain',
          'content-length': String(returnedDataUrl.length),
        },
      });
    }
    return new Response('', { status: 404 });
  };

  try {
    const result = await resolvePinAssetSource(`/content/${ERIC_AVATAR_PIN_ID}`);
    assert.equal(result, returnedDataUrl);
    assert.ok(
      fetchedUrls.some((href) => href.includes(`/content/${ERIC_AVATAR_PIN_ID}`)),
      'resolver should request the pin content URL',
    );
  } finally {
    global.fetch = originalFetch;
    clearResolvedPinAssetCache();
  }
});

test('resolvePinAssetSource unwraps legacy text data URL wrappers', async () => {
  const imageDataUrl = 'data:image/png;base64,iVBORw==';
  const wrapped = `data:text/plain;base64,${Buffer.from(imageDataUrl, 'utf8').toString('base64')}`;

  assert.equal(await resolvePinAssetSource(wrapped), imageDataUrl);
});

test('resolvePinAssetSource strips an optional metafile extension before fetching asset bytes', async () => {
  clearResolvedPinAssetCache();
  const originalFetch = global.fetch;
  const fetchedUrls = [];

  global.fetch = async (url) => {
    const href = String(url);
    fetchedUrls.push(href);
    if (href.endsWith(`/${ERIC_AVATAR_PIN_ID}`)) {
      return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
        headers: {
          'content-type': 'image/png',
          'content-length': '4',
        },
      });
    }
    return new Response('', { status: 404 });
  };

  try {
    const result = await resolvePinAssetSource(`metafile://${ERIC_AVATAR_PIN_ID}.png`);
    assert.equal(result, 'data:image/png;base64,iVBORw==');
    assert.ok(
      fetchedUrls.some((href) => href.endsWith(`/${ERIC_AVATAR_PIN_ID}`)),
      'resolver should fetch the stripped pin id without the file extension',
    );
    assert.ok(
      fetchedUrls.every((href) => !href.includes(`/${ERIC_AVATAR_PIN_ID}.png`)),
      'resolver should not request content URLs with the metafile extension still attached',
    );
  } finally {
    global.fetch = originalFetch;
    clearResolvedPinAssetCache();
  }
});

test('extractPinIdFromReference accepts MetaID accelerated avatar URL variants', () => {
  assert.equal(
    extractPinIdFromReference(
      `https://file.metaid.io/metafile-indexer/api/v1/users/avatar/accelerate/${ERIC_AVATAR_PIN_ID}?process=thumbnail`,
    ),
    ERIC_AVATAR_PIN_ID,
  );
  assert.equal(
    extractPinIdFromReference(
      `https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/${ERIC_AVATAR_PIN_ID}?process=thumbnail`,
    ),
    ERIC_AVATAR_PIN_ID,
  );
});

test('extractPinIdFromReference strips optional metafile extensions across supported reference forms', () => {
  assert.equal(
    extractPinIdFromReference(`metafile://${ERIC_AVATAR_PIN_ID}.png?download=1#preview`),
    ERIC_AVATAR_PIN_ID,
  );
  assert.equal(
    extractPinIdFromReference(`/content/${ERIC_AVATAR_PIN_ID}.webp?size=large`),
    ERIC_AVATAR_PIN_ID,
  );
  assert.equal(
    extractPinIdFromReference(
      `https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/${ERIC_AVATAR_PIN_ID}.jpeg?process=thumbnail`,
    ),
    ERIC_AVATAR_PIN_ID,
  );
});

test('resolveMetaidAvatarReference skips empty content placeholders and uses alternate avatar fields', () => {
  assert.equal(
    resolveMetaidAvatarReference({
      avatar: '/content/',
      avatarUrl: `https://file.metaid.io/metafile-indexer/api/v1/users/avatar/accelerate/${ERIC_AVATAR_PIN_ID}?process=thumbnail`,
    }),
    `https://file.metaid.io/metafile-indexer/api/v1/users/avatar/accelerate/${ERIC_AVATAR_PIN_ID}?process=thumbnail`,
  );
  assert.equal(
    resolveMetaidAvatarReference({
      avatar: '',
      avatarPinId: ERIC_AVATAR_PIN_ID,
    }),
    ERIC_AVATAR_PIN_ID,
  );
});
