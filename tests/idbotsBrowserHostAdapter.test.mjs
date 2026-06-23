import assert from 'node:assert/strict';
import test from 'node:test';

import { createIdbotsBrowserHostAdapter } from '../src/renderer/features/botBrowser/idbotsBrowserHostAdapter.ts';

function createMetabot(overrides = {}) {
  return {
    id: 1,
    name: ' Alpha ',
    avatar: ' https://cdn.example/avatar.png ',
    globalmetaid: ' IDQ1ABC ',
    created_at: 10,
    ...overrides,
  };
}

function createMetaApp(overrides = {}) {
  return {
    sourcePinId: 'pin123i0',
    name: 'Local Demo',
    creatorMetaId: 'idq1publisher',
    description: 'Demo app',
    version: '1.0.0',
    entry: 'index.html',
    codePinId: 'code123i0',
    updatedAt: 1_700_000_000_000,
    sourceType: 'community',
    ...overrides,
  };
}

function createJsonResponse(payload, status = 200) {
  return {
    status,
    async json() {
      return payload;
    },
  };
}

function createAdapter(overrides = {}) {
  return createIdbotsBrowserHostAdapter({
    listMetabots: async () => [createMetabot()],
    listMetaApps: async () => [createMetaApp()],
    resolveMetaAppUrl: async () => 'http://127.0.0.1:17878/metaapps/demo',
    openConversation: async () => {},
    ...overrides,
  });
}

test('getRuntime exposes the IDBots host and local actors/default actor', async () => {
  const adapter = createAdapter({
    listMetabots: async () => [
      createMetabot({ id: 3, created_at: 30, globalmetaid: '   ' }),
      createMetabot({ id: 2, name: ' Beta ', created_at: 20, globalmetaid: 'IDQ1DEF' }),
      createMetabot({ id: 1, created_at: 10, globalmetaid: 'IDQ1ABC' }),
    ],
  });

  const result = await adapter.getRuntime();

  assert.equal(result.ok, true);
  assert.deepEqual(result.data.host, { kind: 'idbots', name: 'IDBots', localMode: true });
  assert.deepEqual(
    result.data.actors.map((actor) => actor.id),
    ['idbots-metabot-1', 'idbots-metabot-2'],
  );
  assert.equal(result.data.defaultActor.id, 'idbots-metabot-1');
  assert.equal(result.data.defaultUri, null);
  assert.deepEqual(result.data.features, {
    privateChat: true,
    serviceCall: false,
    cacheManagement: true,
    templateSettings: true,
    walletLogin: false,
  });
  assert.match(result.data.labels.noActorTitle, /Bot/i);
  assert.doesNotMatch(result.data.labels.noActorTitle, /MetaBot/i);
  assert.match(result.data.labels.noActorBody, /local/i);
  assert.match(result.data.labels.noActorAction.label, /Bot/i);
  assert.doesNotMatch(result.data.labels.noActorAction.label, /MetaBot/i);
});

test('resolveResource finds a local MetaApp by normalized source pin id and returns its local run URL', async () => {
  const resolvedApps = [];
  const adapter = createAdapter({
    listMetaApps: async () => [
      createMetaApp({ sourcePinId: ' other ' }),
      createMetaApp({ sourcePinId: ' pin123i0 ' }),
    ],
    resolveMetaAppUrl: async (app) => {
      resolvedApps.push(app.sourcePinId);
      return 'http://127.0.0.1:17878/metaapps/local-demo';
    },
  });

  const result = await adapter.resolveResource({ uri: 'metaapp://PIN123I0' });

  assert.equal(result.ok, true);
  assert.equal(result.data.resourceType, 'metaapp');
  assert.equal(result.data.normalizedUri, 'metaapp://pin123i0');
  assert.equal(result.data.renderer.url, 'http://127.0.0.1:17878/metaapps/local-demo');
  assert.equal(result.data.renderer.data.record.runUrl, 'http://127.0.0.1:17878/metaapps/local-demo');
  assert.deepEqual(resolvedApps, [' pin123i0 ']);
});

test('resolveResource installs a community MetaApp by source pin id before resolving its local URL', async () => {
  const sourcePinId = 'c06b7a2db6efa241560a2356e9966cf9758dae3ec9c795f614a652b113e30329i0';
  let installed = false;
  const installRequests = [];
  const resolvedApps = [];
  const adapter = createAdapter({
    listMetaApps: async () => installed
      ? [createMetaApp({ sourcePinId, id: 'community-demo' })]
      : [],
    installCommunityMetaApp: async (pinId) => {
      installRequests.push(pinId);
      installed = true;
      return { success: true, appId: 'community-demo', name: 'Community Demo', status: 'installed' };
    },
    resolveMetaAppUrl: async (app) => {
      resolvedApps.push(app.sourcePinId);
      return 'http://127.0.0.1:17878/metaapps/community-demo';
    },
  });

  const result = await adapter.resolveResource({ uri: `metaapp://${sourcePinId.toUpperCase()}` });

  assert.equal(result.ok, true);
  assert.equal(result.data.resourceType, 'metaapp');
  assert.equal(result.data.normalizedUri, `metaapp://${sourcePinId}`);
  assert.equal(result.data.renderer.url, 'http://127.0.0.1:17878/metaapps/community-demo');
  assert.deepEqual(installRequests, [sourcePinId]);
  assert.deepEqual(resolvedApps, [sourcePinId]);
});

test('resolveResource prefers the Browser MetaApp cache resolver before install fallback', async () => {
  const sourcePinId = 'c06b7a2db6efa241560a2356e9966cf9758dae3ec9c795f614a652b113e30329i0';
  const resolvedPins = [];
  const installRequests = [];
  const adapter = createAdapter({
    listMetaApps: async () => [],
    resolveMetaAppPin: async (pinId) => {
      resolvedPins.push(pinId);
      return {
        ok: true,
        state: 'success',
        data: {
          pinId,
          firstPinId: pinId,
          operation: 'create',
          title: 'Eric Homepage',
          appName: 'eric-homepage',
          version: '1.0.0',
          runtime: 'browser',
          indexFile: 'index.html',
          code: 'metafile://code123i0.zip',
          content: 'metafile://code123i0.zip',
          contentType: 'text/html',
          codeType: 'application/zip',
          tags: [],
          ownerGlobalMetaId: 'idq1publisher',
          network: 'mvc',
          localUiUrl: 'http://127.0.0.1:23456/browser-cache/metaapp-preview/session/index.html',
          runUrl: 'http://127.0.0.1:23456/browser-cache/metaapp-preview/session/index.html',
          updatedAt: 1_700_000_000_000,
          source: 'indexer',
        },
      };
    },
    installCommunityMetaApp: async (pinId) => {
      installRequests.push(pinId);
      return { success: false, error: 'install should not be used' };
    },
  });

  const result = await adapter.resolveResource({ uri: `metaapp://${sourcePinId.toUpperCase()}` });

  assert.equal(result.ok, true);
  assert.equal(result.data.resourceType, 'metaapp');
  assert.equal(result.data.normalizedUri, `metaapp://${sourcePinId}`);
  assert.equal(result.data.renderer.type, 'html-iframe');
  assert.equal(
    result.data.renderer.url,
    'http://127.0.0.1:23456/browser-cache/metaapp-preview/session/index.html',
  );
  assert.deepEqual(resolvedPins, [sourcePinId]);
  assert.deepEqual(installRequests, []);
});

test('resolveResource filters service actions and converts private-chat to open-conversation', async () => {
  const adapter = createAdapter({
    fetch: async () =>
      createJsonResponse({
        code: 0,
        data: {
          schemaVersion: 'botHomepage.v3',
          identity: { globalMetaId: 'idq1peer' },
          profile: { name: 'Peer Bot' },
          actions: [
            { id: 'custom-private', label: 'Message', kind: 'private-chat', enabled: true, payload: { to: 'idq1payload' } },
            {
              id: 'custom-conversation',
              label: 'Conversation',
              kind: 'open-conversation',
              enabled: true,
              payload: {
                conversationUri: 'map://simplemsg/conversation?peer=idq1peer',
                peerGlobalMetaId: 'idq1peer',
              },
            },
            { id: 'custom-service', label: 'Service', kind: 'service-call', enabled: true },
          ],
        },
      }),
  });

  const result = await adapter.resolveResource({ uri: 'metaid://idq1peer' });

  assert.equal(result.ok, true);
  assert.equal(result.data.actions.some((action) => action.kind === 'service-call'), false);
  assert.equal(result.data.actions.some((action) => action.kind === 'service-list'), false);

  const converted = result.data.actions.find((action) => action.id === 'custom-private');
  assert.equal(converted.kind, 'open-conversation');
  assert.equal(converted.payload.peerGlobalMetaId, 'idq1payload');
  assert.equal(converted.payload.conversationUri, 'map://simplemsg/conversation?peer=idq1payload');

  const canonical = result.data.actions.find((action) => action.id === 'custom-conversation');
  assert.equal(canonical.kind, 'open-conversation');
  assert.equal(canonical.payload.conversationUri, 'map://simplemsg/conversation?peer=idq1peer');
});

test('resolveResource removes unsupported renderer service payload while preserving other renderer data', async () => {
  const adapter = createAdapter({
    fetch: async () =>
      createJsonResponse({
        code: 0,
        data: {
          schemaVersion: 'botHomepage.v3',
          identity: { globalMetaId: 'idq1peer' },
          profile: { name: 'Peer Bot' },
          services: [
            { id: 'svc-1', name: 'Unsupported service' },
          ],
          sections: [
            { id: 'overview', title: 'Overview', items: [{ text: 'keep me' }] },
            { id: 'services', title: 'Services', items: [{ id: 'svc-2' }] },
          ],
          actions: [
            { id: 'custom-service-list', label: 'Services', kind: 'service-list', enabled: true },
          ],
        },
      }),
  });

  const result = await adapter.resolveResource({ uri: 'metaid://idq1peer' });

  assert.equal(result.ok, true);
  assert.equal(result.data.renderer.data.profile.name, 'Peer Bot');
  assert.equal(result.data.renderer.data.identity.globalMetaId, 'idq1peer');
  assert.equal('services' in result.data.renderer.data, false);
  assert.deepEqual(result.data.renderer.data.sections, [
    { id: 'overview', title: 'Overview', items: [{ text: 'keep me' }] },
  ]);
  assert.equal(result.data.actions.some((action) => action.kind === 'service-list'), false);
});

test('runTrustedAction opens a conversation only with a local actor id and peer id', async () => {
  const opened = [];
  const adapter = createAdapter({
    listMetabots: async () => [createMetabot({ id: 7, globalmetaid: 'idq1777' })],
    openConversation: async (request) => {
      opened.push(request);
    },
  });

  const missingActor = await adapter.runTrustedAction({
    resourceUri: 'metaid://idq1peer',
    kind: 'open-conversation',
    payload: { peerGlobalMetaId: 'idq1peer' },
  });
  assert.equal(missingActor.ok, false);
  assert.equal(missingActor.code, 'browser_action_missing_actor');
  assert.doesNotMatch(missingActor.message, /MetaBot/i);

  const invalidActor = await adapter.runTrustedAction({
    actorId: 'oac-bot-1',
    resourceUri: 'metaid://idq1peer',
    kind: 'open-conversation',
    payload: { peerGlobalMetaId: 'idq1peer' },
  });
  assert.equal(invalidActor.ok, false);
  assert.equal(invalidActor.code, 'browser_action_invalid_actor');
  assert.doesNotMatch(invalidActor.message, /MetaBot/i);

  const missingLocalActor = await adapter.runTrustedAction({
    actorId: 'idbots-metabot-999',
    resourceUri: 'metaid://idq1peer',
    kind: 'open-conversation',
    payload: { peerGlobalMetaId: 'idq1peer' },
  });
  assert.equal(missingLocalActor.ok, false);
  assert.equal(missingLocalActor.code, 'browser_action_invalid_actor');
  assert.doesNotMatch(missingLocalActor.message, /MetaBot/i);

  const missingPeer = await adapter.runTrustedAction({
    actorId: 'idbots-metabot-7',
    resourceUri: 'metaid://idq1peer',
    kind: 'open-conversation',
  });
  assert.equal(missingPeer.ok, false);
  assert.equal(missingPeer.code, 'browser_action_missing_peer');
  assert.doesNotMatch(missingPeer.message, /MetaBot/i);

  const invalidPeer = await adapter.runTrustedAction({
    actorId: 'idbots-metabot-7',
    resourceUri: 'metaid://abc',
    kind: 'open-conversation',
    payload: { peerGlobalMetaId: 'abc' },
  });
  assert.equal(invalidPeer.ok, false);
  assert.equal(invalidPeer.code, 'browser_action_missing_peer');
  assert.doesNotMatch(invalidPeer.message, /MetaBot/i);

  const success = await adapter.runTrustedAction({
    actorId: 'idbots-metabot-7',
    resourceUri: 'metaid://idq1peer',
    kind: 'private-chat',
    payload: {
      to: ' IDQ1PEER ',
      conversationUri: 'map://simplemsg/conversation?peer=idq1peer',
      peerName: 'Peer Bot',
      peerAvatar: 'https://cdn.example/peer.png',
    },
  });

  assert.equal(success.ok, true);
  assert.deepEqual(success.data, {
    kind: 'private-chat',
    handled: true,
    data: { message: 'Conversation opened in IDBots.' },
  });
  assert.deepEqual(opened, [
    {
      actionKind: 'private-chat',
      actorId: 'idbots-metabot-7',
      resourceUri: 'metaid://idq1peer',
      peerGlobalMetaId: 'idq1peer',
      conversationUri: 'map://simplemsg/conversation?peer=idq1peer',
      peerName: 'Peer Bot',
      peerAvatar: 'https://cdn.example/peer.png',
    },
  ]);
});

test('settings and cache return browser command result envelopes', async () => {
  const cacheSnapshot = {
    cacheRoot: '/tmp/idbots-browser-cache/metaapps',
    artifactCount: 1,
    activePreviewSessionCount: 1,
  };
  const adapter = createAdapter({
    getMetaAppCache: async () => ({ ok: true, state: 'success', data: cacheSnapshot }),
    clearMetaAppCache: async (input) => ({
      ok: true,
      state: 'success',
      data: { clearedArtifacts: 1, clearedPinRecords: 1, input },
    }),
  });

  const settings = await adapter.getSettings();
  assert.equal(settings.ok, true);
  assert.equal(settings.data.effectiveBrowser.localMode, true);

  const updated = await adapter.updateSettings({ browser: { renderCustomBotPages: false } });
  assert.equal(updated.ok, true);
  assert.equal(updated.data.browser.renderCustomBotPages, false);
  assert.equal(updated.data.effectiveBrowser.localMode, true);

  const cache = await adapter.getCache();
  assert.deepEqual(cache, { ok: true, state: 'success', data: cacheSnapshot });

  const cleared = await adapter.clearCache({ all: true });
  assert.deepEqual(cleared, {
    ok: true,
    state: 'success',
    data: { clearedArtifacts: 1, clearedPinRecords: 1, input: { all: true } },
  });
});
