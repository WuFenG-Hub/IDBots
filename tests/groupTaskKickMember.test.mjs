import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);

// groupTaskService -> groupChatTransport -> metaidCore imports electron; mock it.
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
const groupTaskService = require('../dist-electron/main/services/groupTaskService.js');

Module._load = originalLoad;

const {
  createGroupTask,
  kickGroupTaskMember,
  setGroupTaskServiceMetabotStoreGetter,
  setGroupTaskServiceGroupTaskStoreGetter,
  setGroupTaskServiceOrchestrationBridgeGetter,
  setGroupTaskServiceKvStoreGetter,
  setGroupTaskServiceTransport,
  resetGroupTaskServiceTransport,
} = groupTaskService;

const GROUP_ID = 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff00000000i0';

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-group-task-kick-'));

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

const openStores = async () => {
  const tempDir = makeTempDir();
  const store = await SqliteStore.create(tempDir);
  const groupTaskStore = new GroupTaskStore(store.getDatabase(), store.getSaveFunction());
  return { store, groupTaskStore, db: store.getDatabase() };
};

// ---------------------------------------------------------------------------
// Store: markMemberRemoved
// ---------------------------------------------------------------------------

test('store markMemberRemoved: local member sets removed_at + remove_pin_id, idempotent', async () => {
  const { store, groupTaskStore, db } = await openStores();
  try {
    insertWallet(db, 1);
    insertMetabot(db, { id: 1, walletId: 1, name: 'Twin Bot', type: 'twin', globalmetaid: 'gmid-twin' });
    insertMetabot(db, { id: 2, walletId: 1, name: 'Coder Bot', globalmetaid: 'gmid-w2' });
    const task = groupTaskStore.createTask({
      groupId: GROUP_ID, title: 'T', goal: 'G', chairMetabotId: 1, createdBy: 'user',
    });
    groupTaskStore.addMember({ taskId: task.id, metabotId: 1, role: 'chair' });
    const worker = groupTaskStore.addMember({ taskId: task.id, metabotId: 2, role: 'worker' });

    const removed = groupTaskStore.markMemberRemoved({
      taskId: task.id, metabotId: 2, removePinId: 'pin-remove-2',
    });
    assert.equal(removed.id, worker.id);
    assert.ok(removed.removedAt, 'removed_at set');
    assert.equal(removed.removePinId, 'pin-remove-2');

    // Active listing hides the kicked member; history keeps it.
    assert.deepEqual(
      groupTaskStore.listMembers(task.id).map((m) => m.metabotId),
      [1],
    );
    assert.equal(groupTaskStore.listMembers(task.id, { includeRemoved: true }).length, 2);
    assert.ok(!groupTaskStore.isMember(task.id, 2), 'kicked local member fails the membership check');

    // Idempotent: a second removal returns the same row without throwing.
    const again = groupTaskStore.markMemberRemoved({ taskId: task.id, metabotId: 2 });
    assert.equal(again.id, worker.id);
    assert.equal(again.removedAt, removed.removedAt, 'removed_at not bumped on repeat');
    assert.equal(again.removePinId, 'pin-remove-2', 'first remove pin id kept');
  } finally {
    store.close();
  }
});

test('store markMemberRemoved: remote member matched by globalmetaid; non-member throws', async () => {
  const { store, groupTaskStore, db } = await openStores();
  try {
    insertWallet(db, 1);
    insertMetabot(db, { id: 1, walletId: 1, name: 'Twin Bot', type: 'twin', globalmetaid: 'gmid-twin' });
    const task = groupTaskStore.createTask({
      groupId: GROUP_ID, title: 'T', goal: 'G', chairMetabotId: 1, createdBy: 'user',
    });
    groupTaskStore.addMember({ taskId: task.id, metabotId: 1, role: 'chair' });
    groupTaskStore.addMember({
      taskId: task.id, metabotId: null, globalmetaid: 'gmid-remote-1', role: 'worker', displayName: 'Remote Bot One',
    });

    const removed = groupTaskStore.markMemberRemoved({
      taskId: task.id, globalmetaid: 'gmid-remote-1', removePinId: 'pin-remove-r1',
    });
    assert.ok(removed.removedAt);
    assert.equal(removed.removePinId, 'pin-remove-r1');
    assert.equal(groupTaskStore.listMembers(task.id).length, 1, 'only the chair stays active');

    // Idempotent on the remote path too (matches the latest, already-removed row).
    const again = groupTaskStore.markMemberRemoved({ taskId: task.id, globalmetaid: 'gmid-remote-1' });
    assert.equal(again.id, removed.id);

    assert.throws(
      () => groupTaskStore.markMemberRemoved({ taskId: task.id, globalmetaid: 'gmid-stranger' }),
      /not a member/,
    );
    assert.throws(
      () => groupTaskStore.markMemberRemoved({ taskId: task.id, metabotId: 99 }),
      /not a member/,
    );
    assert.throws(
      () => groupTaskStore.markMemberRemoved({ taskId: task.id }),
      /metabotId or globalmetaid is required/,
    );
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// Service: kickGroupTaskMember
// ---------------------------------------------------------------------------

/**
 * Harness: real SqliteStore + MetabotStore + GroupTaskStore, mocked transport.
 * state.removeFails: the on-chain removeuser pin rejects.
 * state.metaIdDetail: what the getMetaIdDetail seam resolves (or throws).
 */
const createHarness = async (overrides = {}) => {
  const tempDir = makeTempDir();
  const store = await SqliteStore.create(tempDir);
  const db = store.getDatabase();
  const metabotStore = new MetabotStore(db, store.getSaveFunction());
  const groupTaskStore = new GroupTaskStore(db, store.getSaveFunction());

  insertWallet(db, 1);
  insertMetabot(db, { id: 1, walletId: 1, name: 'Twin Bot', type: 'twin', globalmetaid: 'gmid-twin' });
  insertMetabot(db, { id: 2, walletId: 1, name: 'Coder Bot', globalmetaid: 'gmid-w2' });

  const calls = { remove: [], send: [], detail: [] };
  const state = {
    removeFails: overrides.removeFails ?? false,
    metaIdDetailThrows: overrides.metaIdDetailThrows ?? false,
    metaId: overrides.metaId ?? 'metaid-remote-legacy',
  };

  setGroupTaskServiceMetabotStoreGetter(() => metabotStore);
  setGroupTaskServiceGroupTaskStoreGetter(() => groupTaskStore);
  setGroupTaskServiceKvStoreGetter(() => store);
  setGroupTaskServiceOrchestrationBridgeGetter(null);
  setGroupTaskServiceTransport({
    createGroupChat: async () => ({ groupId: GROUP_ID, pinId: GROUP_ID }),
    joinGroupChat: async (metabotId) => ({ pinId: `join-pin-${metabotId}` }),
    joinGroupChatAsIdentity: async () => ({ pinId: 'owner-join-pin' }),
    waitForGroupIndexed: async () => true,
    removeGroupChatMember: async (metabotId, groupId, opts) => {
      calls.remove.push({ metabotId, groupId, opts });
      if (state.removeFails) throw new Error('chain remove failed');
      return { pinId: `remove-pin-${calls.remove.length}` };
    },
    sendGroupChatMessage: async (metabotId, groupId, opts) => {
      calls.send.push({ metabotId, groupId, opts });
      return { pinId: `msg-pin-${calls.send.length}` };
    },
    getMetaIdDetail: async (identity) => {
      calls.detail.push(identity);
      if (state.metaIdDetailThrows) throw new Error('indexer unavailable');
      return { metaId: state.metaId };
    },
  });

  return {
    store, db, metabotStore, groupTaskStore, calls, state,
    cleanup: () => {
      setGroupTaskServiceOrchestrationBridgeGetter(null);
      resetGroupTaskServiceTransport();
      store.close();
    },
  };
};

const createTaskWithCoder = async (h) => {
  const detail = await createGroupTask({
    title: 'Build MetaApp',
    goal: 'Build and publish the intro MetaApp',
    memberMetabotIds: [2],
    createdBy: 'twinbot',
  });
  h.calls.send.length = 0; // ignore the kickoff message
  return detail;
};

test('kick local member: on-chain pin first, row marked, chair announces (deterministic)', async () => {
  const h = await createHarness();
  try {
    const task = await createTaskWithCoder(h);

    const removed = await kickGroupTaskMember({ taskId: task.id, metabotId: 2, reason: 'off-topic output' });
    assert.ok(removed.removedAt);
    assert.equal(removed.removePinId, 'remove-pin-1');

    // The chair (twin) signed the removal with the member's LEGACY metaId.
    assert.equal(h.calls.remove.length, 1);
    assert.equal(h.calls.remove[0].metabotId, 1);
    assert.equal(h.calls.remove[0].groupId, GROUP_ID);
    assert.equal(h.calls.remove[0].opts.removeMetaid, 'metaid-2');
    assert.equal(h.calls.remove[0].opts.reason, 'off-topic output');

    // Fixed-format moderation notice from the chair, no LLM involved.
    assert.equal(h.calls.send.length, 1);
    assert.equal(h.calls.send[0].metabotId, 1);
    assert.match(h.calls.send[0].opts.content, /Moderation: Coder Bot has been removed from this group task by the owner\./);
    assert.match(h.calls.send[0].opts.content, /Reason: off-topic output/);

    // The roster no longer lists the kicked member.
    assert.deepEqual(h.groupTaskStore.listMembers(task.id).map((m) => m.metabotId), [1]);

    // Idempotent: a second kick is a no-op (no new pin, no new announcement).
    const again = await kickGroupTaskMember({ taskId: task.id, metabotId: 2 });
    assert.equal(again.id, removed.id);
    assert.equal(h.calls.remove.length, 1, 'no second on-chain removal');
    assert.equal(h.calls.send.length, 1, 'no second announcement');
  } finally {
    h.cleanup();
  }
});

test('kick rejects: terminal task, non-member, chair, missing identity', async () => {
  const h = await createHarness();
  try {
    const task = await createTaskWithCoder(h);

    await assert.rejects(
      () => kickGroupTaskMember({ taskId: task.id, metabotId: 99 }),
      /not a member/,
    );
    await assert.rejects(
      () => kickGroupTaskMember({ taskId: task.id, metabotId: 1 }),
      /chair .* cannot be removed/,
    );
    await assert.rejects(
      () => kickGroupTaskMember({ taskId: task.id }),
      /metabotId or globalmetaid is required/,
    );

    // Terminal task: no further member changes.
    h.groupTaskStore.updateTaskStatus(task.id, 'done');
    await assert.rejects(
      () => kickGroupTaskMember({ taskId: task.id, metabotId: 2 }),
      /done; no further/,
    );

    assert.equal(h.calls.remove.length, 0, 'no chain write for rejected kicks');
    assert.ok(
      h.groupTaskStore.listMembers(task.id, { includeRemoved: true }).every((m) => !m.removedAt),
      'nobody marked removed',
    );
  } finally {
    h.cleanup();
  }
});

test('kick: on-chain failure aborts before any DB write', async () => {
  const h = await createHarness({ removeFails: true });
  try {
    const task = await createTaskWithCoder(h);
    await assert.rejects(
      () => kickGroupTaskMember({ taskId: task.id, metabotId: 2 }),
      /chain remove failed/,
    );
    const worker = h.groupTaskStore.listMembers(task.id).find((m) => m.metabotId === 2);
    assert.ok(worker, 'member still active');
    assert.equal(worker.removedAt, null);
    assert.equal(h.calls.send.length, 0, 'no announcement either');
  } finally {
    h.cleanup();
  }
});

test('kick remote member: legacy metaId resolved via the indexer; display name announced', async () => {
  const h = await createHarness({ metaId: 'metaid-remote-legacy' });
  try {
    const task = await createTaskWithCoder(h);
    h.groupTaskStore.addMember({
      taskId: task.id, metabotId: null, globalmetaid: 'gmid-remote-1', role: 'worker', displayName: 'Remote Bot One',
    });

    const removed = await kickGroupTaskMember({ taskId: task.id, globalmetaid: 'gmid-remote-1' });
    assert.ok(removed.removedAt);
    assert.equal(h.calls.detail.length, 1);
    assert.equal(h.calls.detail[0], 'gmid-remote-1');
    assert.equal(h.calls.remove[0].opts.removeMetaid, 'metaid-remote-legacy');
    assert.match(h.calls.send[0].opts.content, /Moderation: Remote Bot One has been removed/);
    assert.deepEqual(
      h.groupTaskStore.listMembers(task.id).map((m) => m.metabotId ?? m.globalmetaid),
      [1, 2],
      'remote member gone from the active roster',
    );
  } finally {
    h.cleanup();
  }
});

test('kick remote member: metaId resolution failure falls back to the GlobalMetaID', async () => {
  const h = await createHarness({ metaIdDetailThrows: true });
  try {
    const task = await createTaskWithCoder(h);
    h.groupTaskStore.addMember({
      taskId: task.id, metabotId: null, globalmetaid: 'gmid-remote-1', role: 'worker', displayName: 'Remote Bot One',
    });

    const removed = await kickGroupTaskMember({ taskId: task.id, globalmetaid: 'gmid-remote-1' });
    assert.ok(removed.removedAt, 'kick still succeeds on the fallback');
    assert.equal(h.calls.remove[0].opts.removeMetaid, 'gmid-remote-1');
  } finally {
    h.cleanup();
  }
});
