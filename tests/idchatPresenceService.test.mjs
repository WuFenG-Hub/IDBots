import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadPresenceService() {
  return require('../dist-electron/main/services/idchatPresenceService.js');
}

test('idchat presence posts online-status to api.idchat.io and normalizes results', async () => {
  const { IdchatPresenceService } = loadPresenceService();
  const calls = [];
  const service = new IdchatPresenceService({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            total: 2,
            onlineCount: 1,
            list: [
              { globalMetaId: 'idq1alpha', isOnline: true, lastSeenAt: 171000, lastSeenAgoSeconds: 5, deviceCount: 2 },
              // Known disconnect (real lastSeenAt): trusted offline verdict,
              // never cross-checked against the online-users registry.
              { globalMetaId: 'idq1beta', isOnline: false, lastSeenAt: 170000, lastSeenAgoSeconds: 1000, deviceCount: 0 },
            ],
          },
          message: 'success',
        }),
      };
    },
  });

  const result = await service.fetchOnlineStatus([' idq1alpha ', 'idq1beta', 'idq1alpha']);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.idchat.io/group-chat/socket/online-status');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { globalMetaIds: ['idq1alpha', 'idq1beta'] });
  assert.deepEqual(result.list.map((entry) => [entry.globalMetaId, entry.isOnline, entry.lastSeenAt, entry.deviceCount]), [
    ['idq1alpha', true, 171000, 2],
    ['idq1beta', false, 170000, 0],
  ]);
});

test('idchat presence repairs never-seen offline verdicts from the online-users registry', async () => {
  const { IdchatPresenceService } = loadPresenceService();
  const calls = [];
  const service = new IdchatPresenceService({
    fetchImpl: async (url) => {
      calls.push(url);
      if (String(url).includes('/group-chat/socket/online-users')) {
        return {
          ok: true,
          json: async () => ({
            code: 0,
            data: {
              total: 1,
              cursor: 0,
              size: 100,
              onlineWindowSeconds: 1200,
              list: [
                { globalMetaId: 'idq1beta', lastSeenAt: 172000, lastSeenAgoSeconds: 3, deviceCount: 1 },
              ],
            },
            message: 'success',
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            total: 2,
            onlineCount: 1,
            list: [
              { globalMetaId: 'idq1alpha', isOnline: true, lastSeenAt: 171000, lastSeenAgoSeconds: 5, deviceCount: 2 },
              // Never-seen verdict: untrustworthy, must be cross-checked.
              { globalMetaId: 'idq1beta', isOnline: false, lastSeenAt: 0, lastSeenAgoSeconds: 0, deviceCount: 0 },
            ],
          },
          message: 'success',
        }),
      };
    },
  });

  const result = await service.fetchOnlineStatus(['idq1alpha', 'idq1beta']);

  assert.equal(calls.length, 2);
  assert.ok(String(calls[1]).startsWith('https://api.idchat.io/group-chat/socket/online-users?'));
  const beta = result.list.find((entry) => entry.globalMetaId === 'idq1beta');
  assert.deepEqual(
    [beta.isOnline, beta.lastSeenAt, beta.lastSeenAgoSeconds, beta.deviceCount],
    [true, 172000, 3, 1],
  );
  assert.equal(result.onlineCount, 2);
});

test('idchat presence appends registry entries for ids the online-status response omitted', async () => {
  const { IdchatPresenceService } = loadPresenceService();
  const service = new IdchatPresenceService({
    fetchImpl: async (url) => {
      if (String(url).includes('/group-chat/socket/online-users')) {
        return {
          ok: true,
          json: async () => ({
            code: 0,
            data: {
              total: 1,
              cursor: 0,
              size: 100,
              onlineWindowSeconds: 1200,
              list: [{ globalMetaId: 'idq1gamma', lastSeenAt: 173000, lastSeenAgoSeconds: 8, deviceCount: 1 }],
            },
            message: 'success',
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          code: 0,
          data: { total: 0, onlineCount: 0, list: [] },
          message: 'success',
        }),
      };
    },
  });

  const result = await service.fetchOnlineStatus(['idq1gamma']);

  assert.deepEqual(
    result.list.map((entry) => [entry.globalMetaId, entry.isOnline, entry.lastSeenAt]),
    [['idq1gamma', true, 173000]],
  );
});

test('idchat presence keeps never-seen offline verdicts when the registry is unreachable', async () => {
  const { IdchatPresenceService } = loadPresenceService();
  const service = new IdchatPresenceService({
    fetchImpl: async (url) => {
      if (String(url).includes('/group-chat/socket/online-users')) {
        throw new Error('registry down');
      }
      return {
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            total: 1,
            onlineCount: 0,
            list: [
              { globalMetaId: 'idq1beta', isOnline: false, lastSeenAt: 0, lastSeenAgoSeconds: 0, deviceCount: 0 },
            ],
          },
          message: 'success',
        }),
      };
    },
  });

  const result = await service.fetchOnlineStatus(['idq1beta']);

  assert.deepEqual(
    result.list.map((entry) => [entry.globalMetaId, entry.isOnline]),
    [['idq1beta', false]],
  );
});

test('idchat presence stops paging once every suspect is resolved or the registry is exhausted', async () => {
  const { IdchatPresenceService } = loadPresenceService();
  const registryCalls = [];
  const service = new IdchatPresenceService({
    fetchImpl: async (url) => {
      const text = String(url);
      if (text.includes('/group-chat/socket/online-users')) {
        registryCalls.push(text);
        return {
          ok: true,
          json: async () => ({
            code: 0,
            data: {
              total: 1,
              cursor: 0,
              size: 100,
              onlineWindowSeconds: 1200,
              list: [{ globalMetaId: 'idq1unrelated', lastSeenAt: 174000, lastSeenAgoSeconds: 2, deviceCount: 1 }],
            },
            message: 'success',
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            total: 1,
            onlineCount: 0,
            list: [
              { globalMetaId: 'idq1beta', isOnline: false, lastSeenAt: 0, lastSeenAgoSeconds: 0, deviceCount: 0 },
            ],
          },
          message: 'success',
        }),
      };
    },
  });

  const result = await service.fetchOnlineStatus(['idq1beta']);

  // Suspect not present in the registry: verdict kept, and paging stopped
  // after the first page because the registry reported total=1 (exhausted).
  assert.equal(registryCalls.length, 1);
  assert.deepEqual(
    result.list.map((entry) => [entry.globalMetaId, entry.isOnline]),
    [['idq1beta', false]],
  );
});

test('idchat presence does not fallback to www.show.now when api.idchat.io fails', async () => {
  const { IdchatPresenceService } = loadPresenceService();
  const urls = [];
  const service = new IdchatPresenceService({
    fetchImpl: async (url) => {
      urls.push(url);
      throw new Error('network down');
    },
  });

  await assert.rejects(() => service.fetchOnlineStatus(['idq1alpha']), /network down/);
  assert.deepEqual(urls, ['https://api.idchat.io/group-chat/socket/online-status']);
});
