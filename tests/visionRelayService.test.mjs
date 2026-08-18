/**
 * Vision relay service unit tests.
 *
 * Covers URL derivation, credential resolution order (kv cache ->
 * metaid-free provider -> identity bootstrap), the recognize happy path,
 * backend error envelope mapping, and the one-shot re-bootstrap retry after
 * a rejected relay key. All externals (store/fetch/bootstrap/image codec)
 * are injected; no network, no DB, no Electron.
 */

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';

const require = Module.createRequire(import.meta.url);

function loadCompiledModule(modulePath) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => path.join(process.cwd(), '.cowork-temp', 'vision-relay-test-user-data'),
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

const service = loadCompiledModule('../dist-electron/main/services/visionRelayService.js');
const {
  deriveVisionRecognizeUrl,
  initVisionRelayService,
  resetVisionRelayServiceForTests,
  recognizeImageViaRelay,
  VISION_RELAY_API_KEY_KV,
  VISION_RELAY_BASE_URL_KV,
} = service;

const CHAT_BASE = 'https://www.metaso.network/assist-open-api/v2/assist/llm/v1';

function makeStore(kv = new Map(), appConfig = null) {
  return {
    get: (key) => {
      if (key === 'app_config') return appConfig;
      return kv.has(key) ? kv.get(key) : null;
    },
    set: (key, value) => kv.set(key, value),
    delete: (key) => kv.delete(key),
  };
}

function setupDeps(overrides = {}) {
  const calls = { bootstrap: 0, fetches: [] };
  const deps = {
    getStore: () => overrides.store ?? makeStore(),
    fetchImpl: async (url, init) => {
      calls.fetches.push({ url, init });
      return overrides.fetchImpl
        ? overrides.fetchImpl(url, init, calls.fetches.length)
        : new Response(
            JSON.stringify({
              code: 0,
              message: 'success',
              data: {
                content: 'a black-and-white logo reading Cactus Needle',
                model: 'metaid-free-vision',
                remainingToday: 99,
                usage: { promptTokens: 186, completionTokens: 152, totalTokens: 338, imageTokens: 162 },
              },
            }),
            { status: 200 },
          );
    },
    bootstrapImpl: async () => {
      calls.bootstrap += 1;
      return { apiKey: 'mrk_bootstrapped', baseUrl: CHAT_BASE };
    },
    loadImageBase64Impl: async () => ({ base64: 'anNwZw==', bytes: 4 }),
  };
  initVisionRelayService({ ...deps, ...overrides.deps });
  return calls;
}

beforeEach(() => {
  resetVisionRelayServiceForTests();
});

// ---------------------------------------------------------------------------
// URL derivation
// ---------------------------------------------------------------------------

test('deriveVisionRecognizeUrl strips the /v1 chat tail and appends the vision path', () => {
  assert.equal(
    deriveVisionRecognizeUrl(CHAT_BASE),
    'https://www.metaso.network/assist-open-api/v2/assist/llm/vision/recognize',
  );
  assert.equal(
    deriveVisionRecognizeUrl('https://example.com/assist-open-api/v2/assist/llm/v1/'),
    'https://example.com/assist-open-api/v2/assist/llm/vision/recognize',
  );
  // A base without /v1 still derives (custom gateway).
  assert.equal(
    deriveVisionRecognizeUrl('https://example.com/relay'),
    'https://example.com/relay/vision/recognize',
  );
  assert.throws(() => deriveVisionRecognizeUrl('   '));
});

// ---------------------------------------------------------------------------
// Credential resolution order
// ---------------------------------------------------------------------------

test('credentials prefer the persisted vision kv over provider and bootstrap', async () => {
  const kv = new Map([
    [VISION_RELAY_API_KEY_KV, 'mrk_kv'],
    [VISION_RELAY_BASE_URL_KV, CHAT_BASE],
  ]);
  const calls = setupDeps({ store: makeStore(kv, { providers: { 'metaid-free': { apiKey: 'mrk_provider', baseUrl: CHAT_BASE } } }) });

  await recognizeImageViaRelay({ imageBase64: 'eA==', mimeType: 'image/png' });

  assert.equal(calls.bootstrap, 0, 'kv credentials must skip bootstrap');
  assert.equal(calls.fetches[0].init.headers.Authorization, 'Bearer mrk_kv');
});

test('credentials fall back to the metaid-free provider when no kv entry exists', async () => {
  const calls = setupDeps({
    store: makeStore(new Map(), { providers: { 'metaid-free': { apiKey: 'mrk_provider', baseUrl: CHAT_BASE } } }),
  });

  await recognizeImageViaRelay({ imageBase64: 'eA==' });

  assert.equal(calls.bootstrap, 0, 'provider credentials must skip bootstrap');
  assert.equal(calls.fetches[0].init.headers.Authorization, 'Bearer mrk_provider');
});

test('credentials bootstrap and persist when nothing is provisioned', async () => {
  const kv = new Map();
  const calls = setupDeps({ store: makeStore(kv, null) });

  await recognizeImageViaRelay({ imageBase64: 'eA==' });

  assert.equal(calls.bootstrap, 1);
  assert.equal(calls.fetches[0].init.headers.Authorization, 'Bearer mrk_bootstrapped');
  assert.equal(kv.get(VISION_RELAY_API_KEY_KV), 'mrk_bootstrapped');
  assert.equal(kv.get(VISION_RELAY_BASE_URL_KV), CHAT_BASE);
});

// ---------------------------------------------------------------------------
// Recognize call
// ---------------------------------------------------------------------------

test('recognize sends the downscaled image payload and unwraps the envelope', async () => {
  const calls = setupDeps({});

  const result = await recognizeImageViaRelay({ imagePath: '/tmp/photo.png', prompt: '图里有什么？' });

  const body = JSON.parse(calls.fetches[0].init.body);
  assert.equal(calls.fetches[0].url, 'https://www.metaso.network/assist-open-api/v2/assist/llm/vision/recognize');
  assert.equal(body.imageBase64, 'anNwZw==');
  assert.equal(body.mimeType, 'image/jpeg');
  assert.equal(body.prompt, '图里有什么？');
  assert.equal(result.content, 'a black-and-white logo reading Cactus Needle');
  assert.equal(result.remainingToday, 99);
  assert.equal(result.usage.imageTokens, 162);
});

test('recognize requires an image source', async () => {
  setupDeps({});
  await assert.rejects(() => recognizeImageViaRelay({ prompt: 'no image' }), /imagePath or imageBase64/);
});

test('backend error messages surface verbatim through VisionRelayError', async () => {
  setupDeps({
    fetchImpl: () =>
      new Response(JSON.stringify({ code: 1, message: 'vision daily quota exhausted' }), { status: 200 }),
  });
  await assert.rejects(
    () => recognizeImageViaRelay({ imageBase64: 'eA==' }),
    (error) => {
      assert.match(error.message, /vision daily quota exhausted/);
      assert.equal(error.relayMessage, 'vision daily quota exhausted');
      return true;
    },
  );
});

test('a rejected relay key triggers exactly one re-bootstrap + retry', async () => {
  const kv = new Map([[VISION_RELAY_API_KEY_KV, 'mrk_stale'], [VISION_RELAY_BASE_URL_KV, CHAT_BASE]]);
  const calls = setupDeps({
    store: makeStore(kv, null),
    fetchImpl: (url, init) => {
      const auth = init.headers.Authorization;
      if (auth === 'Bearer mrk_stale') {
        return new Response(JSON.stringify({ code: 1, message: 'relay key invalid or revoked' }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ code: 0, data: { content: 'ok after retry', usage: {}, remainingToday: -1 } }),
        { status: 200 },
      );
    },
  });

  const result = await recognizeImageViaRelay({ imageBase64: 'eA==' });

  assert.equal(calls.bootstrap, 1, 'stale key must trigger one bootstrap');
  assert.equal(calls.fetches.length, 2);
  assert.equal(result.content, 'ok after retry');
  assert.equal(kv.get(VISION_RELAY_API_KEY_KV), 'mrk_bootstrapped');
});

test('an unreadable image file fails fast with a clear error', async () => {
  const calls = setupDeps({
    deps: { loadImageBase64Impl: async () => null },
  });
  await assert.rejects(() => recognizeImageViaRelay({ imagePath: '/tmp/missing.png' }), /could not read image file/);
  assert.equal(calls.fetches.length, 0, 'no relay call for unreadable files');
});
