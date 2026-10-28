import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRelayCatalogRefresh } = require('../dist-electron/main/services/relayCatalogFreshness.js');

function makeStore(initial) {
  let config = initial;
  const writes = [];
  return {
    store: {
      get: (key) => (key === 'app_config' ? config : null),
      set: (key, value) => {
        if (key !== 'app_config') throw new Error(`unexpected key ${key}`);
        writes.push(value);
        config = value;
      },
    },
    writes,
    read: () => config,
    replace: (value) => {
      config = value;
    },
  };
}

function makeProvider(models = [{ id: 'old-model', name: 'Old', contextWindow: 1000 }]) {
  return {
    enabled: true,
    apiKey: 'relay-secret',
    baseUrl: 'https://relay.example',
    apiFormat: 'openai',
    models,
  };
}

function makeQuota(models) {
  return {
    keyPrefix: 'relay_',
    baseUrl: 'https://relay.example',
    models,
    quotaTotal: 100,
    quotaUsed: 0,
    quotaRemaining: 100,
    quotaCycleResetAt: 0,
    jevQuotaTotal: 0,
    jevQuotaUsed: 0,
    jevQuotaRemaining: 0,
  };
}

test('relay catalog refresh replaces stale models without replacing credentials or unrelated config', async () => {
  const state = makeStore({
    language: 'zh',
    language_initialized: true,
    bootstrap: { owner: 'keep' },
    providers: {
      'metaid-free': makeProvider(),
      deepseek: { enabled: true, apiKey: 'desktop-secret', models: [{ id: 'deepseek-chat' }] },
    },
    model: { defaultProvider: 'metaid-free', defaultModel: 'old-model' },
  });
  let changed = 0;
  const refresh = createRelayCatalogRefresh({
    getStore: () => state.store,
    getQuota: async (input) => {
      assert.deepEqual(input, { apiKey: 'relay-secret', forceRefresh: true });
      return makeQuota([
        { id: 'new-model', contextWindow: 200000, maxOutputTokens: 8000 },
        { id: 'vision-model', contextWindow: 100000 },
      ]);
    },
    onChanged: () => {
      changed += 1;
    },
  });

  assert.deepEqual(await refresh(), { status: 'updated', modelCount: 2 });
  const config = state.read();
  assert.equal(config.language, 'zh');
  assert.equal(config.language_initialized, true);
  assert.deepEqual(config.bootstrap, { owner: 'keep' });
  assert.equal(config.providers['metaid-free'].apiKey, 'relay-secret');
  assert.equal(config.providers['metaid-free'].baseUrl, 'https://relay.example');
  assert.deepEqual(config.providers['metaid-free'].models.map((model) => model.id), ['new-model', 'vision-model']);
  assert.equal(config.providers.deepseek.apiKey, 'desktop-secret');
  assert.equal(config.model.defaultProvider, 'metaid-free');
  assert.equal(config.model.defaultModel, 'new-model');
  assert.equal(changed, 1);
});

test('relay catalog refresh preserves writes that land while the quota request is in flight', async () => {
  const state = makeStore({
    language: 'en',
    providers: { 'metaid-free': makeProvider() },
    model: { defaultProvider: 'deepseek', defaultModel: 'deepseek-chat' },
  });
  let releaseQuota;
  const refresh = createRelayCatalogRefresh({
    getStore: () => state.store,
    getQuota: () => new Promise((resolve) => {
      releaseQuota = () => resolve(makeQuota([{ id: 'new-model' }]));
    }),
    onChanged: () => {},
  });
  const pending = refresh();
  await Promise.resolve();
  state.replace({
    ...state.read(),
    language: 'zh',
    theme: 'dark',
    providers: {
      ...state.read().providers,
      deepseek: { enabled: true, apiKey: 'new-desktop-secret', models: [{ id: 'deepseek-chat' }] },
    },
  });
  releaseQuota();
  await pending;

  assert.equal(state.read().language, 'zh');
  assert.equal(state.read().theme, 'dark');
  assert.equal(state.read().providers.deepseek.apiKey, 'new-desktop-secret');
  assert.equal(state.read().model.defaultModel, 'deepseek-chat');
});

test('relay catalog refresh does not overwrite a credential rotated during the request', async () => {
  const state = makeStore({ providers: { 'metaid-free': makeProvider() } });
  let releaseQuota;
  let changed = 0;
  const refresh = createRelayCatalogRefresh({
    getStore: () => state.store,
    getQuota: () => new Promise((resolve) => {
      releaseQuota = () => resolve(makeQuota([{ id: 'new-model' }]));
    }),
    onChanged: () => {
      changed += 1;
    },
  });
  const pending = refresh();
  await Promise.resolve();
  state.replace({
    ...state.read(),
    providers: {
      'metaid-free': { ...makeProvider(), apiKey: 'rotated-secret' },
    },
  });
  releaseQuota();

  assert.deepEqual(await pending, { status: 'skipped', reason: 'credential-changed' });
  assert.equal(state.read().providers['metaid-free'].apiKey, 'rotated-secret');
  assert.deepEqual(state.read().providers['metaid-free'].models.map((model) => model.id), ['old-model']);
  assert.equal(state.writes.length, 0);
  assert.equal(changed, 0);
});

test('relay catalog refresh never replaces a usable catalog with an empty response', async () => {
  const state = makeStore({ providers: { 'metaid-free': makeProvider() } });
  let changed = 0;
  const refresh = createRelayCatalogRefresh({
    getStore: () => state.store,
    getQuota: async () => makeQuota([]),
    onChanged: () => {
      changed += 1;
    },
  });

  assert.deepEqual(await refresh(), { status: 'unchanged', modelCount: 1 });
  assert.deepEqual(state.read().providers['metaid-free'].models.map((model) => model.id), ['old-model']);
  assert.equal(state.writes.length, 0);
  assert.equal(changed, 0);
});

test('relay catalog refresh propagates failures without writing partial config', async () => {
  const state = makeStore({ providers: { 'metaid-free': makeProvider() } });
  const refresh = createRelayCatalogRefresh({
    getStore: () => state.store,
    getQuota: async () => {
      throw new Error('relay unavailable');
    },
    onChanged: () => {},
  });

  await assert.rejects(refresh(), /relay unavailable/);
  assert.equal(state.writes.length, 0);
});
