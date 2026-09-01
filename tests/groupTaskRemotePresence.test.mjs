import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);

// groupTaskDaemon -> coworkStore imports electron; mock it.
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
const { CoworkStore } = require('../dist-electron/main/coworkStore.js');
const { createGroupTaskDaemonLoop } = require('../dist-electron/main/services/groupTaskDaemon.js');

Module._load = originalLoad;

// OpenTeam M2: remote-teammate unreachable detection. The daemon probes idchat
// presence (throttled, per task) and cross-checks the sender's latest group
// message; an offline + silent remote teammate surfaces as a fact block in the
// chair turn and exactly one private owner brief per unreachable streak.

const GROUP_ID = 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff00000000i0';
const BOSS_GMID = 'gmid-boss';
const REMOTE_GMID = 'gmid-remote-1';
const REMOTE_NAME = 'Remote Alice';

const DEFAULT_NOW_MS = 1_000_000_000_000;
const nowSec = (h) => Math.floor(h.state.nowMs / 1000);

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-remote-presence-'));

const insertWallet = (db, id) => {
  db.run(
    `INSERT INTO metabot_wallets (id, mnemonic, path, created_at) VALUES (?, ?, ?, ?)`,
    [id, `abandon ability able about above absent absorb abstract absurd abuse access accident ${id}`, "m/44'/10001'/0'/0/0", 1700000000000 + id]
  );
};

const insertMetabot = (db, { id, walletId, name, type = 'worker', globalmetaid = null, bossGmid = null, llmId = null }) => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
      name, enabled, metaid, globalmetaid, metabot_type, created_by, role, soul,
      boss_global_metaid, llm_id, allow_chat_skills, bio, goal, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, walletId, `mvc-${id}`, `btc-${id}`, `doge-${id}`, `public-${id}`, `chat-public-${id}`,
      name, 1, `metaid-${id}`, globalmetaid, type, '0000', `${name} role`, `${name} soul`,
      bossGmid, llmId, '[]', null, null, 1700000000000 + id, 1700000000000 + id,
    ]
  );
};

const insertGroupMessage = (db, { pinId, groupId = GROUP_ID, senderMetaId, senderGlobalMetaId, senderName, content, chainTimestamp = null }) => {
  db.run(
    `INSERT INTO group_chat_messages (
      pin_id, tx_id, group_id, channel_id, sender_metaid, sender_global_metaid, sender_address,
      sender_name, sender_avatar, sender_chat_pubkey, protocol, content, content_type, encryption,
      reply_pin, mention, chain_timestamp, chain, raw_data, is_processed, msg_index
    ) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, '', '', '/protocols/simplegroupchat', ?, 'text/plain', NULL, '', '[]', ?, 'mvc', '{}', 0, NULL)`,
    [pinId, pinId.replace(/-i0$/, ''), groupId, senderMetaId, senderGlobalMetaId, senderName, content, chainTimestamp],
  );
};

/**
 * Backdate the remote member's join to before the fake daemon clock
 * (1e12 ms = 2001-09-09): sqlite datetime('now') is real time, which the
 * daemon would read as "joined in the future" and trip the M3 join grace.
 */
const backdateRemoteJoin = (db, taskId) => {
  db.run(
    `UPDATE group_task_members SET created_at = '2000-01-01 00:00:00'
     WHERE task_id = ? AND metabot_id IS NULL`,
    [taskId],
  );
};

const createHarness = async () => {
  const tempDir = makeTempDir();
  const store = await SqliteStore.create(tempDir);
  const db = store.getDatabase();
  const metabotStore = new MetabotStore(db, store.getSaveFunction());
  const groupTaskStore = new GroupTaskStore(db, store.getSaveFunction());
  const coworkStore = new CoworkStore(db, () => {});

  insertWallet(db, 1);
  insertMetabot(db, { id: 1, walletId: 1, name: 'Twin Bot', type: 'twin', globalmetaid: 'gmid-twin', bossGmid: BOSS_GMID, llmId: 'llm-1' });
  insertMetabot(db, { id: 2, walletId: 1, name: 'Coder Bot', globalmetaid: 'gmid-w2', llmId: 'llm-2' });

  const chatCalls = [];
  const sends = [];
  const ownerReportCalls = [];
  const presenceCalls = [];
  const state = {
    nowMs: DEFAULT_NOW_MS,
    // Presence mock: array of entries, or a function(ids) => entries.
    presence: [],
    presenceError: null,
  };

  // fix/group-task-flow follow-up: responder turns run as detached async jobs
  // now. Drain them after each tick so they cannot outlive store.close() in
  // cleanup (same wrapper as groupTaskDaemon.test.mjs).
  const rawLoop = createGroupTaskDaemonLoop({
    getStore: () => store,
    getGroupTaskStore: () => groupTaskStore,
    getMetabotStore: () => metabotStore,
    getCoworkStore: () => coworkStore,
    performChat: async (systemPrompt, userMessage, llmId) => {
      chatCalls.push({ systemPrompt, userMessage, llmId });
      return `reply-for-${llmId}`;
    },
    postGroupTaskMessage: async (taskId, metabotId, content) => {
      sends.push({ taskId, metabotId, content });
      return { pinId: `send-pin-${sends.length}` };
    },
    sendOwnerPrivateReport: async (params) => {
      ownerReportCalls.push(params);
      return { pinId: `owner-report-pin-${ownerReportCalls.length}`, sessionId: null };
    },
    fetchRemotePresence: async (globalMetaIds) => {
      presenceCalls.push(globalMetaIds);
      if (state.presenceError) throw state.presenceError;
      return typeof state.presence === 'function' ? state.presence(globalMetaIds) : state.presence;
    },
    emitLog: () => {},
    now: () => state.nowMs,
    workerCooldownMs: 0,
    chairCooldownMs: 0,
  });
  const loop = {
    ...rawLoop,
    runTick: async () => {
      await rawLoop.runTick();
      await rawLoop.whenIdle();
    },
  };

  /** Task in 'executing' with the local chair plus one remote worker. */
  const createTask = ({ withLocalWorker = false } = {}) => {
    const task = groupTaskStore.createTask({
      groupId: GROUP_ID, title: 'Build MetaApp', goal: 'Build and publish the intro MetaApp',
      acceptanceCriteria: 'Preview URL works', chairMetabotId: 1, createdBy: 'user', createPinId: 'pin-create',
    });
    groupTaskStore.addMember({ taskId: task.id, metabotId: 1, globalmetaid: 'gmid-twin', role: 'chair', joinedPinId: 'pin-create' });
    if (withLocalWorker) {
      groupTaskStore.addMember({ taskId: task.id, metabotId: 2, role: 'worker' });
    }
    groupTaskStore.addMember({
      taskId: task.id, metabotId: null, globalmetaid: REMOTE_GMID, role: 'worker', displayName: REMOTE_NAME,
    });
    // Backdate the join beyond the unreachable window: the daemon clock is
    // fixed (1e12 ms, 2001) while sqlite datetime('now') is real time, which
    // would otherwise read as "just joined" and trip the M3 join grace.
    backdateRemoteJoin(db, task.id);
    groupTaskStore.updateTaskStatus(task.id, 'executing');
    return groupTaskStore.getTaskById(task.id);
  };

  const offlinePresence = (lastSeenAgoSeconds = 1500) => [
    { globalMetaId: REMOTE_GMID, isOnline: false, lastSeenAt: 0, lastSeenAgoSeconds, deviceCount: 0 },
  ];
  const onlinePresence = () => [
    { globalMetaId: REMOTE_GMID, isOnline: true, lastSeenAt: 0, lastSeenAgoSeconds: 0, deviceCount: 1 },
  ];

  return {
    store, db, metabotStore, groupTaskStore, coworkStore, loop,
    chatCalls, sends, ownerReportCalls, presenceCalls, state, createTask,
    offlinePresence, onlinePresence,
    cleanup: () => store.close(),
  };
};

test('remote presence: online teammate — no chair hint, no owner brief', async () => {
  const h = await createHarness();
  try {
    h.createTask();
    h.state.presence = h.onlinePresence();
    insertGroupMessage(h.db, {
      pinId: 'owner-1-i0', senderMetaId: 'metaid-boss', senderGlobalMetaId: BOSS_GMID,
      senderName: 'Boss', content: 'status update please', chainTimestamp: nowSec(h) - 60,
    });

    await h.loop.runTick();

    assert.equal(h.presenceCalls.length, 1);
    assert.deepEqual(h.presenceCalls[0], [REMOTE_GMID]);
    const chairCall = h.chatCalls.find((call) => call.llmId === 'llm-1');
    assert.ok(chairCall, 'chair answered the owner message');
    assert.ok(!chairCall.userMessage.includes('Remote teammate status'));
    assert.equal(h.ownerReportCalls.length, 0);
  } finally {
    h.cleanup();
  }
});

test('remote presence: offline but recently active in the group — not unreachable', async () => {
  const h = await createHarness();
  try {
    h.createTask();
    h.state.presence = h.offlinePresence(600); // offline for ~10 min
    // The remote teammate posted 2 minutes ago — inside the 10-minute window.
    insertGroupMessage(h.db, {
      pinId: 'remote-recent-i0', senderMetaId: 'metaid-remote', senderGlobalMetaId: REMOTE_GMID,
      senderName: REMOTE_NAME, content: '@Twin Bot working on it', chainTimestamp: nowSec(h) - 120,
    });

    await h.loop.runTick();

    const chairCall = h.chatCalls.find((call) => call.llmId === 'llm-1');
    assert.ok(chairCall, 'chair answered the mention');
    assert.ok(!chairCall.userMessage.includes('Remote teammate status'));
    assert.equal(h.ownerReportCalls.length, 0);
  } finally {
    h.cleanup();
  }
});

test('remote presence: offline + silent beyond window — chair hint injected, owner briefed once per streak', async () => {
  const h = await createHarness();
  try {
    h.createTask({ withLocalWorker: true });
    h.state.presence = h.offlinePresence(1500); // offline for ~25 min
    // The remote teammate's latest message is 20 min old — beyond the window.
    insertGroupMessage(h.db, {
      pinId: 'remote-stale-i0', senderMetaId: 'metaid-remote', senderGlobalMetaId: REMOTE_GMID,
      senderName: REMOTE_NAME, content: '@Twin Bot joining the task', chainTimestamp: nowSec(h) - 1200,
    });
    // An owner message addressed to the local worker also reaches the chair.
    insertGroupMessage(h.db, {
      pinId: 'owner-2-i0', senderMetaId: 'metaid-boss', senderGlobalMetaId: BOSS_GMID,
      senderName: 'Boss', content: '@Coder Bot please research options', chainTimestamp: nowSec(h) - 1140,
    });

    await h.loop.runTick();

    // Chair turns carry the host-observed fact block; the worker turn does not.
    const chairCalls = h.chatCalls.filter((call) => call.llmId === 'llm-1');
    assert.ok(chairCalls.length >= 1, 'chair replied');
    for (const call of chairCalls) {
      assert.ok(call.userMessage.includes('[Remote teammate status — host-observed facts]'));
      assert.ok(
        call.userMessage.includes(
          `- ${REMOTE_NAME} (remote teammate) is currently unreachable: offline for ~25 min, no message for 20 min.`,
        ),
      );
    }
    const workerCall = h.chatCalls.find((call) => call.llmId === 'llm-2');
    assert.ok(workerCall, 'worker replied to its assignment');
    assert.ok(!workerCall.userMessage.includes('Remote teammate status'));

    // Owner brief: exactly once, naming the task, the member, and the facts.
    assert.equal(h.ownerReportCalls.length, 1);
    const brief = h.ownerReportCalls[0];
    assert.equal(brief.taskId, 1);
    assert.equal(brief.metabotId, 1);
    assert.equal(brief.ownerGlobalMetaId, BOSS_GMID);
    assert.ok(brief.text.includes('Group task "Build MetaApp"'), 'R5: owner brief names the task by title, not #id');
    assert.ok(!brief.text.includes('#1'), 'R5: no #id in the owner brief text');
    assert.ok(brief.text.includes(`"${REMOTE_NAME}"`));
    assert.ok(brief.text.includes('offline for ~25 min, no message for 20 min'));

    // A later probe (throttle window elapsed) with the same facts must NOT re-brief.
    h.state.nowMs += 61_000;
    await h.loop.runTick();
    assert.equal(h.presenceCalls.length, 2);
    assert.equal(h.ownerReportCalls.length, 1);
  } finally {
    h.cleanup();
  }
});

test('remote presence: recovery clears the hint and re-arms the owner brief', async () => {
  const h = await createHarness();
  try {
    h.createTask();
    h.state.presence = h.offlinePresence(1500);
    insertGroupMessage(h.db, {
      pinId: 'remote-stale-i0', senderMetaId: 'metaid-remote', senderGlobalMetaId: REMOTE_GMID,
      senderName: REMOTE_NAME, content: '@Twin Bot joining the task', chainTimestamp: nowSec(h) - 1200,
    });
    await h.loop.runTick();
    assert.equal(h.ownerReportCalls.length, 1);

    // Recovery: the next probe reports the teammate online — the hint
    // disappears from the chair turn and the notification flag resets.
    h.state.nowMs += 61_000;
    h.state.presence = h.onlinePresence();
    insertGroupMessage(h.db, {
      pinId: 'owner-3-i0', senderMetaId: 'metaid-boss', senderGlobalMetaId: BOSS_GMID,
      senderName: 'Boss', content: 'any progress?', chainTimestamp: nowSec(h) - 30,
    });
    await h.loop.runTick();
    const recoveredChairCall = h.chatCalls.filter((call) => call.llmId === 'llm-1').at(-1);
    assert.ok(!recoveredChairCall.userMessage.includes('Remote teammate status'));
    assert.equal(h.ownerReportCalls.length, 1);

    // A NEW unreachable streak after recovery briefs the owner again.
    h.state.nowMs += 61_000;
    h.state.presence = h.offlinePresence(1800);
    await h.loop.runTick();
    assert.equal(h.ownerReportCalls.length, 2);
    assert.ok(h.ownerReportCalls[1].text.includes(`"${REMOTE_NAME}"`));
  } finally {
    h.cleanup();
  }
});

test('remote presence: terminal task state resets the notification flag', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask();
    h.state.presence = h.offlinePresence(1500);
    insertGroupMessage(h.db, {
      pinId: 'remote-stale-i0', senderMetaId: 'metaid-remote', senderGlobalMetaId: REMOTE_GMID,
      senderName: REMOTE_NAME, content: '@Twin Bot joining the task', chainTimestamp: nowSec(h) - 1200,
    });
    await h.loop.runTick();
    assert.equal(h.ownerReportCalls.length, 1);

    // Task leaves the active set -> in-memory presence/notification state pruned.
    h.db.run(`UPDATE group_tasks SET status = 'done' WHERE id = ?`, [task.id]);
    h.state.nowMs += 61_000;
    await h.loop.runTick();
    assert.equal(h.ownerReportCalls.length, 1);

    // Reactivated (e.g. rework): the next streak briefs the owner again.
    h.db.run(`UPDATE group_tasks SET status = 'executing' WHERE id = ?`, [task.id]);
    h.state.nowMs += 61_000;
    await h.loop.runTick();
    assert.equal(h.ownerReportCalls.length, 2);
  } finally {
    h.cleanup();
  }
});

test('remote presence: probe failure is silent (tick continues, no hint, no brief)', async () => {
  const h = await createHarness();
  try {
    h.createTask();
    h.state.presenceError = new Error('network down');
    insertGroupMessage(h.db, {
      pinId: 'owner-4-i0', senderMetaId: 'metaid-boss', senderGlobalMetaId: BOSS_GMID,
      senderName: 'Boss', content: 'status update please', chainTimestamp: nowSec(h) - 60,
    });

    await h.loop.runTick(); // must not throw

    const chairCall = h.chatCalls.find((call) => call.llmId === 'llm-1');
    assert.ok(chairCall, 'chair still answered despite the failed probe');
    assert.ok(!chairCall.userMessage.includes('Remote teammate status'));
    assert.equal(h.ownerReportCalls.length, 0);
  } finally {
    h.cleanup();
  }
});

test('M3 join grace: a just-joined offline teammate is never flagged unreachable', async () => {
  const h = await createHarness();
  try {
    // Create the task WITHOUT backdating the remote join: relative to the fake
    // daemon clock the membership row reads as brand new, so the grace applies.
    const task = h.groupTaskStore.createTask({
      groupId: GROUP_ID, title: 'Build MetaApp', goal: 'Build and publish the intro MetaApp',
      acceptanceCriteria: 'Preview URL works', chairMetabotId: 1, createdBy: 'user', createPinId: 'pin-create',
    });
    h.groupTaskStore.addMember({ taskId: task.id, metabotId: 1, globalmetaid: 'gmid-twin', role: 'chair', joinedPinId: 'pin-create' });
    h.groupTaskStore.addMember({
      taskId: task.id, metabotId: null, globalmetaid: REMOTE_GMID, role: 'worker', displayName: REMOTE_NAME,
    });
    h.groupTaskStore.updateTaskStatus(task.id, 'executing');

    h.state.presence = h.offlinePresence(1500); // offline ~25 min, and never posted here
    insertGroupMessage(h.db, {
      pinId: 'owner-grace-i0', senderMetaId: 'metaid-boss', senderGlobalMetaId: BOSS_GMID,
      senderName: 'Boss', content: 'status update please', chainTimestamp: nowSec(h) - 60,
    });

    await h.loop.runTick();

    const chairCall = h.chatCalls.find((call) => call.llmId === 'llm-1');
    assert.ok(chairCall, 'chair answered the owner message');
    assert.ok(
      !chairCall.userMessage.includes('Remote teammate status'),
      'a teammate inside the join grace is not flagged unreachable',
    );
    assert.equal(h.ownerReportCalls.length, 0, 'no owner brief during the join grace');
  } finally {
    h.cleanup();
  }
});

test('M3 kick: notified-key cleanup — a re-invited teammate that goes silent re-briefs the owner', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask();
    h.state.presence = h.offlinePresence(1500);
    insertGroupMessage(h.db, {
      pinId: 'remote-stale-i0', senderMetaId: 'metaid-remote', senderGlobalMetaId: REMOTE_GMID,
      senderName: REMOTE_NAME, content: '@Twin Bot joining the task', chainTimestamp: nowSec(h) - 1200,
    });
    await h.loop.runTick();
    assert.equal(h.ownerReportCalls.length, 1, 'first unreachable streak briefed the owner');

    // The owner kicks the remote teammate (task stays active).
    h.groupTaskStore.markMemberRemoved({ taskId: task.id, globalmetaid: REMOTE_GMID, removePinId: 'pin-remove-r1' });
    h.state.nowMs += 61_000;
    await h.loop.runTick();
    assert.equal(h.ownerReportCalls.length, 1, 'no brief about a kicked member');

    // Re-invite (explicit owner decision): fresh ACTIVE row for the same bot,
    // joined long enough ago that the grace does not apply.
    h.groupTaskStore.addMember({
      taskId: task.id, metabotId: null, globalmetaid: REMOTE_GMID, role: 'worker', displayName: REMOTE_NAME,
    });
    backdateRemoteJoin(h.db, task.id);
    h.state.presence = h.offlinePresence(2400);
    h.state.nowMs += 61_000;
    await h.loop.runTick();
    assert.equal(
      h.ownerReportCalls.length, 2,
      'the stale notified key must not suppress the brief for the re-invited teammate',
    );
    assert.ok(h.ownerReportCalls[1].text.includes(`"${REMOTE_NAME}"`));
  } finally {
    h.cleanup();
  }
});
