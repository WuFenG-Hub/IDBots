import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let listCommunityMetaApps;
try {
  ({ listCommunityMetaApps } = require('../dist-electron/main/services/metaAppChainService.js'));
} catch {
  listCommunityMetaApps = null;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function chainMetaAppItem(index, overrides = {}) {
  const suffix = String(index).padStart(2, '0');
  return {
    id: `pin-${suffix}`,
    globalMetaId: `idq1creator${suffix}`,
    timestamp: 1_888_888_000 + index,
    contentSummary: JSON.stringify({
      title: `Paged App ${suffix}`,
      appName: `paged-app-${suffix}`,
      intro: `Paged chain app ${suffix}`,
      runtime: 'browser',
      version: '1.0.0',
      code: `metafile://zip-paged-app-${suffix}`,
      codeType: 'application/zip',
      indexFile: 'index.html',
      disabled: false,
      ...overrides,
    }),
  };
}

test('listCommunityMetaApps parses chain protocol items and computes install status', async () => {
  assert.equal(typeof listCommunityMetaApps, 'function', 'listCommunityMetaApps() should be exported');

  const nowTs = 1_777_777_777;
  const manager = {
    listMetaApps: () => [
      {
        id: 'buzz',
        version: '1.0.0',
        creatorMetaId: 'idq1creator',
        sourceType: 'chain-community',
      },
      {
        id: 'chat',
        version: '2.0.0',
        creatorMetaId: 'idq1local',
        sourceType: 'manual',
      },
    ],
  };

  const fetched = [
    {
      id: 'pin-buzz-new',
      globalMetaId: 'idq1creator',
      timestamp: nowTs,
      contentSummary: JSON.stringify({
        title: 'Buzz',
        appName: 'buzz',
        intro: 'Buzz chain app',
        prompt: 'Create a social feed MetaApp with a compact composer.',
        runtime: 'browser/android',
        version: '1.2.0',
        icon: 'metafile://icon-buzz',
        coverImg: 'metafile://cover-buzz',
        code: 'metafile://zip-buzz',
        codeType: 'application/zip',
        indexFile: 'index.html',
        disabled: false,
      }),
    },
    {
      id: 'pin-chat-conflict',
      globalMetaId: 'idq1another',
      timestamp: nowTs,
      contentSummary: JSON.stringify({
        title: 'Chat',
        appName: 'chat',
        intro: 'Chat chain app',
        runtime: 'browser',
        version: '2.1.0',
        code: 'metafile://zip-chat',
        codeType: 'application/zip',
        indexFile: 'index.html',
        disabled: false,
      }),
    },
    {
      id: 'pin-uninstallable',
      globalMetaId: 'idq1native',
      timestamp: nowTs,
      contentSummary: JSON.stringify({
        title: 'Native only',
        appName: 'native-only',
        runtime: 'android/ios',
        version: '1.0.0',
        code: 'metafile://zip-native',
        codeType: 'application/zip',
        disabled: false,
      }),
    },
    {
      id: 'pin-invalid',
      globalMetaId: 'idq1creator',
      timestamp: nowTs,
      contentSummary: '{',
    },
  ];

  const result = await listCommunityMetaApps({
    manager,
    fetchList: async () => fetched,
    fetchAuthorInfo: async (creatorMetaId) => {
      if (creatorMetaId === 'idq1creator') {
        return { name: 'Creator Bot', avatar: '/content/avatar-creator' };
      }
      if (creatorMetaId === 'idq1another') {
        return { name: 'Another Bot', avatar: 'metafile://avatar-another' };
      }
      if (creatorMetaId === 'idq1native') {
        return { name: 'Native Bot', avatarId: '/content/avatar-native' };
      }
      return null;
    },
  });

  assert.equal(result.success, true);
  assert.equal(Array.isArray(result.apps), true);
  assert.equal(result.apps.length, 3);

  const buzz = result.apps.find((app) => app.appId === 'buzz');
  assert.ok(buzz);
  assert.equal(buzz.status, 'update');
  assert.equal(buzz.installable, true);
  assert.equal(buzz.codePinId, 'zip-buzz');
  assert.equal(buzz.icon, 'metafile://icon-buzz');
  assert.equal(buzz.cover, 'metafile://cover-buzz');
  assert.equal(buzz.authorName, 'Creator Bot');
  assert.equal(buzz.authorAvatar, '/content/avatar-creator');
  assert.equal(buzz.aiPrompt, 'Create a social feed MetaApp with a compact composer.');

  const chat = result.apps.find((app) => app.appId === 'chat');
  assert.ok(chat);
  assert.equal(chat.status, 'uninstallable');
  assert.equal(chat.authorName, 'Another Bot');
  assert.equal(chat.authorAvatar, 'metafile://avatar-another');
  assert.match(chat.reason || '', /冲突|conflict|阻止覆盖安装/i);

  const nativeOnly = result.apps.find((app) => app.appId === 'native-only');
  assert.ok(nativeOnly);
  assert.equal(nativeOnly.status, 'uninstallable');
  assert.equal(nativeOnly.authorName, 'Native Bot');
  assert.equal(nativeOnly.authorAvatar, '/content/avatar-native');
  assert.match(nativeOnly.reason || '', /browser/i);
});

test('listCommunityMetaApps forwards cursor and size, and returns nextCursor', async () => {
  assert.equal(typeof listCommunityMetaApps, 'function', 'listCommunityMetaApps() should be exported');

  const calls = [];
  const result = await listCommunityMetaApps({
    manager: { listMetaApps: () => [] },
    cursor: 'cursor-30',
    size: 30,
    fetchList: async (params = {}) => {
      calls.push(params);
      return {
        list: Array.from({ length: 30 }, (_, index) => chainMetaAppItem(index + 1)),
        nextCursor: 'cursor-60',
      };
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.nextCursor, 'cursor-60');
  assert.deepEqual(calls, [{ cursor: 'cursor-30', size: 30 }]);
  assert.equal(result.apps.length, 30);
  assert.equal(result.apps[0]?.appId, 'paged-app-30');
});

test('listCommunityMetaApps hides nextCursor when the current page is shorter than the requested page size', async () => {
  assert.equal(typeof listCommunityMetaApps, 'function', 'listCommunityMetaApps() should be exported');

  const result = await listCommunityMetaApps({
    manager: { listMetaApps: () => [] },
    cursor: 'cursor-30',
    size: 30,
    fetchList: async () => ({
      list: Array.from({ length: 12 }, (_, index) => chainMetaAppItem(index + 1)),
      nextCursor: 'stale-cursor-after-short-page',
    }),
  });

  assert.equal(result.success, true);
  assert.equal(result.apps.length, 12);
  assert.equal(result.nextCursor, null);
});

test('listCommunityMetaApps uses the remote chain list when the local indexer is stale but non-empty', async () => {
  assert.equal(typeof listCommunityMetaApps, 'function', 'listCommunityMetaApps() should be exported');

  const previousFetch = globalThis.fetch;
  const previousLocalBase = process.env.IDBOTS_MAN_P2P_LOCAL_BASE;
  const calls = [];

  process.env.IDBOTS_MAN_P2P_LOCAL_BASE = 'http://127.0.0.1:19099';
  globalThis.fetch = async (url) => {
    const href = String(url);
    calls.push(href);

    if (href.startsWith('http://127.0.0.1:19099')) {
      return jsonResponse({
        code: 1,
        data: {
          list: [{
            id: 'local-stale-pin',
            globalMetaId: 'idq1local',
            timestamp: 100,
            contentSummary: JSON.stringify({
              title: 'Local Stale App',
              appName: 'local-stale-app',
              intro: 'Only present in the stale local indexer page',
              runtime: 'browser',
              version: '1.0.0',
              code: 'metafile://zip-local-stale',
              codeType: 'application/zip',
              indexFile: 'index.html',
              disabled: false,
            }),
          }],
          nextCursor: 'local-next',
        },
      });
    }

    if (href.startsWith('https://manapi.metaid.io')) {
      return jsonResponse({
        code: 1,
        data: {
          list: Array.from({ length: 30 }, (_, index) => chainMetaAppItem(index + 1, {
            title: `Remote Current App ${index + 1}`,
            appName: `remote-current-app-${index + 1}`,
          })),
          nextCursor: 'remote-next',
        },
      });
    }

    throw new Error(`Unexpected fetch: ${href}`);
  };

  try {
    const result = await listCommunityMetaApps({
      manager: { listMetaApps: () => [] },
      fetchAuthorInfo: async () => null,
      cursor: '0',
      size: 30,
    });

    assert.equal(result.success, true);
    assert.equal(result.nextCursor, 'remote-next');
    assert.deepEqual(result.apps.map((app) => app.sourcePinId).slice(0, 2), ['pin-30', 'pin-29']);
    assert.equal(
      calls.some((href) => href.startsWith('https://manapi.metaid.io/pin/path/list')),
      true,
      'remote chain list should be queried even when the local indexer returns a non-empty stale page',
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousLocalBase === undefined) {
      delete process.env.IDBOTS_MAN_P2P_LOCAL_BASE;
    } else {
      process.env.IDBOTS_MAN_P2P_LOCAL_BASE = previousLocalBase;
    }
  }
});

test('listCommunityMetaApps accepts content metafile when code is empty', async () => {
  assert.equal(typeof listCommunityMetaApps, 'function', 'listCommunityMetaApps() should be exported');

  const result = await listCommunityMetaApps({
    manager: { listMetaApps: () => [] },
    fetchList: async () => [
      {
        id: 'pin-iddisk',
        createMetaId: 'idq1creator',
        timestamp: 1_765_221_178,
        contentSummary: JSON.stringify({
          title: 'IDDisk',
          appName: 'IDDisk',
          intro: 'Chain file manager',
          runtime: 'browser/ios/android',
          version: 'v1.1.0',
          indexFile: 'index.html',
          code: '',
          content: 'metafile://zip-iddisk',
          contentType: 'application/zip',
          codeType: 'application/zip',
          disabled: false,
        }),
      },
    ],
  });

  assert.equal(result.success, true);
  assert.equal(result.apps.length, 1);
  assert.equal(result.apps[0]?.appId, 'IDDisk');
  assert.equal(result.apps[0]?.status, 'install');
  assert.equal(result.apps[0]?.installable, true);
  assert.equal(result.apps[0]?.codeUri, 'metafile://zip-iddisk');
  assert.equal(result.apps[0]?.codePinId, 'zip-iddisk');
});

test('listCommunityMetaApps collapses edit versions into one record and keeps the newest', async () => {
  assert.equal(typeof listCommunityMetaApps, 'function', 'listCommunityMetaApps() should be exported');

  const contentFor = (version, codeSuffix) => JSON.stringify({
    title: `Edit App ${version}`,
    appName: 'edit-app',
    intro: `Edit app v${version}`,
    runtime: 'browser',
    version,
    code: `metafile://zip-edit-app-${codeSuffix}`,
    codeType: 'application/zip',
    indexFile: 'index.html',
    disabled: false,
  });

  const result = await listCommunityMetaApps({
    manager: { listMetaApps: () => [] },
    fetchList: async () => [
      {
        id: 'pin-edit-original',
        operation: 'create',
        globalMetaId: 'idq1creator',
        timestamp: 1_777_777_700,
        contentSummary: contentFor('1.0.0', 'original'),
      },
      {
        id: 'pin-edit-modify',
        operation: 'modify',
        globalMetaId: 'idq1creator',
        timestamp: 1_777_777_800,
        contentSummary: contentFor('1.1.0', 'modified'),
      },
      {
        id: 'pin-edit-revoked',
        operation: 'revoke',
        globalMetaId: 'idq1creator',
        timestamp: 1_777_777_900,
        contentSummary: contentFor('9.9.9', 'revoked'),
      },
    ],
    fetchAuthorInfo: async () => null,
  });

  assert.equal(result.success, true);
  assert.equal(result.apps.length, 1);
  const app = result.apps[0];
  assert.equal(app.appId, 'edit-app');
  assert.equal(app.version, '1.1.0');
  assert.equal(app.sourcePinId, 'pin-edit-modify');
  assert.equal(app.codePinId, 'zip-edit-app-modified');
  assert.deepEqual(result.seen, ['idq1creator::edit-app']);
});

test('listCommunityMetaApps fills a full page of distinct apps across raw pages', async () => {
  assert.equal(typeof listCommunityMetaApps, 'function', 'listCommunityMetaApps() should be exported');

  const fetchCalls = [];
  const result = await listCommunityMetaApps({
    manager: { listMetaApps: () => [] },
    size: 30,
    fetchList: async ({ cursor = '0' } = {}) => {
      fetchCalls.push(cursor);
      if (cursor === '0') {
        // 20 distinct apps, one duplicate edit version, one revoke pin.
        const list = Array.from({ length: 20 }, (_, index) => chainMetaAppItem(index + 1));
        list.push(chainMetaAppItem(3, { version: '2.0.0', title: 'Paged App 03 edited', intro: 'edited' }));
        list.push({ id: 'pin-revoke', operation: 'revoke', globalMetaId: 'idq1x', timestamp: 9, contentSummary: '{}' });
        return { list, nextCursor: 'cursor-b' };
      }
      // Second raw page supplies the remaining 10 distinct apps.
      return {
        list: Array.from({ length: 10 }, (_, index) => chainMetaAppItem(30 - index)),
        nextCursor: 'cursor-c',
      };
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.apps.length, 30);
  assert.equal(result.nextCursor, 'cursor-c');
  assert.deepEqual(fetchCalls, ['0', 'cursor-b']);
  const ids = new Set(result.apps.map((app) => app.sourcePinId));
  assert.equal(ids.size, 30, 'no duplicated app in a full page');
  assert.equal(ids.has('pin-03'), true, 'duplicate edit version collapsed into the original pin');
});

test('listCommunityMetaApps honors the seen-set so stale versions never reappear across pages', async () => {
  assert.equal(typeof listCommunityMetaApps, 'function', 'listCommunityMetaApps() should be exported');

  const contentFor = (appName, version, suffix) => JSON.stringify({
    title: `${appName} ${version}`,
    appName,
    intro: `${appName} v${version}`,
    runtime: 'browser',
    version,
    code: `metafile://zip-${suffix}`,
    codeType: 'application/zip',
    indexFile: 'index.html',
    disabled: false,
  });

  const first = await listCommunityMetaApps({
    manager: { listMetaApps: () => [] },
    size: 5,
    fetchList: async () => [
      {
        id: 'pin-a-head',
        operation: 'create',
        globalMetaId: 'idq1a',
        timestamp: 2_000_000_000,
        contentSummary: contentFor('app-a', '2.0.0', 'a-head'),
      },
      {
        id: 'pin-b-head',
        operation: 'create',
        globalMetaId: 'idq1b',
        timestamp: 1_999_999_999,
        contentSummary: contentFor('app-b', '1.0.0', 'b-head'),
      },
    ],
    fetchAuthorInfo: async () => null,
  });

  assert.equal(first.success, true);
  assert.equal(first.apps.length, 2);
  assert.equal(first.nextCursor, null);
  assert.deepEqual(first.seen, ['idq1a::app-a', 'idq1b::app-b']);

  const second = await listCommunityMetaApps({
    manager: { listMetaApps: () => [] },
    size: 5,
    seen: first.seen,
    fetchList: async () => [
      // Stale version of app-a plus one brand-new app.
      {
        id: 'pin-a-stale',
        operation: 'modify',
        globalMetaId: 'idq1a',
        timestamp: 1_000_000_000,
        contentSummary: contentFor('app-a', '1.0.0', 'a-stale'),
      },
      {
        id: 'pin-c-new',
        operation: 'create',
        globalMetaId: 'idq1c',
        timestamp: 1_000_000_001,
        contentSummary: contentFor('app-c', '1.0.0', 'c-new'),
      },
    ],
    fetchAuthorInfo: async () => null,
  });

  assert.equal(second.success, true);
  assert.deepEqual(second.apps.map((app) => app.sourcePinId), ['pin-c-new']);
  assert.deepEqual(second.seen, ['idq1a::app-a', 'idq1b::app-b', 'idq1c::app-c']);
});

test('listCommunityMetaApps hides MetaApps whose rows MAN marked as revoked (status < 0)', async () => {
  assert.equal(typeof listCommunityMetaApps, 'function', 'listCommunityMetaApps() should be exported');

  const contentFor = (appName, version, suffix) => JSON.stringify({
    title: `${appName} ${version}`,
    appName,
    intro: `${appName} v${version}`,
    runtime: 'browser',
    version,
    code: `metafile://zip-${suffix}`,
    codeType: 'application/zip',
    indexFile: 'index.html',
    disabled: false,
  });

  // Mirrors the real revoked-service shape: every row of a revoked app is marked
  // status -1 by MAN (e.g. bottianya, zhuwei-fortune-service), while a re-published
  // or untouched app keeps status 0.
  const result = await listCommunityMetaApps({
    manager: { listMetaApps: () => [] },
    size: 30,
    fetchList: async () => [
      {
        id: 'pin-revoked-create',
        operation: 'create',
        globalMetaId: 'idq1a',
        status: -1,
        timestamp: 2_000_000_100,
        contentSummary: contentFor('revoked-app', '1.0.0', 'revoked'),
      },
      {
        id: 'pin-revoked-modify',
        operation: 'modify',
        globalMetaId: 'idq1a',
        status: -1,
        timestamp: 2_000_000_200,
        contentSummary: contentFor('revoked-app', '1.1.0', 'revoked-modify'),
      },
      {
        id: 'pin-revoked-declaration',
        operation: 'revoke',
        globalMetaId: 'idq1a',
        status: 0,
        timestamp: 2_000_000_300,
        contentSummary: '{}',
      },
      {
        id: 'pin-live',
        operation: 'create',
        globalMetaId: 'idq1b',
        status: 0,
        timestamp: 2_000_000_000,
        contentSummary: contentFor('live-app', '1.0.0', 'live'),
      },
    ],
    fetchAuthorInfo: async () => null,
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.apps.map((app) => app.sourcePinId), ['pin-live']);
  assert.deepEqual(result.seen, ['idq1b::live-app']);
});

test('listCommunityMetaApps keeps the newest visible row when an older version is revoked', async () => {
  assert.equal(typeof listCommunityMetaApps, 'function', 'listCommunityMetaApps() should be exported');

  const contentFor = (appName, version, suffix) => JSON.stringify({
    title: `${appName} ${version}`,
    appName,
    intro: `${appName} v${version}`,
    runtime: 'browser',
    version,
    code: `metafile://zip-${suffix}`,
    codeType: 'application/zip',
    indexFile: 'index.html',
    disabled: false,
  });

  // Mirrors bot-directory / cosset-li-space: the newest row is visible (status 0),
  // older rows carry a negative status (revoked or superseded) and must not win.
  const result = await listCommunityMetaApps({
    manager: { listMetaApps: () => [] },
    size: 30,
    fetchList: async () => [
      {
        id: 'pin-old-revoked',
        operation: 'create',
        globalMetaId: 'idq1x',
        status: -1,
        timestamp: 1_000_000_100,
        contentSummary: contentFor('mixed-app', '1.0.0', 'old'),
      },
      {
        id: 'pin-current',
        operation: 'create',
        globalMetaId: 'idq1x',
        status: 0,
        timestamp: 1_000_000_200,
        contentSummary: contentFor('mixed-app', '2.0.0', 'current'),
      },
    ],
    fetchAuthorInfo: async () => null,
  });

  assert.equal(result.success, true);
  assert.equal(result.apps.length, 1);
  assert.equal(result.apps[0].sourcePinId, 'pin-current');
  assert.equal(result.apps[0].version, '2.0.0');
  assert.deepEqual(result.seen, ['idq1x::mixed-app']);
});
