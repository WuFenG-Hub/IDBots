/**
 * Relay identity closeout unit tests.
 *
 * Reproduces the 2026-10 identity-split incident in miniature: identity B's
 * relay key sits in every cache tier (jevRelay kv + memory, visionRelay kv +
 * memory, the metaid-free provider entry, the llmRelay quota snapshot), the
 * user_identity row is replaced by identity A, and the closeout must leave
 * NO tier serving B's key while re-issuing a key for A exactly once. Also
 * covers the degraded paths (offline bootstrap, never-provisioned install),
 * flight sharing, and the quota-response identity-mismatch repair loop.
 * All externals (store/bootstrap/fetch/log) are injected; no network, no DB,
 * no Electron.
 */

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);

const {
  METAID_FREE_PROVIDER_KEY,
  applyRelayIdentityChange,
  clearRelayCredentialCaches,
  initRelayIdentityCloseoutService,
  resetRelayIdentityCloseoutServiceForTests,
} = require('../dist-electron/main/services/relayIdentityCloseout.js');
const {
  JEV_RELAY_API_KEY_KV,
  JEV_RELAY_BASE_URL_KV,
  initJevRelayService,
  resetJevRelayServiceForTests,
  resolveJevRelayCredentials,
} = require('../dist-electron/main/services/jevRelayService.js');
const {
  VISION_RELAY_API_KEY_KV,
  VISION_RELAY_BASE_URL_KV,
  initVisionRelayService,
  resetVisionRelayServiceForTests,
  resolveVisionRelayCredentials,
} = require('../dist-electron/main/services/visionRelayService.js');
const {
  getLlmRelayQuota,
  initLlmRelayService,
  resetLlmRelayServiceForTests,
} = require('../dist-electron/main/services/llmRelayService.js');

const CHAT_BASE = 'https://www.metaso.network/assist-open-api/v2/assist/llm/v1';
const IDENTITY_A = '1IdentityAAddressxxxxxxxxxxxxxxxxx';
const IDENTITY_B = '1IdentityBAddressxxxxxxxxxxxxxxxxx';
const KEY_A = 'mrk_identityA_fresh';
const KEY_B = 'mrk_identityB_stale';

function makeStore(initial = {}) {
  const kv = new Map(Object.entries(initial));
  return {
    kv,
    get: (key) => (kv.has(key) ? kv.get(key) : undefined),
    set: (key, value) => {
      kv.set(key, value);
    },
    delete: (key) => {
      kv.delete(key);
    },
  };
}

function providerEntry(apiKey, extra = {}) {
  return {
    enabled: true,
    apiKey,
    baseUrl: CHAT_BASE,
    apiFormat: 'openai',
    models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
    name: 'MetaID Free',
    ...extra,
  };
}

/** Store seeded the way the incident left it: B's key in every tier. */
function makeIncidentStore() {
  return makeStore({
    app_config: { theme: 'dark', providers: { [METAID_FREE_PROVIDER_KEY]: providerEntry(KEY_B), openai: { apiKey: 'sk-user' } } },
    [JEV_RELAY_API_KEY_KV]: KEY_B,
    [JEV_RELAY_BASE_URL_KV]: CHAT_BASE,
    [VISION_RELAY_API_KEY_KV]: KEY_B,
    [VISION_RELAY_BASE_URL_KV]: CHAT_BASE,
  });
}

function captureLog() {
  const lines = [];
  return {
    lines,
    log: (level, tag, message, extra) => {
      lines.push({ level, tag, message, extra });
    },
  };
}

function setup(store, overrides = {}) {
  const counters = { bootstrap: 0, jevBootstrap: 0, visionBootstrap: 0, appConfigChanged: 0 };
  initJevRelayService({
    getStore: () => store,
    bootstrapImpl: async () => {
      counters.jevBootstrap += 1;
      return { apiKey: 'mrk_jev_fallback', baseUrl: CHAT_BASE };
    },
  });
  initVisionRelayService({
    getStore: () => store,
    bootstrapImpl: async () => {
      counters.visionBootstrap += 1;
      return { apiKey: 'mrk_vision_fallback', baseUrl: CHAT_BASE };
    },
  });
  const { lines, log } = captureLog();
  initRelayIdentityCloseoutService({
    getStore: () => store,
    bootstrapImpl: overrides.bootstrapImpl ?? (async () => {
      counters.bootstrap += 1;
      return { apiKey: KEY_A, baseUrl: CHAT_BASE };
    }),
    onAppConfigChanged: () => {
      counters.appConfigChanged += 1;
    },
    log,
  });
  return { counters, lines };
}

function providerOf(store) {
  return store.get('app_config')?.providers?.[METAID_FREE_PROVIDER_KEY];
}

beforeEach(() => {
  resetRelayIdentityCloseoutServiceForTests();
  resetJevRelayServiceForTests();
  resetVisionRelayServiceForTests();
  resetLlmRelayServiceForTests();
});

// ---------------------------------------------------------------------------
// Cache clearing
// ---------------------------------------------------------------------------

test('clearRelayCredentialCaches empties every tier and blanks only the provider credentials', async () => {
  const store = makeIncidentStore();
  const { counters } = setup(store);
  // Prime the in-memory tiers the way a running app has them.
  assert.equal((await resolveJevRelayCredentials()).apiKey, KEY_B);
  assert.equal((await resolveVisionRelayCredentials()).apiKey, KEY_B);

  clearRelayCredentialCaches();

  assert.equal(store.kv.has(JEV_RELAY_API_KEY_KV), false);
  assert.equal(store.kv.has(JEV_RELAY_BASE_URL_KV), false);
  assert.equal(store.kv.has(VISION_RELAY_API_KEY_KV), false);
  assert.equal(store.kv.has(VISION_RELAY_BASE_URL_KV), false);
  const provider = providerOf(store);
  assert.equal(provider.apiKey, '');
  assert.equal(provider.baseUrl, '');
  assert.equal(provider.enabled, true, 'only credentials are blanked');
  assert.deepEqual(provider.models, [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }], 'catalog untouched');
  assert.equal(provider.name, 'MetaID Free');
  assert.equal(store.get('app_config').theme, 'dark', 'unrelated config survives');
  assert.equal(store.get('app_config').providers.openai.apiKey, 'sk-user', 'other providers survive');
  assert.equal(counters.appConfigChanged, 1, 'the renderer is told to reload app_config');

  // In-memory tiers are gone too: with kv and provider empty, both fall through to bootstrap.
  assert.equal((await resolveJevRelayCredentials()).apiKey, 'mrk_jev_fallback');
  assert.equal((await resolveVisionRelayCredentials()).apiKey, 'mrk_vision_fallback');
  assert.equal(counters.jevBootstrap, 1);
  assert.equal(counters.visionBootstrap, 1);
});

test('clearRelayCredentialCaches is a no-op write when the provider credentials are already blank', () => {
  const store = makeStore({ app_config: { providers: { [METAID_FREE_PROVIDER_KEY]: providerEntry('', { baseUrl: '' }) } } });
  const { counters } = setup(store);
  clearRelayCredentialCaches();
  assert.equal(counters.appConfigChanged, 0);
});

// ---------------------------------------------------------------------------
// Identity change closeout (import / create)
// ---------------------------------------------------------------------------

test('applyRelayIdentityChange: import replaces B\'s key with a freshly issued A key in all three caches', async () => {
  const store = makeIncidentStore();
  const { counters, lines } = setup(store);
  assert.equal((await resolveJevRelayCredentials()).apiKey, KEY_B);
  assert.equal((await resolveVisionRelayCredentials()).apiKey, KEY_B);

  const result = await applyRelayIdentityChange({ reason: 'import' });

  assert.deepEqual(result, { cleared: true, rebootstrap: 'ok', keyPrefix: KEY_A.slice(0, 10) });
  assert.equal(counters.bootstrap, 1, 'exactly one identity-signed bootstrap');
  assert.equal(counters.jevBootstrap, 0, 'JEV resolver re-persists from the provider entry, no second bootstrap');
  assert.equal(counters.visionBootstrap, 0, 'vision resolver re-persists from the provider entry, no second bootstrap');

  const provider = providerOf(store);
  assert.equal(provider.apiKey, KEY_A);
  assert.equal(provider.baseUrl, CHAT_BASE);
  assert.equal(provider.enabled, true);
  assert.deepEqual(provider.models, [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }]);
  assert.equal(store.get(JEV_RELAY_API_KEY_KV), KEY_A);
  assert.equal(store.get(JEV_RELAY_BASE_URL_KV), CHAT_BASE);
  assert.equal(store.get(VISION_RELAY_API_KEY_KV), KEY_A);
  assert.equal(store.get(VISION_RELAY_BASE_URL_KV), CHAT_BASE);
  // Memory tiers serve A now.
  assert.equal((await resolveJevRelayCredentials()).apiKey, KEY_A);
  assert.equal((await resolveVisionRelayCredentials()).apiKey, KEY_A);

  const serialized = JSON.stringify([...store.kv.entries()]);
  assert.equal(serialized.includes(KEY_B), false, 'the stale key must not survive anywhere in the store');
  assert.equal(counters.appConfigChanged, 2, 'blank + re-issue, each broadcast to the renderer');

  const reissued = lines.find((line) => line.message.includes('re-issued'));
  assert.ok(reissued, 'cowork.log line marks the key switch');
  assert.equal(reissued.extra.reason, 'import');
  assert.equal(reissued.extra.keyPrefix, KEY_A.slice(0, 10));
  assert.equal(JSON.stringify(lines).includes(KEY_A), false, 'the raw key is never logged');
});

test('applyRelayIdentityChange: create runs the same closeout', async () => {
  const store = makeIncidentStore();
  const { counters } = setup(store);
  const result = await applyRelayIdentityChange({ reason: 'create' });
  assert.equal(result.rebootstrap, 'ok');
  assert.equal(counters.bootstrap, 1);
  assert.equal(providerOf(store).apiKey, KEY_A);
  assert.equal(store.get(JEV_RELAY_API_KEY_KV), KEY_A);
});

test('applyRelayIdentityChange: an offline bootstrap still clears every tier and never rejects', async () => {
  const store = makeIncidentStore();
  const { counters, lines } = setup(store, {
    bootstrapImpl: async () => {
      counters.bootstrap += 1;
      throw new Error('LLM relay request timed out after 10000ms.');
    },
  });
  assert.equal((await resolveJevRelayCredentials()).apiKey, KEY_B);

  const result = await applyRelayIdentityChange({ reason: 'import' });

  assert.equal(result.cleared, true);
  assert.equal(result.rebootstrap, 'failed');
  assert.match(result.error, /timed out/);
  assert.equal(counters.bootstrap, 1);
  assert.equal(providerOf(store).apiKey, '', 'provider stays blank rather than keeping the stale key');
  assert.equal(providerOf(store).baseUrl, '');
  assert.equal(store.kv.has(JEV_RELAY_API_KEY_KV), false);
  assert.equal(store.kv.has(VISION_RELAY_API_KEY_KV), false);
  assert.equal(JSON.stringify([...store.kv.entries()]).includes(KEY_B), false);
  const warn = lines.find((line) => line.level === 'WARN');
  assert.ok(warn, 'failure is logged');
  assert.equal(warn.extra.reason, 'import');
});

test('applyRelayIdentityChange: a never-provisioned install clears the relay kvs and defers bootstrap to first use', async () => {
  const store = makeStore({
    app_config: { providers: { openai: { apiKey: 'sk-user' } } },
    [JEV_RELAY_API_KEY_KV]: KEY_B,
    [JEV_RELAY_BASE_URL_KV]: CHAT_BASE,
  });
  const { counters } = setup(store);
  const result = await applyRelayIdentityChange({ reason: 'import' });
  assert.deepEqual(result, { cleared: true, rebootstrap: 'skipped' });
  assert.equal(counters.bootstrap, 0, 'nothing to refresh, so no key is minted and wasted');
  assert.equal(store.kv.has(JEV_RELAY_API_KEY_KV), false);
  assert.equal(store.get('app_config').providers[METAID_FREE_PROVIDER_KEY], undefined, 'no provider entry is invented');
  assert.equal(counters.appConfigChanged, 0);
});

test('applyRelayIdentityChange: concurrent callers share one flight', async () => {
  const store = makeIncidentStore();
  const { counters } = setup(store);
  const [first, second] = await Promise.all([
    applyRelayIdentityChange({ reason: 'import' }),
    applyRelayIdentityChange({ reason: 'quota-identity-mismatch' }),
  ]);
  assert.deepEqual(first, second);
  assert.equal(counters.bootstrap, 1);
  // A later call after the flight settled runs again.
  await applyRelayIdentityChange({ reason: 'create' });
  assert.equal(counters.bootstrap, 2);
});

test('applyRelayIdentityChange without init clears nothing destructive and reports skipped', async () => {
  const result = await applyRelayIdentityChange({ reason: 'import' });
  assert.deepEqual(result, { cleared: true, rebootstrap: 'skipped' });
});

// ---------------------------------------------------------------------------
// Quota identity-mismatch repair loop (llmRelayService -> closeout)
// ---------------------------------------------------------------------------

test('a quota response naming another identity routes through the closeout and the quota is re-read behind the new key', async () => {
  const store = makeIncidentStore();
  const { counters } = setup(store);
  const fetchCalls = [];
  initLlmRelayService({
    getStore: () => store,
    getUserIdentityStore: () => ({ get: () => ({ mvc_address: IDENTITY_A, globalmetaid: 'idq1identitya' }) }),
    baseUrl: 'https://relay.test',
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      const bearer = String(init.headers?.Authorization ?? '').replace(/^Bearer /, '');
      const owner = bearer === KEY_A ? IDENTITY_A : bearer === KEY_B ? IDENTITY_B : null;
      const body = owner
        ? { code: 0, message: 'success', data: { keyPrefix: bearer.slice(0, 10), baseUrl: CHAT_BASE, models: [], quotaTotal: 10, quotaUsed: 1, quotaRemaining: 9, identityAddress: owner } }
        : { error: { message: 'relay key invalid or revoked', code: 'invalid_api_key' } };
      return { ok: Boolean(owner), status: owner ? 200 : 401, json: async () => body };
    },
  });
  assert.equal((await resolveJevRelayCredentials()).apiKey, KEY_B);

  // The Settings quota card still holds B's key (the incident state).
  const quota = await getLlmRelayQuota({ apiKey: KEY_B, forceRefresh: true });

  assert.equal(quota.identityAddress, IDENTITY_A, 'the returned snapshot belongs to the local identity');
  assert.equal(quota.keyPrefix, KEY_A.slice(0, 10));
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0].init.headers.Authorization, `Bearer ${KEY_B}`);
  assert.equal(fetchCalls[1].init.headers.Authorization, `Bearer ${KEY_A}`);
  assert.equal(counters.bootstrap, 1, 'one closeout bootstrap repaired every tier');
  assert.equal(providerOf(store).apiKey, KEY_A);
  assert.equal(store.get(JEV_RELAY_API_KEY_KV), KEY_A);
  assert.equal(store.get(VISION_RELAY_API_KEY_KV), KEY_A);
  assert.equal((await resolveJevRelayCredentials()).apiKey, KEY_A);
  assert.equal(JSON.stringify([...store.kv.entries()]).includes(KEY_B), false);
});

test('a quota response naming the local identity leaves every tier alone', async () => {
  const store = makeIncidentStore();
  const { counters } = setup(store);
  initLlmRelayService({
    getStore: () => store,
    getUserIdentityStore: () => ({ get: () => ({ mvc_address: IDENTITY_B }) }),
    baseUrl: 'https://relay.test',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ code: 0, message: 'success', data: { keyPrefix: 'mrk_identi', baseUrl: CHAT_BASE, models: [], quotaTotal: 10, quotaUsed: 1, quotaRemaining: 9, identityAddress: IDENTITY_B } }),
    }),
  });
  const quota = await getLlmRelayQuota({ apiKey: KEY_B, forceRefresh: true });
  assert.equal(quota.identityAddress, IDENTITY_B);
  assert.equal(counters.bootstrap, 0);
  assert.equal(providerOf(store).apiKey, KEY_B);
  assert.equal(store.get(JEV_RELAY_API_KEY_KV), KEY_B);
});
