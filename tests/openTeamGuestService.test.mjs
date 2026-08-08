import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  handleOpenTeamInvite,
  handleOpenTeamResponse,
  OPENTEAM_ALLOW_REMOTE_COLLAB_KEY,
} = require('../dist-electron/main/services/openTeamGuestService.js');
const { parseOpenTeamEnvelope } = require('../dist-electron/main/services/openTeamProtocols.js');

const TXID = 'a'.repeat(64);
const INVITE_ID = `${TXID}i0`;
const GROUP_ID = `${'b'.repeat(64)}i0`;
const JOINED_PIN_ID = `${'c'.repeat(64)}i0`;
const REPLY_PIN_ID = `${'d'.repeat(64)}i0`;
const NOW_MS = 1_800_000_000_000; // 2027-01-15 UTC
const FUTURE_EXPIRES_AT = Math.floor(NOW_MS / 1000) + 3600;
const PAST_EXPIRES_AT = Math.floor(NOW_MS / 1000) - 60;

const makeInvite = (overrides = {}) => ({
  v: 1,
  inviteId: INVITE_ID,
  groupId: GROUP_ID,
  taskTitle: 'External Task',
  goalSummary: 'goal',
  requiredSkills: [],
  inviterGlobalMetaId: 'gmid-inviter',
  inviterName: 'Twin Bot',
  chairGlobalMetaId: 'gmid-chair',
  targetGlobalMetaId: 'gmid-guest',
  expiresAt: FUTURE_EXPIRES_AT,
  ...overrides,
});

const makeMetabot = (overrides = {}) => ({
  id: 7,
  name: 'Guest Bot',
  enabled: true,
  globalmetaid: 'gmid-guest',
  ...overrides,
});

const replyContext = () => ({
  peerGlobalMetaId: 'gmid-inviter',
  peerChatPubkey: '02' + 'ab'.repeat(32),
  invitePinId: INVITE_ID,
});

/**
 * Mock deps factory: metabot settings, existing membership, join/send behavior
 * are all controllable; every side effect is recorded in `calls`.
 */
const makeDeps = (options = {}) => {
  const calls = {
    join: [],
    send: [],
    upsert: [],
    catchUp: [],
    getInviteByPinId: [],
    updateInviteStatus: [],
  };
  const settings = options.settings ?? {};
  const membership = options.membership ?? null;
  const inviteRow = options.inviteRow ?? null;
  const deps = {
    getMetabotStore: () => ({
      getMetabotSetting: (metabotId, key) => settings[key] ?? null,
      getMetabotWalletByMetabotId: (metabotId) =>
        options.noWallet ? null : { mnemonic: 'word '.repeat(11) + 'word', path: "m/44'/10001'/0'/0/0" },
    }),
    getMembershipStore: () => ({
      getMembership: (groupId, metabotId) => membership,
      upsertActiveMembership: (input) => {
        calls.upsert.push(input);
        return { id: 1, status: 'active', ...input };
      },
      catchUpCursorToLatest: (groupId, metabotId) => {
        calls.catchUp.push([groupId, metabotId]);
      },
      getInviteByPinId: (pinId) => {
        calls.getInviteByPinId.push(pinId);
        return inviteRow;
      },
      updateInviteStatus: (identity, status, declineReason) => {
        calls.updateInviteStatus.push([identity, status, declineReason ?? null]);
        return inviteRow ? { ...inviteRow, status, declineReason: declineReason ?? null } : null;
      },
    }),
    joinGroupChat: async (metabotId, groupId) => {
      calls.join.push([metabotId, groupId]);
      if (options.joinError) throw new Error(options.joinError);
      return { pinId: JOINED_PIN_ID };
    },
    sendEncryptedSimplemsg: async (input) => {
      calls.send.push(input);
      if (options.sendError) throw new Error(options.sendError);
      return { txids: ['tx-reply'], pinId: REPLY_PIN_ID };
    },
    emitLog: () => {},
    now: () => NOW_MS,
  };
  return { deps, calls };
};

test('happy path: joins, records membership, catches cursor up, replies ACCEPT', async () => {
  const { deps, calls } = makeDeps();
  const result = await handleOpenTeamInvite(deps, {
    metabot: makeMetabot(),
    invite: makeInvite(),
    replyContext: replyContext(),
  });

  assert.equal(result.action, 'accepted');
  assert.equal(result.joinedPinId, JOINED_PIN_ID);
  assert.equal(result.replyPinId, REPLY_PIN_ID);

  assert.deepEqual(calls.join, [[7, GROUP_ID]]);
  assert.equal(calls.upsert.length, 1);
  const upsert = calls.upsert[0];
  assert.equal(upsert.groupId, GROUP_ID);
  assert.equal(upsert.metabotId, 7);
  assert.equal(upsert.globalmetaid, 'gmid-guest');
  assert.equal(upsert.inviterGlobalmetaid, 'gmid-inviter');
  assert.equal(upsert.taskTitle, 'External Task');
  assert.equal(upsert.invitePinId, INVITE_ID);
  assert.equal(upsert.joinedPinId, JOINED_PIN_ID);
  assert.deepEqual(calls.catchUp, [[GROUP_ID, 7]]);

  assert.equal(calls.send.length, 1);
  const reply = calls.send[0];
  assert.equal(reply.metabotId, 7);
  assert.equal(reply.peerGlobalMetaId, 'gmid-inviter');
  assert.equal(reply.peerChatPubkey, replyContext().peerChatPubkey);
  assert.equal(reply.replyPin, INVITE_ID);
  assert.deepEqual(parseOpenTeamEnvelope(reply.plaintext), {
    kind: 'accept',
    inviteId: INVITE_ID,
    joinedPinId: JOINED_PIN_ID,
  });
});

test('declines when the metabot is disabled', async () => {
  const { deps, calls } = makeDeps();
  const result = await handleOpenTeamInvite(deps, {
    metabot: makeMetabot({ enabled: false }),
    invite: makeInvite(),
    replyContext: replyContext(),
  });
  assert.equal(result.action, 'declined');
  assert.equal(result.reason, 'bot_disabled');
  assert.equal(calls.join.length, 0);
  assert.equal(calls.upsert.length, 0);
  assert.equal(calls.send.length, 1);
  const envelope = parseOpenTeamEnvelope(calls.send[0].plaintext);
  assert.equal(envelope.kind, 'decline');
  assert.equal(envelope.inviteId, INVITE_ID);
  assert.match(envelope.reason, /bot_disabled/);
  assert.equal(calls.send[0].replyPin, INVITE_ID);
});

test('declines when the allowRemoteCollab switch is off', async () => {
  const { deps, calls } = makeDeps({ settings: { [OPENTEAM_ALLOW_REMOTE_COLLAB_KEY]: '0' } });
  const result = await handleOpenTeamInvite(deps, {
    metabot: makeMetabot(),
    invite: makeInvite(),
    replyContext: replyContext(),
  });
  assert.equal(result.action, 'declined');
  assert.equal(result.reason, 'remote_collab_disabled');
  assert.equal(calls.join.length, 0);
});

test('missing allowRemoteCollab record means allowed (default on)', async () => {
  const { deps } = makeDeps({ settings: {} });
  const result = await handleOpenTeamInvite(deps, {
    metabot: makeMetabot(),
    invite: makeInvite(),
    replyContext: replyContext(),
  });
  assert.equal(result.action, 'accepted');
});

test('declines when the invite targets a different bot', async () => {
  const { deps, calls } = makeDeps();
  const result = await handleOpenTeamInvite(deps, {
    metabot: makeMetabot({ globalmetaid: 'gmid-other' }),
    invite: makeInvite({ targetGlobalMetaId: 'gmid-guest' }),
    replyContext: replyContext(),
  });
  assert.equal(result.action, 'declined');
  assert.equal(result.reason, 'target_mismatch');
  assert.equal(calls.join.length, 0);
});

test('declines when already an active member of the group', async () => {
  const { deps, calls } = makeDeps({ membership: { status: 'active' } });
  const result = await handleOpenTeamInvite(deps, {
    metabot: makeMetabot(),
    invite: makeInvite(),
    replyContext: replyContext(),
  });
  assert.equal(result.action, 'declined');
  assert.equal(result.reason, 'already_member');
  assert.equal(calls.join.length, 0);
});

test('re-invite after left proceeds (membership flips back to active)', async () => {
  const { deps, calls } = makeDeps({ membership: { status: 'left' } });
  const result = await handleOpenTeamInvite(deps, {
    metabot: makeMetabot(),
    invite: makeInvite(),
    replyContext: replyContext(),
  });
  assert.equal(result.action, 'accepted');
  assert.equal(calls.join.length, 1);
  assert.equal(calls.upsert.length, 1);
});

test('declines when the invite is expired', async () => {
  const { deps, calls } = makeDeps();
  const result = await handleOpenTeamInvite(deps, {
    metabot: makeMetabot(),
    invite: makeInvite({ expiresAt: PAST_EXPIRES_AT }),
    replyContext: replyContext(),
  });
  assert.equal(result.action, 'declined');
  assert.equal(result.reason, 'invite_expired');
  assert.equal(calls.join.length, 0);
});

test('join failure declines with the underlying error message', async () => {
  const { deps, calls } = makeDeps({ joinError: 'insufficient MVC balance' });
  const result = await handleOpenTeamInvite(deps, {
    metabot: makeMetabot(),
    invite: makeInvite(),
    replyContext: replyContext(),
  });
  assert.equal(result.action, 'declined');
  assert.equal(result.reason, 'join_failed');
  assert.equal(calls.upsert.length, 0);
  assert.equal(calls.send.length, 1);
  const envelope = parseOpenTeamEnvelope(calls.send[0].plaintext);
  assert.equal(envelope.kind, 'decline');
  assert.match(envelope.reason, /join_failed: insufficient MVC balance/);
});

test('no wallet: declines without sending (still no join)', async () => {
  const { deps, calls } = makeDeps({ noWallet: true });
  const result = await handleOpenTeamInvite(deps, {
    metabot: makeMetabot({ enabled: false }),
    invite: makeInvite(),
    replyContext: replyContext(),
  });
  assert.equal(result.action, 'declined');
  assert.equal(result.replyPinId, null);
  assert.equal(calls.send.length, 0);
});

// ---------------------------------------------------------------------------
// Inviter-side ACCEPT/DECLINE bookkeeping
// ---------------------------------------------------------------------------

const PENDING_INVITE_ROW = {
  id: 3,
  taskId: 11,
  groupId: GROUP_ID,
  inviteeGlobalmetaid: 'gmid-guest',
  inviteeName: 'Guest Bot',
  invitePinId: INVITE_ID,
  status: 'pending',
  declineReason: null,
  createdAt: null,
  respondedAt: null,
};

test('accept envelope marks the pending invite accepted', () => {
  const { deps, calls } = makeDeps({ inviteRow: PENDING_INVITE_ROW });
  const result = handleOpenTeamResponse(deps, {
    kind: 'accept',
    inviteId: INVITE_ID,
    joinedPinId: JOINED_PIN_ID,
  });
  assert.equal(result.matched, true);
  assert.deepEqual(calls.getInviteByPinId, [INVITE_ID]);
  assert.deepEqual(calls.updateInviteStatus, [[{ invitePinId: INVITE_ID }, 'accepted', null]]);
});

test('decline envelope marks the pending invite declined with reason', () => {
  const { deps, calls } = makeDeps({ inviteRow: PENDING_INVITE_ROW });
  const result = handleOpenTeamResponse(deps, {
    kind: 'decline',
    inviteId: INVITE_ID,
    reason: 'remote_collab_disabled: switch is off',
  });
  assert.equal(result.matched, true);
  assert.deepEqual(calls.updateInviteStatus, [
    [{ invitePinId: INVITE_ID }, 'declined', 'remote_collab_disabled: switch is off'],
  ]);
});

test('unknown invite is ignored without a state change', () => {
  const { deps, calls } = makeDeps({ inviteRow: null });
  const result = handleOpenTeamResponse(deps, {
    kind: 'accept',
    inviteId: INVITE_ID,
    joinedPinId: JOINED_PIN_ID,
  });
  assert.equal(result.matched, false);
  assert.equal(calls.updateInviteStatus.length, 0);
});

test('already-resolved invite is not transitioned again', () => {
  const { deps, calls } = makeDeps({ inviteRow: { ...PENDING_INVITE_ROW, status: 'accepted' } });
  const result = handleOpenTeamResponse(deps, {
    kind: 'decline',
    inviteId: INVITE_ID,
    reason: 'late decline',
  });
  assert.equal(result.matched, true);
  assert.equal(calls.updateInviteStatus.length, 0);
});
