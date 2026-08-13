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
      app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() },
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
  closeGroupTask,
  setGroupTaskServiceMetabotStoreGetter,
  setGroupTaskServiceGroupTaskStoreGetter,
  setGroupTaskServiceKvStoreGetter,
  setGroupTaskServiceTransport,
  setGroupTaskAcceptanceNotifier,
  resetGroupTaskServiceTransport,
} = groupTaskService;

const GROUP_ID = 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff00000000i0';
const CREATE_PIN_ID = GROUP_ID;
const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-source-session-relay-'));

const insertWallet = (db, id) => {
  db.run(
    `INSERT INTO metabot_wallets (id, mnemonic, path, created_at) VALUES (?, ?, ?, ?)`,
    [id, `abandon ability able about above absent absorb abstract absurd abuse access accident ${id}`, "m/44'/10001'/0'/0/0", 1700000000000 + id],
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
    ],
  );
};

const createHarness = async () => {
  const tempDir = makeTempDir();
  const store = await SqliteStore.create(tempDir);
  const db = store.getDatabase();
  const metabotStore = new MetabotStore(db, store.getSaveFunction());
  const groupTaskStore = new GroupTaskStore(db, store.getSaveFunction());

  insertWallet(db, 1);
  insertMetabot(db, { id: 1, walletId: 1, name: 'Twin Bot', type: 'twin', globalmetaid: 'gmid-twin' });
  insertMetabot(db, { id: 2, walletId: 1, name: 'Coder Bot', type: 'worker', globalmetaid: 'gmid-coder' });

  const notifyCalls = [];

  setGroupTaskServiceMetabotStoreGetter(() => metabotStore);
  setGroupTaskServiceGroupTaskStoreGetter(() => groupTaskStore);
  setGroupTaskServiceKvStoreGetter(() => store);
  groupTaskService.setGroupTaskServiceOrchestrationBridgeGetter(null);
  setGroupTaskServiceTransport({
    createGroupChat: async () => ({ groupId: GROUP_ID, pinId: CREATE_PIN_ID }),
    joinGroupChat: async (metabotId) => ({ pinId: `join-pin-${metabotId}` }),
    joinGroupChatAsIdentity: async () => ({ pinId: 'owner-join-pin' }),
    sendGroupChatMessage: async () => ({ pinId: 'msg-pin' }),
    sendGroupChatMessageAsIdentity: async () => ({ pinId: 'identity-send-pin' }),
    waitForGroupIndexed: async () => true,
  });
  setGroupTaskAcceptanceNotifier((input) => {
    notifyCalls.push(input);
    return { ok: true };
  });

  return {
    store, db, metabotStore, groupTaskStore, notifyCalls,
    cleanup: () => {
      setGroupTaskAcceptanceNotifier(null);
      resetGroupTaskServiceTransport();
      groupTaskService.setGroupTaskServiceOrchestrationBridgeGetter(null);
      store.close();
    },
  };
};

/** Advance a freshly-created (planning) task straight to review so it can close. */
const advanceToReview = (groupTaskStore, taskId) => {
  groupTaskStore.updateTaskStatus(taskId, 'executing');
  groupTaskStore.updateTaskStatus(taskId, 'review');
};

test('createGroupTask records sourceSessionId on the task row (R2 passthrough)', async () => {
  const h = await createHarness();
  try {
    const detail = await createGroupTask({
      title: 'Relay demo',
      goal: 'ship it',
      memberMetabotIds: [2],
      createdBy: 'twinbot',
      sourceSessionId: 'session-origin-123',
    });
    assert.equal(detail.sourceSessionId, 'session-origin-123');
    // Re-read from the store to confirm persistence.
    const persisted = h.groupTaskStore.getTaskById(detail.id);
    assert.equal(persisted.sourceSessionId, 'session-origin-123');
  } finally {
    h.cleanup();
  }
});

test('closeGroupTask(done) relays [GROUP_TASK_ACCEPTANCE] once and arms the kv guard', async () => {
  const h = await createHarness();
  try {
    const detail = await createGroupTask({
      title: '西游记第一回',
      goal: 'Three.js 动画',
      memberMetabotIds: [2],
      createdBy: 'twinbot',
      sourceSessionId: 'session-origin-456',
    });
    advanceToReview(h.groupTaskStore, detail.id);
    // Simulate the daemon's T1 review-entry summary so the close can finalize it.
    h.groupTaskStore.saveAcceptanceSummary({
      taskId: detail.id,
      goal: 'Three.js 动画',
      acceptanceCriteria: 'plays',
      deliverables: [{ kind: 'metaapp', uri: 'metaapp://x', status: 'accepted', confirmation: 'confirmed', authorName: 'Lucy' }],
      members: [{ name: 'Lucy', role: 'worker', workStatus: 'done' }],
      guidance: 'guidance',
    });

    await closeGroupTask(detail.id, { status: 'done', rating: 5, ratingComment: 'great' });

    assert.equal(h.notifyCalls.length, 1, 'notifier fired exactly once');
    const call = h.notifyCalls[0];
    assert.equal(call.taskId, detail.id);
    assert.equal(call.targetSessionId, 'session-origin-456');
    assert.ok(call.message.startsWith('[GROUP_TASK_ACCEPTANCE]'));
    assert.ok(call.message.includes('西游记第一回'));
    assert.ok(call.message.includes('结果：done'));
    assert.ok(call.message.includes('评分 5/5'));
    assert.ok(call.message.includes('great'));

    // kv guard armed → a second relay path for the same outcome is suppressed.
    assert.equal(
      h.store.get('group_task_acceptance_notified:' + detail.id + ':done'),
      '1',
    );
    // The acceptance summary was finalized with outcome/rating and its
    // notified_session recorded.
    const summary = h.groupTaskStore.getLatestAcceptanceSummary(detail.id);
    assert.equal(summary?.notifiedSession, 'session-origin-456');
    assert.equal(summary?.outcome, 'done');
    assert.equal(summary?.rating, 5);
  } finally {
    h.cleanup();
  }
});

test('closeGroupTask(done) with NULL sourceSessionId does not notify (degrades silently)', async () => {
  const h = await createHarness();
  try {
    const detail = await createGroupTask({
      title: 'Panel task',
      goal: 'no origin session',
      memberMetabotIds: [2],
      createdBy: 'user', // panel path — no sourceSessionId
    });
    assert.equal(detail.sourceSessionId, null);
    advanceToReview(h.groupTaskStore, detail.id);

    await closeGroupTask(detail.id, { status: 'done', rating: 4 });

    assert.equal(h.notifyCalls.length, 0, 'no relay for a task without a source session');
  } finally {
    h.cleanup();
  }
});

test('notifier returning ok:false does not arm the kv guard (retry stays possible)', async () => {
  const h = await createHarness();
  try {
    // Swap the notifier to one that reports delivery failure (target session gone)
    // and records its own calls.
    const failingCalls = [];
    setGroupTaskAcceptanceNotifier((input) => {
      failingCalls.push(input);
      return { ok: false, warning: 'TARGET_SESSION_STOPPED' };
    });

    const detail = await createGroupTask({
      title: 'Gone session',
      goal: 'target missing',
      memberMetabotIds: [2],
      createdBy: 'twinbot',
      sourceSessionId: 'session-gone',
    });
    advanceToReview(h.groupTaskStore, detail.id);
    await closeGroupTask(detail.id, { status: 'done', rating: 3 });

    assert.equal(failingCalls.length, 1, 'the notifier was attempted');
    // Guard NOT armed because delivery failed → a future retry can fire again.
    assert.equal(h.store.get('group_task_acceptance_notified:' + detail.id + ':done'), undefined);
  } finally {
    h.cleanup();
  }
});

test('closeGroupTask(cancelled) also relays to the source session', async () => {
  const h = await createHarness();
  try {
    const detail = await createGroupTask({
      title: 'Cancel me',
      goal: 'will be cancelled',
      memberMetabotIds: [2],
      createdBy: 'twinbot',
      sourceSessionId: 'session-cancel',
    });
    advanceToReview(h.groupTaskStore, detail.id);
    await closeGroupTask(detail.id, { status: 'cancelled', reason: 'no longer needed' });

    assert.equal(h.notifyCalls.length, 1);
    assert.ok(h.notifyCalls[0].message.includes('结果：cancelled'));
    assert.equal(h.store.get('group_task_acceptance_notified:' + detail.id + ':cancelled'), '1');
  } finally {
    h.cleanup();
  }
});
