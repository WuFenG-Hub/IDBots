import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mvc } = require('meta-contract');

const {
  LLM_RELAY_KEY_IDENTITY_KV,
  LlmRelayApiError,
  bootstrapLlmRelay,
  buildLlmRelayBootstrapMessage,
  clearLlmRelayQuotaCache,
  getLlmRelayQuota,
  initLlmRelayService,
  normalizeLlmRelayApiBase,
  readLlmRelayApiBase,
  relayIdentityMatchesLocalIdentity,
  resetLlmRelayServiceForTests,
  setLlmRelayApiBase,
  setLlmRelayIdentityMismatchHandler,
} = await import('../dist-electron/main/services/llmRelayService.js');

const IDENTITY_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const WALLET_PATH = "m/44'/10001'/0'/0/0";

function deriveAddress(mnemonic) {
  const network = mvc.Networks.livenet;
  const child = mvc.Mnemonic.fromString(mnemonic).toHDPrivateKey('', network).deriveChild(WALLET_PATH);
  return child.publicKey.toAddress(network).toString();
}

const IDENTITY_ADDRESS = deriveAddress(IDENTITY_MNEMONIC);

function verifyMessage(address, message, signature) {
  try {
    return mvc.Message(message).verify(address, signature);
  } catch {
    return false;
  }
}

function makeIdentity() {
  return {
    mnemonic: IDENTITY_MNEMONIC,
    path: WALLET_PATH,
    mvc_address: IDENTITY_ADDRESS,
    globalmetaid: 'idq1testidentity',
  };
}

function makeKvStore() {
  const map = new Map();
  return {
    get: (key) => map.get(key),
    set: (key, value) => { map.set(key, value); },
    _map: map,
  };
}

function makeFetchStub(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const response = await handler({ url: String(url), init });
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.body,
      text: async () => (typeof response.body === 'string' ? response.body : JSON.stringify(response.body)),
    };
  };
  return { calls, fetchImpl };
}

const BOOTSTRAP_DATA = {
  apiKey: 'mrk_testkey123',
  keyPrefix: 'mrk_testke',
  baseUrl: 'https://relay.test/assist-open-api/v2/assist/llm/v1',
  models: [{ id: 'metaid-free-chat', contextWindow: 64000, maxOutputTokens: 4096 }],
  quotaTotal: 5000000,
  quotaUsed: 1000,
  quotaRemaining: 4999000,
  quotaCycleResetAt: 1760486400000,
  jevQuotaTotal: 2500000,
  jevQuotaUsed: 62323,
  jevQuotaRemaining: 2437677,
};

test('buildLlmRelayBootstrapMessage matches the backend canonical string', () => {
  assert.equal(
    buildLlmRelayBootstrapMessage('1Abc', 1720000000),
    'llm-relay-bootstrap:1Abc:1720000000',
  );
});

test('bootstrap signs the canonical message and normalizes the payload', async () => {
  resetLlmRelayServiceForTests();
  const { calls, fetchImpl } = makeFetchStub(() => ({ ok: true, status: 200, body: { code: 0, message: 'success', data: BOOTSTRAP_DATA } }));
  initLlmRelayService({
    getStore: () => makeKvStore(),
    getUserIdentityStore: () => ({ get: () => makeIdentity() }),
    fetchImpl,
    baseUrl: 'https://relay.test/assist-open-api',
  });
  const result = await bootstrapLlmRelay();
  assert.equal(result.apiKey, 'mrk_testkey123');
  assert.equal(result.baseUrl, 'https://relay.test/assist-open-api/v2/assist/llm/v1');
  assert.equal(result.quotaTotal, 5000000);
  assert.equal(result.quotaRemaining, 4999000);
  assert.equal(result.quotaCycleResetAt, 1760486400000);
  assert.equal(result.jevQuotaTotal, 2500000);
  assert.equal(result.jevQuotaUsed, 62323);
  assert.equal(result.jevQuotaRemaining, 2437677);
  assert.deepEqual(result.models, [{ id: 'metaid-free-chat', contextWindow: 64000, maxOutputTokens: 4096 }]);

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, 'https://relay.test/assist-open-api/v2/assist/llm/bootstrap');
  assert.equal(call.init.method, 'POST');
  const headers = call.init.headers;
  assert.equal(headers['X-Identity-Address'], IDENTITY_ADDRESS);
  const timestamp = Number(headers['X-Timestamp']);
  assert.ok(Math.abs(Math.floor(Date.now() / 1000) - timestamp) < 60);
  assert.ok(
    verifyMessage(IDENTITY_ADDRESS, `llm-relay-bootstrap:${IDENTITY_ADDRESS}:${timestamp}`, headers['X-Signature']),
    'signature must recover the identity address over the canonical message',
  );
});

test('bootstrap silently provisions the identity on first run', async () => {
  resetLlmRelayServiceForTests();
  let identity = null;
  const createCalls = [];
  const resumeCalls = [];
  const { fetchImpl } = makeFetchStub(() => ({ ok: true, status: 200, body: { code: 0, message: 'success', data: BOOTSTRAP_DATA } }));
  initLlmRelayService({
    getStore: () => makeKvStore(),
    getUserIdentityStore: () => ({ get: () => identity }),
    createIdentityImpl: async (_store, input, _deps, options) => {
      createCalls.push({ input, options });
      identity = makeIdentity();
      return { success: true, identity };
    },
    resumeIdentityImpl: async () => {
      resumeCalls.push(1);
      return { success: true };
    },
    fetchImpl,
    baseUrl: 'https://relay.test',
  });
  const result = await bootstrapLlmRelay();
  assert.equal(result.apiKey, 'mrk_testkey123');
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].input.name, 'User');
  assert.equal(createCalls[0].options?.deferChainSync, true, 'first paint must not block on chain pins');
  assert.equal(resumeCalls.length, 1, 'chain sync resumes in the background');
});

test('bootstrap fails when identity provisioning fails', async () => {
  resetLlmRelayServiceForTests();
  initLlmRelayService({
    getStore: () => makeKvStore(),
    getUserIdentityStore: () => ({ get: () => null }),
    createIdentityImpl: async () => ({ success: false, error: 'NAME_EMPTY' }),
    fetchImpl: makeFetchStub(() => ({ ok: true, status: 200, body: {} })).fetchImpl,
    baseUrl: 'https://relay.test',
  });
  await assert.rejects(bootstrapLlmRelay(), (error) => {
    assert.ok(error instanceof LlmRelayApiError);
    assert.match(error.message, /failed to provision local user identity/);
    return true;
  });
});

test('bootstrap surfaces metaso envelope errors', async () => {
  resetLlmRelayServiceForTests();
  const { fetchImpl } = makeFetchStub(() => ({ ok: true, status: 200, body: { code: 1, message: 'too many new accounts from this IP today' } }));
  initLlmRelayService({
    getStore: () => makeKvStore(),
    getUserIdentityStore: () => ({ get: () => makeIdentity() }),
    fetchImpl,
    baseUrl: 'https://relay.test',
  });
  await assert.rejects(bootstrapLlmRelay(), /too many new accounts from this IP today/);
});

test('bootstrap surfaces OpenAI-shaped HTTP errors', async () => {
  resetLlmRelayServiceForTests();
  const { fetchImpl } = makeFetchStub(() => ({
    ok: false,
    status: 503,
    body: { error: { message: 'no upstream model provider available', type: 'server_error', code: 'upstream_unavailable' } },
  }));
  initLlmRelayService({
    getStore: () => makeKvStore(),
    getUserIdentityStore: () => ({ get: () => makeIdentity() }),
    fetchImpl,
    baseUrl: 'https://relay.test',
  });
  await assert.rejects(bootstrapLlmRelay(), (error) => {
    assert.equal(error.status, 503);
    assert.match(error.message, /no upstream model provider available/);
    return true;
  });
});

test('quota sends the bearer key and caches for 30s unless forceRefresh', async () => {
  resetLlmRelayServiceForTests();
  const quotaBody = { code: 0, message: 'success', data: { ...BOOTSTRAP_DATA, apiKey: undefined } };
  const { calls, fetchImpl } = makeFetchStub(() => ({ ok: true, status: 200, body: quotaBody }));
  initLlmRelayService({
    getStore: () => makeKvStore(),
    getUserIdentityStore: () => ({ get: () => makeIdentity() }),
    fetchImpl,
    baseUrl: 'https://relay.test',
  });
  const first = await getLlmRelayQuota({ apiKey: 'mrk_testkey123' });
  assert.equal(first.quotaTotal, 5000000);
  assert.equal(first.quotaCycleResetAt, 1760486400000);
  assert.equal(first.jevQuotaTotal, 2500000);
  assert.equal(first.jevQuotaRemaining, 2437677);
  const second = await getLlmRelayQuota({ apiKey: 'mrk_testkey123' });
  assert.equal(calls.length, 1, 'second call within 30s must hit the cache');
  assert.equal(second.quotaTotal, 5000000);
  await getLlmRelayQuota({ apiKey: 'mrk_testkey123', forceRefresh: true });
  assert.equal(calls.length, 2, 'forceRefresh bypasses the cache');
  assert.equal(calls[0].url, 'https://relay.test/v2/assist/llm/quota');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer mrk_testkey123');
});

test('quota requires an apiKey', async () => {
  resetLlmRelayServiceForTests();
  initLlmRelayService({
    getStore: () => makeKvStore(),
    getUserIdentityStore: () => ({ get: () => makeIdentity() }),
    fetchImpl: makeFetchStub(() => ({ ok: true, status: 200, body: {} })).fetchImpl,
    baseUrl: 'https://relay.test',
  });
  await assert.rejects(getLlmRelayQuota({}), /relay apiKey is required/);
});

test('quota normalizes absent weekly/jev fields to 0 (legacy single-pool backend)', async () => {
  resetLlmRelayServiceForTests();
  const data = {
    ...BOOTSTRAP_DATA,
    apiKey: undefined,
    quotaCycleResetAt: undefined,
    jevQuotaTotal: undefined,
    jevQuotaUsed: undefined,
    jevQuotaRemaining: undefined,
  };
  const { fetchImpl } = makeFetchStub(() => ({ ok: true, status: 200, body: { code: 0, message: 'success', data } }));
  initLlmRelayService({
    getStore: () => makeKvStore(),
    getUserIdentityStore: () => ({ get: () => makeIdentity() }),
    fetchImpl,
    baseUrl: 'https://relay.test',
  });
  const quota = await getLlmRelayQuota({ apiKey: 'mrk_testkey123' });
  assert.equal(quota.quotaCycleResetAt, 0);
  assert.equal(quota.jevQuotaTotal, 0);
  assert.equal(quota.jevQuotaUsed, 0);
  assert.equal(quota.jevQuotaRemaining, 0);
});

test('apiBase normalization and kv override', async () => {
  assert.equal(normalizeLlmRelayApiBase(' https://example.com/assist/ '), 'https://example.com/assist');
  assert.equal(normalizeLlmRelayApiBase(''), '');
  assert.throws(() => normalizeLlmRelayApiBase('ftp://example.com'), /http or https/);
  assert.throws(() => normalizeLlmRelayApiBase('not a url'), /valid URL/);

  resetLlmRelayServiceForTests();
  const kv = makeKvStore();
  const { calls, fetchImpl } = makeFetchStub(() => ({ ok: true, status: 200, body: { code: 0, message: 'success', data: BOOTSTRAP_DATA } }));
  initLlmRelayService({
    getStore: () => kv,
    getUserIdentityStore: () => ({ get: () => makeIdentity() }),
    fetchImpl,
    // no deps.baseUrl: the kv override must win
  });
  setLlmRelayApiBase('https://staging.example.com/assist-open-api/');
  assert.equal(readLlmRelayApiBase(kv), 'https://staging.example.com/assist-open-api');
  await bootstrapLlmRelay();
  assert.ok(calls[0].url.startsWith('https://staging.example.com/assist-open-api/'), `kv override must win, got ${calls[0].url}`);
});

// ---------------------------------------------------------------------------
// Identity guard (2026-10 identity-split incident backstop)
// ---------------------------------------------------------------------------

test('relayIdentityMatchesLocalIdentity: unreported fields pass, disagreeing fields fail', () => {
  const local = { mvc_address: IDENTITY_ADDRESS, globalmetaid: 'idq1testidentity' };
  assert.equal(relayIdentityMatchesLocalIdentity({}, local), true, 'legacy backend without identity fields');
  assert.equal(relayIdentityMatchesLocalIdentity({ identityAddress: IDENTITY_ADDRESS }, local), true);
  assert.equal(relayIdentityMatchesLocalIdentity({ identityAddress: ` ${IDENTITY_ADDRESS} ` }, local), true, 'whitespace tolerant');
  assert.equal(relayIdentityMatchesLocalIdentity({ identityAddress: '1SomeoneElse' }, local), false);
  assert.equal(relayIdentityMatchesLocalIdentity({ globalMetaId: 'idq1testidentity' }, local), true);
  assert.equal(relayIdentityMatchesLocalIdentity({ globalMetaId: 'idq1other' }, local), false, 'globalMetaId decides only when no address is reported');
  assert.equal(relayIdentityMatchesLocalIdentity({ identityAddress: '1SomeoneElse' }, null), true, 'no local identity to compare against');
  assert.equal(relayIdentityMatchesLocalIdentity({ identityAddress: '1SomeoneElse' }, { mvc_address: '' }), true, 'blank local address');
});

test('relayIdentityMatchesLocalIdentity: a reported identityAddress is authoritative over globalMetaId', () => {
  const local = { mvc_address: IDENTITY_ADDRESS, globalmetaid: 'idq1testidentity' };
  assert.equal(
    relayIdentityMatchesLocalIdentity({ identityAddress: IDENTITY_ADDRESS, globalMetaId: 'IDQ1-differently-encoded' }, local),
    true,
    'a backend globalMetaId representation that differs from the local derivation must not read as a foreign identity',
  );
  assert.equal(
    relayIdentityMatchesLocalIdentity({ identityAddress: '1SomeoneElse', globalMetaId: 'idq1testidentity' }, local),
    false,
    'a matching globalMetaId cannot rescue a foreign address',
  );
  assert.equal(
    relayIdentityMatchesLocalIdentity({ identityAddress: IDENTITY_ADDRESS, globalMetaId: 'idq1other' }, { mvc_address: '', globalmetaid: 'idq1testidentity' }),
    false,
    'without a local address the globalMetaId fallback still applies',
  );
});

test('bootstrap accepts a response naming the signing identity and surfaces identityAddress', async () => {
  resetLlmRelayServiceForTests();
  const { fetchImpl } = makeFetchStub(() => ({
    ok: true,
    status: 200,
    body: { code: 0, message: 'success', data: { ...BOOTSTRAP_DATA, identityAddress: IDENTITY_ADDRESS, globalMetaId: 'idq1testidentity' } },
  }));
  initLlmRelayService({
    getStore: () => makeKvStore(),
    getUserIdentityStore: () => ({ get: () => makeIdentity() }),
    fetchImpl,
    baseUrl: 'https://relay.test',
  });
  const result = await bootstrapLlmRelay();
  assert.equal(result.apiKey, 'mrk_testkey123');
  assert.equal(result.identityAddress, IDENTITY_ADDRESS);
});

test('bootstrap rejects a response that belongs to another identity (key never handed out)', async () => {
  resetLlmRelayServiceForTests();
  const kv = makeKvStore();
  const { fetchImpl } = makeFetchStub(() => ({
    ok: true,
    status: 200,
    body: { code: 0, message: 'success', data: { ...BOOTSTRAP_DATA, identityAddress: '1SomeoneElse' } },
  }));
  initLlmRelayService({
    getStore: () => kv,
    getUserIdentityStore: () => ({ get: () => makeIdentity() }),
    fetchImpl,
    baseUrl: 'https://relay.test',
  });
  await assert.rejects(bootstrapLlmRelay(), (error) => {
    assert.ok(error instanceof LlmRelayApiError);
    assert.equal(error.stage, 'bootstrap');
    assert.match(error.message, /identity mismatch/);
    assert.match(error.message, new RegExp(IDENTITY_ADDRESS));
    return true;
  });
  assert.equal(kv.get(LLM_RELAY_KEY_IDENTITY_KV), undefined, 'a rejected bootstrap stamps nothing');
});

test('bootstrap stamps the identity the issued key belongs to', async () => {
  resetLlmRelayServiceForTests();
  const kv = makeKvStore();
  const { fetchImpl } = makeFetchStub(() => ({ ok: true, status: 200, body: { code: 0, message: 'success', data: BOOTSTRAP_DATA } }));
  initLlmRelayService({
    getStore: () => kv,
    getUserIdentityStore: () => ({ get: () => makeIdentity() }),
    fetchImpl,
    baseUrl: 'https://relay.test',
  });
  await bootstrapLlmRelay();
  assert.equal(kv.get(LLM_RELAY_KEY_IDENTITY_KV), IDENTITY_ADDRESS);
});

/** Quota stub whose response names the owner of the presented bearer key. */
function makeIdentityAwareQuotaStub(keyOwners) {
  return makeFetchStub(({ init }) => {
    const bearer = String(init.headers?.Authorization ?? '').replace(/^Bearer /, '');
    const owner = keyOwners[bearer];
    if (!owner) {
      return { ok: false, status: 401, body: { error: { message: 'relay key invalid or revoked', code: 'invalid_api_key' } } };
    }
    return {
      ok: true,
      status: 200,
      body: { code: 0, message: 'success', data: { ...BOOTSTRAP_DATA, apiKey: undefined, keyPrefix: bearer.slice(0, 10), identityAddress: owner } },
    };
  });
}

test('quota: a key owned by another identity is rejected without caching when no repair handler is registered', async () => {
  resetLlmRelayServiceForTests();
  const { calls, fetchImpl } = makeIdentityAwareQuotaStub({ mrk_identityB: '1IdentityBAddress' });
  initLlmRelayService({
    getStore: () => makeKvStore(),
    getUserIdentityStore: () => ({ get: () => makeIdentity() }),
    fetchImpl,
    baseUrl: 'https://relay.test',
  });
  await assert.rejects(getLlmRelayQuota({ apiKey: 'mrk_identityB' }), (error) => {
    assert.ok(error instanceof LlmRelayApiError);
    assert.equal(error.stage, 'quota');
    assert.match(error.message, /identity mismatch/);
    return true;
  });
  // The mismatched snapshot must never be served from the 30s cache.
  await assert.rejects(getLlmRelayQuota({ apiKey: 'mrk_identityB' }), /identity mismatch/);
  assert.equal(calls.length, 2, 'every call re-fetches: nothing was cached');
});

test('quota: identity mismatch runs the repair handler, drops the stale key and re-reads behind the re-issued provider key', async () => {
  resetLlmRelayServiceForTests();
  const kv = makeKvStore();
  kv.set('app_config', {
    providers: { 'metaid-free': { enabled: true, apiKey: 'mrk_identityB', baseUrl: 'https://relay.test/v1', models: [{ id: 'deepseek-chat' }] } },
  });
  const { calls, fetchImpl } = makeIdentityAwareQuotaStub({ mrk_identityB: '1IdentityBAddress', mrk_identityA: IDENTITY_ADDRESS });
  initLlmRelayService({
    getStore: () => kv,
    getUserIdentityStore: () => ({ get: () => makeIdentity() }),
    fetchImpl,
    baseUrl: 'https://relay.test',
  });
  const handlerCalls = [];
  setLlmRelayIdentityMismatchHandler(async (context) => {
    handlerCalls.push(context);
    // The closeout re-bootstraps as the local identity and rewrites the provider entry.
    const appConfig = kv.get('app_config');
    kv.set('app_config', {
      ...appConfig,
      providers: { 'metaid-free': { ...appConfig.providers['metaid-free'], apiKey: 'mrk_identityA' } },
    });
  });
  const quota = await getLlmRelayQuota({ apiKey: 'mrk_identityB' });
  assert.equal(handlerCalls.length, 1);
  assert.equal(handlerCalls[0].localMvcAddress, IDENTITY_ADDRESS);
  assert.equal(handlerCalls[0].quota.identityAddress, '1IdentityBAddress');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer mrk_identityB');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer mrk_identityA', 'the re-read uses the repaired provider key');
  assert.equal(quota.identityAddress, IDENTITY_ADDRESS);
  assert.equal(quota.keyPrefix, 'mrk_identi');
  // The repaired snapshot is what gets cached.
  await getLlmRelayQuota({ apiKey: 'mrk_identityB' });
  assert.equal(calls.length, 2, 'cached after repair');
});

test('quota: a repair handler that yields no new key still surfaces the mismatch', async () => {
  resetLlmRelayServiceForTests();
  const kv = makeKvStore();
  kv.set('app_config', { providers: { 'metaid-free': { enabled: true, apiKey: 'mrk_identityB', baseUrl: 'https://relay.test/v1' } } });
  const { calls, fetchImpl } = makeIdentityAwareQuotaStub({ mrk_identityB: '1IdentityBAddress' });
  initLlmRelayService({
    getStore: () => kv,
    getUserIdentityStore: () => ({ get: () => makeIdentity() }),
    fetchImpl,
    baseUrl: 'https://relay.test',
  });
  setLlmRelayIdentityMismatchHandler(async () => {
    // Offline closeout: caches cleared, no fresh key issued.
    const appConfig = kv.get('app_config');
    kv.set('app_config', {
      ...appConfig,
      providers: { 'metaid-free': { ...appConfig.providers['metaid-free'], apiKey: '', baseUrl: '' } },
    });
  });
  await assert.rejects(getLlmRelayQuota({ apiKey: 'mrk_identityB' }), /identity mismatch/);
  assert.equal(calls.length, 1, 'no re-read without a repaired key');
});

test('quota: responses without identity fields keep working (legacy backend) and never invoke the handler', async () => {
  resetLlmRelayServiceForTests();
  const quotaBody = { code: 0, message: 'success', data: { ...BOOTSTRAP_DATA, apiKey: undefined } };
  const { fetchImpl } = makeFetchStub(() => ({ ok: true, status: 200, body: quotaBody }));
  initLlmRelayService({
    getStore: () => makeKvStore(),
    getUserIdentityStore: () => ({ get: () => makeIdentity() }),
    fetchImpl,
    baseUrl: 'https://relay.test',
  });
  let handlerCalls = 0;
  setLlmRelayIdentityMismatchHandler(async () => {
    handlerCalls += 1;
  });
  const quota = await getLlmRelayQuota({ apiKey: 'mrk_testkey123' });
  assert.equal(quota.identityAddress, '');
  assert.equal(handlerCalls, 0);
});

test('clearLlmRelayQuotaCache drops the 30s snapshot', async () => {
  resetLlmRelayServiceForTests();
  const quotaBody = { code: 0, message: 'success', data: { ...BOOTSTRAP_DATA, apiKey: undefined } };
  const { calls, fetchImpl } = makeFetchStub(() => ({ ok: true, status: 200, body: quotaBody }));
  initLlmRelayService({
    getStore: () => makeKvStore(),
    getUserIdentityStore: () => ({ get: () => makeIdentity() }),
    fetchImpl,
    baseUrl: 'https://relay.test',
  });
  await getLlmRelayQuota({ apiKey: 'mrk_testkey123' });
  await getLlmRelayQuota({ apiKey: 'mrk_testkey123' });
  assert.equal(calls.length, 1);
  clearLlmRelayQuotaCache();
  await getLlmRelayQuota({ apiKey: 'mrk_testkey123' });
  assert.equal(calls.length, 2, 'a cleared cache forces a re-fetch');
});
