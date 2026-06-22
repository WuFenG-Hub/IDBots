import assert from 'node:assert/strict';
import test from 'node:test';

import { browserFailure, browserSuccess } from '@openagentinternet/agent-browser-host-contract';
import { createBrowserEndpointShim } from '../src/renderer/features/botBrowser/browserEndpointShim.ts';

function createAdapter() {
  const calls = [];
  return {
    calls,
    adapter: {
      async getRuntime(input) {
        calls.push(['getRuntime', input]);
        return browserSuccess({ host: { kind: 'idbots', name: 'IDBots', localMode: true } });
      },
      async resolveResource(input) {
        calls.push(['resolveResource', input]);
        return browserSuccess({ uri: input.uri, actorId: input.actorId ?? null });
      },
      async getSettings(input) {
        calls.push(['getSettings', input]);
        return browserSuccess({ browser: {}, effectiveBrowser: {}, defaults: {} });
      },
      async updateSettings(input) {
        calls.push(['updateSettings', input]);
        return browserSuccess({ browser: input.browser, effectiveBrowser: {}, defaults: {} });
      },
      async getCache(input) {
        calls.push(['getCache', input]);
        return browserSuccess({});
      },
      async clearCache(input) {
        calls.push(['clearCache', input]);
        return browserSuccess({ cleared: true, input });
      },
      async runTrustedAction(input) {
        calls.push(['runTrustedAction', input]);
        return browserSuccess({ kind: input.kind, handled: true, data: { message: 'ok' } });
      },
    },
  };
}

test('endpoint shim returns raw command result shapes for runtime, settings, resolve, and actions', async () => {
  const { adapter, calls } = createAdapter();
  const shim = createBrowserEndpointShim(adapter);

  const runtime = await shim({ url: '/api/browser/runtime?actorId=idbots-metabot-1' });
  assert.equal(runtime.status, 200);
  assert.equal(runtime.body.ok, true);
  assert.equal(runtime.body.data.host.kind, 'idbots');

  const settings = await shim({ url: '/api/browser/settings?actorId=idbots-metabot-1' });
  assert.equal(settings.status, 200);
  assert.deepEqual(settings.body, { ok: true, state: 'success', data: { browser: {}, effectiveBrowser: {}, defaults: {} } });

  const resolved = await shim({ url: '/api/browser/resolve?uri=metaapp%3A%2F%2FPIN123I0&actorId=idbots-metabot-1' });
  assert.equal(resolved.status, 200);
  assert.deepEqual(resolved.body.data, { uri: 'metaapp://PIN123I0', actorId: 'idbots-metabot-1' });

  const action = await shim({
    url: '/api/browser/actions?actorId=idbots-metabot-1',
    method: 'POST',
    body: {
      resourceUri: 'metaid://idq1peer',
      kind: 'open-conversation',
      payload: { peerGlobalMetaId: 'idq1peer' },
    },
  });
  assert.equal(action.status, 200);
  assert.deepEqual(action.body.data, { kind: 'open-conversation', handled: true, data: { message: 'ok' } });

  assert.deepEqual(calls, [
    ['getRuntime', { actorId: 'idbots-metabot-1' }],
    ['getSettings', { actorId: 'idbots-metabot-1' }],
    ['resolveResource', { actorId: 'idbots-metabot-1', uri: 'metaapp://PIN123I0' }],
    [
      'runTrustedAction',
      {
        actorId: 'idbots-metabot-1',
        resourceUri: 'metaid://idq1peer',
        kind: 'open-conversation',
        payload: { peerGlobalMetaId: 'idq1peer' },
      },
    ],
  ]);
});

test('endpoint shim supports PUT settings and DELETE cache bodies', async () => {
  const { adapter, calls } = createAdapter();
  const shim = createBrowserEndpointShim(adapter);

  const settings = await shim({
    url: 'http://127.0.0.1/api/browser/settings?actorId=idbots-metabot-1',
    method: 'PUT',
    body: { browser: { renderCustomBotPages: false } },
  });
  assert.equal(settings.status, 200);
  assert.deepEqual(settings.body.data.browser, { renderCustomBotPages: false });

  const cache = await shim({
    url: '/api/browser/cache?actorId=idbots-metabot-1',
    method: 'DELETE',
    body: { scope: 'metaapp', all: true, pinId: 'pin123i0', cacheKey: 'abc' },
  });
  assert.equal(cache.status, 200);
  assert.deepEqual(cache.body.data.input, {
    actorId: 'idbots-metabot-1',
    scope: 'metaapp',
    all: true,
    pinId: 'pin123i0',
    cacheKey: 'abc',
  });

  assert.deepEqual(calls, [
    ['updateSettings', { actorId: 'idbots-metabot-1', browser: { renderCustomBotPages: false } }],
    [
      'clearCache',
      {
        actorId: 'idbots-metabot-1',
        scope: 'metaapp',
        all: true,
        pinId: 'pin123i0',
        cacheKey: 'abc',
      },
    ],
  ]);
});

test('endpoint shim returns failures for missing uri, wrong method, unknown path, and mapped adapter errors', async () => {
  const { adapter } = createAdapter();
  const shim = createBrowserEndpointShim({
    ...adapter,
    async resolveResource(input) {
      if (input.uri === 'metaapp://missing') {
        return browserFailure('browser_resource_not_found', 'Resource not found.');
      }
      if (input.uri === 'metaid://missing-config') {
        return browserFailure('browser_config_missing', 'Browser config missing.');
      }
      return adapter.resolveResource(input);
    },
  });

  const missingUri = await shim({ url: '/api/browser/resolve' });
  assert.equal(missingUri.status, 400);
  assert.equal(missingUri.body.code, 'missing_uri');

  const wrongMethod = await shim({ url: '/api/browser/runtime', method: 'POST' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.body.code, 'method_not_allowed');

  const unknown = await shim({ url: '/api/browser/unknown' });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, 'not_found');

  const notFound = await shim({ url: '/api/browser/resolve?uri=metaapp%3A%2F%2Fmissing' });
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body.code, 'browser_resource_not_found');

  const configMissing = await shim({ url: '/api/browser/resolve?uri=metaid%3A%2F%2Fmissing-config' });
  assert.equal(configMissing.status, 500);
  assert.equal(configMissing.body.code, 'browser_config_missing');
});

test('endpoint shim rejects malformed request bodies before calling adapter methods', async () => {
  const { adapter, calls } = createAdapter();
  const shim = createBrowserEndpointShim(adapter);

  const settings = await shim({
    url: '/api/browser/settings',
    method: 'PUT',
    body: 'not-an-object',
  });
  assert.equal(settings.status, 400);
  assert.equal(settings.body.code, 'invalid_request_body');

  const settingsMissingBrowser = await shim({
    url: '/api/browser/settings',
    method: 'PUT',
    body: {},
  });
  assert.equal(settingsMissingBrowser.status, 400);
  assert.equal(settingsMissingBrowser.body.code, 'invalid_request_body');

  const cache = await shim({
    url: '/api/browser/cache',
    method: 'DELETE',
    body: ['bad'],
  });
  assert.equal(cache.status, 400);
  assert.equal(cache.body.code, 'invalid_request_body');

  const cacheNull = await shim({
    url: '/api/browser/cache',
    method: 'DELETE',
    body: null,
  });
  assert.equal(cacheNull.status, 400);
  assert.equal(cacheNull.body.code, 'invalid_request_body');

  const actionNull = await shim({
    url: '/api/browser/actions',
    method: 'POST',
    body: null,
  });
  assert.equal(actionNull.status, 400);
  assert.equal(actionNull.body.code, 'invalid_request_body');

  const action = await shim({
    url: '/api/browser/actions',
    method: 'POST',
    body: { resourceUri: 'metaid://idq1peer' },
  });
  assert.equal(action.status, 400);
  assert.equal(action.body.code, 'invalid_browser_action');

  const actionPayload = await shim({
    url: '/api/browser/actions',
    method: 'POST',
    body: {
      resourceUri: 'metaid://idq1peer',
      kind: 'open-conversation',
      payload: 'bad',
    },
  });
  assert.equal(actionPayload.status, 400);
  assert.equal(actionPayload.body.code, 'invalid_request_body');

  assert.deepEqual(calls, []);
});
