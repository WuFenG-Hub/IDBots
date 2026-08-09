import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { GroupTaskStore } = require('../dist-electron/main/groupTaskStore.js');

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-group-task-remote-'));

const openStores = async (tempDir) => {
  const store = await SqliteStore.create(tempDir);
  const groupTaskStore = new GroupTaskStore(store.getDatabase(), store.getSaveFunction());
  return { store, groupTaskStore, db: store.getDatabase() };
};

const insertWallet = (db, id) => {
  db.run(
    `INSERT INTO metabot_wallets (id, mnemonic, path, created_at)
     VALUES (?, ?, ?, ?)`,
    [id, `abandon ability able about above absent absorb abstract absurd abuse access accident ${id}`, "m/44'/10001'/0'/0/0", 1700000000000 + id]
  );
};

const insertMetabot = (db, { id, walletId, name, type = 'worker', globalmetaid = null }) => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
      name, enabled, metaid, globalmetaid, metabot_type, created_by, role, soul,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, walletId, `mvc-${id}`, `btc-${id}`, `doge-${id}`, `public-${id}`, `chat-public-${id}`,
      name, 1, `metaid-${id}`, globalmetaid, type, '0000', `${name} role`, `${name} soul`,
      1700000000000 + id, 1700000000000 + id,
    ]
  );
};

const getColumns = (db, tableName) => {
  const result = db.exec(`PRAGMA table_info(${tableName})`);
  return (result[0]?.values || []).map((row) => String(row[1]));
};

const createTask = (groupTaskStore, groupId = 'group-remote') =>
  groupTaskStore.createTask({
    groupId, title: 'Remote Task', goal: 'Goal', chairMetabotId: 1, createdBy: 'user',
  });

test('group_task_members carries display_name / removed_at columns (idempotent migration)', async () => {
  const tempDir = makeTempDir();
  const { store, db } = await openStores(tempDir);
  try {
    const cols = getColumns(db, 'group_task_members');
    assert.ok(cols.includes('display_name'));
    assert.ok(cols.includes('removed_at'));
    // Re-opening the same database re-runs the migration guard without error.
    store.close();
    const reopened = await SqliteStore.create(tempDir);
    try {
      const colsAgain = getColumns(reopened.getDatabase(), 'group_task_members');
      assert.ok(colsAgain.includes('display_name'));
      assert.ok(colsAgain.includes('removed_at'));
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
  }
});

test('remote member: addMember does not throw and reads back by globalmetaid', async () => {
  const tempDir = makeTempDir();
  const { store, groupTaskStore } = await openStores(tempDir);
  try {
    const task = createTask(groupTaskStore);
    const member = groupTaskStore.addMember({
      taskId: task.id,
      metabotId: null,
      globalmetaid: 'gmid-remote-1',
      role: 'worker',
      joinedPinId: 'pin-join-remote',
      displayName: 'Remote Bot One',
    });
    assert.ok(member.id > 0);
    assert.equal(member.metabotId, null);
    assert.equal(member.globalmetaid, 'gmid-remote-1');
    assert.equal(member.role, 'worker');
    assert.equal(member.joinedPinId, 'pin-join-remote');
    assert.equal(member.displayName, 'Remote Bot One');
    assert.equal(member.removedAt, null);
    // No local metabots row: name falls back to the display_name snapshot.
    assert.equal(member.name, 'Remote Bot One');

    const members = groupTaskStore.listMembers(task.id);
    assert.equal(members.length, 1);
    assert.equal(members[0].globalmetaid, 'gmid-remote-1');
  } finally {
    store.close();
  }
});

test('remote member: duplicate addMember is idempotent (code-level dedupe on globalmetaid)', async () => {
  const tempDir = makeTempDir();
  const { store, groupTaskStore } = await openStores(tempDir);
  try {
    const task = createTask(groupTaskStore);
    const first = groupTaskStore.addMember({
      taskId: task.id, metabotId: null, globalmetaid: 'gmid-remote-1', role: 'worker', displayName: 'Remote Bot One',
    });
    const again = groupTaskStore.addMember({
      taskId: task.id, metabotId: null, globalmetaid: 'gmid-remote-1', role: 'worker', displayName: 'Remote Bot One',
    });
    assert.equal(again.id, first.id, 'dedupe returns the existing row');
    assert.equal(groupTaskStore.listMembers(task.id).length, 1);

    // Regression for the null === null dedupe bug: a DIFFERENT remote member
    // must not match the first one's row.
    const second = groupTaskStore.addMember({
      taskId: task.id, metabotId: null, globalmetaid: 'gmid-remote-2', role: 'worker', displayName: 'Remote Bot Two',
    });
    assert.notEqual(second.id, first.id);
    assert.equal(groupTaskStore.listMembers(task.id).length, 2);
  } finally {
    store.close();
  }
});

test('remote member: addMember without globalmetaid throws', async () => {
  const tempDir = makeTempDir();
  const { store, groupTaskStore } = await openStores(tempDir);
  try {
    const task = createTask(groupTaskStore);
    assert.throws(
      () => groupTaskStore.addMember({ taskId: task.id, metabotId: null, role: 'worker' }),
      /requires globalmetaid/,
    );
    assert.throws(
      () => groupTaskStore.addMember({ taskId: task.id, metabotId: null, globalmetaid: '   ', role: 'worker' }),
      /requires globalmetaid/,
    );
    assert.equal(groupTaskStore.listMembers(task.id).length, 0);
  } finally {
    store.close();
  }
});

test('remote member: isMember / updateMemberJoinedPinId by globalmetaid', async () => {
  const tempDir = makeTempDir();
  const { store, groupTaskStore } = await openStores(tempDir);
  try {
    const task = createTask(groupTaskStore);
    groupTaskStore.addMember({
      taskId: task.id, metabotId: null, globalmetaid: 'gmid-remote-1', role: 'worker',
    });

    assert.ok(groupTaskStore.isMember(task.id, null, 'gmid-remote-1'));
    assert.ok(!groupTaskStore.isMember(task.id, null, 'gmid-remote-2'));
    assert.ok(!groupTaskStore.isMember(task.id, null));
    assert.ok(!groupTaskStore.isMember(task.id, null, ''));

    groupTaskStore.updateMemberJoinedPinId(task.id, null, 'pin-remote-join', 'gmid-remote-1');
    assert.equal(groupTaskStore.listMembers(task.id)[0].joinedPinId, 'pin-remote-join');

    assert.throws(
      () => groupTaskStore.updateMemberJoinedPinId(task.id, null, 'pin-x'),
      /requires globalmetaid/,
    );
  } finally {
    store.close();
  }
});

test('removed_at: listMembers filters removed rows; re-invite inserts a fresh row', async () => {
  const tempDir = makeTempDir();
  const { store, groupTaskStore, db } = await openStores(tempDir);
  try {
    const task = createTask(groupTaskStore);
    const member = groupTaskStore.addMember({
      taskId: task.id, metabotId: null, globalmetaid: 'gmid-remote-1', role: 'worker', displayName: 'Remote Bot One',
    });
    // Simulate the M3 kick: mark the row removed directly.
    db.run('UPDATE group_task_members SET removed_at = datetime(\'now\') WHERE id = ?', [member.id]);

    // Default listing hides removed members; includeRemoved keeps the history.
    assert.equal(groupTaskStore.listMembers(task.id).length, 0);
    const withRemoved = groupTaskStore.listMembers(task.id, { includeRemoved: true });
    assert.equal(withRemoved.length, 1);
    assert.ok(withRemoved[0].removedAt);

    // A removed member no longer counts as a member on the remote path.
    assert.ok(!groupTaskStore.isMember(task.id, null, 'gmid-remote-1'));

    // Re-invite after removal creates a fresh active row (UNIQUE does not cover NULL metabot_id).
    const rejoined = groupTaskStore.addMember({
      taskId: task.id, metabotId: null, globalmetaid: 'gmid-remote-1', role: 'worker', displayName: 'Remote Bot One',
    });
    assert.notEqual(rejoined.id, member.id);
    assert.equal(rejoined.removedAt, null);
    assert.equal(groupTaskStore.listMembers(task.id).length, 1);
    assert.equal(groupTaskStore.listMembers(task.id, { includeRemoved: true }).length, 2);
    assert.ok(groupTaskStore.isMember(task.id, null, 'gmid-remote-1'));
  } finally {
    store.close();
  }
});

test('local member regression: addMember idempotent, isMember, name from metabots table', async () => {
  const tempDir = makeTempDir();
  const { store, groupTaskStore, db } = await openStores(tempDir);
  try {
    insertWallet(db, 1);
    insertMetabot(db, { id: 1, walletId: 1, name: 'Twin Bot', type: 'twin', globalmetaid: 'gmid-twin' });
    insertMetabot(db, { id: 2, walletId: 1, name: 'Worker Bot', type: 'worker', globalmetaid: 'gmid-worker' });

    const task = createTask(groupTaskStore);
    const chair = groupTaskStore.addMember({
      taskId: task.id, metabotId: 1, globalmetaid: 'gmid-twin', role: 'chair', joinedPinId: 'pin-create',
    });
    const worker = groupTaskStore.addMember({ taskId: task.id, metabotId: 2, role: 'worker' });
    // Adding the same local member again returns the existing row (no-op).
    const workerAgain = groupTaskStore.addMember({ taskId: task.id, metabotId: 2, role: 'worker' });
    assert.equal(workerAgain.id, worker.id);
    assert.equal(groupTaskStore.listMembers(task.id).length, 2);

    // Local members still get the metabots-table name and the globalmetaid fallback.
    assert.equal(chair.name, 'Twin Bot');
    assert.equal(chair.displayName, null);
    assert.equal(worker.name, 'Worker Bot');
    assert.equal(worker.globalmetaid, 'gmid-worker');

    assert.ok(groupTaskStore.isMember(task.id, 2));
    assert.ok(!groupTaskStore.isMember(task.id, 99));

    // Local and remote members coexist in one task.
    groupTaskStore.addMember({
      taskId: task.id, metabotId: null, globalmetaid: 'gmid-remote-1', role: 'worker', displayName: 'Remote Bot One',
    });
    const members = groupTaskStore.listMembers(task.id);
    assert.equal(members.length, 3);
    assert.equal(members.find((m) => m.metabotId === null)?.name, 'Remote Bot One');

    // metabot_id path of updateMemberJoinedPinId unchanged.
    groupTaskStore.updateMemberJoinedPinId(task.id, 2, 'pin-join-2');
    assert.equal(
      groupTaskStore.listMembers(task.id).find((m) => m.metabotId === 2)?.joinedPinId,
      'pin-join-2',
    );
  } finally {
    store.close();
  }
});


test('hasRemovedMember: removed-row check with the optional not-before cutoff', async () => {
  const tempDir = makeTempDir();
  const { store, groupTaskStore, db } = await openStores(tempDir);
  try {
    const task = createTask(groupTaskStore);
    groupTaskStore.addMember({
      taskId: task.id, metabotId: null, globalmetaid: 'gmid-remote-1', role: 'worker', displayName: 'Remote Bot One',
    });
    // An ACTIVE member row is not a removed row.
    assert.equal(groupTaskStore.hasRemovedMember(task.id, 'gmid-remote-1'), false);

    groupTaskStore.markMemberRemoved({ taskId: task.id, globalmetaid: 'gmid-remote-1', removePinId: 'pin-rm' });
    assert.equal(groupTaskStore.hasRemovedMember(task.id, 'gmid-remote-1'), true);
    assert.equal(groupTaskStore.hasRemovedMember(task.id, 'gmid-remote-2'), false, 'other invitees unaffected');
    assert.equal(groupTaskStore.hasRemovedMember(task.id, ''), false, 'blank id never matches');
    assert.equal(groupTaskStore.hasRemovedMember(999, 'gmid-remote-1'), false, 'other tasks unaffected');

    // notBeforeMs cutoff: the kick counts only at/after the given moment.
    assert.equal(
      groupTaskStore.hasRemovedMember(task.id, 'gmid-remote-1', Date.now() - 60_000),
      true,
      'kick after the cutoff counts',
    );
    assert.equal(
      groupTaskStore.hasRemovedMember(task.id, 'gmid-remote-1', Date.now() + 60_000),
      false,
      'kick before the cutoff belongs to an earlier membership',
    );
    // A backdated removed row (kick clearly before a later invite) fails the cutoff.
    db.run(
      `UPDATE group_task_members SET removed_at = datetime('now', '-10 seconds')
       WHERE task_id = ? AND globalmetaid = ?`,
      [task.id, 'gmid-remote-1'],
    );
    assert.equal(groupTaskStore.hasRemovedMember(task.id, 'gmid-remote-1'), true, 'blanket check ignores timing');
    assert.equal(groupTaskStore.hasRemovedMember(task.id, 'gmid-remote-1', Date.now()), false);
  } finally {
    store.close();
  }
});


test('local member re-join after kick: addMember revives the removed row in place (M3)', async () => {
  const tempDir = makeTempDir();
  const { store, groupTaskStore, db } = await openStores(tempDir);
  try {
    insertWallet(db, 1);
    insertMetabot(db, { id: 1, walletId: 1, name: 'Twin Bot', type: 'twin', globalmetaid: 'gmid-twin' });
    insertMetabot(db, { id: 2, walletId: 1, name: 'Worker Bot', type: 'worker', globalmetaid: 'gmid-worker' });

    const task = createTask(groupTaskStore);
    groupTaskStore.addMember({ taskId: task.id, metabotId: 1, role: 'chair', joinedPinId: 'pin-create' });
    const worker = groupTaskStore.addMember({ taskId: task.id, metabotId: 2, role: 'worker', joinedPinId: 'pin-join-2' });

    // Kick (M3): the row is kept and marked removed.
    const removed = groupTaskStore.markMemberRemoved({ taskId: task.id, metabotId: 2, removePinId: 'pin-remove-2' });
    assert.ok(removed.removedAt);
    assert.equal(removed.removePinId, 'pin-remove-2');
    assert.ok(!groupTaskStore.isMember(task.id, 2));

    // UNIQUE(task_id, metabot_id) forbids a fresh row: re-adding revives in place.
    const revived = groupTaskStore.addMember({ taskId: task.id, metabotId: 2, role: 'worker', joinedPinId: 'pin-rejoin-2' });
    assert.equal(revived.id, worker.id, 'the removed row itself is revived');
    assert.equal(revived.removedAt, null);
    assert.equal(revived.removePinId, null);
    assert.equal(revived.joinedPinId, 'pin-rejoin-2', 'the new join pin replaces the old one');
    assert.equal(groupTaskStore.listMembers(task.id, { includeRemoved: true }).length, 2, 'no duplicate row');
    assert.ok(groupTaskStore.isMember(task.id, 2));

    // A revive without a new join pin keeps the previous joined_pin_id.
    groupTaskStore.markMemberRemoved({ taskId: task.id, metabotId: 2 });
    const revivedAgain = groupTaskStore.addMember({ taskId: task.id, metabotId: 2, role: 'worker' });
    assert.equal(revivedAgain.id, worker.id);
    assert.equal(revivedAgain.removedAt, null);
    assert.equal(revivedAgain.joinedPinId, 'pin-rejoin-2', 'previous join pin preserved when none provided');
  } finally {
    store.close();
  }
});
