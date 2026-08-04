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
  joinGroupChatAsIdentity,
  sendGroupChatMessageAsIdentity,
  setGroupChatTransportUserIdentityStoreGetter,
  setGroupChatTransportOverrides,
  resetGroupChatTransportOverrides,
} = require('../dist-electron/main/services/groupChatTransport.js');
const { decryptGroupMessage } = require('../dist-electron/main/services/metaWebCrypto.js');

Module._load = originalLoad;

const GROUP_ID = 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff00000000i0';
const TEST_MNEMONIC = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
const TEST_PATH = "m/44'/10001'/0'/0/0";

const createHarness = (overrides = {}) => {
  const calls = [];
  const identity = overrides.identity === undefined
    ? { mnemonic: TEST_MNEMONIC, path: TEST_PATH, name: 'Owner Name', globalmetaid: 'gmid-owner' }
    : overrides.identity;

  setGroupChatTransportUserIdentityStoreGetter(() => ({
    get: () => identity,
  }));
  setGroupChatTransportOverrides({
    createPinForIdentity: async (params) => {
      calls.push(params);
      return { txids: ['txabc'], pinId: 'txabci0', totalCost: 100 };
    },
  });

  return { calls, cleanup: () => resetGroupChatTransportOverrides() };
};

test('joinGroupChatAsIdentity: simplegroupjoin payload signed by the user identity', async () => {
  const h = createHarness();
  try {
    const result = await joinGroupChatAsIdentity(GROUP_ID);
    assert.equal(result.pinId, 'txabci0');
    assert.equal(h.calls.length, 1);

    const call = h.calls[0];
    assert.equal(call.mnemonic, TEST_MNEMONIC);
    assert.equal(call.path, TEST_PATH);
    assert.equal(call.metaidData.operation, 'create');
    assert.equal(call.metaidData.path, '/protocols/simplegroupjoin');
    assert.equal(call.metaidData.contentType, 'application/json');
    assert.deepEqual(JSON.parse(call.metaidData.payload), {
      groupId: GROUP_ID,
      state: 1,
      referrer: '',
      k: '',
    });
  } finally {
    h.cleanup();
  }
});

test('sendGroupChatMessageAsIdentity: AES simplegroupchat payload, identity defaults', async () => {
  const h = createHarness();
  try {
    const result = await sendGroupChatMessageAsIdentity(GROUP_ID, { content: 'hello from the owner' });
    assert.equal(result.pinId, 'txabci0');
    assert.equal(h.calls.length, 1);

    const call = h.calls[0];
    assert.equal(call.mnemonic, TEST_MNEMONIC);
    assert.equal(call.metaidData.path, '/protocols/simplegroupchat');
    const body = JSON.parse(call.metaidData.payload);
    assert.equal(body.groupId, GROUP_ID);
    assert.equal(body.nickName, 'Owner Name', 'nickName defaults to the identity display name');
    assert.equal(body.contentType, 'text/plain');
    assert.equal(body.encryption, 'aes');
    assert.equal(typeof body.timestamp, 'number');
    assert.equal(body.replyPin, '');
    assert.deepEqual(body.mention, []);
    assert.notEqual(body.content, 'hello from the owner', 'content is encrypted');
    assert.equal(
      decryptGroupMessage(body.content, GROUP_ID.substring(0, 16)),
      'hello from the owner',
      'decrypts with the group key scheme',
    );
  } finally {
    h.cleanup();
  }
});

test('sendGroupChatMessageAsIdentity: explicit nickName/replyPin/mention pass through', async () => {
  const h = createHarness();
  try {
    await sendGroupChatMessageAsIdentity(GROUP_ID, {
      content: 'replying',
      nickName: 'Boss',
      replyPin: 'pin-parent',
      mention: ['gmid-w2'],
    });
    const body = JSON.parse(h.calls[0].metaidData.payload);
    assert.equal(body.nickName, 'Boss');
    assert.equal(body.replyPin, 'pin-parent');
    assert.deepEqual(body.mention, ['gmid-w2']);
  } finally {
    h.cleanup();
  }
});

test('identity functions throw a clear error when no user identity exists', async () => {
  const h = createHarness({ identity: null });
  try {
    await assert.rejects(joinGroupChatAsIdentity(GROUP_ID), /user identity/);
    await assert.rejects(sendGroupChatMessageAsIdentity(GROUP_ID, { content: 'x' }), /user identity/);
    assert.equal(h.calls.length, 0, 'no pin attempted');
  } finally {
    h.cleanup();
  }
});
