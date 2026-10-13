/**
 * Group-task durable working-state block (src/main/services/groupTaskWorkingState.ts)
 * plus its daemon integration: the block must reach BOTH the plain completion
 * path and the skill path (volatileContext is shared), and must stay empty
 * when nothing is open.
 *
 * Run: pnpm run compile:electron && node --test tests/groupTaskWorkingState.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  buildGroupTaskWorkingStateBlock,
  GROUP_WORKING_STATE_MAX_ENTRIES,
} = await import('../dist-electron/main/services/groupTaskWorkingState.js');

// ---------------------------------------------------------------------------
// Pure builder
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-10-13T08:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

test('empty input renders nothing', () => {
  assert.equal(buildGroupTaskWorkingStateBlock({ nowMs: NOW }), '');
  assert.equal(buildGroupTaskWorkingStateBlock({ nowMs: NOW, steps: [], attempts: [], expectedDeliveries: [] }), '');
});

test('terminal steps/attempts are excluded; open ones render', () => {
  const block = buildGroupTaskWorkingStateBlock({
    nowMs: NOW,
    steps: [
      { ordinal: 1, objective: 'done work', status: 'completed', assigneeName: 'Coder Bot' },
      { ordinal: 2, objective: 'failed work', status: 'failed', assigneeName: 'Coder Bot' },
      { ordinal: 3, objective: 'cancelled work', status: 'cancelled', assigneeName: 'Coder Bot' },
      { ordinal: 4, objective: 'waiting on owner verdict', status: 'waiting_input', assigneeName: 'Coder Bot' },
    ],
    attempts: [
      { status: 'completed', stepOrdinal: 1, workerName: 'Coder Bot' },
      { status: 'failed', stepOrdinal: 2, workerName: 'Coder Bot' },
      { status: 'cancelled', stepOrdinal: 3, workerName: 'Coder Bot' },
      { status: 'running', stepOrdinal: 4, workerName: 'Coder Bot', startedAt: iso(NOW - 60_000) },
      { status: 'timed_out', stepOrdinal: 4, workerName: 'Coder Bot', queuedAt: iso(NOW - 120_000) },
    ],
  });
  assert.ok(!block.includes('done work'));
  assert.ok(!block.includes('failed work'));
  assert.ok(!block.includes('cancelled work'));
  assert.match(block, /waiting on owner verdict/);
  assert.match(block, /Attempt \[running\] Coder Bot on step #4 — started /);
  assert.match(block, /Attempt \[timed_out\] Coder Bot on step #4 — queued /);
});

test('overdue entries sort first, then earliest deadline, then status', () => {
  const block = buildGroupTaskWorkingStateBlock({
    nowMs: NOW,
    steps: [
      { ordinal: 1, objective: 'no deadline queued step', status: 'queued', assigneeName: 'A' },
      { ordinal: 2, objective: 'later deadline step', status: 'running', assigneeName: 'B', deadlineAt: iso(NOW + 3_600_000) },
      { ordinal: 3, objective: 'earlier deadline step', status: 'running', assigneeName: 'C', deadlineAt: iso(NOW + 1_800_000) },
    ],
    attempts: [
      { status: 'running', stepOrdinal: 1, workerName: 'A', startedAt: iso(NOW - 60_000) },
    ],
    expectedDeliveries: [
      { memberName: 'Designer Bot', dueAtMs: NOW + 600_000, taskDescription: 'future delivery' },
      { memberName: 'Coder Bot', dueAtMs: NOW - 60_000, taskDescription: 'late delivery' },
    ],
  });
  const lines = block.split('\n').filter((line) => line.startsWith('- '));
  assert.match(lines[0], /\[OVERDUE\] Coder Bot owes a delivery/, 'overdue delivery heads the block');
  assert.match(lines[0], /late delivery/);
  assert.match(lines[1], /Designer Bot owes a delivery/, 'future delivery follows (earliest deadline of the rest)');
  assert.match(lines[2], /earlier deadline step/, 'then the earliest step deadline');
  assert.match(lines[3], /later deadline step/);
  assert.match(lines[4], /Attempt \[running\]/, 'no-deadline entries follow, status rank first (running)');
  assert.match(lines[5], /no deadline queued step/, 'queued step sorts after the running attempt');
});

test('entry cap drops the least-urgent tail and reports the omission', () => {
  const block = buildGroupTaskWorkingStateBlock({
    nowMs: NOW,
    expectedDeliveries: Array.from({ length: GROUP_WORKING_STATE_MAX_ENTRIES + 3 }, (_, index) => ({
      memberName: `Bot ${index}`,
      dueAtMs: NOW + (index + 1) * 60_000,
      taskDescription: `delivery-${index}`,
    })),
  });
  const lines = block.split('\n').filter((line) => line.startsWith('- '));
  assert.equal(lines.length, GROUP_WORKING_STATE_MAX_ENTRIES);
  assert.match(block, /3 least-urgent line\(s\) omitted/);
  assert.match(block, /delivery-0/, 'earliest deadline survives');
  assert.ok(!block.includes(`delivery-${GROUP_WORKING_STATE_MAX_ENTRIES + 2}`), 'latest deadline dropped');
});

test('char cap shrinks the tail until the block fits; objective truncation bounds each line', () => {
  const longObjective = `fetch ${'x'.repeat(400)}`;
  const capped = buildGroupTaskWorkingStateBlock({
    nowMs: NOW,
    maxChars: 800,
    steps: Array.from({ length: 6 }, (_, index) => ({
      ordinal: index + 1,
      objective: `step-${index} ${'o'.repeat(200)}`,
      status: 'queued',
      assigneeName: 'Coder Bot',
    })),
  });
  assert.ok(capped.length <= 800, `bounded by the char cap (got ${capped.length})`);
  assert.match(capped, /least-urgent line\(s\) omitted/);
  assert.match(capped, /step-0/, 'the earliest (most urgent) line survives the trim');
  assert.ok(!capped.includes('step-5'), 'the tail line dropped first');

  const truncated = buildGroupTaskWorkingStateBlock({
    nowMs: NOW,
    steps: [{ ordinal: 1, objective: longObjective, status: 'running', assigneeName: 'Coder Bot' }],
  });
  const line = truncated.split('\n').find((entry) => entry.startsWith('- '));
  assert.ok(line.endsWith('…'), 'long objectives end with an ellipsis');
  assert.ok(!line.includes('x'.repeat(200)), 'the 160-char objective cap holds');
});

test('free text is XML-escaped and whitespace-collapsed', () => {
  const block = buildGroupTaskWorkingStateBlock({
    nowMs: NOW,
    expectedDeliveries: [
      { memberName: 'A <b> & "c"', dueAtMs: NOW + 60_000, taskDescription: 'line1\nline2   spaced' },
    ],
  });
  assert.match(block, /A &lt;b&gt; &amp; &quot;c&quot; owes a delivery: "line1 line2 spaced"/);
});

// ---------------------------------------------------------------------------
// Daemon integration (compiled dist; real SqliteStore + stores)
// ---------------------------------------------------------------------------

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
const { OrchestrationStore } = require('../dist-electron/main/orchestrationStore.js');
const { CoworkStore } = require('../dist-electron/main/coworkStore.js');
const { GroupTaskOrchestrationBridge } = require('../dist-electron/main/services/groupTaskOrchestrationBridge.js');
const { createGroupTaskDaemonLoop } = require('../dist-electron/main/services/groupTaskDaemon.js');

Module._load = originalLoad;

const GROUP_ID = 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff00000000i0';
const BOSS_GMID = 'gmid-boss';
const EXPECTED_DELIVERY_PREFIX = 'group_task_expected_delivery:';

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-working-state-'));

const insertWallet = (db, id) => {
  db.run(
    `INSERT INTO metabot_wallets (id, mnemonic, path, created_at) VALUES (?, ?, ?, ?)`,
    [id, `abandon ability able about above absent absorb abstract absurd abuse access accident ${id}`, "m/44'/10001'/0'/0/0", 1700000000000 + id],
  );
};

const insertMetabot = (db, { id, walletId, name, type = 'worker', globalmetaid = null, bossGmid = null }) => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
      name, enabled, metaid, globalmetaid, metabot_type, created_by, role, soul,
      boss_global_metaid, llm_id, allow_chat_skills, bio, goal, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, walletId, `mvc-${id}`, `btc-${id}`, `doge-${id}`, `public-${id}`, `chat-public-${id}`,
      name, 1, `metaid-${id}`, globalmetaid, type, '0000', `${name} role`, `${name} soul`,
      bossGmid, null, '[]', null, null, 1700000000000 + id, 1700000000000 + id,
    ],
  );
};

const insertGroupMessage = (db, { pinId, groupId = GROUP_ID, senderMetaId, senderGlobalMetaId, senderName, content }) => {
  db.run(
    `INSERT INTO group_chat_messages (
      pin_id, tx_id, group_id, channel_id, sender_metaid, sender_global_metaid, sender_address,
      sender_name, sender_avatar, sender_chat_pubkey, protocol, content, content_type, encryption,
      reply_pin, mention, chain_timestamp, chain, raw_data, is_processed, msg_index
    ) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, '', '', '/protocols/simplegroupchat', ?, 'text/plain', NULL, '', '[]', NULL, 'mvc', '{}', 0, NULL)`,
    [pinId, pinId.replace(/-i0$/, ''), groupId, senderMetaId, senderGlobalMetaId, senderName, content],
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
  insertMetabot(db, { id: 1, walletId: 1, name: 'Twin Bot', type: 'twin', globalmetaid: 'gmid-twin', bossGmid: BOSS_GMID });
  insertMetabot(db, { id: 2, walletId: 1, name: 'Coder Bot', globalmetaid: 'gmid-w2' });
  insertMetabot(db, { id: 3, walletId: 1, name: 'Designer Bot', globalmetaid: 'gmid-w3' });

  const chatCalls = [];
  const skillTurnCalls = [];
  const state = { nowMs: 1_000_000_000_000 };
  const orchestrationBridge = new GroupTaskOrchestrationBridge({
    groupTaskStore,
    orchestrationStore,
    getMetabotById: (id) => metabotStore.getMetabotById(id),
  });

  const target = createGroupTaskDaemonLoop({
    getStore: () => store,
    getGroupTaskStore: () => groupTaskStore,
    getMetabotStore: () => metabotStore,
    getCoworkStore: () => coworkStore,
    orchestrationBridge,
    performChat: async (systemPrompt, userMessage, llmId) => {
      chatCalls.push({ systemPrompt, userMessage, llmId });
      return `reply-for-${llmId}`;
    },
    postGroupTaskMessage: async (taskId, metabotId, content) => ({ pinId: `send-pin-${taskId}-${metabotId}` }),
    getChatSkillsRoutingPrompt: async () =>
      overrides.routing ?? { prompt: null, activeSkillIds: [] },
    runSkillTurn: async (params) => {
      skillTurnCalls.push(params);
      return { replyText: 'skill-turn-reply', assistantMessageId: 'asst-1' };
    },
    emitTaskEvent: () => {},
    emitLog: () => {},
    now: () => state.nowMs,
    workerCooldownMs: 20_000,
    chairCooldownMs: 10_000,
    replyBudget: 40,
    maxRepliesPerTaskPerTick: 3,
    chairPlanRosterSettleMs: 0,
    chairPlanRosterCapMs: 0,
  });
  const loop = {
    ...target,
    runTick: async () => {
      await target.runTick();
      await target.whenIdle();
    },
  };

  const createTask = (workerIds = [2]) => {
    const task = groupTaskStore.createTask({
      groupId: GROUP_ID, title: 'Build MetaApp', goal: 'Build and publish the intro MetaApp',
      acceptanceCriteria: 'Preview URL works', chairMetabotId: 1, createdBy: 'user', createPinId: 'pin-create',
    });
    groupTaskStore.addMember({ taskId: task.id, metabotId: 1, globalmetaid: 'gmid-twin', role: 'chair', joinedPinId: 'pin-create' });
    for (const workerId of workerIds) {
      groupTaskStore.addMember({ taskId: task.id, metabotId: workerId, role: 'worker' });
    }
    groupTaskStore.updateTaskStatus(task.id, 'executing');
    return groupTaskStore.getTaskById(task.id);
  };

  return {
    store, db, metabotStore, groupTaskStore, orchestrationStore, coworkStore, orchestrationBridge,
    loop, chatCalls, skillTurnCalls, state, createTask,
    cleanup: () => store.close(),
  };
};

test('daemon: durable assignments and delivery clocks ride the plain-path turn', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2, 3]);
    // Seed durable state: one queued assignment for Coder Bot via the canonical
    // bridge, one overdue delivery clock for Designer Bot.
    h.orchestrationBridge.beginWorkerAttempt({
      groupTaskId: task.id,
      workerMetabotId: 2,
      objective: 'Fetch the four benchmark CSVs and normalize their columns',
      sourceMessageKey: 'seed-msg-1',
    });
    h.store.set(
      `${EXPECTED_DELIVERY_PREFIX}${task.id}:3`,
      JSON.stringify({ dueAt: h.state.nowMs - 60_000, ackedAt: h.state.nowMs - 600_000, taskDescription: 'Post the layout draft', assignmentMessageId: 9, chairStatedMinutes: 10 }),
    );

    insertGroupMessage(h.db, {
      pinId: 'ws-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-boss',
      senderName: 'Human', content: '@Coder Bot go',
    });
    await h.loop.runTick();

    const userMessage = h.chatCalls[0].userMessage;
    assert.match(userMessage, /<taskWorkingState>/, 'plain-path turn carries the working-state block');
    assert.match(userMessage, /\[OVERDUE\] Designer Bot owes a delivery: "Post the layout draft"/);
    assert.match(userMessage, /Step #1 \[queued\] Coder Bot: Fetch the four benchmark CSVs/);
  } finally {
    h.cleanup();
  }
});

test('daemon: the same block reaches the skill path (shared volatileContext)', async () => {
  const h = await createHarness({ routing: { prompt: 'skill routing prompt', activeSkillIds: ['skill-x'] } });
  try {
    const task = h.createTask([2]);
    h.store.set(
      `${EXPECTED_DELIVERY_PREFIX}${task.id}:2`,
      JSON.stringify({ dueAt: h.state.nowMs + 600_000, ackedAt: h.state.nowMs, taskDescription: null, assignmentMessageId: null, chairStatedMinutes: 10 }),
    );
    insertGroupMessage(h.db, {
      pinId: 'ws-skill-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-boss',
      senderName: 'Human', content: '@Coder Bot go',
    });
    await h.loop.runTick();

    assert.ok(h.skillTurnCalls.length >= 1, 'routing hit runs the skill turn');
    assert.match(h.skillTurnCalls[0].userMessage, /<taskWorkingState>/);
    assert.match(h.skillTurnCalls[0].userMessage, /Coder Bot owes a delivery — due /);
    assert.equal(h.chatCalls.length, 0, 'plain completion never ran');
  } finally {
    h.cleanup();
  }
});

test('daemon: nothing open -> no working-state block', async () => {
  const h = await createHarness();
  try {
    h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'ws-empty-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-boss',
      senderName: 'Human', content: '@Coder Bot go',
    });
    await h.loop.runTick();
    assert.ok(h.chatCalls.length >= 1);
    assert.ok(!h.chatCalls[0].userMessage.includes('<taskWorkingState>'), 'empty ledger renders no block');
  } finally {
    h.cleanup();
  }
});
