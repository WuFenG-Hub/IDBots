import assert from 'node:assert/strict';
import test from 'node:test';

import {
  browserFailure,
  browserManualActionRequired,
  browserSuccess,
} from '@openagentinternet/agent-browser-host-contract';
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
      async getProfile(input) {
        calls.push(['getProfile', input]);
        return browserSuccess({
          globalMetaId: input.globalMetaId,
          name: 'Owner Bot',
          avatar: 'https://cdn.example/owner.png',
        });
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
        sessionId: undefined,
      },
    ],
  ]);
});

test('endpoint shim returns manual_action_required as HTTP 200 without changing state or data', async () => {
  const manualAction = browserManualActionRequired(
    'manual_action_required',
    'Confirm this MetaID PIN write before the host signs or broadcasts it.',
    {
      data: {
        confirmation: {
          actor: {
            uri: 'metaid://idq1abc',
            globalMetaId: 'idq1abc',
            name: 'Alpha',
          },
          operation: 'create',
          path: '/protocols/simplebuzz',
          contentType: 'application/json;utf-8',
          payloadSize: 19,
          confirmationId: 'confirmation-1',
          expiresAt: 1_700_000_060_000,
        },
        confirmRequest: {
          resourceUri: 'metaapp://app123i0',
          kind: 'metaid-pin-write',
          payload: {
            operation: 'create',
            confirmed: true,
            hostConfirmation: { id: 'confirmation-1', token: 'opaque-token-1' },
          },
        },
      },
    },
  );
  const { adapter } = createAdapter();
  const shim = createBrowserEndpointShim({
    ...adapter,
    async runTrustedAction() {
      return manualAction;
    },
  });

  const response = await shim({
    url: '/api/browser/actions?actorId=idbots-metabot-1',
    method: 'POST',
    body: {
      resourceUri: 'metaapp://app123i0',
      kind: 'metaid-pin-write',
      payload: { operation: 'create' },
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, manualAction);
  assert.equal(response.body.state, 'manual_action_required');
  assert.equal(response.body.data.confirmRequest.payload.hostConfirmation.token, 'opaque-token-1');
});

test('endpoint shim forwards Browser info profile lookups', async () => {
  const { adapter, calls } = createAdapter();
  const shim = createBrowserEndpointShim(adapter);

  const profile = await shim({
    url: '/api/browser/info?globalMetaId=%20IDQ1OWNER%20&actorId=idbots-metabot-1',
  });

  assert.equal(profile.status, 200);
  assert.deepEqual(profile.body, {
    ok: true,
    state: 'success',
    data: {
      globalMetaId: 'IDQ1OWNER',
      name: 'Owner Bot',
      avatar: 'https://cdn.example/owner.png',
    },
  });
  assert.deepEqual(calls, [
    ['getProfile', { actorId: 'idbots-metabot-1', globalMetaId: 'IDQ1OWNER' }],
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

test('endpoint shim forwards MetaFile host-picker uploads as trusted actions', async () => {
  const { adapter, calls } = createAdapter();
  const shim = createBrowserEndpointShim(adapter);

  const upload = await shim({
    url: '/api/browser/metafile-upload?actorId=idbots-metabot-1',
    method: 'POST',
    body: {
      source: {
        kind: 'host-picker',
        multiple: true,
        accept: ['image/png'],
      },
      purpose: 'profile-cover',
    },
  });

  assert.equal(upload.status, 200);
  assert.deepEqual(upload.body.data, {
    kind: 'metafile-upload',
    handled: true,
    data: { message: 'ok' },
  });
  assert.deepEqual(calls, [
    [
      'runTrustedAction',
      {
        actorId: 'idbots-metabot-1',
        resourceUri: '',
        kind: 'metafile-upload',
        payload: {
          source: {
            kind: 'host-picker',
            multiple: true,
            accept: ['image/png'],
          },
          purpose: 'profile-cover',
        },
      },
    ],
  ]);
});

test('endpoint shim rejects invalid MetaFile upload requests before adapter execution', async () => {
  const { adapter, calls } = createAdapter();
  const shim = createBrowserEndpointShim(adapter);

  const wrongMethod = await shim({
    url: '/api/browser/metafile-upload',
    method: 'GET',
  });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.body.code, 'method_not_allowed');

  const badBody = await shim({
    url: '/api/browser/metafile-upload',
    method: 'POST',
    body: 'bad',
  });
  assert.equal(badBody.status, 400);
  assert.equal(badBody.body.code, 'invalid_request');

  assert.deepEqual(calls, []);
});

test('endpoint shim converts adapter throws into browser failure envelopes', async () => {
  const { adapter } = createAdapter();
  const shim = createBrowserEndpointShim({
    ...adapter,
    async getRuntime() {
      throw new Error('runtime exploded');
    },
    async runTrustedAction() {
      throw new Error('action exploded');
    },
  });

  const runtime = await shim({ url: '/api/browser/runtime' });
  assert.equal(runtime.status, 400);
  assert.equal(runtime.body.ok, false);
  assert.equal(runtime.body.state, 'failed');
  assert.equal(runtime.body.code, 'browser_endpoint_error');
  assert.match(runtime.body.message, /runtime exploded/);

  const action = await shim({
    url: '/api/browser/actions',
    method: 'POST',
    body: {
      resourceUri: 'metaid://idq1peer',
      kind: 'open-conversation',
      payload: { peerGlobalMetaId: 'idq1peer' },
    },
  });
  assert.equal(action.status, 400);
  assert.equal(action.body.ok, false);
  assert.equal(action.body.state, 'failed');
  assert.equal(action.body.code, 'browser_endpoint_error');
  assert.match(action.body.message, /action exploded/);
});
