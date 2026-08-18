import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { MetabotStore } = require('../dist-electron/main/metabotStore.js');
const { GroupTaskStore, setGroupTaskStoreStatusBroadcaster } = require('../dist-electron/main/groupTaskStore.js');

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-group-task-store-'));

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

const getIndexNames = (db, tableName) => {
  const result = db.exec(`PRAGMA index_list(${tableName})`);
  return (result[0]?.values || []).map((row) => String(row[1]));
};

test('group task tables and index are created on open', async () => {
  const tempDir = makeTempDir();
  const { store, db } = await openStores(tempDir);
  try {
    for (const table of ['group_tasks', 'group_task_members', 'group_task_deliverables']) {
      const cols = getColumns(db, table);
      assert.ok(cols.includes('id'), `${table} should exist with an id column`);
    }
    assert.ok(getColumns(db, 'group_tasks').includes('group_id'));
    assert.ok(getColumns(db, 'group_tasks').includes('orchestration_task_id'));
    assert.ok(
      getIndexNames(db, 'group_tasks').includes('idx_group_tasks_orchestration_task'),
      'idx_group_tasks_orchestration_task should exist',
    );
    assert.ok(getColumns(db, 'group_task_members').includes('joined_pin_id'));
    assert.ok(getColumns(db, 'group_task_deliverables').includes('msg_pin_id'));
    assert.ok(
      getIndexNames(db, 'group_chat_messages').includes('idx_group_chat_messages_group_id'),
      'idx_group_chat_messages_group_id should exist',
    );
    assert.ok(getColumns(db, 'group_chat_messages').includes('msg_index'));
  } finally {
    store.close();
  }
});

test('createTask / getTaskById / getTaskByGroupId / listTasks with status filter', async () => {
  const tempDir = makeTempDir();
  const { store, groupTaskStore } = await openStores(tempDir);
  try {
    const created = groupTaskStore.createTask({
      groupId: 'group-aaa',
      title: 'Task A',
      goal: 'Goal A',
      acceptanceCriteria: 'Criteria A',
      chairMetabotId: 1,
      createdBy: 'user',
      createPinId: 'pin-aaa',
    });
    assert.ok(created.id > 0);
    assert.equal(created.status, 'planning');
    assert.equal(created.groupId, 'group-aaa');
    assert.equal(created.acceptanceCriteria, 'Criteria A');
    assert.equal(created.createPinId, 'pin-aaa');
    assert.equal(created.lastProcessedMsgId, 0);
    assert.equal(created.orchestrationTaskId, null);

    const linked = groupTaskStore.linkOrchestrationTask(created.id, 'orchestration-aaa');
    assert.equal(linked.orchestrationTaskId, 'orchestration-aaa');
    assert.equal(
      groupTaskStore.linkOrchestrationTask(created.id, 'orchestration-aaa').orchestrationTaskId,
      'orchestration-aaa',
      'linking the same canonical task is idempotent',
    );
    assert.throws(
      () => groupTaskStore.linkOrchestrationTask(created.id, 'orchestration-other'),
      /already linked/,
    );

    const byId = groupTaskStore.getTaskById(created.id);
    assert.equal(byId?.title, 'Task A');
    const byGroup = groupTaskStore.getTaskByGroupId('group-aaa');
    assert.equal(byGroup?.id, created.id);
    assert.equal(groupTaskStore.getTaskByGroupId('nope'), null);

    groupTaskStore.createTask({
      groupId: 'group-bbb', title: 'Task B', goal: 'Goal B', chairMetabotId: 1, createdBy: 'twinbot',
    });
    assert.equal(groupTaskStore.listTasks().length, 2);
    const planningOnly = groupTaskStore.listTasks({ status: 'planning' });
    assert.equal(planningOnly.length, 2);
    assert.equal(groupTaskStore.listTasks({ status: 'done' }).length, 0);
  } finally {
    store.close();
  }
});

test('state machine: legal transitions, illegal transitions throw, terminal lock, closed_at', async () => {
  const tempDir = makeTempDir();
  const { store, groupTaskStore } = await openStores(tempDir);
  try {
    const task = groupTaskStore.createTask({
      groupId: 'group-sm', title: 'SM', goal: 'Goal', chairMetabotId: 1, createdBy: 'user',
    });

    // planning -> review is illegal (chair flow must go through executing)
    assert.throws(() => groupTaskStore.updateTaskStatus(task.id, 'review'), /Illegal/);
    // planning -> executing -> review -> done is legal
    assert.equal(groupTaskStore.updateTaskStatus(task.id, 'executing').status, 'executing');
    // executing -> planning is illegal
    assert.throws(() => groupTaskStore.updateTaskStatus(task.id, 'planning'), /Illegal/);
    assert.equal(groupTaskStore.updateTaskStatus(task.id, 'review').status, 'review');
    // review -> executing is the legal rework hatch
    assert.equal(groupTaskStore.updateTaskStatus(task.id, 'executing').status, 'executing');
    assert.equal(groupTaskStore.updateTaskStatus(task.id, 'review').status, 'review');
    const done = groupTaskStore.updateTaskStatus(task.id, 'done');
    assert.equal(done.status, 'done');
    assert.ok(done.closedAt, 'closed_at should be set when entering terminal state');
    // terminal lock: done -> cancelled is illegal
    assert.throws(() => groupTaskStore.updateTaskStatus(task.id, 'cancelled'), /Illegal/);
    assert.throws(() => groupTaskStore.updateTaskStatus(task.id, 'executing'), /Illegal/);

    // owner acceptance may shortcut: planning -> done and executing -> done are legal
    const taskShortcut1 = groupTaskStore.createTask({
      groupId: 'group-sm4', title: 'SM4', goal: 'Goal', chairMetabotId: 1, createdBy: 'user',
    });
    assert.equal(groupTaskStore.updateTaskStatus(taskShortcut1.id, 'done').status, 'done');
    const taskShortcut2 = groupTaskStore.createTask({
      groupId: 'group-sm5', title: 'SM5', goal: 'Goal', chairMetabotId: 1, createdBy: 'user',
    });
    groupTaskStore.updateTaskStatus(taskShortcut2.id, 'executing');
    assert.equal(groupTaskStore.updateTaskStatus(taskShortcut2.id, 'done').status, 'done');

    // -> cancelled from any non-terminal state
    const task2 = groupTaskStore.createTask({
      groupId: 'group-sm2', title: 'SM2', goal: 'Goal', chairMetabotId: 1, createdBy: 'user',
    });
    assert.equal(groupTaskStore.updateTaskStatus(task2.id, 'cancelled').status, 'cancelled');
    const task3 = groupTaskStore.createTask({
      groupId: 'group-sm3', title: 'SM3', goal: 'Goal', chairMetabotId: 1, createdBy: 'user',
    });
    groupTaskStore.updateTaskStatus(task3.id, 'executing');
    assert.equal(groupTaskStore.updateTaskStatus(task3.id, 'cancelled').status, 'cancelled');

    // updating a missing task throws
    assert.throws(() => groupTaskStore.updateTaskStatus(9999, 'executing'), /not found/);
  } finally {
    store.close();
  }
});

test('status broadcast: real transitions emit once, no-op/illegal stay silent, emitter failure is safe', async () => {
  const tempDir = makeTempDir();
  const { store, groupTaskStore } = await openStores(tempDir);
  const events = [];
  setGroupTaskStoreStatusBroadcaster((event) => events.push(event));
  try {
    const task = groupTaskStore.createTask({
      groupId: 'group-broadcast', title: 'Broadcast', goal: 'Goal', chairMetabotId: 1, createdBy: 'user',
    });

    groupTaskStore.updateTaskStatus(task.id, 'executing');
    groupTaskStore.updateTaskStatus(task.id, 'executing'); // no-op: same status returns early
    assert.throws(() => groupTaskStore.updateTaskStatus(task.id, 'planning'), /Illegal/);
    groupTaskStore.updateTaskStatus(task.id, 'review');

    assert.deepEqual(
      events.map((event) => [event.taskId, event.status]),
      [[task.id, 'planning'], [task.id, 'executing'], [task.id, 'review']],
    );
    assert.ok(events.every((event) => event.type === 'groupTask:statusChanged' && typeof event.at === 'number'));

    // A throwing broadcaster must never break the transition itself.
    setGroupTaskStoreStatusBroadcaster(() => { throw new Error('boom'); });
    assert.equal(groupTaskStore.updateTaskStatus(task.id, 'done').status, 'done');
  } finally {
    setGroupTaskStoreStatusBroadcaster(null);
    store.close();
  }
});

test('members: UNIQUE(task_id, metabot_id), addMember idempotent, join listing fields', async () => {
  const tempDir = makeTempDir();
  const { store, groupTaskStore, db } = await openStores(tempDir);
  try {
    insertWallet(db, 1);
    insertMetabot(db, { id: 1, walletId: 1, name: 'Twin Bot', type: 'twin', globalmetaid: 'gmid-twin' });
    insertMetabot(db, { id: 2, walletId: 1, name: 'Worker Bot', type: 'worker', globalmetaid: 'gmid-worker' });

    const task = groupTaskStore.createTask({
      groupId: 'group-mem', title: 'Mem', goal: 'Goal', chairMetabotId: 1, createdBy: 'user',
    });

    groupTaskStore.addMember({ taskId: task.id, metabotId: 1, globalmetaid: 'gmid-twin', role: 'chair', joinedPinId: 'pin-create' });
    groupTaskStore.addMember({ taskId: task.id, metabotId: 2, role: 'worker' });
    // addMember is INSERT OR IGNORE + reselect: adding the same pair again is a no-op
    groupTaskStore.addMember({ taskId: task.id, metabotId: 2, role: 'worker' });
    // raw duplicate INSERT violates UNIQUE(task_id, metabot_id)
    assert.throws(() => {
      db.run('INSERT INTO group_task_members (task_id, metabot_id, role) VALUES (?, ?, ?)', [task.id, 2, 'worker']);
    }, /UNIQUE/);

    const members = groupTaskStore.listMembers(task.id);
    assert.equal(members.length, 2);
    const chair = members.find((m) => m.role === 'chair');
    const worker = members.find((m) => m.role === 'worker');
    assert.equal(chair?.name, 'Twin Bot');
    assert.equal(chair?.globalmetaid, 'gmid-twin');
    assert.equal(chair?.joinedPinId, 'pin-create');
    assert.equal(worker?.name, 'Worker Bot');
    // member row globalmetaid was NULL: falls back to the metabots table
    assert.equal(worker?.globalmetaid, 'gmid-worker');
    assert.equal(worker?.joinedPinId, null);

    assert.ok(groupTaskStore.isMember(task.id, 2));
    assert.ok(!groupTaskStore.isMember(task.id, 99));

    groupTaskStore.updateMemberJoinedPinId(task.id, 2, 'pin-join-2');
    assert.equal(
      groupTaskStore.listMembers(task.id).find((m) => m.metabotId === 2)?.joinedPinId,
      'pin-join-2',
    );
  } finally {
    store.close();
  }
});

test('getActiveGroupIds returns only non-terminal tasks with a group_id', async () => {
  const tempDir = makeTempDir();
  const { store, groupTaskStore } = await openStores(tempDir);
  try {
    const planning = groupTaskStore.createTask({
      groupId: 'group-active-1', title: 'A', goal: 'G', chairMetabotId: 1, createdBy: 'user',
    });
    const executing = groupTaskStore.createTask({
      groupId: 'group-active-2', title: 'B', goal: 'G', chairMetabotId: 1, createdBy: 'user',
    });
    const review = groupTaskStore.createTask({
      groupId: 'group-active-3', title: 'C', goal: 'G', chairMetabotId: 1, createdBy: 'user',
    });
    const done = groupTaskStore.createTask({
      groupId: 'group-inactive-1', title: 'D', goal: 'G', chairMetabotId: 1, createdBy: 'user',
    });
    const cancelled = groupTaskStore.createTask({
      groupId: 'group-inactive-2', title: 'E', goal: 'G', chairMetabotId: 1, createdBy: 'user',
    });
    groupTaskStore.updateTaskStatus(executing.id, 'executing');
    groupTaskStore.updateTaskStatus(review.id, 'executing');
    groupTaskStore.updateTaskStatus(review.id, 'review');
    groupTaskStore.updateTaskStatus(done.id, 'executing');
    groupTaskStore.updateTaskStatus(done.id, 'review');
    groupTaskStore.updateTaskStatus(done.id, 'done');
    groupTaskStore.updateTaskStatus(cancelled.id, 'cancelled');
    assert.ok(planning.id > 0);

    const ids = groupTaskStore.getActiveGroupIds();
    assert.deepEqual(ids.sort(), ['group-active-1', 'group-active-2', 'group-active-3']);
  } finally {
    store.close();
  }
});

test('deliverables CRUD', async () => {
  const tempDir = makeTempDir();
  const { store, groupTaskStore } = await openStores(tempDir);
  try {
    const task = groupTaskStore.createTask({
      groupId: 'group-del', title: 'Del', goal: 'G', chairMetabotId: 1, createdBy: 'user',
    });
    const d = groupTaskStore.addDeliverable({
      taskId: task.id,
      msgPinId: 'pin-msg-1',
      authorGlobalmetaid: 'gmid-worker',
      kind: 'metaapp',
      uri: 'metaapp://pin-xyz',
    });
    assert.ok(d.id > 0);
    assert.equal(d.status, 'pending');

    const list = groupTaskStore.listDeliverables(task.id);
    assert.equal(list.length, 1);
    assert.equal(list[0].uri, 'metaapp://pin-xyz');

    groupTaskStore.updateDeliverableStatus(d.id, 'accepted');
    assert.equal(groupTaskStore.listDeliverables(task.id)[0].status, 'accepted');
  } finally {
    store.close();
  }
});

test('listGroupChatMessages: ordering, paging with beforeId, column set', async () => {
  const tempDir = makeTempDir();
  const { store, groupTaskStore, db } = await openStores(tempDir);
  try {
    const insertMsg = (pinId, groupId, senderName, content, msgIndex) => {
      db.run(
        `INSERT INTO group_chat_messages (
          pin_id, tx_id, group_id, channel_id, sender_metaid, sender_global_metaid, sender_address,
          sender_name, sender_avatar, sender_chat_pubkey, protocol, content, content_type, encryption,
          reply_pin, mention, chain_timestamp, chain, raw_data, is_processed, msg_index
        ) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, 'ava', '', '/protocols/simplegroupchat', ?, 'text/plain', NULL, 'pin-parent', '[]', 1785000000000, 'mvc', '{}', 0, ?)`,
        [pinId, pinId.replace(/-i0$/, ''), groupId, `metaid-${senderName}`, `gmid-${senderName}`, senderName, content, msgIndex],
      );
    };
    for (let i = 1; i <= 5; i++) {
      insertMsg(`m${i}-i0`, 'g1', `Bot${i}`, `content-${i}`, i);
    }
    insertMsg('other-i0', 'g2', 'Other', 'other group', 1);

    // default page: all g1 rows ascending, other groups excluded
    const all = groupTaskStore.listGroupChatMessages('g1');
    assert.equal(all.length, 5);
    assert.deepEqual(all.map((m) => m.content), ['content-1', 'content-2', 'content-3', 'content-4', 'content-5']);
    assert.ok(all.every((m) => m.id > 0 && m.pinId && m.senderName && m.chainTimestamp === 1785000000000));

    // column set (camelCase transcript shape)
    const keys = Object.keys(all[0]).sort();
    assert.deepEqual(keys, [
      'chainTimestamp', 'content', 'contentType', 'id', 'msgIndex',
      'pinId', 'replyPin', 'senderAvatar', 'senderGlobalMetaId', 'senderName',
      'senderSuspect', 'txId',
    ]);
    assert.equal(all[0].senderSuspect, false);
    assert.equal(all[0].msgIndex, 1);
    assert.equal(all[0].replyPin, 'pin-parent');
    assert.equal(all[0].senderAvatar, 'ava');
    assert.equal(all[0].txId, 'm1');

    // limit: the LATEST page (chat semantics), still ascending
    const lastTwo = groupTaskStore.listGroupChatMessages('g1', { limit: 2 });
    assert.deepEqual(lastTwo.map((m) => m.content), ['content-4', 'content-5']);

    // beforeId: the page immediately older than m4, still ascending
    const m4Id = all[3].id;
    const before = groupTaskStore.listGroupChatMessages('g1', { beforeId: m4Id, limit: 2 });
    assert.deepEqual(before.map((m) => m.content), ['content-2', 'content-3']);

    // beforeId beyond the oldest row: empty
    const m1Id = all[0].id;
    assert.deepEqual(groupTaskStore.listGroupChatMessages('g1', { beforeId: m1Id }), []);
  } finally {
    store.close();
  }
});

test('buildMetabotDirectory: sanitized roster with profiles, disabled bots included', async () => {
  const tempDir = makeTempDir();
  const { store, db } = await openStores(tempDir);
  try {
    const { buildMetabotDirectory } = require('../dist-electron/main/services/metabotDirectoryService.js');
    insertWallet(db, 1);
    db.run(
      `INSERT INTO metabots (
        id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
        name, enabled, metaid, globalmetaid, metabot_type, created_by, role, soul, bio, goal,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [1, 1, 'mvc-1', 'btc-1', 'doge-1', 'pub-1', 'chat-1', 'Twin Bot', 1, 'metaid-1', 'gmid-twin',
        'twin', '0000', '  Coordinator  ', 'soul-1', '  Chief of staff  ', ' Ship things ', 1, 1],
    );
    db.run(
      `INSERT INTO metabots (
        id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
        name, enabled, metaid, globalmetaid, metabot_type, created_by, role, soul, bio, goal,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [2, 1, 'mvc-2', 'btc-2', 'doge-2', 'pub-2', 'chat-2', 'Old Bot', 0, 'metaid-2', null,
        'worker', '0000', '   ', 'soul-2', null, null, 2, 2],
    );

    const metabotStore = new MetabotStore(db, store.getSaveFunction());
    const directory = buildMetabotDirectory(metabotStore);
    assert.equal(directory.length, 2);

    const twin = directory.find((entry) => entry.id === 1);
    assert.deepEqual(twin, {
      id: 1,
      name: 'Twin Bot',
      bio: 'Chief of staff',
      role: 'Coordinator',
      goal: 'Ship things',
      metabot_type: 'twin',
      enabled: true,
      globalmetaid: 'gmid-twin',
    });

    const old = directory.find((entry) => entry.id === 2);
    assert.equal(old.enabled, false, 'disabled bots included with enabled:false');
    assert.equal(old.role, null, 'whitespace-only role becomes null');
    assert.equal(old.bio, null);
    assert.equal(old.goal, null);
    assert.equal(old.globalmetaid, null);
  } finally {
    store.close();
  }
});

test('P0-2: member state machine — default statuses, setMemberStatus, listMembersWithStatus', async () => {
  const tempDir = makeTempDir();
  const { store, db, groupTaskStore } = await openStores(tempDir);
  try {
    const task = groupTaskStore.createTask({
      groupId: 'group-p02', title: 'P0-2', goal: 'member states',
      chairMetabotId: 1, createdBy: 'user',
    });
    const chair = groupTaskStore.addMember({ taskId: task.id, metabotId: 1, role: 'chair' });
    const worker = groupTaskStore.addMember({ taskId: task.id, metabotId: 2, role: 'worker' });

    // Default statuses: chair working, worker assigned.
    assert.equal(chair.status, 'working');
    assert.equal(worker.status, 'assigned');

    // Member can set own status (worker -> working).
    const updated = groupTaskStore.setMemberStatus(task.id, 2, 'working');
    assert.equal(updated.status, 'working');
    assert.ok(updated.statusChangedAt);

    // listMembersWithStatus filters.
    assert.deepEqual(
      groupTaskStore.listMembersWithStatus(task.id, ['working']).map((m) => m.metabotId).sort(),
      [1, 2],
    );

    // chair can mark unreachable.
    const unreachable = groupTaskStore.setMemberStatus(task.id, 2, 'unreachable');
    assert.equal(unreachable.status, 'unreachable');

    // remote member by globalmetaid.
    const remote = groupTaskStore.addMember({ taskId: task.id, metabotId: null, globalmetaid: 'gmid-remote', role: 'worker', displayName: 'Remote Bot' });
    const remoteUpdated = groupTaskStore.setMemberStatus(task.id, null, 'standby', 'gmid-remote');
    assert.equal(remoteUpdated.status, 'standby');
    assert.equal(remote.id, remoteUpdated.id);
  } finally {
    store.close();
  }
});

test('P0-2: migration adds status columns on existing databases', async () => {
  const tempDir = makeTempDir();
  const { store, db } = await openStores(tempDir);
  try {
    const cols = getColumns(db, 'group_task_members');
    assert.ok(cols.includes('status'), 'group_task_members.status should exist');
    assert.ok(cols.includes('status_changed_at'), 'group_task_members.status_changed_at should exist');
  } finally {
    store.close();
  }
});

test('P0-4: deliverable verification column + updateDeliverableVerification', async () => {
  const tempDir = makeTempDir();
  const { store, db, groupTaskStore } = await openStores(tempDir);
  try {
    assert.ok(getColumns(db, 'group_task_deliverables').includes('verification'));
    const task = groupTaskStore.createTask({
      groupId: 'group-p04', title: 'P0-4', goal: 'verify', chairMetabotId: 1, createdBy: 'user',
    });
    const deliverable = groupTaskStore.addDeliverable({
      taskId: task.id,
      kind: 'metaapp',
      uri: 'metaapp://ab'.repeat(32) + 'i0',
      authorGlobalmetaid: 'gmid-x',
    });
    groupTaskStore.updateDeliverableVerification(deliverable.id, JSON.stringify({ verified: true }));
    const updated = groupTaskStore.listDeliverables(task.id)[0];
    assert.equal(updated.verification, JSON.stringify({ verified: true }));
  } finally {
    store.close();
  }
});

test('Issue #8: deliverable confirmation column — default unconfirmed, chain-driven flip, orthogonal to status', async () => {
  const tempDir = makeTempDir();
  const { store, db, groupTaskStore } = await openStores(tempDir);
  try {
    assert.ok(getColumns(db, 'group_task_deliverables').includes('confirmation'));
    const task = groupTaskStore.createTask({
      groupId: 'group-i8', title: 'Issue #8', goal: 'ledger', chairMetabotId: 1, createdBy: 'user',
    });
    const deliverable = groupTaskStore.addDeliverable({
      taskId: task.id,
      kind: 'metaapp',
      uri: 'metaapp://ab'.repeat(32) + 'i0',
      authorGlobalmetaid: 'gmid-x',
    });
    // A fresh row defaults to 'unconfirmed' regardless of the column default
    // being relied on.
    assert.equal(deliverable.confirmation, 'unconfirmed');
    assert.equal(groupTaskStore.listDeliverables(task.id)[0].confirmation, 'unconfirmed');

    // The daemon's verification pass flips it (chain-confirmation-driven path).
    groupTaskStore.updateDeliverableConfirmation(deliverable.id, 'confirmed');
    assert.equal(groupTaskStore.listDeliverables(task.id)[0].confirmation, 'confirmed');

    // Confirmation is ORTHOGONAL to acceptance status: flipping the status to
    // accepted must not erase the on-chain confirmation, and vice versa.
    groupTaskStore.updateDeliverableStatus(deliverable.id, 'accepted');
    const accepted = groupTaskStore.listDeliverables(task.id)[0];
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.confirmation, 'confirmed');

    // Revert to unconfirmed (e.g. verification later failed) keeps status.
    groupTaskStore.updateDeliverableConfirmation(deliverable.id, 'unconfirmed');
    const reverted = groupTaskStore.listDeliverables(task.id)[0];
    assert.equal(reverted.status, 'accepted');
    assert.equal(reverted.confirmation, 'unconfirmed');
  } finally {
    store.close();
  }
});

test('P0-5: transition log table + updateTaskStatusWithLog records who/from/to/reason', async () => {
  const tempDir = makeTempDir();
  const { store, db, groupTaskStore } = await openStores(tempDir);
  try {
    const cols = getColumns(db, 'group_task_transitions');
    assert.ok(cols.includes('task_id') && cols.includes('from_status') && cols.includes('to_status'));
    const task = groupTaskStore.createTask({
      groupId: 'group-p05', title: 'P0-5', goal: 'transitions', chairMetabotId: 1, createdBy: 'user',
    });
    groupTaskStore.updateTaskStatusWithLog(task.id, 'executing', { actor: 'metabot:1', reason: 'kickoff' });
    groupTaskStore.updateTaskStatusWithLog(task.id, 'review', { actor: 'Twin Bot', reason: '[STATUS:REVIEW] tag' });
    groupTaskStore.updateTaskStatusWithLog(task.id, 'executing', { actor: 'Twin Bot', reason: 'rework requested' });

    const transitions = groupTaskStore.listTaskTransitions(task.id);
    assert.equal(transitions.length, 3);
    assert.deepEqual(
      transitions.map((t) => [t.fromStatus, t.toStatus, t.actor]),
      [
        ['planning', 'executing', 'metabot:1'],
        ['executing', 'review', 'Twin Bot'],
        ['review', 'executing', 'Twin Bot'],
      ],
    );
    assert.equal(transitions[2].reason, 'rework requested');
  } finally {
    store.close();
  }
});

test('P0-8: integrity events table + add/list/dedupe-by-pin', async () => {
  const tempDir = makeTempDir();
  const { store, db, groupTaskStore } = await openStores(tempDir);
  try {
    assert.ok(getColumns(db, 'group_task_integrity_events').includes('event_type'));
    const task = groupTaskStore.createTask({
      groupId: 'group-p08', title: 'P0-8', goal: 'integrity', chairMetabotId: 1, createdBy: 'user',
    });
    const event = groupTaskStore.addIntegrityEvent({
      taskId: task.id,
      msgPinId: 'pin-correction',
      authorGlobalmetaid: 'gmid-w',
      eventType: 'correction',
      detail: 'corrected the link',
    });
    assert.equal(event.eventType, 'correction');
    assert.equal(groupTaskStore.hasIntegrityEventWithMsgPin(task.id, 'pin-correction'), true);
    assert.equal(groupTaskStore.listIntegrityEvents(task.id).length, 1);
    groupTaskStore.addIntegrityEvent({
      taskId: task.id,
      msgPinId: 'pin-report',
      authorGlobalmetaid: 'gmid-w',
      eventType: 'honest_report',
      detail: 'honest failure',
    });
    assert.equal(groupTaskStore.listIntegrityEvents(task.id).length, 2);
  } finally {
    store.close();
  }
});

test('listDeliverables joins the producing message body for folded text display', async () => {
  const tempDir = makeTempDir();
  const { store, groupTaskStore, db } = await openStores(tempDir);
  try {
    const task = groupTaskStore.createTask({
      groupId: 'group-join', title: 'Join', goal: 'G',
      chairMetabotId: 1, createdBy: 'user', createPinId: 'pin-join',
    });
    // A text deliverable (no uri) — its message body must be joined in.
    db.run(
      `INSERT INTO group_chat_messages (pin_id, group_id, sender_metaid, sender_name, content, protocol)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['msg-pin-1', 'group-join', 'metaid-x', 'loop', '[DELIVERABLE] final review: passed', 'im'],
    );
    groupTaskStore.addDeliverable({
      taskId: task.id, msgPinId: 'msg-pin-1', authorGlobalmetaid: 'gmid-loop', kind: 'text', uri: null,
    });
    // A metafile deliverable — source message joined too (for context).
    const metafilePin = `${'a'.repeat(64)}i0`;
    db.run(
      `INSERT INTO group_chat_messages (pin_id, group_id, sender_metaid, sender_name, content, protocol)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['msg-pin-2', 'group-join', 'metaid-y', 'Builder', `[DELIVERABLE] metafile://${metafilePin}`, 'im'],
    );
    groupTaskStore.addDeliverable({
      taskId: task.id, msgPinId: 'msg-pin-2', authorGlobalmetaid: 'gmid-builder', kind: 'metafile', uri: `metafile://${metafilePin}`,
    });
    // An orphan deliverable (source message gone) — join must yield nulls, not error.
    groupTaskStore.addDeliverable({
      taskId: task.id, msgPinId: 'msg-pin-gone', authorGlobalmetaid: 'gmid-orphan', kind: 'text', uri: null,
    });

    const list = groupTaskStore.listDeliverables(task.id);
    assert.equal(list.length, 3);

    const text = list.find((d) => d.msgPinId === 'msg-pin-1');
    assert.equal(text.kind, 'text');
    assert.equal(text.sourceContent, '[DELIVERABLE] final review: passed');
    assert.equal(text.sourceSenderName, 'loop');

    const metafile = list.find((d) => d.msgPinId === 'msg-pin-2');
    assert.equal(metafile.kind, 'metafile');
    assert.equal(metafile.uri, `metafile://${metafilePin}`);
    assert.equal(metafile.sourceSenderName, 'Builder');

    const orphan = list.find((d) => d.msgPinId === 'msg-pin-gone');
    assert.equal(orphan.sourceContent, null);
    assert.equal(orphan.sourceSenderName, null);
  } finally {
    store.close();
  }
});
