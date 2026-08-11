import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import Module from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Some transitive imports of privateChatDaemon may pull electron; mock it like
// the openTeamGuestDaemon tests do.
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

const { interceptOpenTeamEnvelope } = require('../dist-electron/main/services/privateChatDaemon.js');
const {
  buildOpenTeamInviteMessage,
  buildOpenTeamAcceptMessage,
} = require('../dist-electron/main/services/openTeamProtocols.js');

Module._load = originalLoad;

const TXID = 'a'.repeat(64);
const INVITE_ID = `${TXID}i0`;
const GROUP_ID = `${'b'.repeat(64)}i0`;
const JOINED_PIN_ID = `${'c'.repeat(64)}i0`;
const CHAT_PUBKEY = '02' + 'ab'.repeat(32);

const invitePlaintext = buildOpenTeamInviteMessage({
  v: 1,
  inviteId: INVITE_ID,
  groupId: GROUP_ID,
  taskTitle: 'External Task',
  goalSummary: 'goal',
  requiredSkills: [],
  inviterGlobalMetaId: 'gmid-inviter',
  inviterName: 'Twin Bot',
  chairGlobalMetaId: 'gmid-inviter',
  targetGlobalMetaId: 'gmid-guest',
  expiresAt: Math.floor(Date.now() / 1000) + 600,
});

const metabot = { id: 7, name: 'Guest Bot', enabled: true, globalmetaid: 'gmid-guest' };

const flushMicrotasks = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

test('non-envelope plaintext is not intercepted', () => {
  const result = interceptOpenTeamEnvelope({
    plaintext: 'hello there',
    metabot,
    fromGlobalMetaId: 'gmid-inviter',
    fromChatPubkey: CHAT_PUBKEY,
    messageId: 1,
    emitLog: () => {},
    deps: {
      handleInvite: async () => { throw new Error('must not run'); },
      handleResponse: () => { throw new Error('must not run'); },
      schedule: () => { throw new Error('must not run'); },
    },
  });
  assert.equal(result, false);
});

test('invite envelopes are intercepted and handled asynchronously (never inline)', async () => {
  const handled = [];
  let scheduled = null;
  const intercepted = interceptOpenTeamEnvelope({
    plaintext: invitePlaintext,
    metabot,
    fromGlobalMetaId: 'gmid-inviter',
    fromChatPubkey: CHAT_PUBKEY,
    messageId: 42,
    emitLog: () => {},
    deps: {
      handleInvite: async (input) => { handled.push(input); },
      handleResponse: () => { throw new Error('not a response'); },
      schedule: (task) => { scheduled = task; },
    },
  });
  assert.equal(intercepted, true);
  assert.equal(handled.length, 0, 'handling must not start synchronously on the processOne stack');

  scheduled();
  await flushMicrotasks();

  assert.equal(handled.length, 1);
  assert.equal(handled[0].metabot.id, 7);
  assert.equal(handled[0].invite.inviteId, INVITE_ID);
  assert.equal(handled[0].senderGlobalMetaId, 'gmid-inviter', 'actual row sender passed for sender_mismatch check');
  assert.deepEqual(handled[0].replyContext, {
    peerGlobalMetaId: 'gmid-inviter',
    peerChatPubkey: CHAT_PUBKEY,
    invitePinId: INVITE_ID,
  });
});

test('accept/decline envelopes dispatch to the response handler with the actual sender', async () => {
  const handled = [];
  let scheduled = null;
  const intercepted = interceptOpenTeamEnvelope({
    plaintext: buildOpenTeamAcceptMessage(INVITE_ID, JOINED_PIN_ID),
    metabot,
    fromGlobalMetaId: 'gmid-guest',
    fromChatPubkey: CHAT_PUBKEY,
    messageId: 43,
    emitLog: () => {},
    deps: {
      handleInvite: async () => { throw new Error('not an invite'); },
      handleResponse: (envelope, options) => { handled.push({ envelope, options }); },
      schedule: (task) => { scheduled = task; },
    },
  });
  assert.equal(intercepted, true);
  assert.equal(handled.length, 0);

  scheduled();
  await flushMicrotasks();

  assert.equal(handled.length, 1);
  assert.deepEqual(handled[0].envelope, { kind: 'accept', inviteId: INVITE_ID, joinedPinId: JOINED_PIN_ID });
  assert.deepEqual(handled[0].options, { senderGlobalMetaId: 'gmid-guest' });
});

test('an envelope without from_chat_pubkey is consumed without dispatching (no reply possible)', () => {
  const logs = [];
  let scheduledCalled = false;
  const intercepted = interceptOpenTeamEnvelope({
    plaintext: invitePlaintext,
    metabot,
    fromGlobalMetaId: 'gmid-inviter',
    fromChatPubkey: '',
    messageId: 44,
    emitLog: (line) => logs.push(String(line)),
    deps: {
      handleInvite: async () => { throw new Error('must not run'); },
      handleResponse: () => { throw new Error('must not run'); },
      schedule: () => { scheduledCalled = true; },
    },
  });
  assert.equal(intercepted, true, 'caller still markProcessed + returns');
  assert.equal(scheduledCalled, false);
  assert.ok(logs.some((line) => line.includes('no from_chat_pubkey')));
});

test('an async handling failure is logged, never thrown back into the pipeline', async () => {
  const logs = [];
  const intercepted = interceptOpenTeamEnvelope({
    plaintext: invitePlaintext,
    metabot,
    fromGlobalMetaId: 'gmid-inviter',
    fromChatPubkey: CHAT_PUBKEY,
    messageId: 45,
    emitLog: (line) => logs.push(String(line)),
    deps: {
      handleInvite: async () => { throw new Error('join exploded'); },
      handleResponse: () => {},
      schedule: (task) => task(),
    },
  });
  assert.equal(intercepted, true);
  await flushMicrotasks();
  assert.ok(
    logs.some((line) => line.includes('Envelope handling failed') && line.includes('join exploded')),
    `expected a failure log, got: ${JSON.stringify(logs)}`,
  );
});

test('source order: interception precedes the disabled/wallet gates in processOne', () => {
  // Regression guard for the DECLINE-never-sent bug: the OpenTeam interception
  // must run BEFORE the enabled/wallet early-returns or a disabled bot can
  // never answer an invite (the inviter would wait out the whole TTL).
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/main/services/privateChatDaemon.ts'),
    'utf8',
  );
  const interceptAt = source.indexOf('interceptOpenTeamEnvelope({');
  const disabledGateAt = source.indexOf('MetaBot ${metabot.name} is disabled');
  const walletGateAt = source.indexOf('has no wallet');
  assert.ok(interceptAt > -1, 'interception call site exists');
  assert.ok(disabledGateAt > -1, 'disabled gate exists');
  assert.ok(walletGateAt > -1, 'wallet gate exists');
  assert.ok(interceptAt < disabledGateAt, 'interception must precede the disabled gate');
  assert.ok(interceptAt < walletGateAt, 'interception must precede the wallet gate');
});

// ---------------------------------------------------------------------------
// KICK envelopes (M3): one-way notification — dispatched to handleKick with
// the actual row sender; no reply is needed, so a missing from_chat_pubkey
// does NOT block the dispatch (unlike reply-bound envelopes).
// ---------------------------------------------------------------------------

const { buildOpenTeamKickMessage } = require('../dist-electron/main/services/openTeamProtocols.js');

const kickPlaintext = buildOpenTeamKickMessage({
  v: 1,
  groupId: GROUP_ID,
  taskTitle: 'External Task',
  reason: 'off-topic output',
});

test('kick envelopes dispatch to the kick handler with the actual sender', async () => {
  const handled = [];
  let scheduled = null;
  const intercepted = interceptOpenTeamEnvelope({
    plaintext: kickPlaintext,
    metabot,
    fromGlobalMetaId: 'gmid-inviter',
    fromChatPubkey: CHAT_PUBKEY,
    messageId: 46,
    emitLog: () => {},
    deps: {
      handleInvite: async () => { throw new Error('not an invite'); },
      handleResponse: () => { throw new Error('not a response'); },
      handleKick: (input) => { handled.push(input); },
      schedule: (task) => { scheduled = task; },
    },
  });
  assert.equal(intercepted, true);
  assert.equal(handled.length, 0, 'handling must not start synchronously on the processOne stack');

  scheduled();
  await flushMicrotasks();

  assert.equal(handled.length, 1);
  assert.equal(handled[0].metabot.id, 7);
  assert.deepEqual(handled[0].kick, {
    v: 1,
    groupId: GROUP_ID,
    taskTitle: 'External Task',
    reason: 'off-topic output',
  });
  assert.equal(handled[0].senderGlobalMetaId, 'gmid-inviter', 'actual row sender passed for the inviter check');
});

test('a kick envelope without from_chat_pubkey is still dispatched (no reply needed)', async () => {
  const handled = [];
  let scheduled = null;
  const intercepted = interceptOpenTeamEnvelope({
    plaintext: kickPlaintext,
    metabot,
    fromGlobalMetaId: 'gmid-inviter',
    fromChatPubkey: '',
    messageId: 47,
    emitLog: () => {},
    deps: {
      handleInvite: async () => { throw new Error('must not run'); },
      handleResponse: () => { throw new Error('must not run'); },
      handleKick: (input) => { handled.push(input); },
      schedule: (task) => { scheduled = task; },
    },
  });
  assert.equal(intercepted, true, 'caller still markProcessed + returns');
  scheduled();
  await flushMicrotasks();
  assert.equal(handled.length, 1, 'kick handling does not depend on from_chat_pubkey');
});

// ---------------------------------------------------------------------------
// 改进清单 #15: an incoming invite must become a VISIBLE message in the
// invitee's A2A private-chat stream (not a silent protocol consume).
// ---------------------------------------------------------------------------

test('invite interception calls recordInviteDisplay (with the row display fields) before handling', async () => {
  const displays = [];
  let scheduled = null;
  const intercepted = interceptOpenTeamEnvelope({
    plaintext: invitePlaintext,
    metabot,
    fromGlobalMetaId: 'gmid-inviter',
    fromChatPubkey: CHAT_PUBKEY,
    messageId: 48,
    emitLog: () => {},
    coworkStore: {},
    senderName: 'Twin Bot',
    senderAvatar: 'avatar-1',
    rowPinId: INVITE_ID,
    emitToRenderer: () => {},
    deps: {
      handleInvite: async () => {},
      handleResponse: () => {},
      schedule: (task) => { scheduled = task; },
      recordInviteDisplay: (input) => { displays.push(input); },
    },
  });
  assert.equal(intercepted, true);
  assert.equal(displays.length, 0, 'display must not run synchronously on the processOne stack');
  scheduled();
  await flushMicrotasks();
  assert.equal(displays.length, 1);
  assert.equal(displays[0].metabot.id, 7);
  assert.equal(displays[0].invite.inviteId, INVITE_ID);
  assert.equal(displays[0].senderGlobalMetaId, 'gmid-inviter', 'the row sender is the A2A peer');
  assert.equal(displays[0].senderName, 'Twin Bot');
  assert.equal(displays[0].envelopePinId, INVITE_ID, 'envelope pin id is the dedup identity');
});

test('a failing recordInviteDisplay logs but never blocks invite handling', async () => {
  const logs = [];
  let handled = 0;
  let scheduled = null;
  const intercepted = interceptOpenTeamEnvelope({
    plaintext: invitePlaintext,
    metabot,
    fromGlobalMetaId: 'gmid-inviter',
    fromChatPubkey: CHAT_PUBKEY,
    messageId: 49,
    emitLog: (line) => logs.push(String(line)),
    coworkStore: {},
    deps: {
      handleInvite: async () => { handled += 1; },
      handleResponse: () => {},
      schedule: (task) => { scheduled = task; },
      recordInviteDisplay: () => { throw new Error('display exploded'); },
    },
  });
  assert.equal(intercepted, true);
  scheduled();
  await flushMicrotasks();
  assert.equal(handled, 1, 'invite handling must proceed despite the display failure');
  assert.ok(
    logs.some((line) => line.includes('Invite A2A display failed') && line.includes('display exploded')),
    `expected a display-failure log, got: ${JSON.stringify(logs)}`,
  );
});

test('invite interception without a coworkStore does not call recordInviteDisplay', async () => {
  const displays = [];
  let scheduled = null;
  const intercepted = interceptOpenTeamEnvelope({
    plaintext: invitePlaintext,
    metabot,
    fromGlobalMetaId: 'gmid-inviter',
    fromChatPubkey: CHAT_PUBKEY,
    messageId: 50,
    emitLog: () => {},
    deps: {
      handleInvite: async () => {},
      handleResponse: () => {},
      schedule: (task) => { scheduled = task; },
      recordInviteDisplay: (input) => { displays.push(input); },
    },
  });
  assert.equal(intercepted, true);
  scheduled();
  await flushMicrotasks();
  assert.equal(displays.length, 0, 'no cowork store -> no A2A display');
});
