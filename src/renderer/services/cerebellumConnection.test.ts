import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCerebellumModelsUrl,
  testCerebellumConnection,
} from './cerebellumConnection';

const t = (key: string): string => key;

function mockFetch(handler: (options: { url: string; method: string; headers: Record<string, string> }) => unknown) {
  (globalThis as { window?: unknown }).window = {
    electron: {
      api: {
        fetch: async (options: { url: string; method: string; headers: Record<string, string> }) => handler(options),
      },
    },
  };
}

test.afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

test('buildCerebellumModelsUrl: unversioned host gains /v1/models', () => {
  assert.equal(
    buildCerebellumModelsUrl('https://api.typesafe.ai'),
    'https://api.typesafe.ai/v1/models',
  );
});

test('buildCerebellumModelsUrl: trailing slashes are stripped first', () => {
  assert.equal(
    buildCerebellumModelsUrl('https://api.typesafe.ai///'),
    'https://api.typesafe.ai/v1/models',
  );
});

test('buildCerebellumModelsUrl: base already ending in /v1 is not doubled', () => {
  assert.equal(
    buildCerebellumModelsUrl(' https://api.typesafe.ai/v1 '),
    'https://api.typesafe.ai/v1/models',
  );
});

test('buildCerebellumModelsUrl: empty base falls back to a relative path', () => {
  assert.equal(buildCerebellumModelsUrl(''), '/v1/models');
});

test('testCerebellumConnection: empty api key short-circuits without a request', async () => {
  let called = false;
  mockFetch(() => {
    called = true;
    return { ok: true, status: 200, data: [] };
  });
  const result = await testCerebellumConnection({ baseUrl: 'https://api.typesafe.ai', apiKey: '  ' }, { t });
  assert.equal(called, false);
  assert.deepEqual(result, { success: false, message: 'apiKeyRequired' });
});

test('testCerebellumConnection: 200 with an array payload reports the model count', async () => {
  let seen: { url: string; method: string; headers: Record<string, string> } | null = null;
  mockFetch((options) => {
    seen = options;
    return { ok: true, status: 200, data: [{ id: 'jev-latest' }, { id: 'jev-fast' }] };
  });
  const tReplace = (key: string): string =>
    key === 'cerebellumConnectionSuccess' ? 'ok {count} [{models}]' : key;
  const result = await testCerebellumConnection(
    { baseUrl: 'https://api.typesafe.ai', apiKey: 'sk-jev' },
    { t: tReplace },
  );
  assert.equal(seen!.url, 'https://api.typesafe.ai/v1/models');
  assert.equal(seen!.method, 'GET');
  assert.equal(seen!.headers.Authorization, 'Bearer sk-jev');
  assert.deepEqual(result, { success: true, message: 'ok 2 [jev-latest, jev-fast]' });
});

test('testCerebellumConnection: 200 with an OpenAI-style {data: [...]} payload lists models', async () => {
  mockFetch(() => ({ ok: true, status: 200, data: { object: 'list', data: [{ id: 'jev-latest' }] } }));
  const tReplace = (key: string): string =>
    key === 'cerebellumConnectionSuccess' ? 'ok {count} [{models}]' : key;
  const result = await testCerebellumConnection(
    { baseUrl: 'https://api.typesafe.ai', apiKey: 'sk-jev' },
    { t: tReplace },
  );
  assert.deepEqual(result, { success: true, message: 'ok 1 [jev-latest]' });
});

test('testCerebellumConnection: 200 with a non-listing payload still succeeds generically', async () => {
  mockFetch(() => ({ ok: true, status: 200, data: { hello: 'world' } }));
  const result = await testCerebellumConnection(
    { baseUrl: 'https://api.typesafe.ai', apiKey: 'sk-jev' },
    { t },
  );
  assert.deepEqual(result, { success: true, message: 'connectionSuccess' });
});

test('testCerebellumConnection: 401 maps to the invalid-key message', async () => {
  mockFetch(() => ({ ok: false, status: 401, data: { error: { message: 'bad key' } } }));
  const result = await testCerebellumConnection(
    { baseUrl: 'https://api.typesafe.ai', apiKey: 'sk-wrong' },
    { t },
  );
  assert.deepEqual(result, { success: false, message: 'cerebellumInvalidApiKey' });
});

test('testCerebellumConnection: other statuses surface the status code', async () => {
  mockFetch(() => ({ ok: false, status: 502, data: {} }));
  const result = await testCerebellumConnection(
    { baseUrl: 'https://api.typesafe.ai', apiKey: 'sk-jev' },
    { t },
  );
  assert.deepEqual(result, { success: false, message: 'connectionFailed: 502' });
});

test('testCerebellumConnection: a thrown network error maps to unreachable', async () => {
  mockFetch(() => {
    throw new Error('ECONNREFUSED');
  });
  const result = await testCerebellumConnection(
    { baseUrl: 'https://api.typesafe.ai', apiKey: 'sk-jev' },
    { t },
  );
  assert.equal(result.success, false);
  assert.match(result.message, /^cerebellumConnectionUnreachable \(ECONNREFUSED\)$/);
});

test('buildCerebellumModelsUrl: JEV relay base gains /v1/models (relay path shape)', () => {
  assert.equal(
    buildCerebellumModelsUrl('https://www.metaso.network/assist-open-api/v2/assist/llm/jev'),
    'https://www.metaso.network/assist-open-api/v2/assist/llm/jev/v1/models',
  );
});

test('testCerebellumConnection: 200 with the TypeSafe relay {models:[{name}]} shape lists models', async () => {
  let seenUrl = '';
  mockFetch((options) => {
    seenUrl = options.url;
    return { ok: true, status: 200, data: { models: [{ name: 'jev-latest', description: 'stable' }, { name: 'jev-preview' }] } };
  });
  const tReplace = (key: string): string =>
    key === 'cerebellumConnectionSuccess' ? 'ok {count} [{models}]' : key;
  const result = await testCerebellumConnection(
    {
      baseUrl: 'https://www.metaso.network/assist-open-api/v2/assist/llm/jev',
      apiKey: 'mrk_test',
    },
    { t: tReplace },
  );
  assert.equal(seenUrl, 'https://www.metaso.network/assist-open-api/v2/assist/llm/jev/v1/models');
  assert.deepEqual(result, { success: true, message: 'ok 2 [jev-latest, jev-preview]' });
});

test('testCerebellumConnection: {models: []} falls back to the generic success message', async () => {
  mockFetch(() => ({ ok: true, status: 200, data: { models: [] } }));
  const result = await testCerebellumConnection(
    { baseUrl: 'https://www.metaso.network/assist-open-api/v2/assist/llm/jev', apiKey: 'mrk_test' },
    { t },
  );
  assert.deepEqual(result, { success: true, message: 'connectionSuccess' });
});
