import assert from 'node:assert/strict';
import test from 'node:test';

import { createBotBrowserHostService } from '../src/main/services/botBrowserHostService.ts';

const CANONICAL_GLOBAL_META_ID = 'idq14hmv23j5fnlx4ccnmvlyldjd38xjsechzwg9xz';

function createMetaApp(overrides = {}) {
  return {
    id: 'demo-app',
    sourcePinId: 'pin123i0',
    name: 'Local Demo',
    creatorMetaId: 'idq1publisher',
    description: 'Demo app',
    version: '1.0.0',
    entry: 'index.html',
    codePinId: 'code123i0',
    updatedAt: 1_700_000_000_000,
    sourceType: 'chain-community',
    prompt: '',
    icon: '',
    cover: '',
    ...overrides,
  };
}

function createJsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    async json() {
      return payload;
    },
  };
}

function createHostService(overrides = {}) {
  return createBotBrowserHostService({
    listMetaApps: async () => [],
    resolveMetaAppPin: async () => ({
      ok: false,
      code: 'browser_resource_not_found',
      message: 'Resource not found.',
    }),
    installCommunityMetaApp: async () => ({
      success: false,
      error: 'Resource not found.',
    }),
    resolveMetaAppUrl: async () => 'http://127.0.0.1:17878/metaapps/demo-app',
    ...overrides,
  });
}

function createEnsProviderFactory(input) {
  return {
    id: 'ens',
    supportsName(name) {
      return String(name ?? '').trim().toLowerCase().endsWith('.eth');
    },
    async resolveNameAlias(request) {
      return {
        ok: true,
        data: {
          provider: 'ens',
          normalizedName: String(request.name ?? '').trim().toLowerCase(),
          textKey: input.textKey,
          canonicalUri: `metaid://${CANONICAL_GLOBAL_META_ID}`,
          resolvedAt: 1_720_000_000_000,
          verificationState: 'verified',
          raw: {
            rpcUrls: [...input.rpcUrls],
          },
        },
      };
    },
  };
}

test('resolveResource keeps local MetaApp resolution working through the host service', async () => {
  const service = createHostService({
    listMetaApps: async () => [
      createMetaApp({ sourcePinId: ' pin123i0 ' }),
    ],
    resolveMetaAppUrl: async () => 'http://127.0.0.1:17878/metaapps/local-demo',
  });

  const result = await service.resolveResource({ uri: 'metaapp://PIN123I0' });

  assert.equal(result.ok, true);
  assert.equal(result.data.resourceType, 'metaapp');
  assert.equal(result.data.normalizedUri, 'metaapp://PIN123I0');
  assert.equal(result.data.renderer.url, 'http://127.0.0.1:17878/metaapps/local-demo');
});

test('resolveResource enriches pin owners through ABC profile fetching with host-default fetch', async () => {
  const pinId = '941c5cfe188a01f50c925c0dfab640b3e1a0638a22979c801e8b8c1f45dbda2di0';
  const ownerGlobalMetaId = 'idq14hmv23j5fnlx4ccnmvlyldjd38xjsechzwg9xz';
  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    if (String(url).includes(`/pin/${pinId}`)) {
      return createJsonResponse({
        code: 0,
        data: {
          pin: {
            pinId,
            ownerGlobalMetaId,
            contentType: 'application/json',
            contentBody: JSON.stringify({ title: 'Demo Pin' }),
          },
        },
      });
    }
    if (String(url).includes(`/api/info/globalmetaid/${ownerGlobalMetaId}`)) {
      return createJsonResponse({
        code: 0,
        data: {
          globalMetaId: ownerGlobalMetaId,
          name: 'Owner Bot',
          avatarId: 'avatar123i0',
        },
      });
    }
    return createJsonResponse({}, 404);
  };

  try {
    const service = createHostService();
    const result = await service.resolveResource({ uri: `pin://${pinId}` });

    assert.equal(result.ok, true);
    assert.equal(result.data.owner.globalMetaId, ownerGlobalMetaId);
    assert.equal(result.data.owner.name, 'Owner Bot');
    assert.equal(result.data.owner.avatar, 'https://file.metaid.io/metafile-indexer/content/avatar123i0');
    assert.deepEqual(fetchCalls, [
      `https://manapi.metaid.io/pin/${pinId}`,
      `https://so.metaid.io/api/info/globalmetaid/${ownerGlobalMetaId}`,
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('getProfile reuses ABC fetchBotProfileInfo for Browser info hydration', async () => {
  const globalMetaId = 'idq14hmv23j5fnlx4ccnmvlyldjd38xjsechzwg9xz';
  const fetchCalls = [];
  const service = createHostService({
    fetch: async (url) => {
      fetchCalls.push(String(url));
      return createJsonResponse({
        code: 0,
        data: {
          globalMetaId,
          name: 'Related Bot',
          avatarId: 'relatedavatar123i0',
        },
      });
    },
  });

  const result = await service.getProfile({ globalMetaId });

  assert.equal(result.ok, true);
  assert.deepEqual(result.data, {
    globalMetaId,
    name: 'Related Bot',
    avatar: 'https://file.metaid.io/metafile-indexer/content/relatedavatar123i0',
  });
  assert.deepEqual(fetchCalls, [
    `https://so.metaid.io/api/info/globalmetaid/${globalMetaId}`,
  ]);
});

test('resolveResource resolves a bare ENS alias from host settings and preserves alias semantics', async () => {
  const fetchCalls = [];
  const providerFactoryCalls = [];
  const service = createHostService({
    fetch: async (url) => {
      fetchCalls.push(String(url));
      return createJsonResponse({
        code: 0,
        data: {
          schemaVersion: 'botHomepage.v3',
          identity: { globalMetaId: CANONICAL_GLOBAL_META_ID },
          profile: { name: 'Sunny Bot' },
        },
      });
    },
    ensNameAliasProviderFactory: (config) => {
      providerFactoryCalls.push(config);
      return createEnsProviderFactory(config);
    },
  });

  const updated = await service.updateSettings({
    browser: {
      nameResolution: {
        enabled: true,
        ens: {
          enabled: true,
          rpcUrls: ['https://rpc.example'],
          textKey: 'org.example.agent-browser.uri',
        },
      },
    },
  });
  assert.equal(updated.ok, true);

  const result = await service.resolveResource({ uri: 'sunnyfung.eth' });

  assert.equal(result.ok, true);
  assert.equal(result.data.uri, 'metaid://sunnyfung.eth');
  assert.equal(result.data.normalizedUri, 'metaid://sunnyfung.eth');
  assert.equal(result.data.owner.globalMetaId, CANONICAL_GLOBAL_META_ID);
  assert.deepEqual(providerFactoryCalls, [
    {
      chainId: 1,
      rpcUrls: ['https://rpc.example'],
      textKey: 'org.example.agent-browser.uri',
    },
  ]);
  assert.deepEqual(fetchCalls, [
    `https://so.metaid.io/api/bot-homepage/globalmetaid/${CANONICAL_GLOBAL_META_ID}?version=v3`,
  ]);
});

test('resolveResource resolves metaid:// ENS aliases and keeps the alias in the visible URI', async () => {
  const service = createHostService({
    fetch: async () => createJsonResponse({
      code: 0,
      data: {
        schemaVersion: 'botHomepage.v3',
        identity: { globalMetaId: CANONICAL_GLOBAL_META_ID },
        profile: { name: 'Sunny Bot' },
      },
    }),
    ensNameAliasProviderFactory: (config) => createEnsProviderFactory(config),
  });

  const result = await service.resolveResource({ uri: 'metaid://sunnyfung.eth' });

  assert.equal(result.ok, true);
  assert.equal(result.data.uri, 'metaid://sunnyfung.eth');
  assert.equal(result.data.normalizedUri, 'metaid://sunnyfung.eth');
  assert.equal(result.data.owner.globalMetaId, CANONICAL_GLOBAL_META_ID);
});

test('resolveResource returns name_resolution_unavailable when ENS is disabled in host settings', async () => {
  const providerFactoryCalls = [];
  const service = createHostService({
    ensNameAliasProviderFactory: (config) => {
      providerFactoryCalls.push(config);
      return createEnsProviderFactory(config);
    },
  });

  const updated = await service.updateSettings({
    browser: {
      nameResolution: {
        enabled: false,
        ens: {
          enabled: true,
          rpcUrls: ['https://rpc.example'],
          textKey: 'org.example.agent-browser.uri',
        },
      },
    },
  });
  assert.equal(updated.ok, true);

  const result = await service.resolveResource({ uri: 'sunnyfung.eth' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'name_resolution_unavailable');
  assert.deepEqual(providerFactoryCalls, []);
});

test('resolveResource returns name_resolution_unavailable when ENS rpcUrls are explicitly emptied', async () => {
  const providerFactoryCalls = [];
  const service = createHostService({
    ensNameAliasProviderFactory: (config) => {
      providerFactoryCalls.push(config);
      return createEnsProviderFactory(config);
    },
  });

  const updated = await service.updateSettings({
    browser: {
      nameResolution: {
        enabled: true,
        ens: {
          enabled: true,
          rpcUrls: [],
          textKey: 'org.example.agent-browser.uri',
        },
      },
    },
  });
  assert.equal(updated.ok, true);

  const settings = await service.getSettings();
  assert.equal(settings.ok, true);
  assert.deepEqual(settings.data.effectiveBrowser.nameResolution, {
    enabled: true,
    ens: {
      enabled: false,
      chainId: 1,
      rpcUrls: [],
      textKey: 'org.example.agent-browser.uri',
    },
  });

  const result = await service.resolveResource({ uri: 'sunnyfung.eth' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'name_resolution_unavailable');
  assert.deepEqual(providerFactoryCalls, []);
});
