import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);

// groupChatTransitively imports may pull electron; mock it like other tests do.
const originalLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: false,
        getAppPath: () => process.cwd(),
        getPath: () => process.cwd(),
      },
    };
  }
  return originalLoad.call(this, request, ...rest);
};

const {
  fetchGroupInfo,
  setGroupChatTransportOverrides,
  resetGroupChatTransportOverrides,
} = require('../dist-electron/main/services/groupChatTransport.js');

Module._load = originalLoad;

const GROUP_ID = `${'b'.repeat(64)}i0`;

const okResponse = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

const withFetchFn = async (fetchFn, run) => {
  setGroupChatTransportOverrides({ fetchFn });
  try {
    await run();
  } finally {
    resetGroupChatTransportOverrides();
  }
};

test('fetchGroupInfo: found carries the creator identity fields', async () => {
  await withFetchFn(
    async () => okResponse({
      code: 0,
      data: {
        groupId: GROUP_ID,
        roomName: 'Task Group',
        createUserMetaId: 'metaid-chair',
        createUserGlobalMetaId: 'gmid-chair',
      },
    }),
    async () => {
      const result = await fetchGroupInfo(GROUP_ID);
      assert.deepEqual(result, {
        status: 'found',
        info: {
          groupId: GROUP_ID,
          createUserMetaId: 'metaid-chair',
          createUserGlobalMetaId: 'gmid-chair',
        },
      });
    },
  );
});

test('fetchGroupInfo: indexer answering without the group is not_found', async () => {
  await withFetchFn(
    async () => okResponse({ code: -1, message: 'group not found' }),
    async () => {
      const result = await fetchGroupInfo(GROUP_ID);
      assert.deepEqual(result, { status: 'not_found' });
    },
  );
});

test('fetchGroupInfo: a groupId mismatching record is not_found', async () => {
  await withFetchFn(
    async () => okResponse({ code: 0, data: { groupId: `${'c'.repeat(64)}i0` } }),
    async () => {
      const result = await fetchGroupInfo(GROUP_ID);
      assert.deepEqual(result, { status: 'not_found' });
    },
  );
});

test('fetchGroupInfo: every endpoint failing is error (fail-closed for the guest)', async () => {
  await withFetchFn(
    async () => { throw new Error('network down'); },
    async () => {
      const result = await fetchGroupInfo(GROUP_ID);
      assert.deepEqual(result, { status: 'error' });
    },
  );
  await withFetchFn(
    async () => ({ ok: false, status: 502, json: async () => ({}) }),
    async () => {
      const result = await fetchGroupInfo(GROUP_ID);
      assert.deepEqual(result, { status: 'error' });
    },
  );
});

test('fetchGroupInfo: the second endpoint rescues a failed first one', async () => {
  const seen = [];
  await withFetchFn(
    async (url) => {
      seen.push(String(url));
      if (seen.length === 1) throw new Error('first endpoint down');
      return okResponse({ code: 0, data: { groupId: GROUP_ID } });
    },
    async () => {
      const result = await fetchGroupInfo(GROUP_ID);
      assert.equal(result.status, 'found');
      assert.equal(seen.length, 2, 'both endpoints were tried');
    },
  );
});
