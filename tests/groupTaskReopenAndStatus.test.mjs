/**
 * P0-1 review->executing reopen path + P1-4 member workStatus + P2-8 driver
 * readout + P1-3 eager worker-session pre-creation, all at the service layer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);

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
const { OrchestrationStore } = require('../dist-electron/main/orchestrationStore.js');
const { CoworkStore } = require('../dist-electron/main/coworkStore.js');
const { GroupTaskOrchestrationBridge } = require('../dist-electron/main/services/groupTaskOrchestrationBridge.js');
const groupTaskService = require('../dist-electron/main/services/groupTaskService.js');
const { GROUP_TASK_DRIVER_KV_PREFIX } = require('../dist-electron/main/services/groupTaskDaemon.js');

Module._load = originalLoad;

const {
  getGroupTask,
  closeGroupTask,
  reopenGroupTask,
  reworkGroupTask,
  getGroupTaskMemberStatus,
  joinGroupTaskMemberWithSession,
  computeGroupTaskMemberWorkStatus,
  readGroupTaskDriver,
  setGroupTaskServiceMetabotStoreGetter,
  setGroupTaskServiceGroupTaskStoreGetter,
  setGroupTaskServiceOrchestrationBridgeGetter,
  setGroupTaskServiceKvStoreGetter,
  setGroupTaskServiceCoworkStoreGetter,
  setGroupTaskServiceTransport,
  resetGroupTaskServiceTransport,
} = groupTaskService;

const GROUP_ID = 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff00000000i0';

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-group-reopen-'));

const insertWallet = (db, id) => {
  db.run(
    `INSERT INTO metabot_wallets (id, mnemonic, path, created_at)
     VALUES (?, ?, ?, ?)`,
    [id, `abandon ability able about above absent absorb abstract absurd abuse access accident ${id}`, "m/44'/10001'/0'/0/0", 1700000000000 + id],
  );
};

const insertMetabot = (db, { id, walletId, name, type = 'worker', globalmetaid = null, bossGmid = null }) => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
      name, enabled, metaid, globalmetaid, metabot_type, created_by, role, soul,
      boss_global_metaid, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, walletId, `mvc-${id}`, `btc-${id}`, `doge-${id}`, `public-${id}`, `chat-public-${id}`,
      name, 1, `metaid-${id}`, globalmetaid, type, '0000', `${name} role`, `${name} soul`,
      bossGmid, 1700000000000 + id, 1700000000000 + id,
    ],
  );
};

const insertGroupMessage = (db, { pinId, senderMetaId, senderGlobalMetaId, senderName, content, chainTimestamp = null }) => {
  db.run(
    `INSERT INTO group_chat_messages (
      pin_id, tx_id, group_id, channel_id, sender_metaid, sender_global_metaid, sender_address,
      sender_name, sender_avatar, sender_chat_pubkey, protocol, content, content_type, encryption,
      reply_pin, mention, chain_timestamp, chain, raw_data, is_processed, msg_index
    ) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, '', '', '/protocols/simplegroupchat', ?, 'text/plain', NULL, '', '[]', ?, 'mvc', '{}', 0, NULL)`,
    [pinId, pinId.replace(/-i0$/, ''), GROUP_ID, senderMetaId, senderGlobalMetaId, senderName, content, chainTimestamp],
  );
};

const createHarness = async (overrides = {}) => {
  const tempDir = makeTempDir();
  const store = await SqliteStore.create(tempDir);
  const db = store.getDatabase();
  const metabotStore = new MetabotStore(db, store.getSaveFunction());
  const groupTaskStore = new GroupTaskStore(db, store.getSaveFunction());
  const orchestrationStore = new OrchestrationStore(db, store.getSaveFunction());
  const coworkStore = new CoworkStore(db, () => {});

  insertWallet(db, 1);
  insertMetabot(db, { id: 1, walletId: 1, name: 'Twin Bot', type: 'twin', globalmetaid: 'gmid-twin', bossGmid: 'gmid-boss' });
  insertMetabot(db, { id: 2, walletId: 1, name: 'Coder Bot', globalmetaid: 'gmid-coder' });
  insertMetabot(db, { id: 3, walletId: 1, name: 'Designer Bot', globalmetaid: 'gmid-designer' });

  const bridge = new GroupTaskOrchestrationBridge({
    groupTaskStore,
    orchestrationStore,
    getMetabotById: (id) => metabotStore.getMetabotById(id),
  });

  setGroupTaskServiceMetabotStoreGetter(() => metabotStore);
  setGroupTaskServiceGroupTaskStoreGetter(() => groupTaskStore);
  setGroupTaskServiceOrchestrationBridgeGetter(overrides.withBridge === false ? null : () => bridge);
  setGroupTaskServiceKvStoreGetter(() => store);
  setGroupTaskServiceCoworkStoreGetter(() => coworkStore);
  setGroupTaskServiceTransport({
    createGroupChat: async () => ({ groupId: GROUP_ID, pinId: GROUP_ID }),
    joinGroupChat: async (metabotId) => ({ pinId: `join-pin-${metabotId}` }),
    joinGroupChatAsIdentity: async () => ({ pinId: 'owner-join-pin' }),
    sendGroupChatMessage: async () => ({ pinId: 'msg-pin' }),
    sendGroupChatMessageAsIdentity: async () => ({ pinId: 'identity-send-pin' }),
    waitForGroupIndexed: async () => true,
  });

  const createTask = (status = 'executing', groupId = GROUP_ID) => {
    const task = groupTaskStore.createTask({
      groupId, title: 'Build MetaApp', goal: 'Ship the intro MetaApp',
      chairMetabotId: 1, createdBy: 'user',
    });
    groupTaskStore.addMember({ taskId: task.id, metabotId: 1, globalmetaid: 'gmid-twin', role: 'chair' });
    groupTaskStore.addMember({ taskId: task.id, metabotId: 2, globalmetaid: 'gmid-coder', role: 'worker' });
    // Walk the legal state machine (planning -> executing -> target).
    if (status !== 'planning') {
      groupTaskStore.updateTaskStatus(task.id, 'executing', { actor: { kind: 'chair' } });
      if (status !== 'executing') {
        groupTaskStore.updateTaskStatus(task.id, status, { actor: { kind: 'chair' } });
      }
    }
    return task;
  };

  return {
    store, db, metabotStore, groupTaskStore, orchestrationStore, coworkStore, bridge, createTask,
    cleanup: () => {
      setGroupTaskServiceOrchestrationBridgeGetter(null);
      resetGroupTaskServiceTransport();
      store.close();
    },
  };
};

// ---------------------------------------------------------------------------
// P0-1: reopen (review -> executing)
// ---------------------------------------------------------------------------

test('reopenGroupTask pulls review back to executing, records the owner actor and clears every review-delivery guard', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask('review');
    // Review-delivery guards set (as if a review report cycle already ran).
    h.store.set('group_task_owner_reported:' + task.id, '1');
    h.store.set('group_task_review_notified:' + task.id, '1');
    h.store.set('group_task_review_reassert:' + task.id, '42');

    const detail = await reopenGroupTask(task.id, { actor: { kind: 'owner' } });
    assert.equal(detail.status, 'executing', 'task back to executing');
    assert.equal(detail.statusEvents[0].fromStatus, 'review');
    assert.equal(detail.statusEvents[0].toStatus, 'executing');
    assert.equal(detail.statusEvents[0].actorKind, 'owner', 'owner actor recorded');
    // Improvement #2 (v1.3): the UI rework path must reset ALL review-delivery
    // guards (not just the owner-report one) so the next review re-reports on
    // every channel, and stamp the rework instant for the review re-entry
    // debounce (task #24's stuck source-session report).
    assert.equal(h.store.get('group_task_owner_reported:' + task.id), undefined, 'owner-report guard cleared');
    assert.equal(h.store.get('group_task_review_notified:' + task.id), undefined, 'source-review guard cleared');
    assert.equal(h.store.get('group_task_review_reassert:' + task.id), undefined, 're-assert guard cleared');
    assert.ok(Number(h.store.get('group_task_rework_at:' + task.id)) > 0, 'rework instant stamped');
    // canonical task synced to running via the bridge
    const canonical = h.orchestrationStore.getTask(detail.orchestrationTaskId);
    assert.equal(canonical.status, 'running', 'canonical task projected to running');
  } finally {
    h.cleanup();
  }
});

test('reworkGroupTask (chair RPC path) clears every review-delivery guard and stamps the rework instant', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask('review');
    h.store.set('group_task_owner_reported:' + task.id, '1');
    h.store.set('group_task_review_notified:' + task.id, '1');
    h.store.set('group_task_review_reassert:' + task.id, '42');

    const updated = await reworkGroupTask(task.id, { reason: 'S1 生图受阻，重排子任务' });
    assert.equal(updated.status, 'executing', 'task back to executing');
    assert.equal(h.store.get('group_task_owner_reported:' + task.id), undefined, 'owner-report guard cleared');
    assert.equal(h.store.get('group_task_review_notified:' + task.id), undefined, 'source-review guard cleared');
    assert.equal(h.store.get('group_task_review_reassert:' + task.id), undefined, 're-assert guard cleared');
    assert.ok(Number(h.store.get('group_task_rework_at:' + task.id)) > 0, 'rework instant stamped');
    await assert.rejects(() => reworkGroupTask(task.id), /rework is only available from review/);
  } finally {
    h.cleanup();
  }
});

test('reopenGroupTask rejects non-review tasks and terminal tasks', async () => {
  const h = await createHarness();
  try {
    const executing = h.createTask('executing');
    await assert.rejects(() => reopenGroupTask(executing.id), /only review tasks can be reopened/);
    const done = h.createTask('done', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbii0');
    await assert.rejects(() => reopenGroupTask(done.id), /only review tasks can be reopened/);
    // no extra transitions recorded for the failed attempts
    assert.equal(h.groupTaskStore.listStatusEvents(executing.id).length, 1, 'only the initial chair transition');
  } finally {
    h.cleanup();
  }
});

test('closeGroupTask threads the actor into the status event', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask('review');
    const closed = await closeGroupTask(task.id, { status: 'done', actor: { kind: 'owner', name: 'Owner' } });
    assert.equal(closed.status, 'done');
    const events = h.groupTaskStore.listStatusEvents(task.id);
    assert.equal(events[0].toStatus, 'done');
    assert.equal(events[0].actorKind, 'owner');
    assert.equal(events[0].actorName, 'Owner');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// P1-3: eager worker-session pre-creation on invite
// ---------------------------------------------------------------------------

test('joinGroupTaskMemberWithSession creates the worker session eagerly and reports created/ready', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask();
    const first = await joinGroupTaskMemberWithSession(task.id, 3);
    assert.equal(first.sessionStatus, 'created', 'fresh session created inside the join call');
    const mapping = h.coworkStore.getConversationMapping('metaweb_group_task', `group-task:${task.id}`, 3);
    assert.ok(mapping, 'mapping exists immediately (no daemon tick needed)');
    const session = h.coworkStore.getSession(mapping.coworkSessionId);
    assert.equal(session.messages.length, 1, 'group context injected');
    assert.match(session.messages[0].content, /\[SYSTEM group context snapshot/);

    const second = await joinGroupTaskMemberWithSession(task.id, 3);
    assert.equal(second.sessionStatus, 'ready', 'existing session reported ready');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// P1-4: member workStatus
// ---------------------------------------------------------------------------

test('computeGroupTaskMemberWorkStatus pure derivation', () => {
  const base = { metabotId: 2, lastSpeakAt: 1_700_000_000, lastWorkingAt: null, attemptStatus: null, attemptAtMs: null };
  assert.equal(computeGroupTaskMemberWorkStatus({ ...base }), 'idle');
  assert.equal(computeGroupTaskMemberWorkStatus({ ...base, lastSpeakAt: null }), 'unknown');
  assert.equal(computeGroupTaskMemberWorkStatus({ ...base, attemptStatus: 'running', attemptAtMs: 1_700_000_000_000 }), 'working');
  assert.equal(
    computeGroupTaskMemberWorkStatus({ ...base, lastWorkingAt: 1_700_000_000_000, nowMs: 1_700_000_000_000 + 10 * 60_000 }),
    'working',
    'fresh [WORKING] tag keeps working',
  );
  assert.equal(
    computeGroupTaskMemberWorkStatus({ ...base, lastWorkingAt: 1_700_000_000_000, nowMs: 1_700_000_000_000 + 30 * 60_000 }),
    'idle',
    'stale [WORKING] tag falls back to idle',
  );
  assert.equal(
    computeGroupTaskMemberWorkStatus({ ...base, attemptStatus: 'failed', attemptAtMs: 1_700_000_000_000, nowMs: 1_700_000_000_000 + 10 * 60_000 }),
    'error',
    'recent failed attempt reads error',
  );
  assert.equal(
    computeGroupTaskMemberWorkStatus({ ...base, attemptStatus: 'failed', attemptAtMs: 1_700_000_000_000, nowMs: 1_700_000_000_000 + 120 * 60_000 }),
    'idle',
    'stale failure falls back to idle',
  );
  // R6: a working member whose [WORKING] signal is stale (past the timeout
  // window) reads 'timeout', not idle — the authoritative "went silent" state.
  assert.equal(
    computeGroupTaskMemberWorkStatus({ ...base, memberStatus: 'working', lastWorkingAt: 1_700_000_000_000, nowMs: 1_700_000_000_000 + 30 * 60_000 }),
    'timeout',
    'stale [WORKING] + working member reads timeout',
  );
  assert.equal(
    computeGroupTaskMemberWorkStatus({ ...base, memberStatus: 'working', lastWorkingAt: 1_700_000_000_000, nowMs: 1_700_000_000_000 + 10 * 60_000 }),
    'working',
    'fresh [WORKING] keeps a working member working',
  );
  // R6: an idle member (no memberStatus) with a stale [WORKING] stays idle —
  // timeout only applies to members who self-reported working/assigned.
  assert.equal(
    computeGroupTaskMemberWorkStatus({ ...base, memberStatus: undefined, lastWorkingAt: 1_700_000_000_000, nowMs: 1_700_000_000_000 + 30 * 60_000 }),
    'idle',
    'stale [WORKING] without a working self-report stays idle (back-compat)',
  );
});

test('getGroupTaskMemberStatus surfaces [WORKING]-tag working state from the transcript', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask();
    const recentSec = Math.floor(Date.now() / 1000) - 60; // 1 minute ago
    insertGroupMessage(h.db, {
      pinId: 'work-i0', senderMetaId: 'metaid-coder', senderGlobalMetaId: 'gmid-coder',
      senderName: 'Coder Bot', content: '[WORKING] 已接单，正在做X，预计5分钟', chainTimestamp: recentSec,
    });
    const members = await getGroupTaskMemberStatus(task.id);
    const coder = members.find((m) => m.metabotId === 2);
    assert.equal(coder.workStatus, 'working', '[WORKING] tag within the window reads working');
    assert.equal(coder.lastWorkingAt, recentSec * 1000, 'lastWorkingAt exposed in epoch ms');
  } finally {
    h.cleanup();
  }
});

test('getGroupTaskMemberStatus reads running/failed canonical attempt state', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask();
    // canonical worker attempt in running state (as the daemon would create)
    const context = h.bridge.beginWorkerAttempt({
      groupTaskId: task.id, workerMetabotId: 2,
      objective: 'research topic', sourceMessageKey: 'msg-1',
    });
    h.bridge.markWorkerAttemptRunning(context.attempt.id, 'session-1');
    let members = await getGroupTaskMemberStatus(task.id);
    assert.equal(members.find((m) => m.metabotId === 2).workStatus, 'working', 'running attempt reads working');

    h.bridge.failWorkerAttempt(context.attempt.id, 'tool crashed');
    members = await getGroupTaskMemberStatus(task.id);
    assert.equal(members.find((m) => m.metabotId === 2).workStatus, 'error', 'recent failed attempt reads error');
  } finally {
    h.cleanup();
  }
});

test('getGroupTask full view derives workStatus from [WORKING] tags (not summary-only)', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask();
    const recentSec = Math.floor(Date.now() / 1000) - 60;
    insertGroupMessage(h.db, {
      pinId: 'work-full-i0', senderMetaId: 'metaid-coder', senderGlobalMetaId: 'gmid-coder',
      senderName: 'Coder Bot', content: '[WORKING] 已接单，正在做X，预计5分钟', chainTimestamp: recentSec,
    });
    const detail = await getGroupTask(task.id);
    const coder = detail.members.find((m) => m.metabotId === 2);
    assert.equal(coder.workStatus, 'working', 'IPC full view still sees a fresh [WORKING] tag');
    assert.equal(coder.lastWorkingAt, recentSec * 1000, 'lastWorkingAt exposed in epoch ms on the detail payload');
  } finally {
    h.cleanup();
  }
});

test('working member with a later failed attempt does not read error on the detail rail', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask();
    h.groupTaskStore.setMemberStatus(task.id, 2, 'working', 'gmid-coder');
    const ackSec = Math.floor(Date.now() / 1000) - 90;
    insertGroupMessage(h.db, {
      pinId: 'lucy-ack-i0', senderMetaId: 'metaid-coder', senderGlobalMetaId: 'gmid-coder',
      senderName: 'Coder Bot', content: '[WORKING] 收到，随时待命', chainTimestamp: ackSec,
    });
    const context = h.bridge.beginWorkerAttempt({
      groupTaskId: task.id, workerMetabotId: 2,
      objective: 'write copy', sourceMessageKey: 'msg-lucy',
    });
    h.bridge.markWorkerAttemptRunning(context.attempt.id, 'session-lucy');
    h.bridge.failWorkerAttempt(context.attempt.id, 'OpenAI API error (401): Invalid API key');
    const detail = await getGroupTask(task.id);
    const coder = detail.members.find((m) => m.metabotId === 2);
    assert.equal(coder.status, 'working', 'state-machine status stays working');
    assert.equal(
      coder.workStatus,
      'working',
      'failed attempt after a [WORKING] ACK must not paint the rail as error',
    );
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// P2-8: driver readout
// ---------------------------------------------------------------------------

test('readGroupTaskDriver parses the kv heartbeat claim; detail exposes it', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask();
    assert.equal(readGroupTaskDriver(h.store, task.id), null, 'no claim yet');
    h.store.set(`${GROUP_TASK_DRIVER_KV_PREFIX}${task.id}`, 'inst-abc|1234567890123');
    const info = readGroupTaskDriver(h.store, task.id);
    assert.deepEqual(info, { instanceId: 'inst-abc', atMs: 1234567890123 });
    const detail = await getGroupTask(task.id);
    assert.deepEqual(detail.driver, { instanceId: 'inst-abc', atMs: 1234567890123 });
    assert.ok(Array.isArray(detail.statusEvents), 'statusEvents present on the detail');
  } finally {
    h.cleanup();
  }
});
