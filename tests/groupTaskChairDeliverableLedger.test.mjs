/**
 * F-6 (group task #6 test, 2026-10-24): the chair session's final synthesis
 * message, published as a group message tagged [DELIVERABLE], never entered the
 * deliverable ledger (the ingestion gate excluded chair messages), while the
 * auto-generated acceptance summary claimed completion. Repro + regression:
 *
 *  1. chair-session protocol [DELIVERABLE] lines now register into the ledger
 *     with a `chair:` kind prefix (provenance marker);
 *  2. worker registration is unchanged; chair prose recaps (mid-line tag
 *     citations) still never register;
 *  3. the review-entry acceptance-summary ceremony cross-checks the ledger and
 *     records a host note flagging any [DELIVERABLE]-tagged message missing
 *     from the ledger (safety net for paths the ingestion fix cannot cover,
 *     e.g. a lost row).
 *
 * Harness mirrors groupTaskDaemonProtocol.test.mjs (same electron mock +
 * stores). No on-chain calls: performChat / postGroupTaskMessage are stubs.
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
const { createGroupTaskDaemonLoop } = require('../dist-electron/main/services/groupTaskDaemon.js');
const { detectDeliverableLedgerGaps } = require('../dist-electron/main/services/groupTaskAcceptanceSummary.js');

Module._load = originalLoad;

const GROUP_ID = 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff00000000i0';

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-f6-chair-deliverable-'));

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
      boss_global_metaid, allow_chat_skills, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, walletId, `mvc-${id}`, `btc-${id}`, `doge-${id}`, `public-${id}`, `chat-public-${id}`,
      name, 1, `metaid-${id}`, globalmetaid, type, '0000', `${name} role`, `${name} soul`,
      bossGmid, null, 1700000000000 + id, 1700000000000 + id,
    ],
  );
};

const insertGroupMessage = (db, { pinId, senderMetaId, senderGlobalMetaId, senderName, content, chainTimestamp = null }) => {
  db.run(
    `INSERT INTO group_chat_messages (
      pin_id, tx_id, group_id, channel_id, sender_metaid, sender_global_metaid, sender_address,
      sender_name, sender_avatar, sender_chat_pubkey, protocol, content, content_type, encryption,
      reply_pin, mention, chain_timestamp, chain, raw_data, is_processed, msg_index
    ) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, '', '', '/protocols/simplegroupchat', ?, 'text/plain', NULL,
      '', '[]', ?, 'mvc', '{}', 0, NULL)`,
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
  insertMetabot(db, { id: 2, walletId: 1, name: 'Coder Bot', globalmetaid: 'gmid-w2' });

  const sends = [];
  const logs = [];
  const state = { nowMs: 1_000_000_000_000, chatReply: overrides.chatReply ?? null };

  const orchestrationBridge = new GroupTaskOrchestrationBridge({
    groupTaskStore,
    orchestrationStore,
    getMetabotById: (id) => metabotStore.getMetabotById(id),
  });

  const loopDeps = {
    getStore: () => store,
    getGroupTaskStore: () => groupTaskStore,
    getMetabotStore: () => metabotStore,
    getCoworkStore: () => coworkStore,
    orchestrationBridge,
    performChat: async () => state.chatReply ?? 'reply-for-test',
    postGroupTaskMessage: async (taskId, metabotId, content) => {
      sends.push({ taskId, metabotId, content });
      return { pinId: `send-pin-${sends.length}` };
    },
    getChatSkillsRoutingPrompt: async () => ({ prompt: null, activeSkillIds: [] }),
    runSkillTurn: async () => ({ replyText: 'skill-turn-reply', assistantMessageId: 'asst-fake-1' }),
    emitTaskEvent: () => {},
    emitLog: (msg) => logs.push(msg),
    now: () => state.nowMs,
    workerCooldownMs: 20_000,
    chairCooldownMs: 10_000,
    replyBudget: 40,
    maxRepliesPerTaskPerTick: 3,
    ...(overrides.sendOwnerPrivateReport != null ? { sendOwnerPrivateReport: overrides.sendOwnerPrivateReport } : {}),
    ...(overrides.sendReviewReportToSourceSession != null ? { sendReviewReportToSourceSession: overrides.sendReviewReportToSourceSession } : {}),
  };

  const rawLoop = createGroupTaskDaemonLoop(loopDeps);
  const loop = {
    ...rawLoop,
    runTick: async () => {
      await rawLoop.runTick();
      await rawLoop.whenIdle();
    },
  };

  const createTask = () => {
    const task = groupTaskStore.createTask({
      groupId: GROUP_ID, title: 'Build MetaApp', goal: 'Build and publish the intro MetaApp',
      acceptanceCriteria: 'Preview URL works', chairMetabotId: 1, createdBy: 'user', createPinId: 'pin-create',
    });
    groupTaskStore.addMember({ taskId: task.id, metabotId: 1, globalmetaid: 'gmid-twin', role: 'chair', joinedPinId: 'pin-create' });
    groupTaskStore.addMember({ taskId: task.id, metabotId: 2, role: 'worker' });
    groupTaskStore.updateTaskStatus(task.id, 'executing', { actor: { kind: 'chair' } });
    return groupTaskStore.getTaskById(task.id);
  };

  return {
    store, db, groupTaskStore, loop, sends, logs, state, createTask,
    cleanup: () => store.close(),
  };
};

test('F-6: chair-session [DELIVERABLE] publication registers into the ledger with a chair provenance marker', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask();
    const synthesisPin = '3d'.repeat(32) + 'i0'; // the incident's synthesis pin prefix
    insertGroupMessage(h.db, {
      pinId: 'chair-synth-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: `[DELIVERABLE] 最终统合稿：pin://${synthesisPin}`,
    });
    await h.loop.runTick();

    const rows = h.groupTaskStore.listDeliverables(task.id);
    const synth = rows.find((row) => row.msgPinId === 'chair-synth-i0');
    // BEFORE the fix this row did not exist — the ledger missed the core
    // deliverable (11 worker-only entries in the incident).
    assert.ok(synth, 'chair deliverable IS registered after the fix');
    assert.match(synth.kind, /^chair:/, 'chair provenance marker on kind');
    assert.equal(synth.authorGlobalmetaid, 'gmid-twin');
  } finally {
    h.cleanup();
  }
});

test('F-6 regression: worker registration unchanged; chair prose recap still never registers', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask();
    const workerPin = 'a'.repeat(64) + 'i0';
    insertGroupMessage(h.db, {
      pinId: 'worker-done-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: `[DELIVERABLE] 交付包：metafile://${workerPin}`,
    });
    // Chair recap quoting the artifact mid-line (prose citation, not a
    // protocol tag line) — the strict parser must still reject it.
    insertGroupMessage(h.db, {
      pinId: 'chair-recap-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: `回顾：worker 的 metafile://${workerPin} 已核对，任务完成 [DELIVERABLE] 属正常。`,
    });
    await h.loop.runTick();

    const rows = h.groupTaskStore.listDeliverables(task.id);
    assert.equal(rows.length, 1, 'exactly the worker row');
    assert.equal(rows[0].msgPinId, 'worker-done-i0');
    assert.ok(!rows[0].kind.startsWith('chair:'), 'worker rows carry no chair prefix');
  } finally {
    h.cleanup();
  }
});

test('F-6: review-entry ceremony flags [DELIVERABLE]-tagged messages missing from the ledger (summary/ledger consistency)', async () => {
  const h = await createHarness({
    sendOwnerPrivateReport: async () => ({ pinId: 'owner-report-pin' }),
    sendReviewReportToSourceSession: () => {},
  });
  try {
    const task = h.createTask();
    const lostPin = 'b'.repeat(64) + 'i0';
    insertGroupMessage(h.db, {
      pinId: 'lost-delivery-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: `[DELIVERABLE] 成果：metafile://${lostPin}`,
    });
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.listDeliverables(task.id).length, 1);
    // Simulate the F-6 incident shape: the tagged message exists in the group
    // history but the ledger lost the row (any ingestion-path miss).
    h.db.run('DELETE FROM group_task_deliverables WHERE task_id = ?', [task.id]);

    insertGroupMessage(h.db, {
      pinId: 'review-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '统合收口完整\n[STATUS:REVIEW]',
    });
    await h.loop.runTick();

    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'review');
    const notes = h.groupTaskStore.listPendingHostNotes(task.id);
    assert.ok(
      notes.some((note) => note.body.includes('missing from the ledger') || note.body.includes('no ledger row')),
      'F-6 gap host note recorded at summary generation',
    );
    assert.ok(
      h.logs.some((line) => line.includes('F-6 ledger gap')),
      'F-6 gap logged',
    );
  } finally {
    h.cleanup();
  }
});

test('F-6 unit: detectDeliverableLedgerGaps ignores invalid-only and already-recorded messages', () => {
  const validPin = 'c'.repeat(64) + 'i0';
  const tagMessages = [
    // valid candidate, unregistered → gap
    { pinId: 'msg1-i0', senderGlobalMetaId: 'gmid-twin', content: `[DELIVERABLE] 统合稿：pin://${validPin}` },
    // valid candidate, registered → no gap
    { pinId: 'msg2-i0', senderGlobalMetaId: 'gmid-w2', content: `[DELIVERABLE] 包：metafile://${validPin}` },
    // tag line with a truncated/placeholder URI (no valid candidate) → no gap
    { pinId: 'msg3-i0', senderGlobalMetaId: 'gmid-w2', content: '[DELIVERABLE] 截断：pin://short' },
    // prose citation (tag not at line start) → no gap
    { pinId: 'msg4-i0', senderGlobalMetaId: 'gmid-twin', content: `回顾 [DELIVERABLE] 即上文 pin://${validPin}` },
  ];
  const gaps = detectDeliverableLedgerGaps(tagMessages, ['msg2-i0']);
  assert.deepEqual(gaps, [{ pinId: 'msg1-i0', senderGlobalMetaId: 'gmid-twin' }]);
  // all registered → no gaps
  assert.deepEqual(detectDeliverableLedgerGaps(tagMessages, ['msg1-i0', 'msg2-i0']), []);
});
