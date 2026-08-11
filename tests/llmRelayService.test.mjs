import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mvc } = require('meta-contract');

const {
  LlmRelayApiError,
  bootstrapLlmRelay,
  buildLlmRelayBootstrapMessage,
  getLlmRelayQuota,
  initLlmRelayService,
  normalizeLlmRelayApiBase,
  readLlmRelayApiBase,
  resetLlmRelayServiceForTests,
  setLlmRelayApiBase,
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
  quotaTotal: 1000000,
  quotaUsed: 0,
  quotaRemaining: 1000000,
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
  assert.equal(result.quotaTotal, 1000000);
  assert.equal(result.quotaRemaining, 1000000);
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
  assert.equal(first.quotaTotal, 1000000);
  const second = await getLlmRelayQuota({ apiKey: 'mrk_testkey123' });
  assert.equal(calls.length, 1, 'second call within 30s must hit the cache');
  assert.equal(second.quotaTotal, 1000000);
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
