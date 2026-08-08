import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { OpenTeamMembershipStore } = require('../dist-electron/main/openTeamMembershipStore.js');

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-openteam-store-'));

const openStores = async (tempDir) => {
  const store = await SqliteStore.create(tempDir);
  const openTeamStore = new OpenTeamMembershipStore(store.getDatabase(), store.getSaveFunction());
  return { store, openTeamStore, db: store.getDatabase() };
};

const getColumns = (db, tableName) => {
  const result = db.exec(`PRAGMA table_info(${tableName})`);
  return (result[0]?.values || []).map((row) => String(row[1]));
};

test('openteam tables are created on open', async () => {
  const tempDir = makeTempDir();
  const { store, db } = await openStores(tempDir);
  try {
    const membershipCols = getColumns(db, 'openteam_memberships');
    for (const col of ['id', 'group_id', 'metabot_id', 'globalmetaid', 'inviter_globalmetaid', 'task_title', 'invite_pin_id', 'joined_pin_id', 'status', 'created_at']) {
      assert.ok(membershipCols.includes(col), `openteam_memberships.${col} should exist`);
    }
    const inviteCols = getColumns(db, 'openteam_invites');
    for (const col of ['id', 'task_id', 'group_id', 'invitee_globalmetaid', 'invitee_name', 'invite_pin_id', 'status', 'decline_reason', 'created_at', 'responded_at']) {
      assert.ok(inviteCols.includes(col), `openteam_invites.${col} should exist`);
    }
  } finally {
    store.close();
  }
});

test('memberships: upsert inserts, re-upsert refreshes the same row', async () => {
  const tempDir = makeTempDir();
  const { store, openTeamStore, db } = await openStores(tempDir);
  try {
    const created = openTeamStore.upsertActiveMembership({
      groupId: 'group-ext-1',
      metabotId: 7,
      globalmetaid: 'gmid-bot-7',
      inviterGlobalmetaid: 'gmid-inviter',
      taskTitle: 'External Task',
      invitePinId: 'pin-invite-1',
      joinedPinId: 'pin-join-1',
    });
    assert.ok(created.id > 0);
    assert.equal(created.status, 'active');
    assert.equal(created.groupId, 'group-ext-1');
    assert.equal(created.metabotId, 7);
    assert.equal(created.globalmetaid, 'gmid-bot-7');
    assert.equal(created.inviterGlobalmetaid, 'gmid-inviter');
    assert.equal(created.taskTitle, 'External Task');
    assert.equal(created.invitePinId, 'pin-invite-1');
    assert.equal(created.joinedPinId, 'pin-join-1');
    assert.ok(created.createdAt);

    // Re-upsert on the UNIQUE(group_id, metabot_id) pair: same row, refreshed fields.
    const refreshed = openTeamStore.upsertActiveMembership({
      groupId: 'group-ext-1',
      metabotId: 7,
      joinedPinId: 'pin-join-2',
      taskTitle: 'External Task v2',
    });
    assert.equal(refreshed.id, created.id);
    assert.equal(refreshed.status, 'active');
    assert.equal(refreshed.joinedPinId, 'pin-join-2');
    assert.equal(refreshed.taskTitle, 'External Task v2');
    // Fields not provided by the second upsert keep their previous values.
    assert.equal(refreshed.globalmetaid, 'gmid-bot-7');
    assert.equal(refreshed.invitePinId, 'pin-invite-1');

    // UNIQUE(group_id, metabot_id) holds at the schema level too.
    assert.throws(() => {
      db.run(
        `INSERT INTO openteam_memberships (group_id, metabot_id) VALUES ('group-ext-1', 7)`,
      );
    }, /UNIQUE/);
  } finally {
    store.close();
  }
});

test('memberships: list/get/listActiveGroupIds and markLeft lifecycle', async () => {
  const tempDir = makeTempDir();
  const { store, openTeamStore } = await openStores(tempDir);
  try {
    openTeamStore.upsertActiveMembership({ groupId: 'group-ext-1', metabotId: 7 });
    openTeamStore.upsertActiveMembership({ groupId: 'group-ext-2', metabotId: 7 });
    openTeamStore.upsertActiveMembership({ groupId: 'group-ext-1', metabotId: 8 });

    assert.equal(openTeamStore.listActiveMemberships().length, 3);
    assert.deepEqual(
      openTeamStore.listActiveGroupIds().sort(),
      ['group-ext-1', 'group-ext-2'],
      'active group ids are distinct',
    );

    const membership = openTeamStore.getMembership('group-ext-1', 7);
    assert.ok(membership);
    assert.equal(membership.status, 'active');
    assert.equal(openTeamStore.getMembership('group-ext-9', 7), null);

    // markLeft flips status and drops the group from the active set.
    assert.equal(openTeamStore.markLeft('group-ext-2', 7), true);
    assert.equal(openTeamStore.getMembership('group-ext-2', 7)?.status, 'left');
    assert.deepEqual(openTeamStore.listActiveGroupIds(), ['group-ext-1']);
    assert.equal(openTeamStore.listActiveMemberships().length, 2);
    // Marking a missing membership is a no-op false.
    assert.equal(openTeamStore.markLeft('group-ext-9', 7), false);

    // A fresh invite reactivates the left membership in place.
    const reactivated = openTeamStore.upsertActiveMembership({
      groupId: 'group-ext-2', metabotId: 7, invitePinId: 'pin-invite-2',
    });
    assert.equal(reactivated.status, 'active');
    assert.equal(reactivated.invitePinId, 'pin-invite-2');
    assert.deepEqual(openTeamStore.listActiveGroupIds().sort(), ['group-ext-1', 'group-ext-2']);
  } finally {
    store.close();
  }
});

test('invites: create / pending listing / dedupe check', async () => {
  const tempDir = makeTempDir();
  const { store, openTeamStore } = await openStores(tempDir);
  try {
    const invite = openTeamStore.createInvite({
      taskId: 42,
      groupId: 'group-task-42',
      inviteeGlobalmetaid: 'gmid-invitee-1',
      inviteeName: 'Invitee One',
      invitePinId: 'pin-invite-1',
    });
    assert.ok(invite.id > 0);
    assert.equal(invite.status, 'pending');
    assert.equal(invite.taskId, 42);
    assert.equal(invite.groupId, 'group-task-42');
    assert.equal(invite.inviteeGlobalmetaid, 'gmid-invitee-1');
    assert.equal(invite.inviteeName, 'Invitee One');
    assert.equal(invite.invitePinId, 'pin-invite-1');
    assert.equal(invite.declineReason, null);
    assert.equal(invite.respondedAt, null);
    assert.ok(invite.createdAt);

    assert.equal(openTeamStore.listPendingInvites().length, 1);
    assert.ok(openTeamStore.hasPendingInvite(42, 'gmid-invitee-1'));
    assert.ok(!openTeamStore.hasPendingInvite(42, 'gmid-invitee-2'));
    assert.ok(!openTeamStore.hasPendingInvite(43, 'gmid-invitee-1'));

    assert.equal(openTeamStore.getInviteByPinId('pin-invite-1')?.id, invite.id);
    assert.equal(openTeamStore.getInviteByPinId('pin-nope'), null);
  } finally {
    store.close();
  }
});

test('invites: updateInviteStatus by pinId / by id, decline reason, responded_at', async () => {
  const tempDir = makeTempDir();
  const { store, openTeamStore } = await openStores(tempDir);
  try {
    const accepted = openTeamStore.createInvite({
      taskId: 42, groupId: 'group-task-42', inviteeGlobalmetaid: 'gmid-invitee-1', invitePinId: 'pin-invite-1',
    });
    const declined = openTeamStore.createInvite({
      taskId: 42, groupId: 'group-task-42', inviteeGlobalmetaid: 'gmid-invitee-2', invitePinId: 'pin-invite-2',
    });
    openTeamStore.createInvite({
      taskId: 42, groupId: 'group-task-42', inviteeGlobalmetaid: 'gmid-invitee-3', invitePinId: 'pin-invite-3',
    });

    // Accept via invitePinId (the inviteId carried by OpenTeam envelopes).
    const acceptedRow = openTeamStore.updateInviteStatus({ invitePinId: 'pin-invite-1' }, 'accepted');
    assert.equal(acceptedRow?.id, accepted.id);
    assert.equal(acceptedRow?.status, 'accepted');
    assert.ok(acceptedRow?.respondedAt, 'responded_at stamped on transition');
    assert.ok(!openTeamStore.hasPendingInvite(42, 'gmid-invitee-1'));

    // Decline via id, with a reason.
    const declinedRow = openTeamStore.updateInviteStatus({ id: declined.id }, 'declined', 'remote collaboration disabled');
    assert.equal(declinedRow?.status, 'declined');
    assert.equal(declinedRow?.declineReason, 'remote collaboration disabled');
    assert.ok(declinedRow?.respondedAt);

    // The third invite is still pending; resolved ones left the pending list.
    const pending = openTeamStore.listPendingInvites();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].inviteeGlobalmetaid, 'gmid-invitee-3');

    // Expiry path + unknown identity returns null without throwing.
    const expiredRow = openTeamStore.updateInviteStatus({ invitePinId: 'pin-invite-3' }, 'expired');
    assert.equal(expiredRow?.status, 'expired');
    assert.equal(openTeamStore.listPendingInvites().length, 0);
    assert.equal(openTeamStore.updateInviteStatus({ invitePinId: 'pin-nope' }, 'accepted'), null);
    assert.equal(openTeamStore.updateInviteStatus({}, 'accepted'), null);
  } finally {
    store.close();
  }
});
