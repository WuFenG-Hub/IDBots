import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);

// openTeamService -> groupTaskService -> groupChatTransport -> metaidCore imports
// electron; mock it.
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

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { MetabotStore } = require('../dist-electron/main/metabotStore.js');
const { GroupTaskStore } = require('../dist-electron/main/groupTaskStore.js');
const { OpenTeamMembershipStore } = require('../dist-electron/main/openTeamMembershipStore.js');
const { parseOpenTeamEnvelope } = require('../dist-electron/main/services/openTeamProtocols.js');
const {
  setGroupTaskServiceMetabotStoreGetter,
  setGroupTaskServiceGroupTaskStoreGetter,
} = require('../dist-electron/main/services/groupTaskService.js');
const {
  searchRemoteCandidates,
  inviteRemoteBot,
  resumeOpenTeamInviteWatchers,
  stopOpenTeamInviteWatchers,
  setOpenTeamServiceDeps,
  resetOpenTeamServiceDeps,
  tokenizeOpenTeamQuery,
  scoreOpenTeamCandidate,
} = require('../dist-electron/main/services/openTeamService.js');

Module._load = originalLoad;

const GROUP_ID = 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff00000000i0';
const SEND_PIN_ID = `${'e'.repeat(64)}i0`;
const CHAT_PUBKEY = `02${'cd'.repeat(32)}`;
// GlobalMetaID-shaped test ids (id + version char + '1' + body).
const TWIN_GMID = 'idq1twintwintwintwintwin0';
const LOCAL_GMID = 'idq1localbot00000000000';
const OWNER_GMID = 'idq1owner00000000000000';
const REMOTE_GMID = 'idq1remotebot0000000000';
const REMOTE2_GMID = 'idq1remotebot222222222';
const REMOTE_METAID = 'f'.repeat(64);

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-openteam-svc-'));

const insertWallet = (db, id) => {
  db.run(
    `INSERT INTO metabot_wallets (id, mnemonic, path, created_at)
     VALUES (?, ?, ?, ?)`,
    [id, `abandon ability able about above absent absorb abstract absurd abuse access accident ${id}`, "m/44'/10001'/0'/0/0", 1700000000000 + id]
  );
};

const insertMetabot = (db, { id, walletId, name, type = 'worker', globalmetaid = null, bossGlobalMetaId = null }) => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
      name, enabled, metaid, globalmetaid, metabot_type, created_by, role, soul,
      boss_global_metaid, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, walletId, `mvc-${id}`, `btc-${id}`, `doge-${id}`, `public-${id}`, `chat-public-${id}`,
      name, 1, `metaid-${id}`, globalmetaid, type, '0000', `${name} role`, `${name} soul`,
      bossGlobalMetaId, 1700000000000 + id, 1700000000000 + id,
    ]
  );
};

const makeSearchItem = (globalMetaId, overrides = {}) => ({
  globalMetaId,
  metaId: `meta-${globalMetaId}`,
  address: 'addr',
  chainName: 'mvc',
  name: `name-${globalMetaId}`,
  avatarId: '',
  bio: `bio-${globalMetaId}`,
  chatSkills: ['coding'],
  hasChatPubkey: true,
  hasHomepage: false,
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});

const defaultDetail = {
  metaId: REMOTE_METAID,
  name: 'Remote Bot',
  chatPubkey: CHAT_PUBKEY,
};

const waitFor = async (predicate, { timeoutMs = 4_000, intervalMs = 15 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};

/**
 * Harness: real SqliteStore + MetabotStore + GroupTaskStore + OpenTeamMembershipStore,
 * mocked network/chain deps. Watchers run on real timers with short windows.
 */
const createHarness = async (overrides = {}) => {
  const tempDir = makeTempDir();
  const store = await SqliteStore.create(tempDir);
  const db = store.getDatabase();
  const metabotStore = new MetabotStore(db, store.getSaveFunction());
  const groupTaskStore = new GroupTaskStore(db, store.getSaveFunction());
  const membershipStore = new OpenTeamMembershipStore(db, store.getSaveFunction());

  insertWallet(db, 1);
  insertMetabot(db, { id: 1, walletId: 1, name: 'Twin Bot', type: 'twin', globalmetaid: TWIN_GMID, bossGlobalMetaId: OWNER_GMID });
  insertMetabot(db, { id: 2, walletId: 1, name: 'Local Bot', type: 'worker', globalmetaid: LOCAL_GMID });

  // requireRunnableTask resolves through groupTaskService's own store getters.
  setGroupTaskServiceMetabotStoreGetter(() => metabotStore);
  setGroupTaskServiceGroupTaskStoreGetter(() => groupTaskStore);

  const calls = { search: [], presence: [], detail: [], send: [], wait: [], ownerReport: [], pendingAtSend: [] };
  const searchItems = overrides.searchItems ?? [];
  // gmid -> { isOnline, ago } presence map; missing entries report offline.
  const presenceMap = overrides.presenceMap ?? {};
  const detail = overrides.detail ?? defaultDetail;
  const joined = overrides.joined ?? true;
  const noOwnerReport = overrides.noOwnerReport ?? false;

  setOpenTeamServiceDeps({
    getMetabotStore: () => metabotStore,
    getGroupTaskStore: () => groupTaskStore,
    getMembershipStore: () => membershipStore,
    searchMetaIds: async (params) => {
      calls.search.push(params);
      const items = typeof overrides.searchItemsByCall === 'function'
        ? overrides.searchItemsByCall(params, calls.search.length)
        : searchItems;
      return { items, nextCursor: null, hasMore: false };
    },
    getMetaIdDetail: async (identity) => {
      calls.detail.push(identity);
      return detail;
    },
    fetchOnlineStatus: async (ids) => {
      calls.presence.push(ids);
      const list = ids.map((gmid) => {
        const entry = presenceMap[gmid.toLowerCase()] ?? { isOnline: false, ago: 0 };
        return {
          globalMetaId: gmid,
          isOnline: entry.isOnline,
          lastSeenAt: 0,
          lastSeenAgoSeconds: entry.ago,
          deviceCount: entry.isOnline ? 1 : 0,
        };
      });
      return { total: list.length, onlineCount: list.filter((e) => e.isOnline).length, list };
    },
    waitForMemberJoined: async (groupId, identities, opts) => {
      calls.wait.push({ groupId, identities, opts });
      if (overrides.waitError) throw new Error(overrides.waitError);
      return joined;
    },
    sendEncryptedSimplemsg: async (input) => {
      calls.send.push(input);
      // Snapshot taken while inside the send: proves the pending invite row was
      // persisted BEFORE the envelope went out (crash-safety ordering).
      calls.pendingAtSend.push(membershipStore.listPendingInvites().length);
      if (overrides.sendError) throw new Error(overrides.sendError);
      return { txids: ['tx-invite'], pinId: SEND_PIN_ID };
    },
    sendOwnerPrivateReport: noOwnerReport
      ? undefined
      : async (params) => {
          calls.ownerReport.push(params);
          return { pinId: 'report-pin' };
        },
    emitLog: () => {},
    joinConfirmTimeoutMs: overrides.joinConfirmTimeoutMs ?? 400,
    watcherPollMs: overrides.watcherPollMs ?? 25,
  });

  const task = groupTaskStore.createTask({
    groupId: GROUP_ID,
    title: 'Remote Task',
    goal: 'Prove remote collaboration works end to end',
    chairMetabotId: 1,
    createdBy: 'twinbot',
    createPinId: GROUP_ID,
  });
  groupTaskStore.addMember({ taskId: task.id, metabotId: 1, globalmetaid: TWIN_GMID, role: 'chair', joinedPinId: GROUP_ID });

  return {
    db,
    metabotStore,
    groupTaskStore,
    membershipStore,
    task,
    calls,
    cleanup: () => {
      stopOpenTeamInviteWatchers();
      resetOpenTeamServiceDeps();
    },
  };
};

// ---------------------------------------------------------------------------
// searchRemoteCandidates
// ---------------------------------------------------------------------------

test('searchRemoteCandidates: filters offline + local bots, maps candidate fields', async () => {
  const h = await createHarness({
    searchItems: [
      makeSearchItem(REMOTE_GMID, { name: 'Remote A', bio: 'bio-a', chatSkills: ['translation'], chainName: 'mvc' }),
      makeSearchItem(REMOTE2_GMID, { name: 'Remote B' }),
      makeSearchItem(LOCAL_GMID, { name: 'Local Bot' }),
    ],
    presenceMap: {
      [REMOTE_GMID]: { isOnline: true, ago: 12 },
      [REMOTE2_GMID]: { isOnline: false, ago: 900 },
      [LOCAL_GMID]: { isOnline: true, ago: 3 },
    },
  });
  try {
    const candidates = await searchRemoteCandidates({ keyword: 'translator', limit: 10 });
    // P1-5: keyword searches run TWO recalls — the exact path (keyword passed
    // through) plus a loose path without the keyword (local fuzzy ranking).
    assert.equal(h.calls.search.length, 2, 'exact path + P1-5 fuzzy recall');
    assert.equal(h.calls.search[0].keyword, 'translator');
    assert.equal(h.calls.search[1].keyword, undefined, 'fuzzy recall drops the exact-match keyword');
    assert.equal(h.calls.search[0].hasChatPubkey, true, 'server-side pubkey pre-filter');
    assert.deepEqual(
      h.calls.presence[0].sort(),
      [REMOTE_GMID, REMOTE2_GMID].sort(),
      'local bot excluded before the presence batch',
    );
    assert.equal(candidates.length, 1);
    assert.deepEqual(candidates[0], {
      globalMetaId: REMOTE_GMID,
      name: 'Remote A',
      bio: 'bio-a',
      chatSkills: ['translation'],
      chainName: 'mvc',
      isOnline: true,
      lastSeenAgoSeconds: 12,
    });
  } finally {
    h.cleanup();
  }
});

test('searchRemoteCandidates: empty page and all-offline both yield []', async () => {
  const h = await createHarness({ searchItems: [] });
  try {
    assert.deepEqual(await searchRemoteCandidates({}), []);
    assert.equal(h.calls.presence.length, 0, 'presence lookup skipped for an empty page');
  } finally {
    h.cleanup();
  }

  const h2 = await createHarness({
    searchItems: [makeSearchItem(REMOTE_GMID)],
    presenceMap: { [REMOTE_GMID]: { isOnline: false, ago: 60 } },
  });
  try {
    assert.deepEqual(await searchRemoteCandidates({ skill: 'coding' }), []);
  } finally {
    h2.cleanup();
  }
});

// ---------------------------------------------------------------------------
// inviteRemoteBot validation branches
// ---------------------------------------------------------------------------

test('inviteRemoteBot: rejects a terminal task', async () => {
  const h = await createHarness();
  try {
    h.db.run(`UPDATE group_tasks SET status = 'done' WHERE id = ?`, [h.task.id]);
    await assert.rejects(
      () => inviteRemoteBot({ taskId: h.task.id, inviteeGlobalMetaId: REMOTE_GMID }),
      /is done/,
    );
    assert.equal(h.calls.send.length, 0);
  } finally {
    h.cleanup();
  }
});

test('inviteRemoteBot: rejects a local bot as invitee', async () => {
  const h = await createHarness();
  try {
    await assert.rejects(
      () => inviteRemoteBot({ taskId: h.task.id, inviteeGlobalMetaId: LOCAL_GMID }),
      /local MetaBot/,
    );
    assert.equal(h.calls.send.length, 0);
  } finally {
    h.cleanup();
  }
});

test('inviteRemoteBot: rejects an invitee who is already a member', async () => {
  const h = await createHarness();
  try {
    h.groupTaskStore.addMember({
      taskId: h.task.id,
      metabotId: null,
      globalmetaid: REMOTE_GMID,
      displayName: 'Remote Bot',
      role: 'worker',
      // P1-1/P1-2: a CONFIRMED member carries the join pin — that is what blocks
      // a re-invite. A bare placeholder row (joinedPinId null) must not.
      joinedPinId: 'joined-pin-confirmed',
    });
    await assert.rejects(
      () => inviteRemoteBot({ taskId: h.task.id, inviteeGlobalMetaId: REMOTE_GMID }),
      /already a member/,
    );
  } finally {
    h.cleanup();
  }
});

test('inviteRemoteBot: P1-1 releases a placeholder member whose join never confirmed', async () => {
  const h = await createHarness({ presenceMap: { [REMOTE_GMID]: { isOnline: true, ago: 5 } } });
  try {
    // Placeholder row created by the join watcher without a join pin — the
    // invite expired (or the join never settled). No invite is pending, so the
    // retry is released and the invite goes out again.
    h.groupTaskStore.addMember({
      taskId: h.task.id,
      metabotId: null,
      globalmetaid: REMOTE_GMID,
      displayName: 'Remote Bot',
      role: 'worker',
      joinedPinId: null,
    });
    const result = await inviteRemoteBot({ taskId: h.task.id, inviteeGlobalMetaId: REMOTE_GMID });
    assert.equal(result.status, 'pending');
    assert.ok(result.invitePinId, 'a re-invite pin must be produced');
    assert.equal(h.calls.send.length, 1, 'the retry must actually send a fresh invite');
  } finally {
    h.cleanup();
  }
});

test('inviteRemoteBot: P1-1 placeholder + live pending invite still blocks the duplicate', async () => {
  const h = await createHarness({ presenceMap: { [REMOTE_GMID]: { isOnline: true, ago: 5 } } });
  try {
    h.groupTaskStore.addMember({
      taskId: h.task.id,
      metabotId: null,
      globalmetaid: REMOTE_GMID,
      displayName: 'Remote Bot',
      role: 'worker',
      joinedPinId: null,
    });
    h.membershipStore.createInvite({
      taskId: h.task.id,
      groupId: GROUP_ID,
      inviteeGlobalmetaid: REMOTE_GMID,
      invitePinId: 'pending-pin-live',
    });
    await assert.rejects(
      () => inviteRemoteBot({ taskId: h.task.id, inviteeGlobalMetaId: REMOTE_GMID }),
      /a pending invite for .* already exists/,
    );
  } finally {
    h.cleanup();
  }
});

test('inviteRemoteBot: rejects an offline invitee', async () => {
  const h = await createHarness({ presenceMap: { [REMOTE_GMID]: { isOnline: false, ago: 30 } } });
  try {
    await assert.rejects(
      () => inviteRemoteBot({ taskId: h.task.id, inviteeGlobalMetaId: REMOTE_GMID }),
      /offline/,
    );
    assert.equal(h.calls.send.length, 0);
  } finally {
    h.cleanup();
  }
});

test('inviteRemoteBot: rejects an invitee without a chat pubkey', async () => {
  const h = await createHarness({
    presenceMap: { [REMOTE_GMID]: { isOnline: true, ago: 5 } },
    detail: { metaId: REMOTE_METAID, name: 'Remote Bot', chatPubkey: '' },
  });
  try {
    await assert.rejects(
      () => inviteRemoteBot({ taskId: h.task.id, inviteeGlobalMetaId: REMOTE_GMID }),
      /private messages/,
    );
    assert.equal(h.calls.send.length, 0);
  } finally {
    h.cleanup();
  }
});

test('inviteRemoteBot: rejects a duplicate pending invite', async () => {
  const h = await createHarness({ presenceMap: { [REMOTE_GMID]: { isOnline: true, ago: 5 } } });
  try {
    const first = await inviteRemoteBot({ taskId: h.task.id, inviteeGlobalMetaId: REMOTE_GMID });
    assert.equal(first.status, 'pending');
    await assert.rejects(
      () => inviteRemoteBot({ taskId: h.task.id, inviteeGlobalMetaId: REMOTE_GMID }),
      /pending invite/,
    );
    assert.equal(h.calls.send.length, 1, 'second attempt stopped before sending');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// inviteRemoteBot re-invite policy (M3)
// ---------------------------------------------------------------------------

test('inviteRemoteBot: re-inviting a kicked remote member is rejected unless allowReinvite', async () => {
  const h = await createHarness({ presenceMap: { [REMOTE_GMID]: { isOnline: true, ago: 5 } } });
  try {
    h.groupTaskStore.addMember({
      taskId: h.task.id,
      metabotId: null,
      globalmetaid: REMOTE_GMID,
      displayName: 'Remote Bot',
      role: 'worker',
    });
    h.groupTaskStore.markMemberRemoved({
      taskId: h.task.id,
      globalmetaid: REMOTE_GMID,
      removePinId: 'pin-remove-remote',
    });
    assert.ok(!h.groupTaskStore.isMember(h.task.id, null, REMOTE_GMID), 'kicked member is no longer active');

    await assert.rejects(
      () => inviteRemoteBot({ taskId: h.task.id, inviteeGlobalMetaId: REMOTE_GMID }),
      /previously removed/,
    );
    assert.equal(h.calls.send.length, 0, 'blocked before any invite is sent');

    // The owner explicitly asked for the re-invite: normal flow resumes.
    const result = await inviteRemoteBot({
      taskId: h.task.id,
      inviteeGlobalMetaId: REMOTE_GMID,
      allowReinvite: true,
    });
    assert.equal(result.status, 'pending');
    assert.equal(h.calls.send.length, 1);
    const invite = h.membershipStore.getInviteByPinId(result.invitePinId);
    assert.equal(invite.status, 'pending', 'a fresh invite row tracks the new handshake');
  } finally {
    h.cleanup();
  }
});

test('inviteRemoteBot: re-inviting a declined invitee is rejected unless allowReinvite', async () => {
  const h = await createHarness({ presenceMap: { [REMOTE_GMID]: { isOnline: true, ago: 5 } } });
  try {
    const declined = h.membershipStore.createInvite({
      taskId: h.task.id,
      groupId: GROUP_ID,
      inviteeGlobalmetaid: REMOTE_GMID,
      invitePinId: `${'d'.repeat(64)}i0`,
    });
    // Owner-intent decline (the persisted shape is `<reason>: <detail>`).
    h.membershipStore.updateInviteStatus(
      { invitePinId: declined.invitePinId },
      'declined',
      'remote_collab_disabled: remote collaboration is disabled by the bot owner',
    );

    await assert.rejects(
      () => inviteRemoteBot({ taskId: h.task.id, inviteeGlobalMetaId: REMOTE_GMID }),
      /previously declined/,
    );
    assert.equal(h.calls.send.length, 0);

    const result = await inviteRemoteBot({
      taskId: h.task.id,
      inviteeGlobalMetaId: REMOTE_GMID,
      allowReinvite: true,
    });
    assert.equal(result.status, 'pending');
    assert.equal(h.calls.send.length, 1);
  } finally {
    h.cleanup();
  }
});

test('inviteRemoteBot: transient/technical declines are not negative history and never block', async () => {
  const h = await createHarness({ presenceMap: { [REMOTE_GMID]: { isOnline: true, ago: 5 } } });
  try {
    // rate_limited / group_verify_failed / invite_expired say nothing about
    // the guest owner's willingness — a later invite must go through.
    for (const [index, reason] of [
      'rate_limited: too many invites from this inviter or for this group; retry later',
      'group_verify_failed: could not verify the invited group on-chain',
      'invite_expired: the invite has expired',
    ].entries()) {
      const declined = h.membershipStore.createInvite({
        taskId: h.task.id,
        groupId: GROUP_ID,
        inviteeGlobalmetaid: REMOTE_GMID,
        invitePinId: `${'c'.repeat(63)}${index}i0`,
      });
      h.membershipStore.updateInviteStatus({ invitePinId: declined.invitePinId }, 'declined', reason);

      const result = await inviteRemoteBot({ taskId: h.task.id, inviteeGlobalMetaId: REMOTE_GMID });
      assert.equal(result.status, 'pending', `transient decline "${reason}" does not block the re-invite`);
      // Consume the fresh pending row so the next loop iteration is unblocked.
      h.membershipStore.updateInviteStatus({ invitePinId: result.invitePinId }, 'expired', 'invite_response_timeout');
    }
    assert.equal(h.calls.send.length, 3);
  } finally {
    h.cleanup();
  }
});

test('inviteRemoteBot: an expired invite is not negative history and does not block', async () => {
  const h = await createHarness({ presenceMap: { [REMOTE_GMID]: { isOnline: true, ago: 5 } } });
  try {
    const expired = h.membershipStore.createInvite({
      taskId: h.task.id,
      groupId: GROUP_ID,
      inviteeGlobalmetaid: REMOTE_GMID,
      invitePinId: `${'e'.repeat(63)}ei0`,
    });
    h.membershipStore.updateInviteStatus({ invitePinId: expired.invitePinId }, 'expired', 'invite_response_timeout');

    const result = await inviteRemoteBot({ taskId: h.task.id, inviteeGlobalMetaId: REMOTE_GMID });
    assert.equal(result.status, 'pending');
    assert.equal(h.calls.send.length, 1, 'retry after a timeout is the normal flow');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// inviteRemoteBot happy path
// ---------------------------------------------------------------------------

test('inviteRemoteBot: sends the invite envelope and records a pending invite', async () => {
  const h = await createHarness({ presenceMap: { [REMOTE_GMID]: { isOnline: true, ago: 5 } } });
  try {
    const result = await inviteRemoteBot({
      taskId: h.task.id,
      inviteeGlobalMetaId: REMOTE_GMID,
      inviteeName: 'Remote Bot',
      requiredSkills: ['translation', ' review '],
    });
    assert.equal(result.status, 'pending');
    assert.match(result.invitePinId, /^[0-9a-f]{64}i0$/, 'random pinId-shaped invite id');

    assert.equal(h.calls.send.length, 1);
    const sent = h.calls.send[0];
    assert.equal(sent.metabotId, 1, 'sent from the twin bot wallet');
    assert.equal(sent.peerGlobalMetaId, REMOTE_GMID);
    assert.equal(sent.peerChatPubkey, CHAT_PUBKEY);
    const envelope = parseOpenTeamEnvelope(sent.plaintext);
    assert.equal(envelope.kind, 'invite');
    assert.equal(envelope.invite.inviteId, result.invitePinId);
    assert.equal(envelope.invite.groupId, GROUP_ID);
    assert.equal(envelope.invite.taskTitle, 'Remote Task');
    assert.ok(envelope.invite.goalSummary.length > 0);
    assert.deepEqual(envelope.invite.requiredSkills, ['translation', 'review']);
    assert.equal(envelope.invite.inviterGlobalMetaId, TWIN_GMID);
    assert.equal(envelope.invite.chairGlobalMetaId, TWIN_GMID, 'twin is the chair');
    assert.equal(envelope.invite.targetGlobalMetaId, REMOTE_GMID);
    assert.ok(envelope.invite.expiresAt > Math.floor(Date.now() / 1000), 'expiry in the future');

    const invite = h.membershipStore.getInviteByPinId(result.invitePinId);
    assert.ok(invite);
    assert.equal(invite.status, 'pending');
    assert.equal(invite.taskId, h.task.id);
    assert.equal(invite.groupId, GROUP_ID);
    assert.equal(invite.inviteeGlobalmetaid, REMOTE_GMID);
    assert.equal(invite.inviteeName, 'Remote Bot');

    // The pending row landed BEFORE the envelope send (crash-safe ordering).
    assert.deepEqual(h.calls.pendingAtSend, [1]);
  } finally {
    h.cleanup();
  }
});

test('inviteRemoteBot: a send failure finalizes the pre-persisted invite as expired (send_failed)', async () => {
  const h = await createHarness({
    presenceMap: { [REMOTE_GMID]: { isOnline: true, ago: 5 } },
    sendError: 'insufficient SPACE',
  });
  try {
    await assert.rejects(
      () => inviteRemoteBot({
        taskId: h.task.id,
        inviteeGlobalMetaId: REMOTE_GMID,
        inviteeName: 'Remote Bot',
      }),
      /insufficient SPACE/,
    );
    assert.equal(h.calls.send.length, 1);
    // The row existed when the send was attempted...
    assert.deepEqual(h.calls.pendingAtSend, [1]);
    // ...and was finalized as expired instead of being left a ghost pending row.
    const envelope = parseOpenTeamEnvelope(h.calls.send[0].plaintext);
    const invite = h.membershipStore.getInviteByPinId(envelope.invite.inviteId);
    assert.ok(invite, 'invite row persisted before the send attempt');
    assert.equal(invite.status, 'expired');
    assert.equal(invite.declineReason, 'send_failed');
    assert.equal(
      h.membershipStore.hasPendingInvite(h.task.id, REMOTE_GMID),
      false,
      'expired row must not block a later re-invite',
    );
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Join-confirmation watcher state machine
// ---------------------------------------------------------------------------

test('watcher: accepted + join confirmed -> remote member row, invite stays accepted', async () => {
  const h = await createHarness({
    presenceMap: { [REMOTE_GMID]: { isOnline: true, ago: 5 } },
    joined: true,
  });
  try {
    const { invitePinId } = await inviteRemoteBot({
      taskId: h.task.id,
      inviteeGlobalMetaId: REMOTE_GMID,
      inviteeName: 'Remote Bot',
    });
    // Simulates handleIncomingOpenTeamResponse landing the guest's ACCEPT,
    // including the P1-2 join-pin echo persisted on the invite row.
    h.membershipStore.updateInviteStatus({ invitePinId }, 'accepted');
    h.membershipStore.updateInviteJoinedPinId(invitePinId, 'joined-pin-abc');

    await waitFor(() => h.groupTaskStore.isMember(h.task.id, null, REMOTE_GMID));
    const member = h.groupTaskStore
      .listMembers(h.task.id)
      .find((m) => m.metabotId == null && m.globalmetaid === REMOTE_GMID);
    assert.ok(member);
    assert.equal(member.role, 'worker');
    assert.equal(member.displayName, 'Remote Bot');
    // P1-2: the member row carries the join pin, so "already joined" is
    // readable from the member itself (and blocks duplicate invites).
    assert.equal(member.joinedPinId, 'joined-pin-abc');

    assert.equal(h.calls.wait.length, 1);
    assert.equal(h.calls.wait[0].groupId, GROUP_ID);
    assert.ok(h.calls.wait[0].identities.includes(REMOTE_GMID));
    assert.ok(h.calls.wait[0].identities.includes(REMOTE_METAID), 'both identity forms passed');

    const invite = h.membershipStore.getInviteByPinId(invitePinId);
    assert.equal(invite.status, 'accepted', 'accepted is the final completed state');
    assert.equal(h.calls.ownerReport.length, 0, 'no owner alert on success');
  } finally {
    h.cleanup();
  }
});

test('watcher: accepted but never joins -> expired join_confirm_timeout + owner notified', async () => {
  const h = await createHarness({
    presenceMap: { [REMOTE_GMID]: { isOnline: true, ago: 5 } },
    joined: false,
  });
  try {
    const { invitePinId } = await inviteRemoteBot({
      taskId: h.task.id,
      inviteeGlobalMetaId: REMOTE_GMID,
      inviteeName: 'Remote Bot',
    });
    h.membershipStore.updateInviteStatus({ invitePinId }, 'accepted');

    await waitFor(() => h.membershipStore.getInviteByPinId(invitePinId)?.status === 'expired');
    const invite = h.membershipStore.getInviteByPinId(invitePinId);
    assert.equal(invite.declineReason, 'join_confirm_timeout');
    assert.equal(h.groupTaskStore.isMember(h.task.id, null, REMOTE_GMID), false);

    await waitFor(() => h.calls.ownerReport.length > 0);
    assert.equal(h.calls.ownerReport.length, 1);
    const report = h.calls.ownerReport[0];
    assert.equal(report.taskId, h.task.id);
    assert.equal(report.metabotId, 1, 'report sent by the chair (twin)');
    assert.equal(report.ownerGlobalMetaId, OWNER_GMID);
    assert.match(report.text, /did not complete/);
    assert.match(report.text, /Remote Task/);
  } finally {
    h.cleanup();
  }
});

test('watcher: no response before the window closes -> expired invite_response_timeout', async () => {
  const h = await createHarness({
    presenceMap: { [REMOTE_GMID]: { isOnline: true, ago: 5 } },
  });
  try {
    const { invitePinId } = await inviteRemoteBot({
      taskId: h.task.id,
      inviteeGlobalMetaId: REMOTE_GMID,
    });
    // The pending window is created_at + envelope TTL (600s) + propagation
    // margin (300s): backdate past the whole window so the next poll expires.
    h.db.run(
      `UPDATE openteam_invites SET created_at = datetime('now', '-20 minutes') WHERE invite_pin_id = ?`,
      [invitePinId],
    );
    await waitFor(() => h.membershipStore.getInviteByPinId(invitePinId)?.status === 'expired');
    const invite = h.membershipStore.getInviteByPinId(invitePinId);
    assert.equal(invite.declineReason, 'invite_response_timeout');
    assert.equal(h.calls.wait.length, 0, 'join confirmation never ran');
    await waitFor(() => h.calls.ownerReport.length > 0);
    assert.equal(h.calls.ownerReport.length, 1);
  } finally {
    h.cleanup();
  }
});

test('watcher: a legitimate ACCEPT landing inside the propagation margin is still processed', async () => {
  const h = await createHarness({
    presenceMap: { [REMOTE_GMID]: { isOnline: true, ago: 5 } },
    joined: true,
  });
  try {
    const { invitePinId } = await inviteRemoteBot({
      taskId: h.task.id,
      inviteeGlobalMetaId: REMOTE_GMID,
      inviteeName: 'Remote Bot',
    });
    // The guest accepted just before the envelope expiry (T+600s) and the
    // ACCEPT needed time to cross the indexer + private-message layers: the
    // invite row is now 610s old — past the envelope TTL but well inside the
    // TTL + propagation margin pending window.
    h.db.run(
      `UPDATE openteam_invites SET created_at = datetime('now', '-610 seconds') WHERE invite_pin_id = ?`,
      [invitePinId],
    );
    // Several polls pass: the watcher must NOT expire the invite underneath
    // the in-flight ACCEPT (the pre-fix behavior dropped it here).
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(
      h.membershipStore.getInviteByPinId(invitePinId)?.status,
      'pending',
      'still pending inside the propagation margin',
    );

    h.membershipStore.updateInviteStatus({ invitePinId }, 'accepted');
    await waitFor(() => h.groupTaskStore.isMember(h.task.id, null, REMOTE_GMID));
    const invite = h.membershipStore.getInviteByPinId(invitePinId);
    assert.equal(invite.status, 'accepted', 'the late ACCEPT completed the handshake');
    assert.equal(h.calls.ownerReport.length, 0, 'no owner alert on success');
  } finally {
    h.cleanup();
  }
});

test('watcher: a declined invite stops the watcher quietly', async () => {
  const h = await createHarness({
    presenceMap: { [REMOTE_GMID]: { isOnline: true, ago: 5 } },
  });
  try {
    const { invitePinId } = await inviteRemoteBot({
      taskId: h.task.id,
      inviteeGlobalMetaId: REMOTE_GMID,
    });
    h.membershipStore.updateInviteStatus({ invitePinId }, 'declined', 'remote_collab_disabled');
    // Give the watcher several polls to observe the decline.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const invite = h.membershipStore.getInviteByPinId(invitePinId);
    assert.equal(invite.status, 'declined');
    assert.equal(invite.declineReason, 'remote_collab_disabled');
    assert.equal(h.calls.wait.length, 0, 'declined invites never enter join confirmation');
    assert.equal(h.groupTaskStore.isMember(h.task.id, null, REMOTE_GMID), false);
    assert.equal(h.calls.ownerReport.length, 0, 'declines are not owner-alerted (only timeouts)');
  } finally {
    h.cleanup();
  }
});

test('resumeOpenTeamInviteWatchers re-arms pending invites after a restart', async () => {
  const h = await createHarness({ joined: true });
  try {
    // A pending invite row left over from before the "restart" (no watcher yet).
    const leftover = h.membershipStore.createInvite({
      taskId: h.task.id,
      groupId: GROUP_ID,
      inviteeGlobalmetaid: REMOTE_GMID,
      inviteeName: 'Remote Bot',
      invitePinId: `${'1'.repeat(64)}i0`,
    });
    const started = resumeOpenTeamInviteWatchers();
    assert.equal(started, 1);
    h.membershipStore.updateInviteStatus({ invitePinId: leftover.invitePinId }, 'accepted');
    await waitFor(() => h.groupTaskStore.isMember(h.task.id, null, REMOTE_GMID));
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Restart recovery of accepted-but-unconfirmed invites (crash mid-handshake)
// ---------------------------------------------------------------------------

test('resume: accepted + no member row + inside the window -> join confirmed, member recorded', async () => {
  const h = await createHarness({ joined: true });
  try {
    // ACCEPT landed before the "restart"; the join confirmation never ran.
    const invite = h.membershipStore.createInvite({
      taskId: h.task.id,
      groupId: GROUP_ID,
      inviteeGlobalmetaid: REMOTE_GMID,
      inviteeName: 'Remote Bot',
      invitePinId: `${'2'.repeat(64)}i0`,
    });
    h.membershipStore.updateInviteStatus({ invitePinId: invite.invitePinId }, 'accepted');

    const started = resumeOpenTeamInviteWatchers();
    assert.equal(started, 1, 'accepted-but-unconfirmed invite gets a watcher');

    await waitFor(() => h.groupTaskStore.isMember(h.task.id, null, REMOTE_GMID));
    const member = h.groupTaskStore
      .listMembers(h.task.id)
      .find((m) => m.metabotId == null && m.globalmetaid === REMOTE_GMID);
    assert.ok(member);
    assert.equal(member.role, 'worker');
    assert.equal(member.displayName, 'Remote Bot');
    assert.equal(h.calls.wait.length, 1);
    assert.ok(h.calls.wait[0].identities.includes(REMOTE_GMID));

    const after = h.membershipStore.getInviteByPinId(invite.invitePinId);
    assert.equal(after.status, 'accepted', 'accepted is the final completed state');
    assert.equal(h.calls.ownerReport.length, 0, 'no owner alert on success');
  } finally {
    h.cleanup();
  }
});

test('resume: accepted + no member row + never joins -> expired join_confirm_timeout', async () => {
  const h = await createHarness({ joined: false });
  try {
    const invite = h.membershipStore.createInvite({
      taskId: h.task.id,
      groupId: GROUP_ID,
      inviteeGlobalmetaid: REMOTE_GMID,
      inviteeName: 'Remote Bot',
      invitePinId: `${'3'.repeat(64)}i0`,
    });
    h.membershipStore.updateInviteStatus({ invitePinId: invite.invitePinId }, 'accepted');
    // Ancient created_at no longer shortens the join-confirmation budget: it
    // runs from responded_at (the ACCEPT landing), so this watcher still gets
    // its full (harness: 400ms) confirmation window before expiring.
    h.db.run(
      `UPDATE openteam_invites SET created_at = datetime('now', '-1 hour') WHERE invite_pin_id = ?`,
      [invite.invitePinId],
    );

    const started = resumeOpenTeamInviteWatchers();
    assert.equal(started, 1, 'accepted-but-unconfirmed invite gets a watcher');

    await waitFor(() => h.membershipStore.getInviteByPinId(invite.invitePinId)?.status === 'expired');
    const after = h.membershipStore.getInviteByPinId(invite.invitePinId);
    assert.equal(after.declineReason, 'join_confirm_timeout');
    assert.equal(h.groupTaskStore.isMember(h.task.id, null, REMOTE_GMID), false);

    await waitFor(() => h.calls.ownerReport.length > 0);
    assert.equal(h.calls.ownerReport.length, 1, 'same owner heads-up as a live watcher timeout');
    assert.match(h.calls.ownerReport[0].text, /never appeared/);
  } finally {
    h.cleanup();
  }
});

test('watcher: the join-confirmation budget runs from responded_at, not created_at', async () => {
  const h = await createHarness({ joined: false, joinConfirmTimeoutMs: 400 });
  try {
    const invite = h.membershipStore.createInvite({
      taskId: h.task.id,
      groupId: GROUP_ID,
      inviteeGlobalmetaid: REMOTE_GMID,
      inviteeName: 'Remote Bot',
      invitePinId: `${'5'.repeat(64)}i0`,
    });
    h.membershipStore.updateInviteStatus({ invitePinId: invite.invitePinId }, 'accepted');
    // created_at is an hour old: anchoring the budget there (the pre-fix
    // behavior) would expire the invite immediately, even though the ACCEPT
    // has just landed and deserves a full confirmation window.
    h.db.run(
      `UPDATE openteam_invites SET created_at = datetime('now', '-1 hour') WHERE invite_pin_id = ?`,
      [invite.invitePinId],
    );

    const started = resumeOpenTeamInviteWatchers();
    assert.equal(started, 1);
    await waitFor(() => h.calls.wait.length > 0);
    assert.ok(
      h.calls.wait[0].opts.timeoutMs >= 300,
      `confirmation window runs from responded_at (~400ms), got ${h.calls.wait[0].opts.timeoutMs}ms`,
    );
    // Only after that fresh budget elapses unconfirmed does the invite expire.
    await waitFor(() => h.membershipStore.getInviteByPinId(invite.invitePinId)?.status === 'expired');
    assert.equal(h.membershipStore.getInviteByPinId(invite.invitePinId)?.declineReason, 'join_confirm_timeout');
  } finally {
    h.cleanup();
  }
});

test('watcher: a failing step past the deadline finalizes the invite instead of retrying forever', async () => {
  const h = await createHarness({
    joined: false,
    joinConfirmTimeoutMs: 400,
    waitError: 'indexer unreachable',
  });
  try {
    const invite = h.membershipStore.createInvite({
      taskId: h.task.id,
      groupId: GROUP_ID,
      inviteeGlobalmetaid: REMOTE_GMID,
      inviteeName: 'Remote Bot',
      invitePinId: `${'6'.repeat(64)}i0`,
    });
    h.membershipStore.updateInviteStatus({ invitePinId: invite.invitePinId }, 'accepted');

    const started = resumeOpenTeamInviteWatchers();
    assert.equal(started, 1);

    // Every step throws; the watcher retries while inside the budget, then
    // finalizes through the normal expire path once the deadline has passed.
    await waitFor(() => h.membershipStore.getInviteByPinId(invite.invitePinId)?.status === 'expired');
    const after = h.membershipStore.getInviteByPinId(invite.invitePinId);
    assert.equal(after.declineReason, 'join_confirm_timeout');
    assert.ok(h.calls.wait.length >= 2, 'the failing step was retried before the deadline');
    await waitFor(() => h.calls.ownerReport.length > 0);
    assert.equal(h.calls.ownerReport.length, 1);
    assert.match(h.calls.ownerReport[0].text, /never appeared/);

    // The watcher stopped: no further join-confirmation attempts.
    const waitCalls = h.calls.wait.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(h.calls.wait.length, waitCalls, 'no infinite retry loop after finalization');
  } finally {
    h.cleanup();
  }
});

test('resume: watcher polls both persisted identity forms (globalMetaId + legacy metaId)', async () => {
  const h = await createHarness({ joined: true });
  try {
    const invite = h.membershipStore.createInvite({
      taskId: h.task.id,
      groupId: GROUP_ID,
      inviteeGlobalmetaid: REMOTE_GMID,
      inviteeMetaid: REMOTE_METAID,
      inviteeName: 'Remote Bot',
      invitePinId: `${'7'.repeat(64)}i0`,
    });
    h.membershipStore.updateInviteStatus({ invitePinId: invite.invitePinId }, 'accepted');

    const started = resumeOpenTeamInviteWatchers();
    assert.equal(started, 1);
    await waitFor(() => h.calls.wait.length > 0);
    assert.ok(h.calls.wait[0].identities.includes(REMOTE_GMID));
    assert.ok(
      h.calls.wait[0].identities.includes(REMOTE_METAID),
      'the persisted legacy metaId form survives the restart',
    );
    await waitFor(() => h.groupTaskStore.isMember(h.task.id, null, REMOTE_GMID));
  } finally {
    h.cleanup();
  }
});

test('resume: a kicked invitee is not revived — no watcher, no expiry, no owner alert', async () => {
  const h = await createHarness({ joined: true });
  try {
    // Full handshake completed, then the member was kicked (invite row stays
    // accepted as history; the member row is marked removed).
    const invite = h.membershipStore.createInvite({
      taskId: h.task.id,
      groupId: GROUP_ID,
      inviteeGlobalmetaid: REMOTE_GMID,
      inviteeName: 'Remote Bot',
      invitePinId: `${'8'.repeat(64)}i0`,
    });
    h.membershipStore.updateInviteStatus({ invitePinId: invite.invitePinId }, 'accepted');
    h.groupTaskStore.addMember({
      taskId: h.task.id,
      metabotId: null,
      globalmetaid: REMOTE_GMID,
      displayName: 'Remote Bot',
      role: 'worker',
    });
    h.groupTaskStore.markMemberRemoved({
      taskId: h.task.id,
      globalmetaid: REMOTE_GMID,
      removePinId: 'pin-remove-remote',
    });
    assert.ok(!h.groupTaskStore.isMember(h.task.id, null, REMOTE_GMID), 'kicked member is inactive');

    const started = resumeOpenTeamInviteWatchers();
    assert.equal(started, 0, 'the kicked invitee invite freezes as accepted history');

    // Give any (unexpectedly started) watcher several polls to misbehave.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(h.calls.wait.length, 0, 'no join confirmation for a kicked invitee');
    assert.equal(h.calls.ownerReport.length, 0, 'no misleading timeout alert');
    const after = h.membershipStore.getInviteByPinId(invite.invitePinId);
    assert.equal(after.status, 'accepted', 'invite row untouched (history), not expired');
    assert.equal(
      h.groupTaskStore.listMembers(h.task.id).filter((m) => m.globalmetaid === REMOTE_GMID).length,
      0,
      'the kick is not silently undone',
    );
  } finally {
    h.cleanup();
  }
});

test('watcher: a kick landing after resume but before the first tick stops the watcher quietly', async () => {
  const h = await createHarness({ joined: true });
  try {
    const invite = h.membershipStore.createInvite({
      taskId: h.task.id,
      groupId: GROUP_ID,
      inviteeGlobalmetaid: REMOTE_GMID,
      inviteeName: 'Remote Bot',
      invitePinId: `${'9'.repeat(64)}i0`,
    });
    h.membershipStore.updateInviteStatus({ invitePinId: invite.invitePinId }, 'accepted');
    // Resume arms the watcher while the roster looks clean...
    const started = resumeOpenTeamInviteWatchers();
    assert.equal(started, 1);
    // ...then the owner kicks the member before the watcher's first tick runs
    // (both calls are synchronous; the tick fires on the next macrotask).
    h.groupTaskStore.addMember({
      taskId: h.task.id,
      metabotId: null,
      globalmetaid: REMOTE_GMID,
      displayName: 'Remote Bot',
      role: 'worker',
    });
    h.groupTaskStore.markMemberRemoved({
      taskId: h.task.id,
      globalmetaid: REMOTE_GMID,
      removePinId: 'pin-remove-remote',
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(h.calls.wait.length, 0, 'the watcher never polls the indexer for a kicked invitee');
    assert.equal(h.calls.ownerReport.length, 0, 'no misleading owner alert');
    assert.equal(
      h.membershipStore.getInviteByPinId(invite.invitePinId)?.status,
      'accepted',
      'invite stays accepted (history), the kick stays authoritative',
    );
    assert.equal(h.groupTaskStore.isMember(h.task.id, null, REMOTE_GMID), false, 'not revived');
  } finally {
    h.cleanup();
  }
});

test('watcher: an explicit re-invite after a kick still completes its handshake', async () => {
  const h = await createHarness({
    presenceMap: { [REMOTE_GMID]: { isOnline: true, ago: 5 } },
    joined: true,
  });
  try {
    // Earlier membership kicked. removed_at and the invite's created_at are
    // both millisecond-precision, so even a same-second kick + re-invite
    // (exactly what this test does) keeps the removed row PREDATING the
    // re-invite instead of freezing it.
    h.groupTaskStore.addMember({
      taskId: h.task.id,
      metabotId: null,
      globalmetaid: REMOTE_GMID,
      displayName: 'Remote Bot',
      role: 'worker',
    });
    h.groupTaskStore.markMemberRemoved({
      taskId: h.task.id,
      globalmetaid: REMOTE_GMID,
      removePinId: 'pin-remove-remote',
    });
    // Keep the kick strictly BEFORE the re-invite at millisecond granularity
    // (a same-ms tie would be an artifact, not a real ordering); both still
    // land inside the same wall-clock second — the case the fix targets.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Owner explicitly asked for the re-invite: the old removed row must not
    // block the new invite's join confirmation.
    const { invitePinId } = await inviteRemoteBot({
      taskId: h.task.id,
      inviteeGlobalMetaId: REMOTE_GMID,
      inviteeName: 'Remote Bot',
      allowReinvite: true,
    });
    h.membershipStore.updateInviteStatus({ invitePinId }, 'accepted');
    await waitFor(() => h.groupTaskStore.isMember(h.task.id, null, REMOTE_GMID));
    const invite = h.membershipStore.getInviteByPinId(invitePinId);
    assert.equal(invite.status, 'accepted');
    assert.equal(h.calls.ownerReport.length, 0);
  } finally {
    h.cleanup();
  }
});

test('resume: accepted + member row already present -> no watcher, no duplicate action', async () => {
  const h = await createHarness();
  try {
    // The join completed before the "restart": member row already recorded.
    h.groupTaskStore.addMember({
      taskId: h.task.id,
      metabotId: null,
      globalmetaid: REMOTE_GMID,
      displayName: 'Remote Bot',
      role: 'worker',
    });
    const invite = h.membershipStore.createInvite({
      taskId: h.task.id,
      groupId: GROUP_ID,
      inviteeGlobalmetaid: REMOTE_GMID,
      inviteeName: 'Remote Bot',
      invitePinId: `${'4'.repeat(64)}i0`,
    });
    h.membershipStore.updateInviteStatus({ invitePinId: invite.invitePinId }, 'accepted');

    const started = resumeOpenTeamInviteWatchers();
    assert.equal(started, 0, 'completed invites are not re-armed');

    // Give any (unexpectedly started) watcher several polls to act.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(h.calls.wait.length, 0, 'no join confirmation re-run');
    assert.equal(h.calls.ownerReport.length, 0, 'no owner alert');
    const members = h.groupTaskStore
      .listMembers(h.task.id)
      .filter((m) => m.metabotId == null && m.globalmetaid === REMOTE_GMID);
    assert.equal(members.length, 1, 'still exactly one remote member row');
    const after = h.membershipStore.getInviteByPinId(invite.invitePinId);
    assert.equal(after.status, 'accepted', 'invite row untouched');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// P1-5: fuzzy recall (bot full name + skill-description matching)
// ---------------------------------------------------------------------------

test('P1-5: tokenizeOpenTeamQuery splits separators and adds CJK bigrams', () => {
  const tokens = tokenizeOpenTeamQuery('占卜塔罗 fortune-teller');
  assert.ok(tokens.includes('占卜塔罗'), 'CJK run kept whole');
  assert.ok(tokens.includes('占卜') && tokens.includes('卜塔') && tokens.includes('塔罗'), 'CJK bigrams added');
  assert.ok(tokens.includes('fortune-teller'), 'ASCII token kept');
  assert.ok(!tokenizeOpenTeamQuery('  ').length, 'blank query yields no tokens');
});

test('P1-5: scoreOpenTeamCandidate weighs name > chatSkills > bio and misses at 0', () => {
  const item = {
    name: 'Fortune Teller Master',
    bio: 'Reads tarot cards and tells fortunes for the group',
    chatSkills: ['tarot', 'divination'],
  };
  const nameScore = scoreOpenTeamCandidate(item, tokenizeOpenTeamQuery('fortune'));
  const skillScore = scoreOpenTeamCandidate(item, tokenizeOpenTeamQuery('divination'));
  const bioScore = scoreOpenTeamCandidate(item, tokenizeOpenTeamQuery('tarot cards'));
  assert.ok(nameScore > skillScore, 'name hits outrank skill hits');
  assert.ok(skillScore > 0 && bioScore > 0);
  assert.equal(scoreOpenTeamCandidate(item, tokenizeOpenTeamQuery('quantum physics')), 0, 'no match -> excluded');
});

test('P1-5: fuzzy path recalls candidates the exact path missed (bio match)', async () => {
  const h = await createHarness({
    searchItems: [],
    searchItemsByCall: (params, callIndex) => {
      // Call 1 = exact path (keyword passed) -> nothing matches server-side.
      // Call 2 = fuzzy recall (no keyword) -> the full candidate page.
      return callIndex === 1 ? [] : [makeSearchItem(REMOTE_GMID, { name: 'FTM Bot', bio: '占卜塔罗牌大师', chatSkills: ['tarot'] })];
    },
    presenceMap: { [REMOTE_GMID]: { isOnline: true, ago: 7 } },
  });
  try {
    const candidates = await searchRemoteCandidates({ keyword: '占卜塔罗', limit: 10 });
    assert.ok(
      candidates.some((c) => c.globalMetaId === REMOTE_GMID),
      'bio-match candidate recalled by the fuzzy path (CJK bigram overlap)',
    );
    assert.equal(h.calls.search.length, 2, 'exact path + P1-5 fuzzy recall');
    assert.equal(h.calls.search[1].keyword, undefined, 'fuzzy recall drops the exact keyword');
    assert.equal(candidates[0].name, 'FTM Bot');
  } finally {
    h.cleanup();
  }
});
