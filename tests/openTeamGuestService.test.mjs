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
 * fetchGroupInfo defaults to a verified group whose creator is the inviter.
 */
const makeDeps = (options = {}) => {
  const calls = {
    join: [],
    send: [],
    upsert: [],
    catchUp: [],
    getInviteByPinId: [],
    updateInviteStatus: [],
    groupInfo: [],
    createGuestInvite: [],
    updateGuestInviteStatus: [],
    updateInviteJoinedPinId: [],
  };
  const settings = options.settings ?? {};
  const membership = options.membership ?? null;
  const inviteRow = options.inviteRow ?? null;
  const groupInfo = options.groupInfo ?? {
    status: 'found',
    createUserMetaId: '',
    createUserGlobalMetaId: 'gmid-inviter',
  };
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
      // P0-1: guest-side invite history hooks (recorded on entry, finalized by
      // outcome) — recorded for assertions, never fail the handling path.
      createGuestInvite: (input) => {
        calls.createGuestInvite.push(input);
        return { id: 1, status: 'invited', requiredSkills: [], createdAt: '2026-08-10 00:00:00', ...input };
      },
      updateGuestInviteStatus: (invitePinId, status, options) => {
        calls.updateGuestInviteStatus.push([invitePinId, status, options ?? null]);
        return { id: 1, invitePinId, status, ...options };
      },
      // P1-2: ACCEPT echoes the join pin — persist it on the invite row.
      updateInviteJoinedPinId: (invitePinId, joinedPinId) => {
        calls.updateInviteJoinedPinId.push([invitePinId, joinedPinId]);
        return inviteRow ? { ...inviteRow, status: 'accepted', joinedPinId } : null;
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
    fetchGroupInfo: async (groupId) => {
      calls.groupInfo.push(groupId);
      if (options.groupInfoError) throw new Error(options.groupInfoError);
      return groupInfo;
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

  // P0-1: the invite entered the guest-side history on entry and was finalized
  // as accepted with the join pin.
  assert.equal(calls.createGuestInvite.length, 1, 'invite recorded in guest history on entry');
  const recorded = calls.createGuestInvite[0];
  assert.equal(recorded.groupId, GROUP_ID);
  assert.equal(recorded.inviterGlobalmetaid, 'gmid-inviter');
  assert.equal(recorded.inviterName, 'Twin Bot');
  assert.equal(recorded.taskTitle, 'External Task');
  assert.equal(recorded.invitePinId, INVITE_ID);
  assert.equal(recorded.targetGlobalmetaid, 'gmid-guest');
  assert.deepEqual(calls.updateGuestInviteStatus, [[INVITE_ID, 'accepted', { joinedPinId: JOINED_PIN_ID }]]);
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
  // P0-1: history row exists even for a declined invite, finalized as declined.
  assert.equal(calls.createGuestInvite.length, 1, 'invite recorded before the decline decision');
  assert.equal(calls.updateGuestInviteStatus[0][1], 'declined');
  assert.match(calls.updateGuestInviteStatus[0][2].reason, /bot_disabled/);
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

// ---------------------------------------------------------------------------
// Invite hardening: sender match, dedup, rate limit, clock skew, group verify
// ---------------------------------------------------------------------------

const INVITE_ID_2 = `${'e'.repeat(64)}i0`;
const INVITE_ID_3 = `${'f'.repeat(64)}i0`;
const INVITE_ID_4 = `${'0'.repeat(64)}i0`;

test('declines when the actual sender differs from the envelope inviter (sender_mismatch)', async () => {
  const { deps, calls } = makeDeps();
  const result = await handleOpenTeamInvite(deps, {
    metabot: makeMetabot(),
    invite: makeInvite(),
    replyContext: replyContext(),
    senderGlobalMetaId: 'gmid-attacker',
  });
  assert.equal(result.action, 'declined');
  assert.equal(result.reason, 'sender_mismatch');
  assert.equal(calls.join.length, 0);
  assert.equal(calls.groupInfo.length, 0, 'no network lookup for a forged sender');
  assert.equal(calls.send.length, 1);
  const envelope = parseOpenTeamEnvelope(calls.send[0].plaintext);
  assert.equal(envelope.kind, 'decline');
  assert.match(envelope.reason, /sender_mismatch/);
});

test('a sender matching the inviter (case-normalized) proceeds', async () => {
  const { deps, calls } = makeDeps();
  const result = await handleOpenTeamInvite(deps, {
    metabot: makeMetabot(),
    invite: makeInvite(),
    replyContext: replyContext(),
    senderGlobalMetaId: 'GMID-INVITER',
  });
  assert.equal(result.action, 'accepted');
  assert.equal(calls.join.length, 1);
});

test('duplicate inviteId redelivery is skipped silently (idempotent)', async () => {
  const { deps, calls } = makeDeps();
  const first = await handleOpenTeamInvite(deps, {
    metabot: makeMetabot(),
    invite: makeInvite(),
    replyContext: replyContext(),
  });
  assert.equal(first.action, 'accepted');
  const second = await handleOpenTeamInvite(deps, {
    metabot: makeMetabot(),
    invite: makeInvite(),
    replyContext: replyContext(),
  });
  assert.equal(second.action, 'skipped');
  assert.equal(second.reason, 'duplicate_invite');
  assert.equal(second.replyPinId, null);
  assert.equal(calls.join.length, 1, 'no second join');
  assert.equal(calls.send.length, 1, 'no second reply');
  // P0-1: the duplicate is finalized as skipped in the guest history.
  assert.equal(calls.createGuestInvite.length, 2, 'each delivery records (idempotent by pin)');
  assert.deepEqual(
    calls.updateGuestInviteStatus.at(-1),
    [INVITE_ID, 'skipped', { reason: 'duplicate_invite' }],
  );
});

test('redelivery of an invite whose membership row carries invite_pin_id is skipped silently', async () => {
  const { deps, calls } = makeDeps({ membership: { status: 'active', invitePinId: INVITE_ID } });
  const result = await handleOpenTeamInvite(deps, {
    metabot: makeMetabot(),
    invite: makeInvite(),
    replyContext: replyContext(),
  });
  assert.equal(result.action, 'skipped');
  assert.equal(result.reason, 'duplicate_invite');
  assert.equal(calls.join.length, 0);
  assert.equal(calls.send.length, 0);
});

test('rate limit: the 4th invite from the same inviter within the window is declined', async () => {
  const { deps, calls } = makeDeps();
  // Distinct groupIds isolate the per-inviter dimension (the per-group cap
  // would otherwise trip at the same count).
  const groupIds = [
    GROUP_ID,
    `${'1'.repeat(64)}i0`,
    `${'2'.repeat(64)}i0`,
    `${'3'.repeat(64)}i0`,
  ];
  for (const [index, inviteId] of [INVITE_ID, INVITE_ID_2, INVITE_ID_3].entries()) {
    const result = await handleOpenTeamInvite(deps, {
      metabot: makeMetabot(),
      invite: makeInvite({ inviteId, groupId: groupIds[index] }),
      replyContext: { ...replyContext(), invitePinId: inviteId },
    });
    assert.equal(result.action, 'accepted');
  }
  const fourth = await handleOpenTeamInvite(deps, {
    metabot: makeMetabot(),
    invite: makeInvite({ inviteId: INVITE_ID_4, groupId: groupIds[3] }),
    replyContext: { ...replyContext(), invitePinId: INVITE_ID_4 },
  });
  assert.equal(fourth.action, 'declined');
  assert.equal(fourth.reason, 'rate_limited');
  assert.equal(calls.join.length, 3, 'the rate-limited invite never pays a join pin');
  assert.equal(calls.groupInfo.length, 3, 'the rate-limited invite never hits the indexer');
});

test('rate limit: the 4th invite for the same group is declined even from another inviter', async () => {
  const { deps, calls } = makeDeps({
    groupInfo: { status: 'found', createUserMetaId: '', createUserGlobalMetaId: 'gmid-chair' },
  });
  const inviters = ['gmid-inviter-a', 'gmid-inviter-b', 'gmid-inviter-c'];
  const inviteIds = [INVITE_ID, INVITE_ID_2, INVITE_ID_3];
  for (const [index, inviter] of inviters.entries()) {
    const result = await handleOpenTeamInvite(deps, {
      metabot: makeMetabot(),
      invite: makeInvite({
        inviteId: inviteIds[index],
        inviterGlobalMetaId: inviter,
        chairGlobalMetaId: 'gmid-chair',
      }),
      replyContext: { ...replyContext(), invitePinId: inviteIds[index], peerGlobalMetaId: inviter },
    });
    assert.equal(result.action, 'accepted');
  }
  const fourth = await handleOpenTeamInvite(deps, {
    metabot: makeMetabot(),
    invite: makeInvite({
      inviteId: INVITE_ID_4,
      inviterGlobalMetaId: 'gmid-inviter-d',
      chairGlobalMetaId: 'gmid-chair',
    }),
    replyContext: { ...replyContext(), invitePinId: INVITE_ID_4, peerGlobalMetaId: 'gmid-inviter-d' },
  });
  assert.equal(fourth.action, 'declined');
  assert.equal(fourth.reason, 'rate_limited');
  assert.equal(calls.join.length, 3);
});

test('expiry skew: an invite 30s past expiresAt is still accepted', async () => {
  const { deps, calls } = makeDeps();
  const result = await handleOpenTeamInvite(deps, {
    metabot: makeMetabot(),
    invite: makeInvite({ expiresAt: Math.floor(NOW_MS / 1000) - 30 }),
    replyContext: replyContext(),
  });
  assert.equal(result.action, 'accepted');
  assert.equal(calls.join.length, 1);
});

test('declines invalid_group when the group does not exist on-chain', async () => {
  const { deps, calls } = makeDeps({ groupInfo: { status: 'not_found' } });
  const result = await handleOpenTeamInvite(deps, {
    metabot: makeMetabot(),
    invite: makeInvite(),
    replyContext: replyContext(),
  });
  assert.equal(result.action, 'declined');
  assert.equal(result.reason, 'invalid_group');
  assert.equal(calls.join.length, 0);
  assert.equal(calls.send.length, 1);
  const envelope = parseOpenTeamEnvelope(calls.send[0].plaintext);
  assert.match(envelope.reason, /invalid_group/);
});

test('declines inviter_not_chair when the inviter is not the group creator', async () => {
  const { deps, calls } = makeDeps({
    groupInfo: { status: 'found', createUserMetaId: 'metaid-creator', createUserGlobalMetaId: 'gmid-creator' },
  });
  const result = await handleOpenTeamInvite(deps, {
    metabot: makeMetabot(),
    invite: makeInvite(),
    replyContext: replyContext(),
  });
  assert.equal(result.action, 'declined');
  assert.equal(result.reason, 'inviter_not_chair');
  assert.equal(calls.join.length, 0);
  assert.equal(calls.upsert.length, 0);
});

test('a chairGlobalMetaId matching the group creator is enough (double-form match)', async () => {
  const { deps, calls } = makeDeps({
    groupInfo: { status: 'found', createUserMetaId: '', createUserGlobalMetaId: 'gmid-chair' },
  });
  const result = await handleOpenTeamInvite(deps, {
    metabot: makeMetabot(),
    invite: makeInvite({ inviterGlobalMetaId: 'gmid-delegate', chairGlobalMetaId: 'gmid-chair' }),
    replyContext: { ...replyContext(), peerGlobalMetaId: 'gmid-delegate' },
  });
  assert.equal(result.action, 'accepted');
  assert.equal(calls.join.length, 1);
});

test('declines group_verify_failed when the indexer lookup errors (fail-closed)', async () => {
  for (const options of [
    { groupInfo: { status: 'error' } },
    { groupInfoError: 'network down' },
  ]) {
    const { deps, calls } = makeDeps(options);
    const result = await handleOpenTeamInvite(deps, {
      metabot: makeMetabot(),
      invite: makeInvite(),
      replyContext: replyContext(),
    });
    assert.equal(result.action, 'declined');
    assert.equal(result.reason, 'group_verify_failed');
    assert.equal(calls.join.length, 0);
    assert.equal(calls.send.length, 1);
  }
});

test('group verification runs before the paid join', async () => {
  const { deps, calls } = makeDeps();
  const result = await handleOpenTeamInvite(deps, {
    metabot: makeMetabot(),
    invite: makeInvite(),
    replyContext: replyContext(),
  });
  assert.equal(result.action, 'accepted');
  assert.deepEqual(calls.groupInfo, [GROUP_ID]);
  assert.equal(calls.join.length, 1);
});

test('accept/decline from a sender that is not the invitee is ignored', () => {
  const { deps, calls } = makeDeps({ inviteRow: PENDING_INVITE_ROW });
  const result = handleOpenTeamResponse(
    deps,
    { kind: 'accept', inviteId: INVITE_ID, joinedPinId: JOINED_PIN_ID },
    { senderGlobalMetaId: 'gmid-attacker' },
  );
  assert.equal(result.matched, true);
  assert.equal(calls.updateInviteStatus.length, 0, 'forged ACCEPT must not transition the invite');
});

test('accept from the actual invitee transitions the invite (normalized compare)', () => {
  const { deps, calls } = makeDeps({ inviteRow: PENDING_INVITE_ROW });
  const result = handleOpenTeamResponse(
    deps,
    { kind: 'accept', inviteId: INVITE_ID, joinedPinId: JOINED_PIN_ID },
    { senderGlobalMetaId: 'GMID-GUEST' },
  );
  assert.equal(result.matched, true);
  assert.deepEqual(calls.updateInviteStatus, [[{ invitePinId: INVITE_ID }, 'accepted', null]]);
});

// ---------------------------------------------------------------------------
// KICK handler (M3): the chair's one-way kick notification marks the local
// membership left; forged kicks (sender != recorded inviter) are ignored.
// ---------------------------------------------------------------------------

const { handleOpenTeamKick } = require('../dist-electron/main/services/openTeamGuestService.js');

const makeKickDeps = (options = {}) => {
  const calls = { markLeft: [] };
  const membership = options.membership === undefined
    ? {
        id: 3,
        groupId: GROUP_ID,
        metabotId: 7,
        globalmetaid: 'gmid-guest',
        inviterGlobalmetaid: 'gmid-inviter',
        taskTitle: 'External Task',
        status: 'active',
      }
    : options.membership;
  const deps = {
    getMetabotStore: () => ({}),
    getMembershipStore: () => ({
      getMembership: () => membership,
      markLeft: (groupId, metabotId) => {
        calls.markLeft.push([groupId, metabotId]);
        return true;
      },
    }),
    emitLog: () => {},
  };
  return { deps, calls };
};

const kickPayload = (overrides = {}) => ({
  v: 1,
  groupId: GROUP_ID,
  taskTitle: 'External Task',
  reason: 'off-topic output',
  ...overrides,
});

test('kick from the recorded inviter marks the membership left', () => {
  const { deps, calls } = makeKickDeps();
  const result = handleOpenTeamKick(deps, {
    metabot: makeMetabot(),
    kick: kickPayload(),
    senderGlobalMetaId: 'gmid-inviter',
  });
  assert.deepEqual(result, { action: 'marked_left', reason: '' });
  assert.deepEqual(calls.markLeft, [[GROUP_ID, 7]]);
});

test('kick sender check normalizes case (inviter match still marks left)', () => {
  const { deps, calls } = makeKickDeps();
  const result = handleOpenTeamKick(deps, {
    metabot: makeMetabot(),
    kick: kickPayload(),
    senderGlobalMetaId: 'GMID-INVITER',
  });
  assert.equal(result.action, 'marked_left');
  assert.equal(calls.markLeft.length, 1);
});

test('kick from a sender that is not the recorded inviter is ignored', () => {
  const { deps, calls } = makeKickDeps();
  const result = handleOpenTeamKick(deps, {
    metabot: makeMetabot(),
    kick: kickPayload(),
    senderGlobalMetaId: 'gmid-attacker',
  });
  assert.deepEqual(result, { action: 'ignored', reason: 'sender_not_inviter' });
  assert.equal(calls.markLeft.length, 0, 'forged KICK must not flip the membership');
});

test('kick without a sender identity is ignored', () => {
  const { deps, calls } = makeKickDeps();
  const result = handleOpenTeamKick(deps, {
    metabot: makeMetabot(),
    kick: kickPayload(),
    senderGlobalMetaId: undefined,
  });
  assert.equal(result.action, 'ignored');
  assert.equal(result.reason, 'sender_not_inviter');
  assert.equal(calls.markLeft.length, 0);
});

test('kick for an unknown group or an already-left membership is a no-op', () => {
  const unknown = makeKickDeps({ membership: null });
  const r1 = handleOpenTeamKick(unknown.deps, {
    metabot: makeMetabot(),
    kick: kickPayload(),
    senderGlobalMetaId: 'gmid-inviter',
  });
  assert.deepEqual(r1, { action: 'ignored', reason: 'no_membership' });
  assert.equal(unknown.calls.markLeft.length, 0);

  const left = makeKickDeps({
    membership: {
      id: 3, groupId: GROUP_ID, metabotId: 7, globalmetaid: 'gmid-guest',
      inviterGlobalmetaid: 'gmid-inviter', taskTitle: 'External Task', status: 'left',
    },
  });
  const r2 = handleOpenTeamKick(left.deps, {
    metabot: makeMetabot(),
    kick: kickPayload(),
    senderGlobalMetaId: 'gmid-inviter',
  });
  assert.deepEqual(r2, { action: 'ignored', reason: 'already_left' });
  assert.equal(left.calls.markLeft.length, 0);
});
