/**
 * JEV relay service unit tests.
 *
 * Covers the free-provider credential chain (in-memory cache -> jevRelay kv
 * -> metaid-free provider -> identity bootstrap), the runtime cerebellum
 * config injection (typesafe passthrough / free key injection / silent off),
 * and the one-shot 401 re-bootstrap retry wrapper. All externals
 * (store/bootstrap) are injected; no network, no DB, no Electron.
 */

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);

const service = require('../dist-electron/main/services/jevRelayService.js');
const {
  initJevRelayService,
  resetJevRelayServiceForTests,
  resolveJevRelayCredentials,
  resolveCerebellumRuntimeConfig,
  createJevRelayFetchWithKeyRetry,
  JEV_RELAY_API_KEY_KV,
  JEV_RELAY_BASE_URL_KV,
} = service;

const CHAT_BASE = 'https://www.metaso.network/assist-open-api/v2/assist/llm/v1';
const FREE_CEREBELLUM_CONFIG = {
  cerebellum: {
    enabled: true,
    provider: 'idbots-jev-free',
    apiKey: '',
    baseUrl: '',
    model: '',
  },
};

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
  const calls = { bootstrap: 0 };
  const deps = {
    getStore: () => overrides.store ?? makeStore(),
    bootstrapImpl: overrides.bootstrapImpl ?? (async () => {
      calls.bootstrap += 1;
      if (overrides.bootstrapError) {
        throw new Error(overrides.bootstrapError);
      }
      return { apiKey: `mrk_boot${calls.bootstrap}`, baseUrl: CHAT_BASE };
    }),
  };
  initJevRelayService(deps);
  return calls;
}

beforeEach(() => {
  resetJevRelayServiceForTests();
});

// ---------------------------------------------------------------------------
// Credential chain
// ---------------------------------------------------------------------------

test('resolveJevRelayCredentials: jevRelay kv wins without bootstrapping', async () => {
  const calls = setupDeps({
    store: makeStore(new Map([
      [JEV_RELAY_API_KEY_KV, 'mrk_kv'],
      [JEV_RELAY_BASE_URL_KV, CHAT_BASE],
    ])),
  });
  const credentials = await resolveJevRelayCredentials();
  assert.deepEqual(credentials, { apiKey: 'mrk_kv', baseUrl: CHAT_BASE });
  assert.equal(calls.bootstrap, 0);
});

test('resolveJevRelayCredentials: metaid-free provider is used and persisted to kv', async () => {
  const kv = new Map();
  const calls = setupDeps({
    store: makeStore(kv, {
      providers: {
        'metaid-free': { apiKey: 'mrk_provider', baseUrl: CHAT_BASE },
      },
    }),
  });
  const credentials = await resolveJevRelayCredentials();
  assert.deepEqual(credentials, { apiKey: 'mrk_provider', baseUrl: CHAT_BASE });
  assert.equal(calls.bootstrap, 0);
  assert.equal(kv.get(JEV_RELAY_API_KEY_KV), 'mrk_provider');
  assert.equal(kv.get(JEV_RELAY_BASE_URL_KV), CHAT_BASE);
});

test('resolveJevRelayCredentials: bootstrap is the last resort and persists', async () => {
  const kv = new Map();
  const calls = setupDeps({ store: makeStore(kv) });
  const credentials = await resolveJevRelayCredentials();
  assert.equal(credentials.apiKey, 'mrk_boot1');
  assert.equal(calls.bootstrap, 1);
  assert.equal(kv.get(JEV_RELAY_API_KEY_KV), 'mrk_boot1');
  // Subsequent resolutions ride the in-memory cache: no extra bootstrap.
  await resolveJevRelayCredentials();
  assert.equal(calls.bootstrap, 1);
});

// ---------------------------------------------------------------------------
// Runtime cerebellum config
// ---------------------------------------------------------------------------

test('resolveCerebellumRuntimeConfig: typesafe config passes through untouched', async () => {
  setupDeps({ store: makeStore() });
  const config = await resolveCerebellumRuntimeConfig({
    cerebellum: {
      enabled: true,
      provider: 'typesafe-jev',
      apiKey: 'sk-direct',
      baseUrl: 'https://api.typesafe.ai',
      model: 'jev-preview',
    },
  });
  assert.deepEqual(config, {
    provider: 'typesafe-jev',
    apiKey: 'sk-direct',
    baseUrl: 'https://api.typesafe.ai',
    model: 'jev-preview',
  });
});

test('resolveCerebellumRuntimeConfig: free provider gets the chain key injected', async () => {
  const calls = setupDeps({
    store: makeStore(new Map([
      [JEV_RELAY_API_KEY_KV, 'mrk_live'],
      [JEV_RELAY_BASE_URL_KV, CHAT_BASE],
    ])),
  });
  const config = await resolveCerebellumRuntimeConfig(FREE_CEREBELLUM_CONFIG);
  assert.deepEqual(config, {
    provider: 'idbots-jev-free',
    apiKey: 'mrk_live',
    baseUrl: 'https://www.metaso.network/assist-open-api/v2/assist/llm/jev',
    model: 'jev-latest',
  });
  assert.equal(calls.bootstrap, 0);
});

test('resolveCerebellumRuntimeConfig: free provider without credentials maps to null (silent off)', async () => {
  setupDeps({ store: makeStore(), bootstrapError: 'offline' });
  assert.equal(await resolveCerebellumRuntimeConfig(FREE_CEREBELLUM_CONFIG), null);
});

test('resolveCerebellumRuntimeConfig: disabled cerebellum maps to null without a bootstrap', async () => {
  const calls = setupDeps({ store: makeStore() });
  assert.equal(await resolveCerebellumRuntimeConfig({ cerebellum: { enabled: false, provider: 'idbots-jev-free' } }), null);
  assert.equal(calls.bootstrap, 0);
});

// ---------------------------------------------------------------------------
// 401 re-bootstrap retry wrapper
// ---------------------------------------------------------------------------

function makeResponse(status) {
  return { ok: status >= 200 && status < 300, status };
}

test('createJevRelayFetchWithKeyRetry: non-401 responses pass through with one request', async () => {
  setupDeps({
    store: makeStore(new Map([
      [JEV_RELAY_API_KEY_KV, 'mrk_live'],
      [JEV_RELAY_BASE_URL_KV, CHAT_BASE],
    ])),
  });
  const fetches = [];
  const wrapped = createJevRelayFetchWithKeyRetry(async (url, init) => {
    fetches.push({ url, init });
    return makeResponse(200);
  });
  const response = await wrapped('https://relay.example/v1/systemone', {
    method: 'POST',
    headers: { Authorization: 'Bearer mrk_live' },
  });
  assert.equal(response.status, 200);
  assert.equal(fetches.length, 1);
});

test('createJevRelayFetchWithKeyRetry: 401 re-bootstraps once and retries with the fresh key', async () => {
  const kv = new Map([
    [JEV_RELAY_API_KEY_KV, 'mrk_revoked'],
    [JEV_RELAY_BASE_URL_KV, CHAT_BASE],
  ]);
  const calls = setupDeps({ store: makeStore(kv) });
  const fetches = [];
  const wrapped = createJevRelayFetchWithKeyRetry(async (url, init) => {
    fetches.push({ url, init });
    // First call rides the revoked key; the retry (mrk_boot1) succeeds.
    return makeResponse(init.headers.Authorization === 'Bearer mrk_boot1' ? 200 : 401);
  });
  const response = await wrapped('https://relay.example/v1/systemone', {
    method: 'POST',
    headers: { Authorization: 'Bearer mrk_revoked', 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 200);
  assert.equal(fetches.length, 2);
  assert.equal(calls.bootstrap, 1);
  assert.equal(fetches[1].init.headers.Authorization, 'Bearer mrk_boot1');
  assert.equal(fetches[1].init.headers['Content-Type'], 'application/json');
  assert.equal(fetches[1].init.body, '{}');
  // The stale kv entry was replaced by the fresh bootstrap key.
  assert.equal(kv.get(JEV_RELAY_API_KEY_KV), 'mrk_boot1');
});

test('createJevRelayFetchWithKeyRetry: a second 401 is returned as-is (no retry storm)', async () => {
  const kv = new Map([
    [JEV_RELAY_API_KEY_KV, 'mrk_revoked'],
    [JEV_RELAY_BASE_URL_KV, CHAT_BASE],
  ]);
  const calls = setupDeps({ store: makeStore(kv) });
  const fetches = [];
  const wrapped = createJevRelayFetchWithKeyRetry(async (url, init) => {
    fetches.push(init);
    return makeResponse(401);
  });
  const response = await wrapped('https://relay.example/v1/systemone', {
    method: 'POST',
    headers: { Authorization: 'Bearer mrk_revoked' },
  });
  assert.equal(response.status, 401);
  assert.equal(fetches.length, 2);
  assert.equal(calls.bootstrap, 1);
});

test('createJevRelayFetchWithKeyRetry: bootstrap failure during retry returns the original 401', async () => {
  setupDeps({ store: makeStore(), bootstrapError: 'offline' });
  const fetches = [];
  const wrapped = createJevRelayFetchWithKeyRetry(async (url, init) => {
    fetches.push(init);
    return makeResponse(401);
  });
  const response = await wrapped('https://relay.example/v1/systemone', {
    method: 'POST',
    headers: { Authorization: 'Bearer mrk_dead' },
  });
  assert.equal(response.status, 401);
  assert.equal(fetches.length, 1);
});

// ---------------------------------------------------------------------------
// First-sentence latency (2026-10-15): the caller's AbortSignal must bound
// the whole wrapper, re-bootstrap included. The decision call sites run 1.5s
// budgets; an identity-signed bootstrap took 15s+ and used to blow through
// the deadline because nothing raced the signal on that path.
// ---------------------------------------------------------------------------

test('createJevRelayFetchWithKeyRetry: already-aborted signal skips the re-bootstrap entirely', async () => {
  const calls = setupDeps({ store: makeStore() });
  const fetches = [];
  const wrapped = createJevRelayFetchWithKeyRetry(async (url, init) => {
    fetches.push(init);
    return makeResponse(401);
  });
  const controller = new AbortController();
  controller.abort();
  const response = await wrapped('https://relay.example/v1/systemone', {
    method: 'POST',
    headers: { Authorization: 'Bearer mrk_revoked' },
    signal: controller.signal,
  });
  assert.equal(response.status, 401);
  assert.equal(fetches.length, 1);
  assert.equal(calls.bootstrap, 0);
});

test('createJevRelayFetchWithKeyRetry: a signal firing mid-bootstrap returns the 401 promptly and the shared bootstrap still lands', async () => {
  let releaseBootstrap;
  const bootstrapGate = new Promise((resolve) => { releaseBootstrap = resolve; });
  const calls = setupDeps({
    store: makeStore(),
    bootstrapImpl: async () => {
      calls.bootstrap += 1;
      await bootstrapGate;
      return { apiKey: 'mrk_boot1', baseUrl: CHAT_BASE };
    },
  });
  const fetches = [];
  const wrapped = createJevRelayFetchWithKeyRetry(async (url, init) => {
    fetches.push(init);
    return makeResponse(401);
  });
  const controller = new AbortController();
  const pending = wrapped('https://relay.example/v1/systemone', {
    method: 'POST',
    headers: { Authorization: 'Bearer mrk_revoked' },
    signal: controller.signal,
  });
  // Abort while the bootstrap is still in flight: the wrapper must settle
  // with the original 401 instead of waiting the bootstrap out.
  setTimeout(() => controller.abort(), 10);
  const settledAt = Date.now();
  const response = await pending;
  assert.equal(response.status, 401);
  assert.ok(Date.now() - settledAt < 5000, 'wrapper settles shortly after the abort, not after the bootstrap');
  assert.equal(fetches.length, 1);
  // The shared bootstrap keeps running and caches the fresh key for the
  // NEXT turn — no second bootstrap, no lost credentials.
  releaseBootstrap();
  const credentials = await resolveJevRelayCredentials();
  assert.equal(credentials.apiKey, 'mrk_boot1');
  assert.equal(calls.bootstrap, 1);
});

test('resolveJevRelayCredentials: concurrent cold resolves share one bootstrap flight', async () => {
  const calls = setupDeps({ store: makeStore() });
  const [a, b, c] = await Promise.all([
    resolveJevRelayCredentials(),
    resolveJevRelayCredentials(),
    resolveJevRelayCredentials(),
  ]);
  assert.equal(a.apiKey, 'mrk_boot1');
  assert.equal(b.apiKey, 'mrk_boot1');
  assert.equal(c.apiKey, 'mrk_boot1');
  assert.equal(calls.bootstrap, 1);
});

test('resolveJevRelayCredentials: a failed bootstrap flight does not latch — the next call retries', async () => {
  let failFirst = true;
  const calls = setupDeps({
    store: makeStore(),
    bootstrapImpl: async () => {
      calls.bootstrap += 1;
      if (failFirst) {
        failFirst = false;
        throw new Error('relay unreachable');
      }
      return { apiKey: 'mrk_boot2', baseUrl: CHAT_BASE };
    },
  });
  await assert.rejects(() => resolveJevRelayCredentials(), /relay unreachable/);
  const credentials = await resolveJevRelayCredentials();
  assert.equal(credentials.apiKey, 'mrk_boot2');
  assert.equal(calls.bootstrap, 2);
});
