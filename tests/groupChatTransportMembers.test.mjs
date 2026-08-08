import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);

// groupChatTransport -> metaidCore imports electron; mock it.
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
  fetchGroupMembers,
  waitForMemberJoined,
  setGroupChatTransportOverrides,
  resetGroupChatTransportOverrides,
} = require('../dist-electron/main/services/groupChatTransport.js');

Module._load = originalLoad;

const GROUP_ID = 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff00000000i0';

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status });

/**
 * fetch stub: routes is a list of {includes, respond} rules evaluated in order;
 * `respond(url)` returns a Response or throws. Unmatched URLs 500. Every call
 * is recorded in `calls`.
 */
const stubFetch = (routes) => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(String(url));
    const route = routes.find((r) => String(url).includes(r.includes));
    if (!route) return jsonResponse({ code: 1, message: 'no route' }, 500);
    return route.respond(String(url));
  };
  return { calls, fetchFn };
};

const memberListBody = (data) => ({ code: 0, data });

test('fetchGroupMembers collects metaId/globalMetaId from list/admins/creator', async () => {
  const { calls, fetchFn } = stubFetch([
    {
      includes: 'group-member-list',
      respond: () => jsonResponse(memberListBody({
        list: [
          { metaId: 'meta-1', globalMetaId: 'gmid-1' },
          { metaId: 'meta-2' },
          'plain-string-entry',
          { name: 'no-ids' },
          null,
        ],
        admins: [{ globalMetaId: 'gmid-admin' }],
        creator: { metaId: 'meta-creator', globalMetaId: 'gmid-creator' },
      })),
    },
  ]);
  setGroupChatTransportOverrides({ fetchFn });
  try {
    const members = await fetchGroupMembers(GROUP_ID);
    assert.ok(Array.isArray(members));
    assert.deepEqual(
      new Set(members),
      new Set(['meta-1', 'gmid-1', 'meta-2', 'plain-string-entry', 'gmid-admin', 'meta-creator', 'gmid-creator']),
    );
    assert.equal(calls.length, 1, 'first endpoint answered; no fallback needed');
    assert.ok(calls[0].startsWith('https://api.idchat.io/'));
    assert.ok(calls[0].includes(`groupId=${encodeURIComponent(GROUP_ID)}`));
  } finally {
    resetGroupChatTransportOverrides();
  }
});

test('fetchGroupMembers falls back to the second endpoint, null when both fail', async () => {
  const { calls, fetchFn } = stubFetch([
    {
      includes: 'api.idchat.io',
      respond: () => jsonResponse({ code: 50000, message: 'boom' }),
    },
    {
      includes: 'www.show.now',
      respond: () => jsonResponse(memberListBody({ list: [{ globalMetaId: 'gmid-fallback' }] })),
    },
  ]);
  setGroupChatTransportOverrides({ fetchFn });
  try {
    const members = await fetchGroupMembers(GROUP_ID);
    assert.deepEqual(members, ['gmid-fallback']);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].startsWith('https://api.idchat.io/'));
    assert.ok(calls[1].startsWith('https://www.show.now/'));
  } finally {
    resetGroupChatTransportOverrides();
  }

  const failing = stubFetch([
    { includes: 'group-member-list', respond: () => jsonResponse({ code: 1 }, 502) },
  ]);
  setGroupChatTransportOverrides({ fetchFn: failing.fetchFn });
  try {
    const members = await fetchGroupMembers(GROUP_ID);
    assert.equal(members, null, 'both endpoints failed -> null (not an empty list)');
    assert.equal(failing.calls.length, 2);
  } finally {
    resetGroupChatTransportOverrides();
  }
});

test('fetchGroupMembers: an empty list is a real result (no fallback, not null)', async () => {
  const { calls, fetchFn } = stubFetch([
    { includes: 'group-member-list', respond: () => jsonResponse(memberListBody({ list: [] })) },
  ]);
  setGroupChatTransportOverrides({ fetchFn });
  try {
    const members = await fetchGroupMembers(GROUP_ID);
    assert.deepEqual(members, []);
    assert.equal(calls.length, 1);
  } finally {
    resetGroupChatTransportOverrides();
  }
});

test('fetchGroupMembers: network errors are tolerated per endpoint', async () => {
  const { fetchFn } = stubFetch([
    {
      includes: 'api.idchat.io',
      respond: () => {
        throw new Error('socket hangup');
      },
    },
    {
      includes: 'www.show.now',
      respond: () => jsonResponse(memberListBody({ admins: [{ metaId: 'meta-admin' }] })),
    },
  ]);
  setGroupChatTransportOverrides({ fetchFn });
  try {
    const members = await fetchGroupMembers(GROUP_ID);
    assert.deepEqual(members, ['meta-admin']);
  } finally {
    resetGroupChatTransportOverrides();
  }
});

test('waitForMemberJoined returns true when any identity form appears', async () => {
  const { fetchFn } = stubFetch([
    {
      includes: 'group-member-list',
      respond: () => jsonResponse(memberListBody({
        list: [{ metaId: 'META-Case', globalMetaId: 'gmid-other' }],
      })),
    },
  ]);
  setGroupChatTransportOverrides({ fetchFn });
  try {
    // Second candidate form matches, case-insensitively.
    const joined = await waitForMemberJoined(GROUP_ID, ['gmid-absent', 'meta-case'], {
      timeoutMs: 500,
      intervalMs: 20,
    });
    assert.equal(joined, true);
  } finally {
    resetGroupChatTransportOverrides();
  }
});

test('waitForMemberJoined returns false on timeout (never throws)', async () => {
  const { fetchFn } = stubFetch([
    {
      includes: 'group-member-list',
      respond: () => jsonResponse(memberListBody({ list: [{ globalMetaId: 'gmid-other' }] })),
    },
  ]);
  setGroupChatTransportOverrides({ fetchFn });
  try {
    const joined = await waitForMemberJoined(GROUP_ID, 'gmid-absent', { timeoutMs: 120, intervalMs: 20 });
    assert.equal(joined, false);
  } finally {
    resetGroupChatTransportOverrides();
  }
});

test('waitForMemberJoined tolerates failed fetches until timeout', async () => {
  const { fetchFn } = stubFetch([
    { includes: 'group-member-list', respond: () => jsonResponse({ code: 1 }, 500) },
  ]);
  setGroupChatTransportOverrides({ fetchFn });
  try {
    const joined = await waitForMemberJoined(GROUP_ID, ['gmid-x'], { timeoutMs: 120, intervalMs: 20 });
    assert.equal(joined, false);
  } finally {
    resetGroupChatTransportOverrides();
  }
});

test('waitForMemberJoined: empty candidate set is an immediate false', async () => {
  const joined = await waitForMemberJoined(GROUP_ID, ['', '  '], { timeoutMs: 100, intervalMs: 20 });
  assert.equal(joined, false);
});
