/**
 * Round-5 daemon protocol tests: P0-2 worker ACK (post + kv dedupe),
 * P0-1 review-phase dispatch silence hint, P2-6 [DEPENDS_ON] gate, and
 * P2-8 multi-driver kv mutex.
 *
 * Harness mirrors groupTaskDaemon.test.mjs (same electron mock + stores) and
 * additionally keeps the loop deps so a SECOND daemon loop can be created over
 * the SAME kv/store to exercise the driver mutex.
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
const { createGroupTaskDaemonLoop, gateChairDrivingSend } = require('../dist-electron/main/services/groupTaskDaemon.js');

Module._load = originalLoad;

const GROUP_ID = 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff00000000i0';
const BOSS_GMID = 'gmid-boss';
const UPSTREAM_PINID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaai0';

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-group-daemon-protocol-'));

const insertWallet = (db, id) => {
  db.run(
    `INSERT INTO metabot_wallets (id, mnemonic, path, created_at)
     VALUES (?, ?, ?, ?)`,
    [id, `abandon ability able about above absent absorb abstract absurd abuse access accident ${id}`, "m/44'/10001'/0'/0/0", 1700000000000 + id],
  );
};

const insertMetabot = (db, { id, walletId, name, type = 'worker', globalmetaid = null, bossGmid = null, allowChatSkills = null }) => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
      name, enabled, metaid, globalmetaid, metabot_type, created_by, role, soul,
      boss_global_metaid, allow_chat_skills, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, walletId, `mvc-${id}`, `btc-${id}`, `doge-${id}`, `public-${id}`, `chat-public-${id}`,
      name, 1, `metaid-${id}`, globalmetaid, type, '0000', `${name} role`, `${name} soul`,
      bossGmid, allowChatSkills ? JSON.stringify(allowChatSkills) : null,
      1700000000000 + id, 1700000000000 + id,
    ],
  );
};

const insertGroupMessage = (db, { pinId, senderMetaId, senderGlobalMetaId, senderName, content, mention = null, chainTimestamp = null }) => {
  db.run(
    `INSERT INTO group_chat_messages (
      pin_id, tx_id, group_id, channel_id, sender_metaid, sender_global_metaid, sender_address,
      sender_name, sender_avatar, sender_chat_pubkey, protocol, content, content_type, encryption,
      reply_pin, mention, chain_timestamp, chain, raw_data, is_processed, msg_index
    ) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, '', '', '/protocols/simplegroupchat', ?, 'text/plain', NULL, '', ?, ?, 'mvc', '{}', 0, NULL)`,
    [pinId, pinId.replace(/-i0$/, ''), GROUP_ID, senderMetaId, senderGlobalMetaId, senderName, content,
      mention ? JSON.stringify(mention) : '[]', chainTimestamp],
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
  insertMetabot(db, { id: 2, walletId: 1, name: 'Coder Bot', globalmetaid: 'gmid-w2', allowChatSkills: overrides.coderChatSkills ?? [] });
  insertMetabot(db, { id: 3, walletId: 1, name: 'Designer Bot', globalmetaid: 'gmid-w3' });

  const chatCalls = [];
  const sends = [];
  const routingCalls = [];
  const skillTurnCalls = [];
  const logs = [];
  const state = {
    nowMs: 1_000_000_000_000,
    chatErrorAlways: overrides.chatErrorAlways ?? null,
    routing: overrides.routing ?? null,
    chatReply: overrides.chatReply ?? null,
    skillReply: overrides.skillReply ?? null,
  };

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
    performChat: async (systemPrompt, userMessage, llmId) => {
      chatCalls.push({ systemPrompt, userMessage, llmId });
      if (state.chatErrorAlways) throw new Error(state.chatErrorAlways);
      return state.chatReply ?? `reply-for-${llmId}`;
    },
    postGroupTaskMessage: async (taskId, metabotId, content) => {
      sends.push({ taskId, metabotId, content });
      return { pinId: `send-pin-${sends.length}` };
    },
    getChatSkillsRoutingPrompt: async (input) => {
      routingCalls.push(input);
      return typeof state.routing === 'function'
        ? state.routing(input)
        : (state.routing ?? { prompt: null, activeSkillIds: [] });
    },
    runSkillTurn: async (params) => {
      skillTurnCalls.push(params);
      return { replyText: state.skillReply ?? 'skill-turn-reply', assistantMessageId: 'asst-fake-1' };
    },
    emitTaskEvent: () => {},
    emitLog: (msg) => logs.push(msg),
    now: () => state.nowMs,
    workerCooldownMs: overrides.workerCooldownMs ?? 20_000,
    chairCooldownMs: overrides.chairCooldownMs ?? 10_000,
    replyBudget: overrides.replyBudget ?? 40,
    maxRepliesPerTaskPerTick: overrides.maxRepliesPerTaskPerTick ?? 3,
    ...(overrides.disableChairPlanningTurn != null ? { disableChairPlanningTurn: overrides.disableChairPlanningTurn } : {}),
    ...(overrides.autoAckWorkerDispatch != null ? { autoAckWorkerDispatch: overrides.autoAckWorkerDispatch } : {}),
    ...(overrides.dependencyWaitMaxMs != null ? { dependencyWaitMaxMs: overrides.dependencyWaitMaxMs } : {}),
    ...(overrides.driverGraceMs != null ? { driverGraceMs: overrides.driverGraceMs } : {}),
    ...(overrides.readPinForVerification != null ? { readPinForVerification: overrides.readPinForVerification } : {}),
    ...(overrides.readPinSecondaryForVerification != null ? { readPinSecondaryForVerification: overrides.readPinSecondaryForVerification } : {}),
  };

  const loop = createGroupTaskDaemonLoop(loopDeps);

  const createTask = (workerIds = [2, 3], opts = {}) => {
    const task = groupTaskStore.createTask({
      groupId: GROUP_ID, title: 'Build MetaApp', goal: 'Build and publish the intro MetaApp',
      acceptanceCriteria: 'Preview URL works', chairMetabotId: 1, createdBy: 'user', createPinId: 'pin-create',
    });
    groupTaskStore.addMember({ taskId: task.id, metabotId: 1, globalmetaid: 'gmid-twin', role: 'chair', joinedPinId: 'pin-create' });
    for (const workerId of workerIds) {
      groupTaskStore.addMember({ taskId: task.id, metabotId: workerId, role: 'worker' });
    }
    if (opts.activate !== false) {
      groupTaskStore.updateTaskStatus(task.id, 'executing', { actor: { kind: 'chair' } });
    }
    return groupTaskStore.getTaskById(task.id);
  };

  return {
    store, db, metabotStore, groupTaskStore, orchestrationStore, coworkStore,
    loop, chatCalls, sends, routingCalls, skillTurnCalls, logs, state, createTask,
    /** A SECOND daemon loop over the SAME stores/kv (multi-instance mutex). */
    makeSecondLoop: () => createGroupTaskDaemonLoop(loopDeps),
    cleanup: () => store.close(),
  };
};

// ---------------------------------------------------------------------------
// P0-2: worker ACK
// ---------------------------------------------------------------------------

test('auto-ACK: worker skill-turn dispatch posts [WORKING] before the turn; kv guard prevents double-ACK on reprocess', async () => {
  const h = await createHarness({
    coderChatSkills: ['web-search'],
    routing: () => ({ prompt: '<available_skills>web-search</available_skills>', activeSkillIds: ['web-search'] }),
  });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'ack-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot 配图任务，请开始',
    });
    await h.loop.runTick();

    assert.equal(h.sends.length, 2, 'ACK + turn reply');
    assert.match(h.sends[0].content, /^\[WORKING\]/, 'ACK starts with the [WORKING] tag');
    assert.equal(h.sends[1].content, 'skill-turn-reply');
    const ackKey = `group_task_ack:${task.id}:2:${h.groupTaskStore.listGroupChatMessages(GROUP_ID, { limit: 1 })[0].id}`;
    assert.equal(h.store.get(ackKey), '1', 'ACK kv guard written');

    // Rewind the cursor so the SAME message reprocesses (simulating a retry):
    // the guard must suppress a second ACK while the turn still runs. Direct
    // SQL because updateLastProcessedMsgId is monotonic by design.
    h.state.nowMs += 25_000; // escape the worker cooldown
    h.db.run('UPDATE group_tasks SET last_processed_msg_id = 0 WHERE id = ?', [task.id]);
    await h.loop.runTick();

    const ackCount = h.sends.filter((s) => s.content.startsWith('[WORKING]')).length;
    assert.equal(ackCount, 1, 'exactly one ACK despite reprocessing');
    assert.equal(h.sends.length, 3, 'ACK + two turn replies');
  } finally {
    h.cleanup();
  }
});

test('auto-ACK: disabled via deps flag — no ACK posted', async () => {
  const h = await createHarness({
    coderChatSkills: ['web-search'],
    routing: () => ({ prompt: '<available_skills>x</available_skills>', activeSkillIds: ['x'] }),
    autoAckWorkerDispatch: false,
  });
  try {
    h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'noack-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot do the work',
    });
    await h.loop.runTick();
    assert.deepEqual(h.sends.map((s) => s.content), ['skill-turn-reply'], 'no ACK when disabled');
  } finally {
    h.cleanup();
  }
});

test('P14: chair protocol messages (carrying [DELIVERABLE]/[STATUS:] tags) never auto-ACK', async () => {
  const h = await createHarness({
    coderChatSkills: ['web-search'],
    routing: () => ({ prompt: '<available_skills>x</available_skills>', activeSkillIds: ['x'] }),
  });
  try {
    h.createTask([2]);
    // A chair note that both mentions the worker and carries a protocol tag is
    // coordination, not an assignment (task #22: template ACKs quoting status
    // notes as "assignments").
    insertGroupMessage(h.db, {
      pinId: 'chair-status-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot [DELIVERABLE] 已收到上游成果，稍后派工',
    });
    await h.loop.runTick();
    assert.equal(
      h.sends.filter((s) => s.content.startsWith('[WORKING]')).length,
      0,
      'no template ACK for a protocol-tagged chair note',
    );
    assert.ok(h.logs.some((line) => line.includes('auto-ACK suppressed')));
  } finally {
    h.cleanup();
  }
});

test('P14: no stale 已接单 ACK after the worker already delivered past the assignment', async () => {
  const h = await createHarness({
    coderChatSkills: ['web-search'],
    routing: () => ({ prompt: '<available_skills>x</available_skills>', activeSkillIds: ['x'] }),
  });
  try {
    const task = h.createTask([2]);
    // Worker delivers first (deliverable row created now); the chair
    // coordination note that arrives afterwards must not produce an ACK
    // claiming the worker just accepted work (eleven's empty-assignment
    // ACK case in task #22).
    const deliveredPin = 'e'.repeat(64) + 'i0';
    insertGroupMessage(h.db, {
      pinId: 'done-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: `[DELIVERABLE] metafile: metafile://${deliveredPin}`,
      chainTimestamp: 100,
    });
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.listDeliverables(task.id).length, 1, 'deliverable recorded');

    insertGroupMessage(h.db, {
      pinId: 'late-chair-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot 整合进 MetaApp', chainTimestamp: 101,
    });
    h.state.nowMs += 25_000; // escape the worker cooldown
    await h.loop.runTick();
    assert.equal(
      h.sends.filter((s) => s.content.startsWith('[WORKING]')).length,
      0,
      'no ACK claiming un-started work after delivery',
    );
  } finally {
    h.cleanup();
  }
});

test('P5: roll-call (请确认在线) mentions arm no ACK watch — no false no-ACK warning', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'rollcall-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot:请确认在线(每人一次即可,无需客套)。',
    });
    await h.loop.runTick();
    assert.ok(h.logs.some((line) => line.includes('roll-call mention') && line.includes('no ACK watch armed')));
    // Long past the 3-minute ACK timeout: no chair warning may fire (task #21
    // falsely warned about members who were merely waiting/observing).
    h.state.nowMs += 10 * 60 * 1000;
    await h.loop.runTick();
    assert.equal(
      h.sends.filter((s) => s.content.includes('has not sent a [WORKING] ACK')).length,
      0,
      'no false no-ACK reminder for a roll-call mention',
    );
  } finally {
    h.cleanup();
  }
});

test('P5: a standby (observer) member mentioned by the chair arms no ACK watch', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    h.groupTaskStore.setMemberStatus(task.id, 2, 'standby', 'gmid-w2');
    insertGroupMessage(h.db, {
      pinId: 'standby-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot 请旁观本次验收整理',
    });
    await h.loop.runTick();
    assert.ok(h.logs.some((line) => line.includes('standing by') && line.includes('no ACK watch')));
    h.state.nowMs += 10 * 60 * 1000;
    await h.loop.runTick();
    assert.equal(
      h.sends.filter((s) => s.content.includes('has not sent a [WORKING] ACK')).length,
      0,
      'no false no-ACK reminder for an observer',
    );
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// P0-1: review-phase silence hint
// ---------------------------------------------------------------------------

test('review-phase dispatch to workers logs the silence hint and never replies', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    h.groupTaskStore.updateTaskStatus(task.id, 'review', { actor: { kind: 'chair' } });
    insertGroupMessage(h.db, {
      pinId: 'review-dispatch-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot please do the extra task',
    });
    await h.loop.runTick();

    assert.equal(h.sends.length, 0, 'review phase: no worker reply');
    assert.ok(
      h.logs.some((line) => line.includes('review-phase silence') && line.includes('Coder Bot')),
      'daemon logs the silenced dispatch so the chair knows why',
    );
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// P2-6: [DEPENDS_ON] gate
// ---------------------------------------------------------------------------

test('[DEPENDS_ON] holds the worker dispatch until the upstream deliverable lands', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'dep-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: `@Coder Bot 写文案 [DEPENDS_ON: ${UPSTREAM_PINID}] 等上游交付后再动笔`,
    });
    await h.loop.runTick();
    assert.equal(h.sends.length, 0, 'dispatch held while the upstream deliverable is missing');

    // Upstream deliverable lands (from a worker; [DELIVERABLE] tag).
    insertGroupMessage(h.db, {
      pinId: 'upstream-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: `[DELIVERABLE] metaapp: metaapp://${UPSTREAM_PINID}`,
    });
    await h.loop.runTick(); // deliverable recorded (+ chair verifies it)
    await h.loop.runTick(); // deferred worker dispatch proceeds

    const workerSends = h.sends.filter((s) => s.metabotId === 2);
    assert.equal(workerSends.length, 1, 'deferred dispatch proceeds after the upstream deliverable arrives');
    assert.match(workerSends[0].content, /^reply-for-/);
    assert.ok(
      h.logs.some((line) => line.includes('waits for upstream deliverable')),
      'host logs the dependency hold',
    );
  } finally {
    h.cleanup();
  }
});

test('[DEPENDS_ON] bounded wait times out and proceeds anyway', async () => {
  const h = await createHarness({ dependencyWaitMaxMs: 1_000 });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'dep-timeout-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: `@Coder Bot step B [DEPENDS_ON: ${UPSTREAM_PINID}]`,
    });
    await h.loop.runTick();
    assert.equal(h.sends.length, 0, 'held initially');

    h.state.nowMs += 2_000; // past the 1s wait bound
    await h.loop.runTick();
    await h.loop.runTick();

    assert.equal(h.sends.length, 1, 'dispatch proceeds after the bounded wait expires');
    assert.ok(h.logs.some((line) => line.includes('timed out')), 'timeout logged');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// P2-8: multi-driver mutex
// ---------------------------------------------------------------------------

test('driver mutex: only the claiming instance drives a task; stale claims are taken over', async () => {
  const h = await createHarness({ driverGraceMs: 20_000, disableChairPlanningTurn: true });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'mutex-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot research the topic',
    });

    const loopA = h.loop;
    const loopB = h.makeSecondLoop();

    // Tick A: claims the driver and replies; tick B (same instant): yields.
    await loopA.runTick();
    await loopB.runTick();
    assert.equal(h.sends.length, 1, 'exactly ONE reply — the second instance yielded');
    assert.ok(
      h.logs.some((line) => line.includes('yields this tick')),
      'yielding instance logs the mutex wait',
    );

    // Stale claim takeover: advance past the grace window, tick B drives.
    h.state.nowMs += 25_000;
    await loopB.runTick();
    assert.equal(h.sends.length, 1, 'no new messages -> no new replies');

    // Fresh dispatch while B holds a fresh claim: A yields, B replies.
    insertGroupMessage(h.db, {
      pinId: 'mutex2-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot follow-up question',
    });
    await loopA.runTick(); // A yields (B's claim is fresh)
    await loopB.runTick(); // B drives
    assert.equal(h.sends.length, 2, 'only the current driver replied to the follow-up');
  } finally {
    h.cleanup();
  }
});

test('driver mutex: same instance refreshes its own lease instead of yielding', async () => {
  const h = await createHarness({ driverGraceMs: 20_000, disableChairPlanningTurn: true });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'lease-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot one more task',
    });
    await h.loop.runTick();
    assert.equal(h.sends.length, 1);

    h.state.nowMs += 10_000; // still inside the grace window
    await h.loop.runTick(); // same instance: refreshes lease, drives normally
    assert.equal(h.sends.length, 1, 'no duplicate reply on the same message');
    assert.ok(
      !h.logs.some((line) => line.includes('yields this tick')),
      'own lease never logs a yield',
    );
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// F2 (GT#11): manual chair sends participate in the driver claim
// ---------------------------------------------------------------------------

test('F2: manual chair driving send is rejected while the daemon claim is fresh, then takes the floor', async () => {
  const h = await createHarness({ driverGraceMs: 20_000, disableChairPlanningTurn: true });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'f2-drive-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot research the topic',
    });
    await h.loop.runTick(); // daemon drives -> its claim is fresh
    assert.equal(h.sends.length, 1);
    const rawClaim = h.store.get(`group_task_driver:${task.id}`);
    assert.ok(rawClaim, 'daemon holds a driver claim after driving');
    const [daemonDriverId] = rawClaim.split('|');

    // A manual chair session attempts a driving send while the claim is fresh.
    const rejected = gateChairDrivingSend({
      kv: h.store, taskId: task.id, senderMetabotId: 1, chairMetabotId: 1,
      driverId: 'manual-session-1', graceMs: 20_000, nowMs: h.state.nowMs + 5_000,
    });
    assert.equal(rejected.ok, false, 'manual driving send rejected while the daemon drives');
    assert.match(rejected.error, /being driven by another session/);
    assert.match(rejected.error, /retry in \d+s/);
    assert.equal(rejected.driverId, daemonDriverId);
    assert.ok(rejected.retryAfterMs > 0);

    // Grace expired -> the manual session takes the floor.
    const acquired = gateChairDrivingSend({
      kv: h.store, taskId: task.id, senderMetabotId: 1, chairMetabotId: 1,
      driverId: 'manual-session-1', graceMs: 20_000, nowMs: h.state.nowMs + 25_000,
    });
    assert.equal(acquired.ok, true, 'stale daemon claim -> manual session takes over');
    assert.equal(
      h.store.get(`group_task_driver:${task.id}`),
      `manual-session-1|${h.state.nowMs + 25_000}`,
    );

    // The daemon yields its tick while the manual claim stays fresh.
    h.state.nowMs += 30_000;
    insertGroupMessage(h.db, {
      pinId: 'f2-yield-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot follow-up research',
    });
    await h.loop.runTick();
    assert.equal(h.sends.length, 1, 'daemon does not double-drive while the manual session drives');
    assert.ok(h.logs.some((line) => line.includes('yields this tick')), 'daemon logs the mutex yield');

    // Manual claim stale -> the daemon resumes driving.
    h.state.nowMs += 40_000;
    await h.loop.runTick();
    assert.equal(h.sends.length, 2, 'daemon resumes driving after the manual claim expires');
  } finally {
    h.cleanup();
  }
});

test('F2: worker sends always pass the driving gate (no mutex for non-chair)', async () => {
  const h = await createHarness({ driverGraceMs: 20_000, disableChairPlanningTurn: true });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'f2-worker-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot research the topic',
    });
    await h.loop.runTick();
    assert.equal(h.sends.length, 1, 'daemon drives');

    // A worker ACK must never be blocked by the driver claim.
    const workerGate = gateChairDrivingSend({
      kv: h.store, taskId: task.id, senderMetabotId: 2, chairMetabotId: 1,
      driverId: 'worker-session', graceMs: 20_000, nowMs: h.state.nowMs + 3_000,
    });
    assert.deepEqual(workerGate, { ok: true }, 'worker send passes the gate');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Issue #8: deliverable ledger on-chain confirmation, driven by multi-source
// verification — the record-time path and the monitor re-verification path.
// ---------------------------------------------------------------------------

test('Issue #8: [DELIVERABLE] with an on-chain-found pin records confirmation=confirmed (pending acceptance)', async () => {
  const foundPin = 'b'.repeat(64) + 'i0';
  const h = await createHarness({
    readPinForVerification: async (pinId) => (pinId === foundPin ? 'found' : 'not_found'),
  });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'deli-confirmed-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: `[DELIVERABLE] metaapp: metaapp://${foundPin}`,
    });
    await h.loop.runTick();

    const deliverables = h.groupTaskStore.listDeliverables(task.id);
    assert.equal(deliverables.length, 1, 'one deliverable row recorded');
    // The pin is verifiably on-chain, so the ledger says confirmed — and P3
    // (v1.1): a verified deliverable leaves 'pending' (status 'delivered'),
    // while the owner's acceptance verdict is still unwritten.
    assert.equal(deliverables[0].confirmation, 'confirmed');
    assert.equal(deliverables[0].status, 'delivered');
  } finally {
    h.cleanup();
  }
});

test('Issue #8: monitor re-verification drives unconfirmed -> confirmed once the pin lands on-chain', async () => {
  const foundPin = 'c'.repeat(64) + 'i0';
  let outcome = 'not_found';
  const h = await createHarness({
    readPinForVerification: async (pinId) => (pinId === foundPin ? outcome : 'not_found'),
  });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'deli-lagging-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: `[DELIVERABLE] metaapp: metaapp://${foundPin}`,
    });
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.listDeliverables(task.id)[0].confirmation, 'unconfirmed',
      'pin not found on-chain yet => unconfirmed');

    // The pin lands on-chain; the next monitor pass (retry window elapsed)
    // re-verifies and drives the ledger to confirmed.
    outcome = 'found';
    h.state.nowMs += 11 * 60 * 1000; // past the 10-minute verification retry window
    await h.loop.runTick();
    const deliverable = h.groupTaskStore.listDeliverables(task.id)[0];
    assert.equal(deliverable.confirmation, 'confirmed', 'monitor pass flips the ledger');
    assert.equal(deliverable.status, 'delivered', 'P3: verified via monitor leaves pending too');
  } finally {
    h.cleanup();
  }
});

test('P3: verified-but-pending legacy rows are backfilled to delivered by the monitor', async () => {
  const foundPin = 'd'.repeat(64) + 'i0';
  const h = await createHarness({
    readPinForVerification: async (pinId) => (pinId === foundPin ? 'found' : 'not_found'),
  });
  try {
    const task = h.createTask([2]);
    // Task #22 shape: a row recorded before the 'delivered' status existed —
    // verification report says verified, confirmation confirmed, but the enum
    // is stuck at 'pending'. Insert directly to simulate the legacy ledger.
    h.db.run(
      `INSERT INTO group_task_deliverables
         (task_id, msg_pin_id, author_globalmetaid, kind, uri, status, confirmation, verification)
       VALUES (?, 'legacy-i0', 'gmid-w2', 'metaapp', ?, 'pending', 'confirmed', ?)`,
      [task.id, `metaapp://${foundPin}`, JSON.stringify({ verified: true, checkedAt: Date.now() })],
    );
    await h.loop.runTick();
    const deliverable = h.groupTaskStore.listDeliverables(task.id)[0];
    assert.equal(deliverable.status, 'delivered', 'backfill flips the legacy verified row');
  } finally {
    h.cleanup();
  }
});
