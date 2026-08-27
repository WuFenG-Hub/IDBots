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
const { OpenTeamMembershipStore } = require('../dist-electron/main/openTeamMembershipStore.js');
const { OrchestrationStore } = require('../dist-electron/main/orchestrationStore.js');
const { CoworkStore } = require('../dist-electron/main/coworkStore.js');
const { GroupTaskOrchestrationBridge } = require('../dist-electron/main/services/groupTaskOrchestrationBridge.js');
const {
  decideGroupTaskResponders,
  createGroupTaskDaemonLoop,
  resolveDerivedAssignmentUpstream,
  buildOpenTeamPlanningStatusBlock,
  buildMemberJoinWelcomeText,
} = require('../dist-electron/main/services/groupTaskDaemon.js');
const { buildGroupTaskSystemPrompt } = require('../dist-electron/main/services/groupTaskPrompts.js');

Module._load = originalLoad;

const GROUP_ID = 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff00000000i0';
const BOSS_GMID = 'gmid-boss';

// Round-4: deliverable URIs must carry a full 64-hex + i0 pinid token.
const REAL_PINID_1 = `${'ab'.repeat(32)}i0`;
const REAL_PINID_2 = `${'cd'.repeat(32)}i0`;

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-group-task-daemon-'));

// ---------------------------------------------------------------------------
// Pure gating fixtures
// ---------------------------------------------------------------------------

const GATE_BOTS = new Map([
  [1, { id: 1, name: 'Twin Bot', metaid: 'metaid-1', globalmetaid: 'gmid-twin', boss_global_metaid: BOSS_GMID }],
  [2, { id: 2, name: 'Coder Bot', metaid: 'metaid-2', globalmetaid: 'gmid-w2', boss_global_metaid: BOSS_GMID }],
  [3, { id: 3, name: 'Designer Bot', metaid: 'metaid-3', globalmetaid: 'gmid-w3', boss_global_metaid: BOSS_GMID }],
]);

const GATE_MEMBERS = [
  { metabotId: 1, globalmetaid: 'gmid-twin', role: 'chair', name: 'Twin Bot' },
  { metabotId: 2, globalmetaid: 'gmid-w2', role: 'worker', name: 'Coder Bot' },
  { metabotId: 3, globalmetaid: 'gmid-w3', role: 'worker', name: 'Designer Bot' },
];
const gateMessage = (overrides = {}) => ({
  id: 1,
  senderMetaId: 'metaid-human',
  senderGlobalMetaId: 'gmid-human',
  senderName: 'Human',
  content: 'hello group',
  mention: null,
  // Round-4: gating tests exercise decision logic, not attribution — the
  // speaker is a non-member non-owner human, so attribution would flag it
  // SUSPECT; these fixtures pin senderSuspect=false explicitly.
  senderSuspect: false,
  ...overrides,
});

const gateTask = (status = 'executing') => ({ id: 1, status });

// ---------------------------------------------------------------------------
// Daemon loop harness
// ---------------------------------------------------------------------------

const insertWallet = (db, id) => {
  db.run(
    `INSERT INTO metabot_wallets (id, mnemonic, path, created_at) VALUES (?, ?, ?, ?)`,
    [id, `abandon ability able about above absent absorb abstract absurd abuse access accident ${id}`, "m/44'/10001'/0'/0/0", 1700000000000 + id]
  );
};

const insertMetabot = (db, { id, walletId, name, type = 'worker', globalmetaid = null, bossGmid = null, llmId = null, allowChatSkills = [], bio = null, goal = null }) => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
      name, enabled, metaid, globalmetaid, metabot_type, created_by, role, soul,
      boss_global_metaid, llm_id, allow_chat_skills, bio, goal, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, walletId, `mvc-${id}`, `btc-${id}`, `doge-${id}`, `public-${id}`, `chat-public-${id}`,
      name, 1, `metaid-${id}`, globalmetaid, type, '0000', `${name} role`, `${name} soul`,
      bossGmid, llmId, JSON.stringify(allowChatSkills), bio, goal, 1700000000000 + id, 1700000000000 + id,
    ]
  );
};

const insertGroupMessage = (db, { pinId, groupId = GROUP_ID, senderMetaId, senderGlobalMetaId, senderName, content, mention = null, replyPin = '', chainTimestamp = null }) => {
  db.run(
    `INSERT INTO group_chat_messages (
      pin_id, tx_id, group_id, channel_id, sender_metaid, sender_global_metaid, sender_address,
      sender_name, sender_avatar, sender_chat_pubkey, protocol, content, content_type, encryption,
      reply_pin, mention, chain_timestamp, chain, raw_data, is_processed, msg_index
    ) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, '', '', '/protocols/simplegroupchat', ?, 'text/plain', NULL, ?, ?, ?, 'mvc', '{}', 0, NULL)`,
    [pinId, pinId.replace(/-i0$/, ''), groupId, senderMetaId, senderGlobalMetaId, senderName, content,
      replyPin, mention ? JSON.stringify(mention) : '[]', chainTimestamp],
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
  insertMetabot(db, { id: 1, walletId: 1, name: 'Twin Bot', type: 'twin', globalmetaid: 'gmid-twin', bossGmid: BOSS_GMID, llmId: 'llm-1', bio: 'Coordinates the team', goal: 'Ship group tasks' });
  insertMetabot(db, { id: 2, walletId: 1, name: 'Coder Bot', globalmetaid: 'gmid-w2', llmId: 'llm-2', allowChatSkills: overrides.coderChatSkills ?? [], bio: 'Search and code specialist' });
  insertMetabot(db, { id: 3, walletId: 1, name: 'Designer Bot', globalmetaid: 'gmid-w3', llmId: 'llm-3', bio: 'Visual design' });
  insertMetabot(db, { id: 4, walletId: 1, name: 'Reviewer Bot', globalmetaid: 'gmid-w4', llmId: 'llm-4' });

  const chatCalls = [];
  const sends = [];
  const routingCalls = [];
  const skillTurnCalls = [];
  const events = [];
  const ownerReportCalls = [];
  const state = {
    nowMs: 1_000_000_000_000,
    chatError: overrides.chatError ?? null,
    chatErrorAlways: overrides.chatErrorAlways ?? null,
    routing: overrides.routing ?? null,
    chatReply: overrides.chatReply ?? null,
    skillReply: overrides.skillReply ?? null,
    ownerReportFails: overrides.ownerReportFails ?? false,
    ownerReportResult: overrides.ownerReportResult ?? null,
    pinOutcomes: overrides.pinOutcomes ?? {},
    sendFailures: overrides.sendFailures ?? null,
  };
  const seenChatErrors = new Set();
  const orchestrationBridge = new GroupTaskOrchestrationBridge({
    groupTaskStore,
    orchestrationStore,
    getMetabotById: (id) => metabotStore.getMetabotById(id),
  });

  const deps = {
    getStore: () => store,
    getGroupTaskStore: () => groupTaskStore,
    getMetabotStore: () => metabotStore,
    getCoworkStore: () => coworkStore,
    buildTeamCultureBlock: overrides.buildTeamCultureBlock ?? null,
    orchestrationBridge,
    performChat: async (systemPrompt, userMessage, llmId) => {
      chatCalls.push({ systemPrompt, userMessage, llmId });
      if (state.chatErrorAlways) {
        throw new Error(state.chatErrorAlways);
      }
      if (state.chatError && !seenChatErrors.has(state.chatError)) {
        seenChatErrors.add(state.chatError);
        throw new Error(state.chatError);
      }
      return state.chatReply ?? `reply-for-${llmId}`;
    },
    postGroupTaskMessage: async (taskId, metabotId, content, opts) => {
      sends.push({ taskId, metabotId, content, replyPin: opts?.replyPin });
      if (state.sendFailures?.has(metabotId)) {
        throw new Error(`on-chain send failed for bot ${metabotId}`);
      }
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
    emitTaskEvent: (payload) => {
      events.push(payload);
    },
    sendOwnerPrivateReport: async (params) => {
      ownerReportCalls.push(params);
      if (state.ownerReportFails) {
        throw new Error('owner chat public key unavailable');
      }
      return state.ownerReportResult ?? {
        pinId: `owner-report-pin-${ownerReportCalls.length}`,
        sessionId: `owner-report-session-${ownerReportCalls.length}`,
      };
    },
    readPinForVerification: async (pinId) => state.pinOutcomes[pinId] ?? 'unavailable',
    ...(overrides.listUserMemories ? { listUserMemories: overrides.listUserMemories } : {}),
    ...(overrides.listDailySummaries ? { listDailySummaries: overrides.listDailySummaries } : {}),
    ...(overrides.getMetaIDGroupCognitionPromptBlock
      ? { getMetaIDGroupCognitionPromptBlock: overrides.getMetaIDGroupCognitionPromptBlock }
      : {}),
    ...(overrides.resolveGlobalMetaId
      ? { resolveGlobalMetaId: overrides.resolveGlobalMetaId }
      : {}),
    ...(overrides.probeUrl ? { probeUrl: overrides.probeUrl } : { probeUrl: async () => null }),
    ...(overrides.readPinSecondaryForVerification
      ? { readPinSecondaryForVerification: overrides.readPinSecondaryForVerification }
      : {}),
    ...(overrides.verificationRetryMs != null
      ? { verificationRetryMs: overrides.verificationRetryMs }
      : {}),
    emitLog: overrides.emitLog ?? (() => {}),
    now: () => state.nowMs,
    workerCooldownMs: overrides.workerCooldownMs ?? 20_000,
    chairCooldownMs: overrides.chairCooldownMs ?? 10_000,
    replyBudget: overrides.replyBudget ?? 40,
    maxRepliesPerTaskPerTick: overrides.maxRepliesPerTaskPerTick ?? 3,
    ...(overrides.chairTwinSuppressWindowMs != null
      ? { chairTwinSuppressWindowMs: overrides.chairTwinSuppressWindowMs }
      : {}),
    ...(overrides.disableChairPlanningTurn != null
      ? { disableChairPlanningTurn: overrides.disableChairPlanningTurn }
      : {}),
    // F1 (GT#11): legacy tests add all members before the first tick, so the
    // roster-settle gate is off by default here; dedicated F1 tests override
    // settle/cap explicitly to exercise the mid-create race protection.
    ...(overrides.chairPlanRosterSettleMs != null
      ? { chairPlanRosterSettleMs: overrides.chairPlanRosterSettleMs }
      : { chairPlanRosterSettleMs: 0 }),
    ...(overrides.chairPlanRosterCapMs != null
      ? { chairPlanRosterCapMs: overrides.chairPlanRosterCapMs }
      : { chairPlanRosterCapMs: 0 }),
    ...(overrides.memberUnreachableAfterMinutes != null
      ? { memberUnreachableAfterMinutes: overrides.memberUnreachableAfterMinutes }
      : {}),
    ...(overrides.ackTimeoutMs != null
      ? { ackTimeoutMs: overrides.ackTimeoutMs }
      : {}),
    // Generic dep override seam (e.g. getOpenTeamMembershipStore for the #13
    // join-welcome tests); spreads last so tests can override anything above.
    ...(overrides.deps ? overrides.deps : {}),
  };
  const loop = createGroupTaskDaemonLoop(deps);

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
      groupTaskStore.updateTaskStatus(task.id, 'executing');
    }
    return groupTaskStore.getTaskById(task.id);
  };

  return {
    store, db, metabotStore, groupTaskStore, orchestrationStore, coworkStore, loop, deps,
    chatCalls, sends, routingCalls, skillTurnCalls, events, ownerReportCalls, state, createTask,
    cleanup: () => store.close(),
  };
};

// ---------------------------------------------------------------------------
// Gating matrix (pure)
// ---------------------------------------------------------------------------

test('gating: worker responds only when mentioned (by name or mention array)', () => {
  const byName = decideGroupTaskResponders(
    gateMessage({ content: '@Coder Bot please handle this' }),
    gateTask(), GATE_MEMBERS, GATE_BOTS,
  );
  assert.deepEqual(byName, [{ metabotId: 2, reason: 'worker_mentioned' }]);

  const byMentionArray = decideGroupTaskResponders(
    gateMessage({ content: 'please handle this', mention: JSON.stringify(['gmid-w2']) }),
    gateTask(), GATE_MEMBERS, GATE_BOTS,
  );
  assert.deepEqual(byMentionArray, [{ metabotId: 2, reason: 'worker_mentioned' }]);

  const byMetaIdInArray = decideGroupTaskResponders(
    gateMessage({ content: 'go', mention: JSON.stringify(['metaid-3']) }),
    gateTask(), GATE_MEMBERS, GATE_BOTS,
  );
  assert.deepEqual(byMetaIdInArray, [{ metabotId: 3, reason: 'worker_mentioned' }]);

  // name match is case-insensitive (word-boundary @ required)
  const byNameCase = decideGroupTaskResponders(
    gateMessage({ content: '@coder bot, take it' }),
    gateTask(), GATE_MEMBERS, GATE_BOTS,
  );
  assert.deepEqual(byNameCase, [{ metabotId: 2, reason: 'worker_mentioned' }]);

  // P0-3: a bare name WITHOUT the @ prefix is NOT a mention (kickoff roster
  // lines and recaps must not trigger replies). With nobody addressed it falls
  // to the chair's floor-control duty instead.
  const bareName = decideGroupTaskResponders(
    gateMessage({ content: 'coder bot, take it' }),
    gateTask(), GATE_MEMBERS, GATE_BOTS,
  );
  assert.deepEqual(bareName, [{ metabotId: 1, reason: 'chair_floor_control' }], 'bare name without @ must not trigger a worker');
});

test('gating: chair rules (a) mentioned, (b) owner message, (c) deliverable, (d) floor control', () => {
  // (a) chair mentioned (word-boundary @)
  assert.deepEqual(
    decideGroupTaskResponders(gateMessage({ content: '@Twin Bot, your call?' }), gateTask(), GATE_MEMBERS, GATE_BOTS),
    [{ metabotId: 1, reason: 'chair_mentioned' }],
  );
  // bare chair name without @ is not a mention (still may be floor control)
  assert.deepEqual(
    decideGroupTaskResponders(gateMessage({ content: 'Twin Bot, your call?' }), gateTask(), GATE_MEMBERS, GATE_BOTS),
    [{ metabotId: 1, reason: 'chair_floor_control' }],
  );

  // (b) owner message: no mention needed for the chair; workers get NO privilege
  assert.deepEqual(
    decideGroupTaskResponders(
      gateMessage({ senderGlobalMetaId: BOSS_GMID, content: 'status update please' }),
      gateTask(), GATE_MEMBERS, GATE_BOTS,
    ),
    [{ metabotId: 1, reason: 'chair_owner_message' }],
  );

  // (c) deliverable tag
  assert.deepEqual(
    decideGroupTaskResponders(
      gateMessage({ senderGlobalMetaId: 'gmid-w2', content: '[DELIVERABLE] metaapp: metaapp://pin1' }),
      gateTask(), GATE_MEMBERS, GATE_BOTS,
    ),
    [{ metabotId: 1, reason: 'chair_deliverable' }],
  );

  // (d) not addressed to any specific member -> chair floor control
  assert.deepEqual(
    decideGroupTaskResponders(gateMessage({ content: 'I have a general question about the goal' }), gateTask(), GATE_MEMBERS, GATE_BOTS),
    [{ metabotId: 1, reason: 'chair_floor_control' }],
  );
});

test('gating: message addressed only to one worker keeps the chair silent', () => {
  const decisions = decideGroupTaskResponders(
    gateMessage({ content: '@Designer Bot draft the layout' }),
    gateTask(), GATE_MEMBERS, GATE_BOTS,
  );
  assert.deepEqual(decisions, [{ metabotId: 3, reason: 'worker_mentioned' }]);

  // two workers addressed: both reply, chair still silent
  const twoWorkers = decideGroupTaskResponders(
    gateMessage({ content: '@Coder Bot @Designer Bot sync up' }),
    gateTask(), GATE_MEMBERS, GATE_BOTS,
  );
  assert.deepEqual(twoWorkers, [
    { metabotId: 2, reason: 'worker_mentioned' },
    { metabotId: 3, reason: 'worker_mentioned' },
  ]);
});

test('gating: self-skip, unmentioned local author, empty content, terminal task', () => {
  // chair's own message never triggers the chair (even with a deliverable tag)
  assert.deepEqual(
    decideGroupTaskResponders(
      gateMessage({ senderGlobalMetaId: 'gmid-twin', content: '[DELIVERABLE] my own note' }),
      gateTask(), GATE_MEMBERS, GATE_BOTS,
    ),
    [],
  );

  // local worker authored, mentions nobody: self-skip for that worker, others silent,
  // chair takes floor control (message not addressed to a specific member)
  assert.deepEqual(
    decideGroupTaskResponders(
      gateMessage({ senderGlobalMetaId: 'gmid-w2', content: 'I finished my part' }),
      gateTask(), GATE_MEMBERS, GATE_BOTS,
    ),
    [{ metabotId: 1, reason: 'chair_floor_control' }],
  );

  // empty content -> nobody
  assert.deepEqual(
    decideGroupTaskResponders(gateMessage({ content: '   ' }), gateTask(), GATE_MEMBERS, GATE_BOTS),
    [],
  );

  // terminal task -> nobody
  assert.deepEqual(
    decideGroupTaskResponders(gateMessage({ content: '@Coder Bot go' }), gateTask('done'), GATE_MEMBERS, GATE_BOTS),
    [],
  );
  assert.deepEqual(
    decideGroupTaskResponders(gateMessage({ content: '@Coder Bot go' }), gateTask('cancelled'), GATE_MEMBERS, GATE_BOTS),
    [],
  );
});

// ---------------------------------------------------------------------------
// Daemon loop
// ---------------------------------------------------------------------------

test('happy path: kickoff mentioning two workers triggers both, chair stays silent, sessions recorded', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2, 3]);
    insertGroupMessage(h.db, {
      pinId: 'kickoff-i0',
      senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin', senderName: 'Twin Bot',
      content: 'Team kickoff. @Coder Bot research options. @Designer Bot draft the layout.',
    });

    await h.loop.runTick();

    // both workers replied; chair (author) did not
    assert.deepEqual(h.sends.map((s) => s.metabotId).sort(), [2, 3]);
    assert.equal(h.chatCalls.length, 2);

    // prompts carry the task facts and the triggering-message marker
    const coderCall = h.chatCalls.find((c) => c.llmId === 'llm-2');
    assert.match(coderCall.systemPrompt, /Build MetaApp/);
    assert.match(coderCall.systemPrompt, /Preview URL works/);
    assert.match(coderCall.systemPrompt, /the worker of this task group/);
    assert.match(coderCall.userMessage, />>> Twin Bot: Team kickoff\..*<<< \(the message you are responding to\)/);
    assert.match(h.sends.find((s) => s.metabotId === 2).content, /reply-for-llm-2/);

    // R5: worker replies are threaded under the chair message that dispatched
    // them (replyPin injected by the host from the gating context).
    for (const workerId of [2, 3]) {
      assert.equal(
        h.sends.find((s) => s.metabotId === workerId).replyPin,
        'kickoff-i0',
        `worker ${workerId} reply carries the kickoff replyPin`,
      );
    }

    // sessions: one per (task, worker) on the metaweb_group_task channel
    for (const workerId of [2, 3]) {
      const mapping = h.coworkStore.getConversationMapping('metaweb_group_task', `group-task:${task.id}`, workerId);
      assert.ok(mapping, `mapping for worker ${workerId}`);
      const session = h.coworkStore.getSession(mapping.coworkSessionId);
      assert.equal(session.sessionType, 'group_task');
      assert.equal(session.metabotId, workerId);
      const messages = h.coworkStore.getSessionMessages(session.id);
      assert.deepEqual(messages.map((m) => m.type), ['user', 'assistant']);
      assert.match(messages[0].content, /recent group log/);
      assert.equal(messages[1].content, `reply-for-llm-${workerId}`);
    }

    // cursor advanced past the kickoff message
    const msgId = h.db.exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', ['kickoff-i0'])[0].values[0][0];
    assert.equal(h.groupTaskStore.getTaskById(task.id).lastProcessedMsgId, msgId);

    // The observable group execution is projected into canonical Worker steps.
    const canonicalId = h.groupTaskStore.getTaskById(task.id).orchestrationTaskId;
    const canonical = h.orchestrationStore.getTask(canonicalId);
    assert.equal(canonical.status, 'running');
    const steps = h.orchestrationStore.listSteps(canonical.id);
    assert.deepEqual(steps.map((step) => step.assigneeMetabotId).sort(), [2, 3]);
    assert.ok(steps.every((step) => step.status === 'waiting_input'));
    assert.ok(steps.every((step) => h.orchestrationStore.listAttempts(step.id)[0].status === 'completed'));
  } finally {
    h.cleanup();
  }
});

test('R7: a failed on-chain send injects a delivery-failure notice into the sender bot session', async () => {
  // Coder Bot's sends fail; its reply was already added to its session before
  // the send, so without R7 it would wrongly think it had spoken.
  const h = await createHarness({ sendFailures: new Set([2]) });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'kickoff-i0',
      senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin', senderName: 'Twin Bot',
      content: 'Team kickoff. @Coder Bot research options.',
    });
    await h.loop.runTick();

    // The send was attempted (and threw).
    assert.ok(h.sends.some((s) => s.metabotId === 2), 'coder reply send attempted');

    // R7: the failure notice is in Coder Bot's task session as a user turn.
    const mapping = h.coworkStore.getConversationMapping('metaweb_group_task', `group-task:${task.id}`, 2);
    assert.ok(mapping, 'coder session mapping exists');
    const session = h.coworkStore.getSession(mapping.coworkSessionId);
    const messages = h.coworkStore.getSessionMessages(session.id);
    const notice = messages.find((m) => /delivery-failure/i.test(m.content));
    assert.ok(notice, 'delivery-failure notice injected');
    assert.equal(notice.type, 'user');
    assert.match(notice.content, /NOT delivered to the group/);
    assert.match(notice.content, /on-chain send failed for bot 2/);
  } finally {
    h.cleanup();
  }
});

test('R6: stale [WORKING] local worker → timeout status + L3 owner brief (idempotent per streak)', async () => {
  const h = await createHarness({
    workerCooldownMs: 0,
    chairCooldownMs: 0,
    // Fast windows so the test doesn't wait real minutes.
    deps: { memberTimeoutAfterMinutes: 1, memberEscalateAfterMinutes: 1 },
  });
  try {
    const task = h.createTask([2]);
    // Worker 2 self-reports [WORKING] with a chain timestamp ~16.7 min in the
    // past (seconds), so both the L2 timeout window and the L3 escalation window
    // have already elapsed at the default nowMs (1_000_000_000_000).
    insertGroupMessage(h.db, {
      pinId: 'working-stale-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 已接单', chainTimestamp: 999_999_000,
    });
    h.groupTaskStore.setMemberStatus(task.id, 2, 'working', 'gmid-w2');
    // Advance the daemon cursor past the [WORKING] message so the tick doesn't
    // re-process it via handleMemberProtocolMarkers (which would re-mark working).
    const staleId = h.db.exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', ['working-stale-i0'])[0].values[0][0];
    h.groupTaskStore.updateLastProcessedMsgId(task.id, staleId);
    await h.loop.runTick();

    // L2: authoritative status flipped to unreachable (timeout signal).
    const member = h.groupTaskStore.listMembers(task.id).find((m) => m.metabotId === 2);
    assert.equal(member.status, 'unreachable');

    // L3: the owner was briefed once about the silent LOCAL member.
    assert.equal(h.ownerReportCalls.length, 1, 'L3 owner brief fired');
    assert.match(h.ownerReportCalls[0].text, /has been silent/);
    assert.match(h.ownerReportCalls[0].text, /Coder Bot/);

    // Idempotent: a second tick does not re-brief (per-streak kv guard).
    await h.loop.runTick();
    assert.equal(h.ownerReportCalls.length, 1, 'owner brief fires once per streak');
  } finally {
    h.cleanup();
  }
});

test('cursor advances on no-reply messages; a failing message holds the batch (fail-stop) until it recovers', async () => {
  // Cooldowns off: this test isolates the fail-stop/retry ordering semantics.
  const h = await createHarness({ workerCooldownMs: 0, chairCooldownMs: 0 });
  try {
    const task = h.createTask([2]);

    // chair talking (self-skip) -> no replies at all
    insertGroupMessage(h.db, {
      pinId: 'self-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: 'note to self, nobody addressed',
    });
    await h.loop.runTick();
    assert.equal(h.sends.length, 0);
    const selfId = h.db.exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', ['self-i0'])[0].values[0][0];
    assert.equal(h.groupTaskStore.getTaskById(task.id).lastProcessedMsgId, selfId);

    // First message blows up the LLM (one-shot error), second would succeed:
    // fail-stop — the later message waits BEHIND the failed one so its success
    // can never advance the cursor past the pending retry.
    h.state.chatError = 'llm exploded';
    insertGroupMessage(h.db, {
      pinId: 'boom-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot first attempt',
    });
    insertGroupMessage(h.db, {
      pinId: 'ok-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot second attempt',
    });
    await h.loop.runTick();

    assert.equal(h.chatCalls.length, 1, 'only the first message attempted; the batch stops at the failure');
    assert.equal(h.sends.length, 0, 'nothing sent while the first message fails');
    assert.equal(
      h.groupTaskStore.getTaskById(task.id).lastProcessedMsgId, selfId,
      'cursor held before the failing message (no leapfrog by the later clean message)',
    );

    // Next tick: the failed message recovers (one-shot error spent) and both
    // flow in order.
    await h.loop.runTick();
    assert.equal(h.chatCalls.length, 3, 'failed message retried, then the queued one');
    assert.equal(h.sends.length, 2);
    assert.match(h.chatCalls[1].userMessage, />>> Human: @Coder Bot first attempt <<</, 'retry keeps message order');
    assert.match(h.chatCalls[2].userMessage, />>> Human: @Coder Bot second attempt <<</);
    const okId = h.db.exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', ['ok-i0'])[0].values[0][0];
    assert.equal(h.groupTaskStore.getTaskById(task.id).lastProcessedMsgId, okId);
  } finally {
    h.cleanup();
  }
});

test('loop prevention: cooldown and per-tick cap', async () => {
  const h = await createHarness({ maxRepliesPerTaskPerTick: 2 });
  try {
    const task = h.createTask([2, 3, 4]);

    // one message mentions all three workers; per-tick cap = 2
    insertGroupMessage(h.db, {
      pinId: 'all-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot @Designer Bot @Reviewer Bot all hands',
    });
    await h.loop.runTick();
    assert.equal(h.sends.length, 2, 'per-tick cap stops the third worker');

    // P0-3c: the capped worker is DEFERRED, not dropped — the next tick
    // compensates it (its message is already behind the cursor). Coder's fresh
    // mention is still inside its 20s cooldown, so it stays deferred.
    insertGroupMessage(h.db, {
      pinId: 'again-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot again',
    });
    await h.loop.runTick();
    assert.equal(h.sends.length, 3, 'deferred third worker gets its turn on the next tick');
    assert.equal(h.sends.at(-1).metabotId, 4, 'compensation reply is from the capped Reviewer Bot');
    assert.equal(
      h.sends.filter((s) => s.metabotId === 2).length,
      1,
      'Coder Bot is still inside its cooldown; its mention is deferred, not dropped',
    );

    // past cooldown: the deferred 'again' mention finally flows, and the fresh
    // 'third' mention is deferred again (just replied).
    h.state.nowMs += 21_000;
    insertGroupMessage(h.db, {
      pinId: 'third-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot third',
    });
    await h.loop.runTick();
    assert.equal(h.sends.length, 4, 'deferred Coder reply compensates after cooldown');
    assert.equal(h.sends.at(-1).metabotId, 2);
  } finally {
    h.cleanup();
  }
});

test('loop prevention: reply budget per (task, bot)', async () => {
  const h = await createHarness({ replyBudget: 1 });
  try {
    h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'm1-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot one',
    });
    await h.loop.runTick();
    assert.equal(h.sends.length, 1);

    // budget exhausted (1): even after the cooldown, no more replies from this bot
    h.state.nowMs += 60_000;
    insertGroupMessage(h.db, {
      pinId: 'm2-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot two',
    });
    await h.loop.runTick();
    assert.equal(h.sends.length, 1, 'budget exhausted: no second reply');
  } finally {
    h.cleanup();
  }
});

test('chair reply does not count against the per-tick worker cap', async () => {
  const h = await createHarness({ maxRepliesPerTaskPerTick: 1 });
  try {
    h.createTask([2, 3]);
    // owner message mentions both workers: chair replies (owner privilege) + 1 worker (cap)
    insertGroupMessage(h.db, {
      pinId: 'boss-i0', senderMetaId: 'metaid-boss', senderGlobalMetaId: BOSS_GMID,
      senderName: 'Boss', content: '@Coder Bot @Designer Bot get started',
    });
    await h.loop.runTick();
    const workerSends = h.sends.filter((s) => s.metabotId !== 1);
    const chairSends = h.sends.filter((s) => s.metabotId === 1);
    assert.equal(chairSends.length, 1, 'chair replied to the owner message');
    assert.equal(workerSends.length, 1, 'worker cap = 1, chair reply not counted');
  } finally {
    h.cleanup();
  }
});

test('send failure is logged and swallowed; cursor still advances', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    const originalSend = h.sends;
    let attempt = 0;
    // rebuild a loop whose send throws
    const failingLoop = createGroupTaskDaemonLoop({
      getStore: () => h.store,
      getGroupTaskStore: () => h.groupTaskStore,
      getMetabotStore: () => h.metabotStore,
      getCoworkStore: () => h.coworkStore,
      performChat: async () => 'reply-text',
      postGroupTaskMessage: async () => {
        attempt += 1;
        throw new Error('chain offline');
      },
      emitLog: () => {},
      now: () => h.state.nowMs,
    });
    insertGroupMessage(h.db, {
      pinId: 'fail-send-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot say hi',
    });
    await failingLoop.runTick();
    assert.equal(attempt, 1, 'send was attempted');
    assert.equal(originalSend.length, 0, 'no successful sends recorded');
    const msgId = h.db.exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', ['fail-send-i0'])[0].values[0][0];
    assert.equal(h.groupTaskStore.getTaskById(task.id).lastProcessedMsgId, msgId, 'cursor advanced despite send failure');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Protocol tags ([DELIVERABLE] / [STATUS]) and skill turns
// ---------------------------------------------------------------------------

test('deliverable tags: kind inference, uri extraction, author recorded, dedupe by msg_pin_id', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    const cases = [
      { pinId: 'd1-i0', content: '[DELIVERABLE] metafile: metafile://ababababababababababababababababababababababababababababababababi0.png see this', kind: 'metafile', uri: 'metafile://ababababababababababababababababababababababababababababababababi0.png' },
      { pinId: 'd2-i0', content: '[DELIVERABLE] metaapp: metaapp://cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdi0 is live', kind: 'metaapp', uri: 'metaapp://cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdi0' },
      { pinId: 'd3-i0', content: '[DELIVERABLE] url: https://example.com/preview', kind: 'url', uri: 'https://example.com/preview' },
      { pinId: 'd4-i0', content: '[deliverable] text summary: the work is done', kind: 'text', uri: null },
    ];
    for (const c of cases) {
      insertGroupMessage(h.db, {
        pinId: c.pinId, senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
        senderName: 'Coder Bot', content: c.content,
      });
    }
    await h.loop.runTick();

    const rows = h.groupTaskStore.listDeliverables(task.id);
    assert.equal(rows.length, 4);
    for (const c of cases) {
      const row = rows.find((r) => r.msgPinId === c.pinId);
      assert.ok(row, `deliverable for ${c.pinId}`);
      assert.equal(row.kind, c.kind, `${c.pinId} kind`);
      assert.equal(row.uri, c.uri, `${c.pinId} uri`);
      assert.equal(row.authorGlobalmetaid, 'gmid-w2');
      assert.equal(row.status, 'pending');
    }

    // reprocessing the same messages (cursor forced back) must not duplicate rows
    h.db.run('UPDATE group_tasks SET last_processed_msg_id = 0 WHERE id = ?', [task.id]);
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.listDeliverables(task.id).length, 4, 'dedupe by task_id + msg_pin_id');
  } finally {
    h.cleanup();
  }
});

test('status tags: chair-only, transitions, same-status silent, review->executing rework hatch', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2], { activate: false }); // stays 'planning'
    insertGroupMessage(h.db, {
      pinId: 's1-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[STATUS:REVIEW] worker trying to move it',
    });
    insertGroupMessage(h.db, {
      pinId: 's2-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '[STATUS:EXECUTING] work is underway',
    });
    insertGroupMessage(h.db, {
      pinId: 's3-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '[STATUS:EXECUTING] still underway',
    });
    insertGroupMessage(h.db, {
      pinId: 's4-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '[STATUS:REVIEW] goal looks met',
    });
    insertGroupMessage(h.db, {
      pinId: 's5-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '[STATUS:EXECUTING] rework needed after all',
    });
    await h.loop.runTick();

    // worker tag ignored; chair tags drive planning->executing->review->executing
    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'executing');
    assert.deepEqual(
      h.events
        .filter((e) => e.type === 'groupTask:statusChanged')
        .map((e) => ({ type: e.type, taskId: e.taskId, status: e.status })),
      [
        { type: 'groupTask:statusChanged', taskId: task.id, status: 'executing' },
        { type: 'groupTask:statusChanged', taskId: task.id, status: 'review' },
        { type: 'groupTask:statusChanged', taskId: task.id, status: 'executing' },
      ],
      'every real transition fires the event (incl. the review->executing rework hatch); same-status does not',
    );
    assert.ok(h.events.every((e) => typeof e.at === 'number'));
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// #13 join-welcome handshake + #14 closing ceremony
// ---------------------------------------------------------------------------

test('#13 welcome: remote member joining mid-task triggers ONE welcome broadcast (who + why + handshake @s)', async () => {
  const h = await createHarness();
  const membershipStore = new OpenTeamMembershipStore(h.db, h.store.getSaveFunction());
  h.deps.getOpenTeamMembershipStore = () => membershipStore;
  try {
    const task = h.createTask([2, 3]);
    // First tick snapshots the create-time roster (chair has a join pin here;
    // local workers carry none in this harness) — no welcome for it.
    await h.loop.runTick();
    assert.equal(h.sends.length, 0, 'create-time roster produces no welcome');

    // The invite row records WHY the remote member was invited; then the join
    // lands (member row with joined_pin_id appears — P1-2 watcher behavior).
    membershipStore.createInvite({
      taskId: task.id,
      groupId: GROUP_ID,
      inviteeGlobalmetaid: 'gmid-remote-fortune',
      inviteeName: 'Fortune Teller Master',
      invitePinId: 'invite-fortune',
      requiredSkills: ['占卜', '塔罗'],
    });
    h.groupTaskStore.addMember({
      taskId: task.id,
      metabotId: null,
      globalmetaid: 'gmid-remote-fortune',
      displayName: 'Fortune Teller Master',
      role: 'worker',
      joinedPinId: 'pin-join-fortune',
    });

    await h.loop.runTick();

    const welcome = h.sends.find((s) => s.metabotId === 1);
    assert.ok(welcome, 'welcome posted as the chair');
    assert.match(welcome.content, /欢迎 @Fortune Teller Master/);
    assert.match(welcome.content, /受邀参与:占卜, 塔罗/, 'invite required-skills explain why');
    assert.match(welcome.content, /先向群内打个招呼确认就位/);
    assert.match(welcome.content, /@Coder Bot/);
    assert.match(welcome.content, /@Designer Bot/);
    assert.match(welcome.content, /确认在线/);

    // Second tick: no duplicate welcome (kv-guarded), no new sends at all.
    const sendCount = h.sends.length;
    await h.loop.runTick();
    assert.equal(h.sends.length, sendCount, 'welcome fires exactly once');
  } finally {
    h.cleanup();
  }
});

test('#13 welcome: existing members reply once to the handshake and nothing replies back', async () => {
  const h = await createHarness({ workerCooldownMs: 0, chairCooldownMs: 0 });
  const membershipStore = new OpenTeamMembershipStore(h.db, h.store.getSaveFunction());
  h.deps.getOpenTeamMembershipStore = () => membershipStore;
  try {
    const task = h.createTask([2, 3]);
    await h.loop.runTick(); // snapshot tick
    h.groupTaskStore.addMember({
      taskId: task.id,
      metabotId: null,
      globalmetaid: 'gmid-remote-fortune',
      displayName: 'Fortune Teller Master',
      role: 'worker',
      joinedPinId: 'pin-join-fortune',
    });
    await h.loop.runTick(); // welcome posted, @s Coder Bot + Designer Bot

    const welcome = h.sends.find((s) => s.metabotId === 1);
    assert.ok(welcome, 'welcome posted');
    assert.equal(h.sends.length, 1, 'welcome tick posts only the welcome');

    // Simulate the on-chain round-trip: the welcome enters the group log.
    insertGroupMessage(h.db, {
      pinId: 'welcome-pin-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: welcome.content,
    });
    await h.loop.runTick();

    const replies = h.sends.filter((s) => s.metabotId !== 1);
    assert.deepEqual(
      replies.map((s) => s.metabotId).sort(),
      [2, 3],
      'existing members confirmed once (mention-gated reply to the welcome)',
    );

    // Their confirmations carry no mentions: no further replies, no loop.
    const count = h.sends.length;
    await h.loop.runTick();
    assert.equal(h.sends.length, count, 'handshake stops after one round');
  } finally {
    h.cleanup();
  }
});

test('#14 closing ceremony: review entry posts a system closing line as chair (never ends on worker [WORKING])', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]); // executing (planning->review is illegal by the state machine)
    // A worker's [WORKING] sits last in the log; the chair posts the bare tag.
    insertGroupMessage(h.db, {
      pinId: 'working-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 已接单，正在收尾',
      chainTimestamp: 100,
    });
    insertGroupMessage(h.db, {
      pinId: 'review-tag-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '[STATUS:REVIEW] goal looks met',
      chainTimestamp: 101,
    });
    await h.loop.runTick();

    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'review');
    const closing = h.sends.find((s) => s.metabotId === 1 && /进入验收阶段/.test(s.content));
    assert.ok(closing, 'review entry posts the system closing line as the chair');
    assert.match(closing.content, /任务「Build MetaApp」/);
    assert.doesNotMatch(closing.content, /#\d+/, 'R5: the ceremony refers to the task by title, not #id');
    // R1: the closing is now the host's deterministic acceptance summary — it
    // restates the goal and carries the deliverable list + 3-action guidance
    // ("把菜端上桌"), not the old fixed "所有步骤已完成 / 等待人类评审" string.
    assert.match(closing.content, /目标：Build and publish the intro MetaApp/);
    assert.match(closing.content, /成果清单：/);
    assert.match(closing.content, /无已核验交付物/);
    assert.match(closing.content, /①[\s\S]*②[\s\S]*③/);
    // R1: the summary is persisted as the single source of truth (version 1).
    const summary = h.groupTaskStore.getLatestAcceptanceSummary(task.id);
    assert.ok(summary, 'acceptance summary persisted on review entry');
    assert.equal(summary.version, 1);
    assert.equal(summary.goal, 'Build and publish the intro MetaApp');
    // The closing (chair identity) is the LAST posted message — never a worker [WORKING].
    assert.equal(h.sends[h.sends.length - 1].metabotId, 1);
  } finally {
    h.cleanup();
  }
});

test('Improvement #1: review entry captures the chair 【结论】 into the record and the group message', async () => {
  const h = await createHarness({ chatReply: '【结论】验收通过并结项\n\n叙述正文……' });
  try {
    const task = h.createTask([2]); // executing
    insertGroupMessage(h.db, {
      pinId: 'review-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '[STATUS:REVIEW] goal met', chainTimestamp: 101,
    });
    await h.loop.runTick();

    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'review');
    // The verdict is persisted on the summary record — the single authoritative
    // copy the card headline renders from.
    const summary = h.groupTaskStore.getLatestAcceptanceSummary(task.id);
    assert.ok(summary, 'summary persisted on review entry');
    assert.equal(summary.conclusion, '验收通过并结项');
    // The group 📦 message leads with the SAME string (no divergent copy).
    const closing = h.sends.find((s) => s.metabotId === 1 && /进入验收阶段/.test(s.content));
    assert.ok(closing, 'ceremony message posted');
    assert.match(closing.content, /^结论：验收通过并结项$/m);
  } finally {
    h.cleanup();
  }
});

test('Improvement #1: a failed owner report degrades to a conclusion-less ceremony (never blocks review)', async () => {
  const h = await createHarness({ ownerReportFails: true });
  try {
    const task = h.createTask([2]); // executing
    insertGroupMessage(h.db, {
      pinId: 'review-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '[STATUS:REVIEW] goal met', chainTimestamp: 101,
    });
    await h.loop.runTick();

    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'review');
    const summary = h.groupTaskStore.getLatestAcceptanceSummary(task.id);
    assert.ok(summary);
    assert.equal(summary.conclusion, null, 'no fabricated conclusion without the report');
    const closing = h.sends.find((s) => s.metabotId === 1 && /进入验收阶段/.test(s.content));
    assert.ok(closing, 'ceremony still posted despite the report failure');
    assert.ok(!closing.content.includes('结论：'), 'no conclusion line when none was captured');
  } finally {
    h.cleanup();
  }
});

test('#14 closing re-assert: a worker straggler landing after review entry is followed by the chair closing line again', async () => {  const h = await createHarness();
  try {
    const task = h.createTask([2]); // executing (planning->review is illegal)
    // Worker [WORKING] then chair [STATUS:REVIEW] -> review + closing ceremony.
    insertGroupMessage(h.db, {
      pinId: 'working-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] finishing up', chainTimestamp: 100,
    });
    insertGroupMessage(h.db, {
      pinId: 'review-tag-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '[STATUS:REVIEW] goal met', chainTimestamp: 101,
    });
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'review');
    const firstClosingCount = h.sends.filter(
      (s) => s.metabotId === 1 && /进入验收阶段/.test(s.content),
    ).length;
    assert.ok(firstClosingCount >= 1, 'closing ceremony posted on review entry');

    // The chair closing line lands on-chain, then a worker turn that was in
    // flight when review began finishes AFTER it — the group would now rest on
    // a worker's message instead of the host's.
    insertGroupMessage(h.db, {
      pinId: 'closing-landed-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: 'chair closing landed on chain', chainTimestamp: 102,
    });
    insertGroupMessage(h.db, {
      pinId: 'straggler-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: 'final build passed, uploading', chainTimestamp: 103,
    });
    await h.loop.runTick();

    const closings = h.sends.filter((s) => s.metabotId === 1 && /进入验收阶段/.test(s.content));
    assert.ok(
      closings.length > firstClosingCount,
      'chair re-asserted the closing line after the straggler',
    );
    assert.equal(h.sends[h.sends.length - 1].metabotId, 1, 'the chair, not the worker, is last');
    assert.match(h.sends[h.sends.length - 1].content, /进入验收阶段/);
    // P12 (v1.1): the re-assert is the COMPACT closing line only — the full
    // acceptance summary must never be re-posted per straggler (task #22 got
    // two identical >2000-char summaries this way).
    assert.doesNotMatch(h.sends[h.sends.length - 1].content, /成果清单：/);
    const summaryPosts = h.sends.filter((s) => s.metabotId === 1 && /成果清单：/.test(s.content)).length;
    assert.equal(summaryPosts, 1, 'exactly one full acceptance summary in the transcript');

    // Idempotent: a second tick with no NEW straggler does not re-assert again.
    const countAfter = h.sends.length;
    await h.loop.runTick();
    assert.equal(h.sends.length, countAfter, 're-assert fires once per straggler (kv-guarded)');
  } finally {
    h.cleanup();
  }
});

test('skill path: routing hit runs the skill turn in the existing session, plain path untouched', async () => {
  const h = await createHarness({
    coderChatSkills: ['web-search'],
    routing: () => ({ prompt: '<available_skills>web-search</available_skills>', activeSkillIds: ['web-search'] }),
  });
  try {
    const task = h.createTask([2, 3]);
    // Round-4: a member WORKER (Designer Bot) mentions a colleague — the
    // sender is neither boss nor chair, so the widened flag stays false.
    insertGroupMessage(h.db, {
      pinId: 'skill-i0', senderMetaId: 'metaid-3', senderGlobalMetaId: 'gmid-w3',
      senderName: 'Designer Bot', content: '@Coder Bot search for MetaID docs',
    });
    await h.loop.runTick();

    assert.equal(h.skillTurnCalls.length, 1, 'skill turn used');
    // P14 (v1.1): the sender is a fellow WORKER (Designer Bot), not the chair —
    // a worker mention is not an assignment, so no auto-ACK chat call runs and
    // no "[WORKING] 已接单" template may quote it as work (task #22 logged ~20
    // such mismatches). The plain completion itself is not called either.
    assert.equal(h.chatCalls.length, 0, 'no ACK chat call for a worker-originated mention');
    assert.equal(
      h.sends.filter((s) => s.content.startsWith('[WORKING]')).length,
      0,
      'no template ACK posted',
    );
    assert.equal(h.routingCalls[0].metabotId, 2, 'routing scoped to the responding bot');
    assert.equal(h.routingCalls[0].widened, false, 'human sender: no owner privilege');

    // ran inside the existing metaweb_group_task session for (task, worker)
    const mapping = h.coworkStore.getConversationMapping('metaweb_group_task', `group-task:${task.id}`, 2);
    assert.ok(mapping);
    assert.equal(h.skillTurnCalls[0].sessionId, mapping.coworkSessionId);
    assert.deepEqual(h.skillTurnCalls[0].activeSkillIds, ['web-search']);
    assert.match(h.skillTurnCalls[0].systemPrompt, /available_skills/);
    assert.match(h.skillTurnCalls[0].userMessage, />>> Designer Bot: @Coder Bot/);

    // P14 (v1.1): no [WORKING] ACK precedes the turn — the trigger came from
    // a fellow worker, not the chair, so no assignment context exists. Only
    // the skill-turn reply goes on-chain, posted as the worker bot.
    assert.equal(h.sends.length, 1, 'turn reply only (no auto-ACK for worker-originated trigger)');
    assert.equal(h.sends[0].metabotId, 2, 'reply posted as the worker bot');
    assert.equal(h.sends[0].content, 'skill-turn-reply');
    const messages = h.coworkStore.getSessionMessages(mapping.coworkSessionId);
    assert.deepEqual(messages.map((m) => m.type), ['user']);
  } finally {
    h.cleanup();
  }
});

test('skill path: no routing hit falls back to the plain completion', async () => {
  const h = await createHarness({ coderChatSkills: ['web-search'] }); // routing returns null prompt
  try {
    h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'plain-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot quick question',
    });
    await h.loop.runTick();

    assert.equal(h.skillTurnCalls.length, 0, 'skill turn not used');
    assert.equal(h.chatCalls.length, 1, 'plain completion used');
    assert.equal(h.sends.length, 1);
    assert.match(h.sends[0].content, /reply-for-llm-2/);
  } finally {
    h.cleanup();
  }
});

test('skill routing: owner message widens to the responding bot\'s full set', async () => {
  const h = await createHarness({
    routing: () => ({ prompt: '<available_skills>x</available_skills>', activeSkillIds: ['x'] }),
  });
  try {
    h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'boss-skill-i0', senderMetaId: 'metaid-boss', senderGlobalMetaId: BOSS_GMID,
      senderName: 'Boss', content: 'chair, give me a status summary',
    });
    await h.loop.runTick();

    assert.equal(h.routingCalls.length, 1, 'only the chair responds to the owner message');
    assert.equal(h.routingCalls[0].widened, true, 'owner privilege widens to the bot\'s full set');
    assert.equal(h.skillTurnCalls.length, 1);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Review-phase silence, mid-batch flip, and the [NO_REPLY] escape hatch
// ---------------------------------------------------------------------------

test('gating: review phase — workers never respond, chair only answers the owner', () => {
  const reviewTask = gateTask('review');

  // worker @-mentioned in review -> silent
  assert.deepEqual(
    decideGroupTaskResponders(
      gateMessage({ content: '@Coder Bot are you sure?' }),
      reviewTask, GATE_MEMBERS, GATE_BOTS,
    ),
    [],
  );
  // chair mentioned -> silent
  assert.deepEqual(
    decideGroupTaskResponders(
      gateMessage({ content: '@Twin Bot thanks!' }),
      reviewTask, GATE_MEMBERS, GATE_BOTS,
    ),
    [],
  );
  // floor control (unaddressed) -> silent
  assert.deepEqual(
    decideGroupTaskResponders(
      gateMessage({ content: 'a general afterthought' }),
      reviewTask, GATE_MEMBERS, GATE_BOTS,
    ),
    [],
  );
  // deliverable -> silent
  assert.deepEqual(
    decideGroupTaskResponders(
      gateMessage({ senderGlobalMetaId: 'gmid-w2', content: '[DELIVERABLE] metaapp: metaapp://pin9' }),
      reviewTask, GATE_MEMBERS, GATE_BOTS,
    ),
    [],
  );
  // owner message -> chair responds (acceptance dialogue)
  assert.deepEqual(
    decideGroupTaskResponders(
      gateMessage({ senderGlobalMetaId: BOSS_GMID, content: 'not quite — rework this part' }),
      reviewTask, GATE_MEMBERS, GATE_BOTS,
    ),
    [{ metabotId: 1, reason: 'chair_owner_message' }],
  );
});

test('mid-batch [STATUS:REVIEW] flip gates subsequent messages with the new status', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]); // executing
    insertGroupMessage(h.db, {
      pinId: 'pre-flip-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot wrap up your part',
    });
    insertGroupMessage(h.db, {
      pinId: 'flip-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '[STATUS:REVIEW] everything is in',
    });
    insertGroupMessage(h.db, {
      pinId: 'post-flip-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot one more thing',
    });
    await h.loop.runTick();

    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'review');
    const sends = h.sends.map((s) => [s.metabotId, s.content]);
    assert.deepEqual(
      sends.slice(0, 1),
      [[2, 'reply-for-llm-2']],
      'worker answered the pre-flip mention only; the post-flip mention is gated silent',
    );
    assert.equal(sends[1][0], 1, 'closing posted as the chair');
    assert.match(sends[1][1], /进入验收阶段/, 'closing line content');
    // P1-2: the swallowed post-flip dispatch now produces a host dispatch-held
    // notice (as the chair) instead of vanishing silently.
    assert.equal(sends.length, 3, 'closing line + dispatch-held notice for the gated mention');
    assert.match(sends[2][1], /\[GROUP_TASK_NOTICE:dispatch_held\]/, 'dispatch-held notice');
    assert.equal(
      h.chatCalls.filter((c) => c.llmId === 'llm-2').length, 1,
      'no LLM call for the post-flip message (the other call is the owner-report turn)',
    );
    assert.equal(h.ownerReportCalls.length, 1, 'review transition fired the owner report');
  } finally {
    h.cleanup();
  }
});

test('[NO_REPLY] plain path: suppressed on-chain, session kept, cooldown recorded', async () => {
  const h = await createHarness({ chatReply: '[NO_REPLY]' });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'nr1-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot thanks!',
    });
    await h.loop.runTick();

    assert.equal(h.chatCalls.length, 1, 'LLM was consulted');
    assert.equal(h.sends.length, 0, 'nothing went on-chain');
    // session continuity: user + assistant ([NO_REPLY]) both appended
    const mapping = h.coworkStore.getConversationMapping('metaweb_group_task', `group-task:${task.id}`, 2);
    assert.ok(mapping);
    const sessionMessages = h.coworkStore.getSessionMessages(mapping.coworkSessionId);
    assert.deepEqual(sessionMessages.map((m) => m.type), ['user', 'assistant']);
    assert.equal(sessionMessages[1].content, '[NO_REPLY]');

    // cooldown recorded: an immediate second mention never reaches the LLM
    insertGroupMessage(h.db, {
      pinId: 'nr2-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot and this one too',
    });
    await h.loop.runTick();
    assert.equal(h.chatCalls.length, 1, 'cooldown blocks the immediate follow-up');
    assert.equal(h.sends.length, 0);
  } finally {
    h.cleanup();
  }
});

test('[NO_REPLY] matching: trailing text and case variants suppressed; normal replies unaffected', async () => {
  const h = await createHarness();
  try {
    h.createTask([2]);
    const mentionAndTick = async (pinId) => {
      // Round-4: assignments come from the chair (twin) — the chair self-skips
      // and only the mentioned worker replies.
      insertGroupMessage(h.db, {
        pinId, senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
        senderName: 'Twin Bot', content: '@Coder Bot ping',
      });
      await h.loop.runTick();
      h.state.nowMs += 21_000; // step past the worker cooldown for the next case
    };

    h.state.chatReply = '[NO_REPLY] Thanks!';
    await mentionAndTick('v1-i0');
    assert.equal(h.sends.length, 0, 'tag with trailing text is suppressed');

    h.state.chatReply = '[no_reply]';
    await mentionAndTick('v2-i0');
    assert.equal(h.sends.length, 0, 'case-insensitive match');

    h.state.chatReply = 'Here is the actual result.';
    await mentionAndTick('v3-i0');
    assert.equal(h.sends.length, 1, 'normal reply goes on-chain');
    assert.equal(h.sends[0].content, 'Here is the actual result.');

    h.state.chatReply = 'I noted [NO_REPLY] in the log output';
    await mentionAndTick('v4-i0');
    assert.equal(h.sends.length, 2, 'mid-sentence [NO_REPLY] is not treated as a tag');
  } finally {
    h.cleanup();
  }
});

test('[NO_REPLY] also applies on the skill-turn path', async () => {
  const h = await createHarness({
    coderChatSkills: ['web-search'],
    routing: () => ({ prompt: '<available_skills>x</available_skills>', activeSkillIds: ['x'] }),
    skillReply: '[NO_REPLY]',
  });
  try {
    h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'nr-skill-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot run a search',
    });
    await h.loop.runTick();

    assert.equal(h.skillTurnCalls.length, 1, 'skill turn ran');
    // Entropy P0: the host auto-ACK is templated by default — the
    // "[WORKING] 已接单" signal still posts (the group must not see a silent
    // worker) but costs zero LLM calls; the phrased ACK is an opt-in knob.
    assert.equal(h.chatCalls.length, 0, 'ACK is templated — no chat call');
    assert.equal(h.sends.length, 1, 'ACK posted; the [NO_REPLY] turn reply suppressed on-chain');
    assert.match(h.sends[0].content, /^\[WORKING\]/, 'the only send is the ACK status line');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Chair planning turn, chair trust, and roster profiles
// ---------------------------------------------------------------------------

test('chair planning turn: fires once for a new planning task (kv, directive, roster profiles)', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2], { activate: false }); // planning
    await h.loop.runTick();

    assert.deepEqual(h.sends.map((s) => s.metabotId), [1], 'chair posted exactly one plan');
    assert.equal(h.store.get(`group_task_chair_planned:${task.id}`), '1');

    await h.loop.runTick();
    assert.equal(h.sends.length, 1, 'planning fires exactly once');

    const planningCall = h.chatCalls[0];
    assert.equal(planningCall.llmId, 'llm-1');
    assert.match(planningCall.userMessage, /SYSTEM planning directive/);
    assert.match(planningCall.userMessage, /recent group log/);
    assert.match(planningCall.userMessage, /\[STATUS:EXECUTING\]/);
    assert.match(planningCall.systemPrompt, /Roster profiles/);
    assert.match(planningCall.systemPrompt, /Search and code specialist/);

    const mapping = h.coworkStore.getConversationMapping('metaweb_group_task', `group-task:${task.id}`, 1);
    assert.ok(mapping, 'chair session on the metaweb_group_task channel');
    assert.deepEqual(
      h.coworkStore.getSessionMessages(mapping.coworkSessionId).map((m) => m.type),
      ['user', 'assistant'],
    );
  } finally {
    h.cleanup();
  }
});

test('chair planning turn: not attempted for executing tasks', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]); // executing
    await h.loop.runTick();
    assert.equal(h.sends.length, 0);
    assert.equal(h.chatCalls.length, 0);
    assert.equal(h.store.get(`group_task_chair_planned:${task.id}`), undefined);
  } finally {
    h.cleanup();
  }
});

test('chair planning turn: failures retry up to 3 attempts then give up', async () => {
  const h = await createHarness({ chatErrorAlways: 'llm offline' });
  try {
    const task = h.createTask([2], { activate: false });
    for (let i = 0; i < 5; i++) {
      await h.loop.runTick();
    }
    assert.equal(h.chatCalls.length, 3, 'three attempts, then silent');
    assert.equal(h.store.get(`group_task_chair_plan_attempts:${task.id}`), 3);
    assert.equal(h.store.get(`group_task_chair_planned:${task.id}`), undefined);
    assert.equal(h.sends.length, 0);
  } finally {
    h.cleanup();
  }
});

test('chair planning turn: [NO_REPLY] plan counts as a failed attempt', async () => {
  const h = await createHarness({ chatReply: '[NO_REPLY]' });
  try {
    const task = h.createTask([2], { activate: false });
    await h.loop.runTick();
    assert.equal(h.store.get(`group_task_chair_plan_attempts:${task.id}`), 1);
    assert.equal(h.store.get(`group_task_chair_planned:${task.id}`), undefined);
    assert.equal(h.sends.length, 0);
  } finally {
    h.cleanup();
  }
});

test('chair planning turn: posted plan flips status via [STATUS:EXECUTING] on round-trip', async () => {
  const h = await createHarness({
    chatReply: 'Plan: @Coder Bot research first, then hand off. [STATUS:EXECUTING]',
  });
  try {
    const task = h.createTask([2], { activate: false });
    await h.loop.runTick();
    assert.equal(h.sends.length, 1);
    assert.match(h.sends[0].content, /\[STATUS:EXECUTING\]/);
    assert.equal(
      h.groupTaskStore.getTaskById(task.id).status, 'planning',
      'status flips only when the plan round-trips through the listener',
    );

    insertGroupMessage(h.db, {
      pinId: 'plan-roundtrip-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: h.sends[0].content,
    });
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'executing');
    assert.ok(h.events.some((e) => e.status === 'executing'), 'transition event fired');
  } finally {
    h.cleanup();
  }
});

test('chair trust: worker responding to a chair-sender message gets widened routing', async () => {
  const h = await createHarness({
    routing: () => ({ prompt: '<available_skills>x</available_skills>', activeSkillIds: ['x'] }),
  });
  try {
    h.createTask([2]); // executing; chair is gmid-twin
    insertGroupMessage(h.db, {
      pinId: 'chair-assign-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot research the topic now',
    });
    await h.loop.runTick();

    assert.equal(h.routingCalls.length, 1);
    assert.equal(h.routingCalls[0].widened, true, 'chair assignments unlock the full skill set');
    assert.equal(h.skillTurnCalls.length, 1);
  } finally {
    h.cleanup();
  }
});

test('remote OpenTeam member joins the prompt roster; never produces a local reply', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    h.groupTaskStore.addMember({
      taskId: task.id,
      metabotId: null,
      globalmetaid: 'gmid-remote-alicia',
      displayName: 'Alicia Remote',
      role: 'worker',
      joinedPinId: 'pin-join-alicia',
    });

    // Local worker mentioned by the chair: its prompt roster must
    // include the remote teammate (annotated, exact name), and only the local
    // bot replies (the chair stays silent — it is the sender itself).
    // (Round-4 attribution: a non-member chain identity would be SUSPECT and
    // never trigger replies, so the sender is a task member.)
    insertGroupMessage(h.db, {
      pinId: 'mention-coder-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot please start the research',
    });
    await h.loop.runTick();

    const coderCall = h.chatCalls.find((call) => call.llmId === 'llm-2');
    assert.ok(coderCall, 'local worker replied to the mention');
    assert.match(coderCall.systemPrompt, /^- Alicia Remote \(worker, remote teammate via OpenTeam\)$/m);
    assert.match(coderCall.systemPrompt, /profile not available locally/);
    assert.ok(
      h.sends.every((send) => send.metabotId === 2),
      'remote member never generates a local send',
    );

    // A deliverable posted by the remote teammate (from its own machine)
    // still triggers the chair through the normal deliverable path.
    insertGroupMessage(h.db, {
      pinId: 'remote-deliverable-i0', senderMetaId: 'metaid-remote', senderGlobalMetaId: 'gmid-remote-alicia',
      senderName: 'Alicia Remote', content: '[DELIVERABLE] doc: metaapp://abc123',
    });
    await h.loop.runTick();

    const chairCall = h.chatCalls.find((call) => call.llmId === 'llm-1');
    assert.ok(chairCall, 'chair responds to a remote teammate deliverable');
    assert.match(chairCall.systemPrompt, /^- Alicia Remote \(worker, remote teammate via OpenTeam\)$/m);
    assert.match(chairCall.systemPrompt, /OpenTeam remote teammates/);
  } finally {
    h.cleanup();
  }
});

test('prompts: roster profiles include bio/role/goal with the length cap', () => {
  const longBio = `bio-start ${'x'.repeat(500)} bio-end`;
  const prompt = buildGroupTaskSystemPrompt({
    metabot: { name: 'Twin Bot' },
    task: { title: 'T', goal: 'G' },
    members: [
      { name: 'Twin Bot', role: 'chair', bio: 'Chief of staff', roleProfile: 'Coordinator', goal: 'Ship tasks' },
      { name: 'Coder Bot', role: 'worker', bio: longBio, roleProfile: null, goal: null },
      { name: 'Ghost Bot', role: 'worker' },
    ],
    botRole: 'chair',
  });

  assert.match(prompt, /## Roster profiles/);
  assert.match(prompt, /- Twin Bot \(chair\) — Role: Coordinator; Bio: Chief of staff; Goal: Ship tasks/);
  assert.match(prompt, /- Coder Bot \(worker\) — Bio: bio-start/);
  assert.ok(!prompt.includes('bio-end'), 'bio is capped before its tail');
  assert.ok(!/Ghost Bot \(worker\) —/.test(prompt), 'profile-less member gets no profile line');

  const bioLine = prompt.split('\n').find((line) => line.startsWith('- Coder Bot (worker) — Bio:'));
  const renderedBio = bioLine.replace('- Coder Bot (worker) — Bio: ', '');
  assert.ok(renderedBio.length <= 200, `bio capped at 200 chars (got ${renderedBio.length})`);
});

test('prompts: remote OpenTeam teammate annotated in roster, profiles, and playbooks', () => {
  const members = [
    { name: 'Twin Bot', role: 'chair' },
    { name: 'Coder Bot', role: 'worker', bio: 'Search and code specialist' },
    { name: 'Alicia Remote', role: 'worker', remote: true },
  ];
  const chairPrompt = buildGroupTaskSystemPrompt({
    metabot: { name: 'Twin Bot' },
    task: { title: 'T', goal: 'G' },
    members,
    botRole: 'chair',
  });

  // Roster annotation keeps the exact name intact for @-mention matching.
  assert.match(chairPrompt, /^- Alicia Remote \(worker, remote teammate via OpenTeam\)$/m);
  assert.match(chairPrompt, /- Alicia Remote \(worker\) — external teammate via OpenTeam; profile not available locally/);
  assert.match(chairPrompt, /OpenTeam remote teammates \(marked "remote teammate via OpenTeam" in the roster\) are external collaborators/);
  assert.match(chairPrompt, /Welcome them as you would a new colleague/);
  assert.match(chairPrompt, /Their replies come from their own machine and may arrive late or not at all/);
  assert.match(chairPrompt, /re-assign the work and explain the change to the owner/);
  // M2: capability-gap assessment and remote-search discipline rules.
  assert.match(chairPrompt, /Capability check is match-first: pick the seated specialist whose profile and impressions fit the step/);
  assert.match(chairPrompt, /recommend a remote OpenTeam recruit to the owner/);
  assert.match(chairPrompt, /One candidate at a time, best bio\/chatSkills\/on-chain fit first/);
  assert.match(chairPrompt, /has not joined after ~10 minutes, treat it as no deal/);
  assert.match(chairPrompt, /Never @-assign work to an invitee before it appears in the roster/);

  const workerPrompt = buildGroupTaskSystemPrompt({
    metabot: { name: 'Coder Bot' },
    task: { title: 'T', goal: 'G' },
    members,
    botRole: 'worker',
  });
  assert.match(workerPrompt, /^- Alicia Remote \(worker, remote teammate via OpenTeam\)$/m);
  assert.match(workerPrompt, /treat them as equal teammates and be polite/);
  assert.ok(!workerPrompt.includes('OpenTeam remote teammates (marked'), 'chair-only etiquette stays out of the worker playbook');
  assert.ok(!workerPrompt.includes('Capability check before recruiting'), 'chair-only recruiting rules stay out of the worker playbook');
});

test('prompts: chair playbook gates member kicks behind explicit owner confirmation', () => {
  const members = [
    { name: 'Twin Bot', role: 'chair' },
    { name: 'Coder Bot', role: 'worker' },
  ];
  const chairPrompt = buildGroupTaskSystemPrompt({
    metabot: { name: 'Twin Bot' },
    task: { title: 'T', goal: 'G' },
    members,
    botRole: 'chair',
  });
  // R3: a chat-initiated kick must be restated and explicitly confirmed by the
  // owner first; the Tasks-UI modal already counts as that confirmation.
  assert.match(chairPrompt, /Removing a member \(kick\) is owner-confirmed, never casual/);
  assert.match(chairPrompt, /explicit confirmation in the same conversation/);
  assert.match(chairPrompt, /Tasks-UI modal already IS the owner's confirmation/);

  const workerPrompt = buildGroupTaskSystemPrompt({
    metabot: { name: 'Coder Bot' },
    task: { title: 'T', goal: 'G' },
    members,
    botRole: 'worker',
  });
  assert.ok(!workerPrompt.includes('Removing a member (kick)'), 'kick governance stays out of the worker playbook');
});

test('prompts: chair playbook carries lifecycle-autonomy and user-language rules (R5)', () => {
  const members = [
    { name: 'Twin Bot', role: 'chair' },
    { name: 'Coder Bot', role: 'worker' },
  ];
  const chairPrompt = buildGroupTaskSystemPrompt({
    metabot: { name: 'Twin Bot' },
    task: { title: 'T', goal: 'G' },
    members,
    botRole: 'chair',
  });
  // R5: the chair drives the lifecycle itself and speaks user language.
  assert.match(chairPrompt, /Lifecycle autonomy: you drive the task through its states/);
  assert.match(chairPrompt, /awaits their acceptance in the Tasks UI/);
  assert.match(chairPrompt, /NEVER sit in executing asking the owner "what next\?"/);
  assert.match(chairPrompt, /User language: refer to the task by its title, never by `#id`/);
  assert.match(chairPrompt, /Lead every report with the conclusion/);
  assert.match(chairPrompt, /OWNER LANGUAGE is Chinese \(Simplified\)/);

  const workerPrompt = buildGroupTaskSystemPrompt({
    metabot: { name: 'Coder Bot' },
    task: { title: 'T', goal: 'G' },
    members,
    botRole: 'worker',
  });
  assert.ok(!workerPrompt.includes('Lifecycle autonomy'), 'lifecycle ownership stays out of the worker playbook');
  assert.ok(!workerPrompt.includes('User language: refer to the task by its title'), 'user-language rule stays out of the worker playbook');
});

test('prompts: English owner language uses English WORKING/STANDBY examples and no CJK', () => {
  const members = [
    { name: 'Twin Bot', role: 'chair' },
    { name: 'Coder Bot', role: 'worker' },
  ];
  const workerPrompt = buildGroupTaskSystemPrompt({
    metabot: { name: 'Coder Bot' },
    task: { title: 'T', goal: 'G' },
    members,
    botRole: 'worker',
    language: 'en',
  });
  assert.match(workerPrompt, /OWNER LANGUAGE is English/);
  assert.match(workerPrompt, /\[WORKING\] On it: X, ETA N min/);
  assert.match(workerPrompt, /\[STANDBY\] observing \/ on standby \/ can exit/);
  assert.equal(/[\u4e00-\u9fff]/.test(workerPrompt), false);
});

// ---------------------------------------------------------------------------
// Worldview/time/experience prompts, deliverable verification, owner report
// ---------------------------------------------------------------------------

test('prompts: worldview block, time line, honesty and chair boundary', () => {
  const prompt = buildGroupTaskSystemPrompt({
    metabot: { name: 'Twin Bot' },
    task: { title: 'T', goal: 'G' },
    members: [
      { name: 'Twin Bot', role: 'chair' },
      { name: 'Coder Bot', role: 'worker' },
    ],
    botRole: 'chair',
    ownerGlobalMetaId: 'gmid-boss',
    currentTimeText: 'Current time: 2026-08-04 23:52 (UTC+8, Asia/Shanghai); today is Tuesday, August 4, 2026.',
    experienceBlock: '<self_identity>I am the twin.</self_identity>',
  });

  assert.match(prompt, /## Group task environment/);
  assert.match(prompt, /OWNER \(a human, globalMetaId `gmid-boss`\)/);
  assert.match(prompt, /Twin Bot \(the owner's digital twin\) chairs the group/);
  assert.match(prompt, /a pinid is exactly 64 lowercase hex chars \+ `i0`/);
  assert.match(prompt, /\/protocols\/simplebuzz/);
  assert.match(prompt, /Current time: 2026-08-04 23:52 \(UTC\+8, Asia\/Shanghai\); today is Tuesday, August 4, 2026\./);
  assert.match(prompt, /NEVER fabricate results, pinids, txids/);
  assert.match(prompt, /honest failure is acceptable, a fabricated success is a critical fault/);
  assert.match(prompt, /you NEVER execute task work yourself/);
  assert.match(prompt, /VERIFY it \(format, plausibility, any daemon verification notes/);
  assert.match(prompt, /<self_identity>I am the twin\.<\/self_identity>/);
});

test('turn prompts keep the system prompt stable and put the fresh current-time line in the user message', async () => {
  const h = await createHarness();
  try {
    h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'time-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-boss',
      senderName: 'Human', content: '@Coder Bot hi',
    });
    await h.loop.runTick();

    const date = new Date(h.state.nowMs);
    const pad = (v) => String(v).padStart(2, '0');
    const local = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    // Cache-prefix discipline: the minute-precision time line must NEVER sit in
    // the system prompt (it would change every turn and reset the SDK session);
    // it rides the user message instead.
    assert.ok(
      !h.chatCalls[0].systemPrompt.includes('Current time:'),
      'system prompt must not carry the per-turn time line',
    );
    assert.ok(
      h.chatCalls[0].userMessage.includes(`Current time: ${local} (`),
      `user message carries the injected-now local time (expected prefix "Current time: ${local} (")`,
    );
    assert.match(h.chatCalls[0].userMessage, /today is \w+day, /);
    assert.match(h.chatCalls[0].systemPrompt, /## Group task environment/);
  } finally {
    h.cleanup();
  }
});

test('experience block: memory/dream deps feed the A2A builder; absent deps omit it', async () => {
  const withMemory = await createHarness({
    listUserMemories: (metabotId, input) =>
      input.usageClass === 'self_identity' ? [{ text: 'I am the search specialist.' }] : [],
    listDailySummaries: () => [{ summaryDate: '2026-08-03', summaryText: 'Searched the web for the owner.' }],
  });
  try {
    withMemory.createTask([2]);
    insertGroupMessage(withMemory.db, {
      pinId: 'mem-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-boss',
      senderName: 'Human', content: '@Coder Bot go',
    });
    await withMemory.loop.runTick();
    assert.match(withMemory.chatCalls[0].userMessage, /I am the search specialist\./);
    assert.match(withMemory.chatCalls[0].userMessage, /Searched the web for the owner\./);
    assert.ok(!withMemory.chatCalls[0].systemPrompt.includes('I am the search specialist.'),
      'experience block must not sit in the system prompt (volatile, cache-prefix breaker)');
  } finally {
    withMemory.cleanup();
  }

  const withoutMemory = await createHarness();
  try {
    withoutMemory.createTask([2]);
    insertGroupMessage(withoutMemory.db, {
      pinId: 'nomem-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-boss',
      senderName: 'Human', content: '@Coder Bot go',
    });
    await withoutMemory.loop.runTick();
    assert.ok(!withoutMemory.chatCalls[0].systemPrompt.includes('self_identity'));
  } finally {
    withoutMemory.cleanup();
  }
});

test('group cognition projection is observer-relative and wired into per-bot prompts', async () => {
  const cognitionCalls = [];
  const h = await createHarness({
    getMetaIDGroupCognitionPromptBlock: async (input) => {
      cognitionCalls.push(input);
      return [
        '<metaid_group_cognition>',
        `Observer: ${input.observerGlobalMetaID}`,
        ...input.roster.map((member) => `- ${member.name} ${member.globalMetaID} (${member.role})`),
        '</metaid_group_cognition>',
      ].join('\n');
    },
  });
  try {
    h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'cog-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-boss',
      senderName: 'Human', content: '@Coder Bot go',
    });
    await h.loop.runTick();

    const workerCall = h.chatCalls.find((call) => call.llmId === 'llm-2');
    assert.ok(workerCall, 'worker replied');
    assert.match(workerCall.userMessage, /<metaid_group_cognition>/);
    assert.match(workerCall.userMessage, /Observer: gmid-w2/);
    assert.match(workerCall.userMessage, /- Twin Bot gmid-twin \(chair\)/);
    assert.doesNotMatch(workerCall.userMessage, /- Coder Bot gmid-w2 \(worker\)/,
      'entropy P1: worker cognition is chair-only');
    assert.ok(!workerCall.systemPrompt.includes('<metaid_group_cognition>'),
      'cognition block must not sit in the system prompt (volatile, cache-prefix breaker)');

    const workerInput = cognitionCalls.find((input) => input.observerGlobalMetaID === 'gmid-w2');
    assert.ok(workerInput, 'cognition dep called for the responding worker');
    // Entropy P1: workers get a chair-only cognition roster (narrow specific
    // heat); the full roster stays reserved for the chair's arbitration view.
    assert.deepEqual(
      workerInput.roster.map((member) => member.globalMetaID),
      ['gmid-twin'],
    );
  } finally {
    h.cleanup();
  }
});

test('group cognition projection failure or absence omits the block without blocking the turn', async () => {
  const logMessages = [];
  const failing = await createHarness({
    getMetaIDGroupCognitionPromptBlock: async () => {
      throw new Error('cognition service down');
    },
    emitLog: (message) => {
      logMessages.push(message);
    },
  });
  try {
    failing.createTask([2]);
    insertGroupMessage(failing.db, {
      pinId: 'cogfail-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot go',
    });
    await failing.loop.runTick();
    assert.equal(failing.sends.length, 1, 'reply still delivered');
    assert.ok(!failing.chatCalls[0].systemPrompt.includes('metaid_group_cognition'));
    assert.ok(
      logMessages.some((message) => message.includes('MetaID group cognition projection unavailable for bot 2')),
      'failure emits a bounded diagnostic without private content',
    );
  } finally {
    failing.cleanup();
  }

  const absent = await createHarness();
  try {
    absent.createTask([2]);
    insertGroupMessage(absent.db, {
      pinId: 'cogabsent-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot go',
    });
    await absent.loop.runTick();
    assert.equal(absent.sends.length, 1, 'reply still delivered');
    assert.ok(!absent.chatCalls[0].systemPrompt.includes('metaid_group_cognition'));
  } finally {
    absent.cleanup();
  }
});

test('deliverable verification: fabricated pinid warns the chair in context', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'fake-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[DELIVERABLE] buzz posted: 0x8f3a2b1c done!',
    });
    await h.loop.runTick();

    assert.equal(h.chatCalls.length, 1, 'chair triggered by the deliverable');
    assert.equal(h.chatCalls[0].llmId, 'llm-1');
    assert.match(
      h.chatCalls[0].userMessage,
      /⚠ Host verification: reported pinid "0x8f3a2b1c" FAILS format validation/,
    );
    assert.equal(h.groupTaskStore.listDeliverables(task.id).length, 1, 'row still recorded');
  } finally {
    h.cleanup();
  }
});

test('deliverable verification: uppercase hex candidate fails format', async () => {
  const UPPER = 'ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789';
  const h = await createHarness();
  try {
    h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'up-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: `[DELIVERABLE] metafile://${UPPER}i0`,
    });
    await h.loop.runTick();
    assert.match(h.chatCalls[0].userMessage, /FAILS format validation/);
  } finally {
    h.cleanup();
  }
});

test('deliverable verification: valid pinid reports found / not-found / unavailable', async () => {
  const VALID = `${'a'.repeat(64)}i0`;
  const runCase = async (pinOutcomes) => {
    const h = await createHarness({ pinOutcomes });
    try {
      h.createTask([2]);
      insertGroupMessage(h.db, {
        pinId: 'v-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
        senderName: 'Coder Bot', content: `[DELIVERABLE] metaapp: metaapp://${VALID}`,
      });
      await h.loop.runTick();
      return h.chatCalls[0].userMessage;
    } finally {
      h.cleanup();
    }
  };

  assert.match(await runCase({ [VALID]: 'found' }), /✓ Host verification: pinid format valid; pin found on-chain/);
  assert.match(await runCase({ [VALID]: 'not_found' }), /⚠ Host verification: pinid format valid but pin NOT found on-chain/);
  assert.match(await runCase({}), /… Host verification: pinid format valid; on-chain check unavailable/);
});

test('owner report: review transition sends exactly one private report to the boss', async () => {
  const h = await createHarness({ chatReply: 'Report: goal met, deliverables verified.' });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'd-rep-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: `[DELIVERABLE] metaapp: metaapp://${'b'.repeat(64)}i0`,
    });
    insertGroupMessage(h.db, {
      pinId: 'rev-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '[STATUS:REVIEW] all done',
    });
    await h.loop.runTick();

    assert.equal(h.ownerReportCalls.length, 1, 'exactly one private report');
    assert.equal(h.ownerReportCalls[0].metabotId, 1, 'from the chair bot');
    assert.equal(h.ownerReportCalls[0].taskId, task.id, 'delivery is tied to the task');
    assert.equal(h.ownerReportCalls[0].ownerGlobalMetaId, BOSS_GMID, 'to the owner');
    assert.match(h.ownerReportCalls[0].text, /Report: goal met, deliverables verified\./);

    const reportCall = h.chatCalls.find((c) => /owner-report directive/.test(c.userMessage));
    assert.ok(reportCall, 'report turn used the owner-report directive');
    assert.match(reportCall.userMessage, /Goal: Build and publish the intro MetaApp/);
    assert.match(reportCall.userMessage, /metaapp:\/\//);

    assert.equal(h.store.get(`group_task_owner_reported:${task.id}`), '1', 'guard set');
    assert.deepEqual(
      h.events.find((event) => event.type === 'groupTask:ownerReportDelivery'),
      {
        type: 'groupTask:ownerReportDelivery',
        taskId: task.id,
        outcome: 'sent',
        pinId: 'owner-report-pin-1',
        sessionId: 'owner-report-session-1',
        displayError: null,
        at: h.state.nowMs,
      },
      'renderer receives the successful delivery and A2A session result',
    );
    await h.loop.runTick();
    assert.equal(h.ownerReportCalls.length, 1, 'no duplicate on the next tick');

    // the report never goes through the group send fn; only the chair
    // deliverable ack and the #14 review-entry closing line hit the group
    assert.deepEqual(
      h.sends.map((s) => s.metabotId),
      [1, 1],
      'only chair-identity sends (deliverable ack + review closing) hit the group',
    );
    assert.match(h.sends[1].content, /进入验收阶段/, 'second chair send is the closing line');
    const mapping = h.coworkStore.getConversationMapping('metaweb_group_task', `group-task:${task.id}`, 1);
    const sessionText = h.coworkStore.getSessionMessages(mapping.coworkSessionId).map((m) => m.content).join('\n');
    assert.match(sessionText, /\[Private report sent to the owner/);
  } finally {
    h.cleanup();
  }
});

test('owner report: rework hatch clears the guard and the next review reports again', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    const chairMsg = (pinId, content) => insertGroupMessage(h.db, {
      pinId, senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content,
    });

    chairMsg('rw1-i0', '[STATUS:REVIEW] done');
    await h.loop.runTick();
    assert.equal(h.ownerReportCalls.length, 1);

    // Improvement #2 (v1.3): the re-review must land past the review re-entry
    // debounce window — a [STATUS:REVIEW] within 30s of the rework hatch is a
    // stale in-flight verdict and is deliberately skipped.
    chairMsg('rw2-i0', '[STATUS:EXECUTING] rework needed');
    await h.loop.runTick();
    h.state.nowMs += 31_000;
    chairMsg('rw3-i0', '[STATUS:REVIEW] done for real');
    await h.loop.runTick();
    assert.equal(h.ownerReportCalls.length, 2, 're-review after rework reports again');
    assert.equal(h.store.get(`group_task_owner_reported:${task.id}`), '1');
  } finally {
    h.cleanup();
  }
});

test('owner report: A2A display failure is reported without retrying the on-chain send', async () => {
  const h = await createHarness({
    ownerReportResult: {
      pinId: 'owner-report-pin-display-failed',
      sessionId: null,
      displayError: 'cowork session unavailable',
    },
  });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'rdf1-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '[STATUS:REVIEW] done',
    });
    await h.loop.runTick();

    assert.equal(h.ownerReportCalls.length, 1, 'the report was sent once');
    assert.equal(h.store.get(`group_task_owner_reported:${task.id}`), '1', 'send guard is set');
    assert.deepEqual(
      h.events.find((event) => event.type === 'groupTask:ownerReportDelivery'),
      {
        type: 'groupTask:ownerReportDelivery',
        taskId: task.id,
        outcome: 'sent',
        pinId: 'owner-report-pin-display-failed',
        sessionId: null,
        displayError: 'cowork session unavailable',
        at: h.state.nowMs,
      },
    );

    await h.loop.runTick();
    assert.equal(h.ownerReportCalls.length, 1, 'display failure does not resend the on-chain report');
  } finally {
    h.cleanup();
  }
});

test('owner report: send failure is logged and does not block the tick', async () => {
  const h = await createHarness({ ownerReportFails: true });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'rf1-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '[STATUS:REVIEW] done',
    });
    insertGroupMessage(h.db, {
      pinId: 'rf2-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-boss',
      senderName: 'Human', content: 'unrelated chatter',
    });
    await h.loop.runTick();

    assert.equal(h.ownerReportCalls.length, 1, 'send was attempted');
    assert.equal(h.store.get(`group_task_owner_reported:${task.id}`), undefined, 'guard not set on failure');
    assert.deepEqual(
      h.events.find((event) => event.type === 'groupTask:ownerReportDelivery'),
      {
        type: 'groupTask:ownerReportDelivery',
        taskId: task.id,
        outcome: 'failed',
        error: 'owner chat public key unavailable',
        at: h.state.nowMs,
      },
      'renderer receives the real delivery failure reason',
    );
    const afterId = h.db.exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', ['rf2-i0'])[0].values[0][0];
    assert.equal(
      h.groupTaskStore.getTaskById(task.id).lastProcessedMsgId, afterId,
      'tick processed the rest of the batch despite the send failure',
    );
  } finally {
    h.cleanup();
  }
});

test('P1-4: chair messages and placeholder URIs never become deliverables', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);

    // chair message quoting the planning example -> NOT collected
    insertGroupMessage(h.db, {
      pinId: 'chair-example-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '[DELIVERABLE] example format: metaapp://<pinId> or metaapp://[PINID]',
    });
    // worker message with a placeholder URI -> NOT collected
    insertGroupMessage(h.db, {
      pinId: 'worker-placeholder-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[DELIVERABLE] metaapp://<pinId>',
    });
    // worker message with a real URI -> collected
    insertGroupMessage(h.db, {
      pinId: 'worker-real-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[DELIVERABLE] metaapp: metaapp://ababababababababababababababababababababababababababababababababi0',
    });
    await h.loop.runTick();

    const rows = h.groupTaskStore.listDeliverables(task.id);
    assert.equal(rows.length, 1, 'only the real worker deliverable is recorded');
    assert.equal(rows[0].msgPinId, 'worker-real-i0');
    assert.equal(rows[0].uri, 'metaapp://ababababababababababababababababababababababababababababababababi0');
  } finally {
    h.cleanup();
  }
});

test('P2-7: chair auto response is suppressed when the Twin already replied to that message', async () => {
  const h = await createHarness();
  try {
    h.createTask([2]);

    // Lucy delivers; the Twin (chair) ALREADY replied on-chain to that pin
    insertGroupMessage(h.db, {
      pinId: 'deliver-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[DELIVERABLE] metaapp: metaapp://ababababababababababababababababababababababababababababababababi0',
    });
    insertGroupMessage(h.db, {
      pinId: 'chair-reply-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: 'thanks, verifying now', replyPin: 'deliver-i0',
    });
    await h.loop.runTick();

    // The chair must NOT auto-respond to the deliverable (Twin already spoke).
    // The worker mention is absent, so no worker replies either.
    assert.equal(h.sends.length, 0, 'no duplicate chair auto response');
    // but the deliverable is still recorded from the worker message
    const taskId = h.groupTaskStore.listTasks()[0].id;
    assert.equal(h.groupTaskStore.listDeliverables(taskId).length, 1);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Round-2 iteration: P1-4 line-scoped [DELIVERABLE] parsing (new obs. 3)
// ---------------------------------------------------------------------------

test('P1-4 r2: [DELIVERABLE] parsing is line-scoped — body dir paths and truncated URIs never pollute', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    const summary = (row) => ({ kind: row.kind, uri: row.uri });

    // Case ① (doc msg83): the tag line carries no URI; the BODY mentions a
    // `metaapp/` directory path. Must be a text deliverable (uri null),
    // never kind=metaapp.
    insertGroupMessage(h.db, {
      pinId: 'r2-msg83-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: '门户 MetaApp 页面已完成，本地目录 metaapp/agent-daily-portal 验收通过。\n[DELIVERABLE] ② 门户 MetaApp 页面（已开发+本地验收通过）',
    });

    // Case ② (doc msg85): a truncated `metafile://…zip（50KB，5 文件）` in the
    // body must NOT win; the real metaapp:// URI on the tag line is collected
    // and the kind follows that line's scheme.
    insertGroupMessage(h.db, {
      pinId: 'r2-msg85-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: '完成：源码已打包，content=metafile://…zip（50KB，5 文件）请查收。\n[DELIVERABLE] ④ metaapp: metaapp://ababababababababababababababababababababababababababababababababi0',
    });

    // Full-width paren annotation AFTER the URI on the tag line: the URI is
    // trimmed at the paren; the deliverable is recorded with the clean URI.
    insertGroupMessage(h.db, {
      pinId: 'r2-paren-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: '[DELIVERABLE] ⑤ 海报 metafile://cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdi0（1.2MB，5 文件）',
    });

    // Tag line whose ONLY URI is truncated garbage: rejected as a placeholder
    // (planning-style example, not a deliverable).
    insertGroupMessage(h.db, {
      pinId: 'r2-trunc-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: '[DELIVERABLE] 示例：metafile://…zip（50KB，5 文件）',
    });
    await h.loop.runTick();

    const rows = h.groupTaskStore.listDeliverables(task.id);
    const byPin = (pinId) => rows.find((r) => r.msgPinId === pinId);
    assert.equal(rows.length, 3, 'only the three real deliverables are recorded');

    assert.deepEqual(
      summary(byPin('r2-msg83-i0')),
      { kind: 'text', uri: null },
      'body `metaapp/` dir path must not misjudge the kind (was kind=metaapp, uri=null)',
    );
    assert.deepEqual(
      summary(byPin('r2-msg85-i0')),
      { kind: 'metaapp', uri: 'metaapp://ababababababababababababababababababababababababababababababababi0' },
      'body ellipsis URI ignored; the tag-line metaapp:// URI is collected (was lost entirely)',
    );
    assert.deepEqual(
      summary(byPin('r2-paren-i0')),
      { kind: 'metafile', uri: 'metafile://cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdi0' },
      'full-width paren annotation trimmed from the URI',
    );
    assert.equal(byPin('r2-trunc-i0'), undefined, 'truncated-only tag line is rejected as a placeholder');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Round-2 iteration: P1-5 planning-directive distribution + opt-out (obs. 1/5)
// ---------------------------------------------------------------------------

test('P1-5 r2: planning directive assigns each seated specialist their own coarse seat', async () => {
  const h = await createHarness();
  try {
    h.createTask([2, 3], { activate: false }); // planning; two workers on the roster
    await h.loop.runTick();
    const planningCall = h.chatCalls[0];
    assert.match(
      planningCall.userMessage,
      /Assign each seated specialist their own coarse seat/,
      'directive plans against the hired seats instead of spreading work to fill the roster',
    );
    assert.match(planningCall.userMessage, /do not invent extra work to occupy unused names/);
    assert.match(planningCall.userMessage, /Research is a basic capability of every seat/);
  } finally {
    h.cleanup();
  }
});

test('P1-5 r2: planning directive with a single worker assigns that seat to that member', async () => {
  const h = await createHarness();
  try {
    h.createTask([2], { activate: false });
    await h.loop.runTick();
    assert.match(
      h.chatCalls[0].userMessage,
      /single worker on the roster — assign that seat's work to that one member/,
    );
  } finally {
    h.cleanup();
  }
});

test('P1-5 r2: disableChairPlanningTurn opts out of the auto planning turn (Twin leads the kickoff)', async () => {
  const h = await createHarness({ disableChairPlanningTurn: true });
  try {
    const task = h.createTask([2], { activate: false }); // planning
    await h.loop.runTick();
    assert.equal(h.sends.length, 0, 'no auto plan posted');
    assert.equal(h.chatCalls.length, 0, 'no LLM planning call');
    assert.equal(h.store.get(`group_task_chair_planned:${task.id}`), '1', 'task marked as host-planned');

    await h.loop.runTick();
    assert.equal(h.chatCalls.length, 0, 'guard stays quiet on later ticks');
    assert.equal(h.sends.length, 0);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Round-2 iteration: P2-7 windowed Twin-activity suppression (new obs. 4)
// ---------------------------------------------------------------------------

test('P2-7 r2: Twin speech in the window suppresses chair auto replies (incl. replies without reply_pin)', async () => {
  const h = await createHarness();
  try {
    h.createTask([2]);

    // The Twin speaks proactively (no reply_pin) at chain second 1_000_000_000.
    insertGroupMessage(h.db, {
      pinId: 'twin-active-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '各位，这个任务我来主导，按计划推进。', chainTimestamp: 1_000_000_000,
    });
    // A worker deliverable arrives 5s later — the daemon auto verify must be
    // suppressed while the Twin is actively speaking.
    insertGroupMessage(h.db, {
      pinId: 'dlv-1-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[DELIVERABLE] metaapp: metaapp://ababababababababababababababababababababababababababababababababi0', chainTimestamp: 1_000_000_005,
    });
    await h.loop.runTick();
    assert.equal(h.sends.length, 0, 'no daemon chair auto reply while the Twin is speaking');
    let taskId = h.groupTaskStore.listTasks()[0].id;
    assert.equal(h.groupTaskStore.listDeliverables(taskId).length, 1, 'deliverable row still recorded');

    // The Twin replies to the NEXT deliverable WITHOUT a reply_pin — the exact
    // pin match cannot see this; the window check must.
    h.state.nowMs += 10_000;
    insertGroupMessage(h.db, {
      pinId: 'twin-reply-nopin-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '已核实，收下。', chainTimestamp: 1_000_000_015,
    });
    insertGroupMessage(h.db, {
      pinId: 'dlv-2-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[DELIVERABLE] ② 文章 metafile://cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdi0', chainTimestamp: 1_000_000_020,
    });
    await h.loop.runTick();
    assert.equal(h.sends.length, 0, 'Twin reply without reply_pin also suppresses the auto verify');
    assert.equal(h.groupTaskStore.listDeliverables(taskId).length, 2, 'deliverable rows still recorded');
  } finally {
    h.cleanup();
  }
});

test('P2-7 r2: daemon auto replies resume when the Twin is quiet, and its own replies do not self-suppress', async () => {
  const h = await createHarness();
  try {
    h.createTask([2]);

    // Twin spoke LONG ago (outside the 60s window) — the daemon auto verify runs.
    insertGroupMessage(h.db, {
      pinId: 'twin-old-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '旧消息：不在窗口内。', chainTimestamp: 999_000_000,
    });
    insertGroupMessage(h.db, {
      pinId: 'dlv-1-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[DELIVERABLE] metaapp: metaapp://ababababababababababababababababababababababababababababababababi0', chainTimestamp: 1_000_000_000,
    });
    await h.loop.runTick();
    assert.equal(h.sends.length, 1, 'Twin quiet: the chair auto-verifies the deliverable');
    assert.equal(h.sends[0].metabotId, 1);

    // The daemon's own reply round-trips on-chain (pin send-pin-1). Another
    // deliverable arrives inside the window — the daemon must NOT treat its
    // own reply as Twin activity and must verify again.
    h.state.nowMs += 30_000;
    insertGroupMessage(h.db, {
      pinId: 'send-pin-1', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: h.sends[0].content, chainTimestamp: 1_000_000_030,
    });
    insertGroupMessage(h.db, {
      pinId: 'dlv-2-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[DELIVERABLE] ② 文章 metafile://cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdi0', chainTimestamp: 1_000_000_035,
    });
    await h.loop.runTick();
    assert.equal(h.sends.length, 2, "the daemon's own reply does not suppress the next auto verify");
    assert.equal(h.sends[1].metabotId, 1);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Round-4: chain-GlobalMetaID attribution (SUSPECT) + correction-first
// ---------------------------------------------------------------------------

test('round-4 attribution: non-member sender is SUSPECT — no deliverables, no replies, row flagged', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'intruder-i0', senderMetaId: 'metaid-x', senderGlobalMetaId: 'gmid-stranger',
      senderName: 'Some Bot',
      content: `@Coder Bot do this\n**[DELIVERABLE] metaapp: metaapp://${REAL_PINID_1}**`,
    });
    await h.loop.runTick();
    const suspect = h.db.exec(
      'SELECT sender_suspect FROM group_chat_messages WHERE pin_id = ?', ['intruder-i0'],
    )[0].values[0][0];
    assert.equal(suspect, 1, 'row flagged SUSPECT');
    assert.equal(h.sends.length, 0, 'no replies triggered for a non-member speaker');
    assert.equal(h.groupTaskStore.listDeliverables(task.id).length, 0, 'no deliverables from non-members');
  } finally {
    h.cleanup();
  }
});

test('round-4 attribution: owner (boss gmid) is never SUSPECT and still reaches the chair', async () => {
  const h = await createHarness();
  try {
    h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'owner-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: BOSS_GMID,
      senderName: 'Human', content: 'status update please',
    });
    await h.loop.runTick();
    const suspect = h.db.exec(
      'SELECT sender_suspect FROM group_chat_messages WHERE pin_id = ?', ['owner-i0'],
    )[0].values[0][0];
    assert.equal(suspect, 0, 'owner exempt from SUSPECT');
    assert.equal(h.sends.length, 1, 'chair answers the owner');
    assert.equal(h.sends[0].metabotId, 1);
  } finally {
    h.cleanup();
  }
});

test('round-4 attribution: legacy metaid resolved via injected resolver, persisted, member not SUSPECT', async () => {
  const h = await createHarness({
    resolveGlobalMetaId: async (legacy) => (legacy === 'metaid-2' ? 'gmid-w2' : null),
  });
  try {
    const task = h.createTask([2, 3]);
    // Indexer push carried only the legacy chain signature, no GlobalMetaID.
    insertGroupMessage(h.db, {
      pinId: 'legacy-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: null,
      senderName: 'Coder Bot', content: '@Designer Bot hi',
    });
    await h.loop.runTick();
    const row = h.db.exec(
      'SELECT sender_global_metaid, sender_suspect FROM group_chat_messages WHERE pin_id = ?', ['legacy-i0'],
    )[0].values[0];
    assert.equal(row[0], 'gmid-w2', 'resolved GlobalMetaID persisted onto the row');
    assert.equal(row[1], 0, 'member sender is not SUSPECT');
    assert.equal(h.sends.length, 1, 'mentioned member replies');
    assert.equal(h.sends[0].metabotId, 3);
  } finally {
    h.cleanup();
  }
});

test('round-4 attribution: unresolvable legacy metaid → SUSPECT, silent', async () => {
  const h = await createHarness({ resolveGlobalMetaId: async () => null });
  try {
    h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'ghost-i0', senderMetaId: 'metaid-ghost', senderGlobalMetaId: null,
      senderName: 'Ghost', content: '@Coder Bot hi',
    });
    await h.loop.runTick();
    const suspect = h.db.exec(
      'SELECT sender_suspect FROM group_chat_messages WHERE pin_id = ?', ['ghost-i0'],
    )[0].values[0][0];
    assert.equal(suspect, 1, 'unresolvable signature flagged SUSPECT');
    assert.equal(h.sends.length, 0, 'no replies for an unresolvable sender');
  } finally {
    h.cleanup();
  }
});

test('M3 kick: messages from a removed member turn SUSPECT — no replies, no deliverables', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);

    // Pre-kick: a member deliverable is ingested and the chair verifies it.
    insertGroupMessage(h.db, {
      pinId: 'pre-kick-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: `[DELIVERABLE] metaapp: metaapp://${REAL_PINID_1}`,
    });
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.listDeliverables(task.id).length, 1, 'pre-kick deliverable recorded');
    assert.equal(h.sends.length, 1, 'pre-kick deliverable triggers the chair');

    // M3: the owner kicks the member (removeuser pin landed; row marked).
    h.groupTaskStore.markMemberRemoved({ taskId: task.id, metabotId: 2, removePinId: 'pin-remove-2' });

    // The kicked member's daemon (or an indexer that has not enforced the
    // removal yet) keeps posting — the host must stay silent and ingest nothing.
    insertGroupMessage(h.db, {
      pinId: 'post-kick-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: `@Twin Bot still here\n[DELIVERABLE] metaapp: metaapp://${REAL_PINID_2}`,
    });
    await h.loop.runTick();
    const suspect = h.db.exec(
      'SELECT sender_suspect FROM group_chat_messages WHERE pin_id = ?', ['post-kick-i0'],
    )[0].values[0][0];
    assert.equal(suspect, 1, 'post-kick message flagged SUSPECT (sender no longer a member)');
    assert.equal(h.sends.length, 1, 'no replies after the kick');
    assert.equal(h.groupTaskStore.listDeliverables(task.id).length, 1, 'no deliverables after the kick');
  } finally {
    h.cleanup();
  }
});

test('round-4 correction-first: a 更正 message supersedes the matched deliverable in place', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'd1-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: `[DELIVERABLE] buzz: https://openagentinternet.org/browser/buzz/${REAL_PINID_2}`,
    });
    await h.loop.runTick();
    let rows = h.groupTaskStore.listDeliverables(task.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].uri, `https://openagentinternet.org/browser/buzz/${REAL_PINID_2}`);

    // Same author corrects the link; the buzz pinid token ties them together.
    insertGroupMessage(h.db, {
      pinId: 'd2-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: `链接更正：此前的 buzz 交付链接为无效路由。\n[DELIVERABLE] buzz 正确预览链接: https://openagentinternet.org/browser/pin/${REAL_PINID_2}（实测 HTTP 200）`,
    });
    await h.loop.runTick();
    rows = h.groupTaskStore.listDeliverables(task.id);
    assert.equal(rows.length, 1, 'correction updates in place — no duplicate row');
    assert.equal(rows[0].uri, `https://openagentinternet.org/browser/pin/${REAL_PINID_2}`);
    assert.equal(rows[0].msgPinId, 'd1-i0', 'original row retained, uri superseded');
    assert.equal(rows[0].status, 'pending');
  } finally {
    h.cleanup();
  }
});

test('round-4: one message with two [DELIVERABLE] tag lines records two rows (msg94 regression)', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'multi-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: [
        `**[DELIVERABLE] metaapp: metaapp://${REAL_PINID_1}**`,
        `**[DELIVERABLE] 分享链接: https://openagentinternet.org/browser/metaapp/${REAL_PINID_1}**`,
      ].join('\n'),
    });
    await h.loop.runTick();
    const rows = h.groupTaskStore.listDeliverables(task.id);
    assert.equal(rows.length, 2, 'one row per tag line');
    assert.deepEqual(rows.map((r) => r.kind).sort(), ['metaapp', 'url']);
    assert.ok(rows.some((r) => r.uri === `metaapp://${REAL_PINID_1}`), 'metaapp row kept');
    assert.ok(
      rows.some((r) => r.uri === `https://openagentinternet.org/browser/metaapp/${REAL_PINID_1}`),
      'share-link row kept (previously dropped by the whole-message dedupe)',
    );
    assert.ok(!rows.some((r) => r.uri?.endsWith('**')), 'no trailing markdown in recorded URIs');
  } finally {
    h.cleanup();
  }
});

test('round-4: HTTP probe notes on https deliverable links ride the chair verification context', async () => {
  const probeResults = {
    [`https://openagentinternet.org/browser/pin/${REAL_PINID_2}`]: 200,
    [`https://openagentinternet.org/browser/buzz/${REAL_PINID_2}`]: 404,
  };
  const h = await createHarness({
    probeUrl: async (url) => probeResults[url] ?? null,
  });
  try {
    h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'probe-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: [
        `[DELIVERABLE] buzz 正确预览链接: https://openagentinternet.org/browser/pin/${REAL_PINID_2}`,
        `[DELIVERABLE] 旧链接: https://openagentinternet.org/browser/buzz/${REAL_PINID_2}`,
      ].join('\n'),
    });
    await h.loop.runTick();

    // The chair was triggered by the deliverable tag; its context carries the
    // probe notes: 200 marked reachable, 404 flagged for clarification.
    const chairCall = h.chatCalls.find((call) => call.userMessage.includes('Host verification'));
    assert.ok(chairCall, 'chair received verification notes');
    assert.match(chairCall.userMessage, /HTTP probe .*\/browser\/pin\/.* → 200 \(link reachable\)/);
    assert.match(chairCall.userMessage, /HTTP probe .*\/browser\/buzz\/.* → 404 — link may be invalid; verify before accepting/);
  } finally {
    h.cleanup();
  }
});

test('round-4 cursor semantics: failing message is retried, cursor advances only on success', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    // one-shot LLM failure: tick 1 fails, tick 2 succeeds
    h.state.chatError = 'transient boom';
    insertGroupMessage(h.db, {
      pinId: 'retry-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot go',
    });
    const msgId = h.db.exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', ['retry-i0'])[0].values[0][0];

    await h.loop.runTick();
    assert.equal(h.groupTaskStore.getTaskById(task.id).lastProcessedMsgId, 0,
      'cursor does NOT advance on a failed message (retry semantics)');
    assert.equal(h.chatCalls.length, 1, 'first attempt failed');

    await h.loop.runTick();
    assert.equal(h.groupTaskStore.getTaskById(task.id).lastProcessedMsgId, msgId,
      'cursor advances once the message is processed successfully');
    assert.equal(h.chatCalls.length, 2, 'message was retried');
    assert.equal(h.sends.length, 1);
  } finally {
    h.cleanup();
  }
});

test('round-4 cursor semantics: permanently failing message is dropped after the bounded retries', async () => {
  const h = await createHarness({ chatErrorAlways: 'always boom' });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'stuck-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot do the impossible',
    });
    const msgId = h.db.exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', ['stuck-i0'])[0].values[0][0];

    for (let tick = 1; tick <= 4; tick += 1) {
      await h.loop.runTick();
      assert.equal(h.groupTaskStore.getTaskById(task.id).lastProcessedMsgId, 0,
        `tick ${tick}: cursor held until the retry budget is spent`);
    }
    // the 5th failure spends the budget: the message is dropped, cursor advances
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.getTaskById(task.id).lastProcessedMsgId, msgId,
      'cursor advanced past the permanently failing message after the bounded retries');
    assert.equal(h.chatCalls.length, 5, 'exactly MSG_RETRY_MAX_FAILURES attempts');

    // the 6th tick has nothing left to process
    await h.loop.runTick();
    assert.equal(h.chatCalls.length, 5, 'no further attempts after the drop');
  } finally {
    h.cleanup();
  }
});

test('GT#26 regression: control tags on a dropped message still land via the tag-only reprocess', async () => {
  const h = await createHarness({ disableChairPlanningTurn: true });
  try {
    const task = h.createTask([2], { activate: false }); // stays 'planning'
    // Stall-storm shape: the durable status write keeps failing (e.g. a busy
    // DB while the DSH watchdog crisis unfolds) for EVERY retry attempt, then
    // recovers in time for the drop-time tag-only reprocess.
    const originalUpdate = h.groupTaskStore.updateTaskStatus.bind(h.groupTaskStore);
    let executingUpdateCalls = 0;
    h.groupTaskStore.updateTaskStatus = (id, next, opts) => {
      if (id === task.id && next === 'executing') {
        executingUpdateCalls += 1;
        if (executingUpdateCalls <= 5) throw new Error('simulated SQLITE_BUSY during the stall storm');
      }
      return originalUpdate(id, next, opts);
    };

    insertGroupMessage(h.db, {
      pinId: 'gt26-plan-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '[GROUP TASK #26 计划] Remotion vs HyperFrames 双视频对比……分工如下。\n\n[STATUS:EXECUTING]',
    });
    const msgId = h.db.exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', ['gt26-plan-i0'])[0].values[0][0];
    // Baseline: the task-creation announcement (a lower id) may process
    // normally on tick 1 — the cursor must then HOLD there across the retries.
    const baselineCursor = msgId - 1;

    for (let tick = 1; tick <= 4; tick += 1) {
      await h.loop.runTick();
      assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'planning',
        `tick ${tick}: every attempt failed before the transition could land`);
      assert.equal(h.groupTaskStore.getTaskById(task.id).lastProcessedMsgId, baselineCursor,
        `tick ${tick}: cursor held while the retry budget was being spent`);
    }

    // The 5th failure spends the budget: the message is dropped, and the
    // tag-only reprocess lands the [STATUS:EXECUTING] transition the retries
    // never could — the exact loss that pinned task #26 in 'planning'.
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'executing',
      'chair [STATUS:EXECUTING] on the dropped message still transitioned the task');
    assert.equal(h.groupTaskStore.getTaskById(task.id).lastProcessedMsgId, msgId,
      'cursor advanced past the dropped message');
    const transitions = h.db.exec(
      'SELECT from_status, to_status FROM group_task_status_events WHERE task_id = ?',
      [task.id],
    );
    assert.deepEqual(
      (transitions[0]?.values ?? []).map((row) => [row[0], row[1]]),
      [['planning', 'executing']],
      'the transition is durably recorded',
    );
    assert.equal(h.chatCalls.length, 0, 'no reply generation ever ran for the dropped message');
  } finally {
    h.cleanup();
  }
});

test('round-4: lastDrivenAt heartbeat is written every tick', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    await h.loop.runTick();
    const row = h.db.exec('SELECT last_driven_at FROM group_tasks WHERE id = ?', [task.id])[0].values[0][0];
    assert.equal(row, 1_000_000_000, 'heartbeat = floor(now()/1000)');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// R2P1-4: a resolver THROW is transient (retry path), only a definitive null
// resolution marks SUSPECT.
// ---------------------------------------------------------------------------

test('R2P1-4: resolver throw rides the bounded retry path — no SUSPECT, cursor held, recovered on retry', async () => {
  let resolverCalls = 0;
  const h = await createHarness({
    resolveGlobalMetaId: async (legacy) => {
      resolverCalls += 1;
      if (resolverCalls === 1) throw new Error('manapi temporarily unreachable');
      return legacy === 'metaid-2' ? 'gmid-w2' : null;
    },
  });
  try {
    const task = h.createTask([2, 3]);
    insertGroupMessage(h.db, {
      pinId: 'transient-resolve-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: null,
      senderName: 'Coder Bot', content: '@Designer Bot hi',
    });
    const msgId = h.db.exec(
      'SELECT id FROM group_chat_messages WHERE pin_id = ?', ['transient-resolve-i0'],
    )[0].values[0][0];

    await h.loop.runTick();
    assert.equal(h.groupTaskStore.getTaskById(task.id).lastProcessedMsgId, 0,
      'cursor held while the resolver is failing');
    assert.equal(h.sends.length, 0, 'no reply from an unattributed message');
    const afterThrow = h.db.exec(
      'SELECT sender_suspect, sender_global_metaid FROM group_chat_messages WHERE pin_id = ?',
      ['transient-resolve-i0'],
    )[0].values[0];
    assert.equal(Number(afterThrow[0] ?? 0), 0, 'a resolver throw must NOT mark SUSPECT');
    assert.equal(afterThrow[1], null, 'nothing persisted while unresolved');

    await h.loop.runTick();
    assert.equal(resolverCalls, 2, 'message retried on the next tick');
    assert.equal(h.groupTaskStore.getTaskById(task.id).lastProcessedMsgId, msgId,
      'cursor advances once the resolution succeeds');
    const resolved = h.db.exec(
      'SELECT sender_global_metaid, sender_suspect FROM group_chat_messages WHERE pin_id = ?',
      ['transient-resolve-i0'],
    )[0].values[0];
    assert.equal(resolved[0], 'gmid-w2');
    assert.equal(Number(resolved[1]), 0, 'member sender is not SUSPECT');
    assert.equal(h.sends.length, 1, 'the legitimate member message is answered after recovery');
    assert.equal(h.sends[0].metabotId, 3);
  } finally {
    h.cleanup();
  }
});

test('R2P1-4: permanently throwing resolver drops the message after the bounded retries, never SUSPECT', async () => {
  const h = await createHarness({
    resolveGlobalMetaId: async () => { throw new Error('manapi down for good'); },
  });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'down-resolve-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: null,
      senderName: 'Coder Bot', content: '@Coder Bot hi',
    });
    const msgId = h.db.exec(
      'SELECT id FROM group_chat_messages WHERE pin_id = ?', ['down-resolve-i0'],
    )[0].values[0][0];

    for (let tick = 1; tick <= 4; tick += 1) {
      await h.loop.runTick();
      assert.equal(h.groupTaskStore.getTaskById(task.id).lastProcessedMsgId, 0,
        `tick ${tick}: cursor held while the resolver keeps failing`);
    }
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.getTaskById(task.id).lastProcessedMsgId, msgId,
      'bounded retries spent: cursor advances past the unresolvable message');
    const row = h.db.exec(
      'SELECT sender_suspect FROM group_chat_messages WHERE pin_id = ?', ['down-resolve-i0'],
    )[0].values[0];
    assert.equal(Number(row[0] ?? 0), 0, 'never stamped SUSPECT on transient-resolution failures');
    assert.equal(h.sends.length, 0);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// M3 deferred-reply re-check: a reply deferred by the cooldown is dropped when
// the sender was kicked (or flagged SUSPECT) before the deferred turn runs.
// ---------------------------------------------------------------------------

const setupDeferredReply = async (h) => {
  const task = h.createTask([2, 3]);
  // First mention: Designer Bot answers (cooldown starts).
  insertGroupMessage(h.db, {
    pinId: 'defer-first-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
    senderName: 'Coder Bot', content: '@Designer Bot first task',
  });
  await h.loop.runTick();
  assert.equal(h.sends.length, 1, 'first mention answered');
  assert.equal(h.sends[0].metabotId, 3);

  // Second mention inside the cooldown window: deferred to a later tick.
  insertGroupMessage(h.db, {
    pinId: 'defer-second-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
    senderName: 'Coder Bot', content: '@Designer Bot second task',
  });
  await h.loop.runTick();
  assert.equal(h.sends.length, 1, 'cooldown mention deferred, not answered yet');
  const secondMsgId = h.db.exec(
    'SELECT id FROM group_chat_messages WHERE pin_id = ?', ['defer-second-i0'],
  )[0].values[0][0];
  return { task, secondMsgId };
};

test('M3 deferred re-check: sender kicked before the deferred turn — reply dropped', async () => {
  const h = await createHarness();
  try {
    const { task } = await setupDeferredReply(h);

    // The owner kicks the SENDER of the deferred message; the replier stays.
    h.groupTaskStore.markMemberRemoved({ taskId: task.id, metabotId: 2, removePinId: 'pin-remove-2' });

    h.state.nowMs += 30_000; // past the worker cooldown
    await h.loop.runTick();
    assert.equal(h.sends.length, 1, 'no reply on a kicked sender\'s message');
  } finally {
    h.cleanup();
  }
});

test('M3 deferred re-check: sender flagged SUSPECT before the deferred turn — reply dropped', async () => {
  const h = await createHarness();
  try {
    const { secondMsgId } = await setupDeferredReply(h);

    // Late attribution flip (e.g. a manual/host re-evaluation) marks the row suspect.
    h.groupTaskStore.setMessageSenderSuspect(secondMsgId, true);

    h.state.nowMs += 30_000;
    await h.loop.runTick();
    assert.equal(h.sends.length, 1, 'no reply on a suspect message');
  } finally {
    h.cleanup();
  }
});

test('M3 deferred re-check: sender still an active member — deferred reply fires normally', async () => {
  const h = await createHarness();
  try {
    await setupDeferredReply(h);
    h.state.nowMs += 30_000;
    await h.loop.runTick();
    assert.equal(h.sends.length, 2, 'deferred reply fires once the cooldown elapsed');
    assert.equal(h.sends[1].metabotId, 3);
  } finally {
    h.cleanup();
  }
});

test('R2P1-4: a resolver failure holds the whole batch — a later clean message cannot leapfrog the cursor', async () => {
  let resolverCalls = 0;
  const h = await createHarness({
    resolveGlobalMetaId: async (legacy) => {
      resolverCalls += 1;
      if (resolverCalls === 1) throw new Error('manapi unreachable');
      return legacy === 'metaid-2' ? 'gmid-w2' : null;
    },
  });
  try {
    const task = h.createTask([2, 3]);
    // N: needs resolution (throws transiently on the first tick).
    insertGroupMessage(h.db, {
      pinId: 'unresolved-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: null,
      senderName: 'Coder Bot', content: '@Designer Bot from an unresolved sender',
    });
    // N+1: fully attributable owner message — would succeed if it were reached.
    insertGroupMessage(h.db, {
      pinId: 'clean-owner-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: BOSS_GMID,
      senderName: 'Human', content: 'status update please',
    });

    await h.loop.runTick();
    assert.equal(h.groupTaskStore.getTaskById(task.id).lastProcessedMsgId, 0,
      'cursor held at the failing message');
    assert.equal(h.chatCalls.length, 0,
      'the later clean message was NOT processed behind the failed one (no leapfrog)');

    await h.loop.runTick();
    assert.equal(h.sends.length, 2, 'both messages processed after recovery');
    assert.equal(h.sends[0].metabotId, 3, 'the previously failing message answered first (in order)');
    assert.equal(h.sends[1].metabotId, 1, 'the owner message answered after it');
  } finally {
    h.cleanup();
  }
});

test('P0-2: silent assigned/working members are auto-marked unreachable after the threshold', async () => {
  const h = await createHarness({ memberUnreachableAfterMinutes: 5 });
  try {
    const task = h.createTask([2, 3]);
    // Anchor the daemon clock to wall time so sqlite created_at baselines
    // (real datetime('now')) compare sensibly.
    const startMs = Date.now();
    h.state.nowMs = startMs;

    // Worker 2 spoke 1 minute ago (within threshold); worker 3 never spoke.
    insertGroupMessage(h.db, {
      pinId: 'pin-old-1',
      senderMetaId: 'metaid-2',
      senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: 'hello',
      chainTimestamp: Math.floor((startMs - 60_000) / 1000),
    });

    // Fresh task: worker 2 spoke (implicit ACK → working); worker 3 is still
    // within threshold → assigned (not yet unreachable).
    await h.loop.runTick();
    let members = h.groupTaskStore.listMembers(task.id);
    assert.equal(members.find((m) => m.metabotId === 2).status, 'working');
    assert.equal(members.find((m) => m.metabotId === 3).status, 'assigned');

    // Advance past the threshold: both become unreachable.
    h.state.nowMs = startMs + 6 * 60_000;
    await h.loop.runTick();
    members = h.groupTaskStore.listMembers(task.id);
    assert.equal(members.find((m) => m.metabotId === 2).status, 'unreachable');
    assert.equal(members.find((m) => m.metabotId === 3).status, 'unreachable');

    // Chair member is never auto-marked.
    assert.equal(members.find((m) => m.metabotId === 1).status, 'working');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// P0-3: [WORKING] ACK + chair reminders
// ---------------------------------------------------------------------------

test('P0-3: chair assignment records pending ACK; worker [WORKING] ACK clears it and marks working', async () => {
  const h = await createHarness({ ackTimeoutMs: 180_000 });
  try {
    const task = h.createTask([2, 3]);
    h.state.nowMs = Date.now();

    // Chair assigns worker 2.
    insertGroupMessage(h.db, {
      pinId: 'pin-assign-1', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot please build the metaapp',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.equal(h.store.get('group_task_ack_pending:1:2') != null, true);

    // Worker 2 ACKs with [WORKING] and an estimate.
    insertGroupMessage(h.db, {
      pinId: 'pin-ack-1', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 已接单：build metaapp，预计 5 分钟',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.equal(h.store.get('group_task_ack_pending:1:2'), undefined);
    const member = h.groupTaskStore.listMembers(task.id).find((m) => m.metabotId === 2);
    assert.equal(member.status, 'working');
    assert.ok(h.store.get('group_task_expected_delivery:1:2'), 'expected delivery deadline recorded');
  } finally {
    h.cleanup();
  }
});

test('P0-3: missing ACK past the timeout posts ONE chair reminder, never auto-fails', async () => {
  const h = await createHarness({ ackTimeoutMs: 180_000 });
  try {
    const task = h.createTask([2, 3]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    insertGroupMessage(h.db, {
      pinId: 'pin-assign-2', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot please build the metaapp',
      chainTimestamp: Math.floor(startMs / 1000),
    });
    await h.loop.runTick();
    h.sends.length = 0;

    // Before timeout: no reminder.
    h.state.nowMs = startMs + 60_000;
    await h.loop.runTick();
    assert.equal(h.sends.length, 0);
    assert.equal(h.groupTaskStore.listMembers(task.id).find((m) => m.metabotId === 2).status, 'assigned');

    // Past timeout: one reminder as the chair.
    h.state.nowMs = startMs + 200_000;
    await h.loop.runTick();
    assert.equal(h.sends.length, 1);
    assert.match(h.sends[0].content, /@chair/);
    assert.match(h.sends[0].content, /has not sent a \[WORKING\] ACK/);

    // A later tick does not re-remind.
    h.state.nowMs = startMs + 400_000;
    await h.loop.runTick();
    assert.equal(h.sends.length, 1);
  } finally {
    h.cleanup();
  }
});

test('P0-3: [STANDBY] marker sets standby; ordinary worker speech is an implicit ACK', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2, 3]);
    h.state.nowMs = Date.now();

    // Chair assigns worker 2 and worker 3.
    insertGroupMessage(h.db, {
      pinId: 'pin-assign-3', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot and @Designer Bot please work',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.ok(h.store.get('group_task_ack_pending:1:2'));
    assert.ok(h.store.get('group_task_ack_pending:1:3'));

    // Worker 3 posts [STANDBY] → standby; worker 2 posts ordinary speech → working (implicit ACK).
    insertGroupMessage(h.db, {
      pinId: 'pin-standby-1', senderMetaId: 'metaid-3', senderGlobalMetaId: 'gmid-w3',
      senderName: 'Designer Bot', content: '[STANDBY] 静默观察 / 待命接手 / 可退出',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    insertGroupMessage(h.db, {
      pinId: 'pin-implicit-1', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: 'on it, will deliver soon',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    const members = h.groupTaskStore.listMembers(task.id);
    assert.equal(members.find((m) => m.metabotId === 3).status, 'standby');
    assert.equal(members.find((m) => m.metabotId === 2).status, 'working');
    assert.equal(h.store.get('group_task_ack_pending:1:2'), undefined);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// P0-4: deliverable verification + deadline reminders
// ---------------------------------------------------------------------------

test('P0-4: pinid deliverable gets multi-source verification persisted (found+found → verified)', async () => {
  const h = await createHarness({
    readPinSecondaryForVerification: async () => 'found',
    verificationRetryMs: 60_000,
  });
  try {
    const task = h.createTask([2, 3]);
    h.state.nowMs = Date.now();
    h.state.pinOutcomes[REAL_PINID_1] = 'found';
    insertGroupMessage(h.db, {
      pinId: 'pin-deliv-1', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: `[DELIVERABLE] metaapp: metaapp://${REAL_PINID_1}`,
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    const deliverable = h.groupTaskStore.listDeliverables(task.id)[0];
    assert.ok(deliverable, 'deliverable recorded');
    const report = JSON.parse(deliverable.verification);
    assert.equal(report.verified, true);
    assert.equal(report.sources.length, 2);
    assert.deepEqual(report.sources.map((s) => s.outcome).sort(), ['found', 'found']);
  } finally {
    h.cleanup();
  }
});

test('P0-4: indexer lag (man not_found, secondary found) persists pending-sync, not a hard failure', async () => {
  const h = await createHarness({
    readPinSecondaryForVerification: async () => 'found',
    verificationRetryMs: 60_000,
  });
  try {
    const task = h.createTask([2, 3]);
    h.state.nowMs = Date.now();
    h.state.pinOutcomes[REAL_PINID_2] = 'not_found';
    insertGroupMessage(h.db, {
      pinId: 'pin-deliv-2', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: `[DELIVERABLE] metaapp: metaapp://${REAL_PINID_2}`,
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    const deliverable = h.groupTaskStore.listDeliverables(task.id)[0];
    const report = JSON.parse(deliverable.verification);
    assert.equal(report.verified, false);
    assert.equal(report.sources.some((s) => s.outcome === 'not_found'), true);
    assert.equal(report.sources.some((s) => s.outcome === 'found'), true);
  } finally {
    h.cleanup();
  }
});

test('P0-4: missed delivery deadline posts ONE reminder; delivered members are skipped', async () => {
  const h = await createHarness({ ackTimeoutMs: 180_000 });
  try {
    const task = h.createTask([2, 3]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    // Chair assigns worker 2; worker ACKs with a 5-minute estimate.
    insertGroupMessage(h.db, {
      pinId: 'pin-a4-1', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot please deliver',
      chainTimestamp: Math.floor(startMs / 1000),
    });
    insertGroupMessage(h.db, {
      pinId: 'pin-a4-2', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 已接单：deliver，预计 5 分钟',
      chainTimestamp: Math.floor(startMs / 1000),
    });
    await h.loop.runTick();
    assert.ok(h.store.get('group_task_expected_delivery:1:2'));
    h.sends.length = 0;

    // Before deadline: no reminder.
    h.state.nowMs = startMs + 3 * 60_000;
    await h.loop.runTick();
    assert.equal(h.sends.length, 0);

    // Past deadline: one reminder.
    h.state.nowMs = startMs + 6 * 60_000;
    await h.loop.runTick();
    const reminders = h.sends.filter((s) => /no \[DELIVERABLE\] arrived/.test(s.content));
    assert.equal(reminders.length, 1);
    assert.match(reminders[0].content, /@chair/);

    // No repeat.
    h.state.nowMs = startMs + 12 * 60_000;
    await h.loop.runTick();
    assert.equal(h.sends.filter((s) => /no \[DELIVERABLE\] arrived/.test(s.content)).length, 1);
  } finally {
    h.cleanup();
  }
});

test('P0-8: member correction message records an integrity event (deduped by pin)', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2, 3]);
    h.state.nowMs = Date.now();
    insertGroupMessage(h.db, {
      pinId: 'pin-correction-1', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '更正：我此前的链接无效，正确预览如下',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    const events = h.groupTaskStore.listIntegrityEvents(task.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, 'correction');
    assert.equal(events[0].msgPinId, 'pin-correction-1');

    // same pin re-processed (retry) → no duplicate
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.listIntegrityEvents(task.id).length, 1);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// C-1: chair auto-planning must cover >= 2 members (defensive check)
// ---------------------------------------------------------------------------

test('C-1: checkPlanningCoverage is advisory — a one-seat plan is legal', () => {
  const { checkPlanningCoverage } = require('../dist-electron/main/services/groupTaskDaemon.js');
  const tenWorkers = ['AI_小新', 'Builder', 'Lucy', 'eleven', 'loop AI', '小明同学', '10th bot', '77', 'Stephen', 'claude-bot2'];

  const single = checkPlanningCoverage(
    'Plan: @AI_小新 you are the only worker, do everything. [STATUS:EXECUTING]',
    tenWorkers,
  );
  assert.equal(single.ok, true);
  assert.deepEqual(single.mentionedWorkers, ['AI_小新']);
  assert.ok(single.unmentionedWorkers.includes('Lucy'));

  const spread = checkPlanningCoverage(
    'Plan: @AI_小新 research, @Lucy copy, @Builder assemble; others standby. [STATUS:EXECUTING]',
    tenWorkers,
  );
  assert.equal(spread.ok, true);
  assert.ok(spread.mentionedWorkers.length >= 2);

  const singleWorkerRoster = checkPlanningCoverage('Plan: @Coder Bot do it', ['Coder Bot']);
  assert.equal(singleWorkerRoster.ok, true);
});

test('C-1: a one-seat plan posts immediately without a host coverage warning', async () => {
  const h = await createHarness({
    chatReply: 'Plan: @Coder Bot, you are the only worker — do everything. [STATUS:EXECUTING]',
    disableChairPlanningTurn: false,
  });
  try {
    // Seated roster may be larger than the plan; extra names stay idle on purpose.
    const task = h.createTask([2, 3, 4], { activate: false });
    await h.loop.runTick();
    assert.equal(h.sends.length, 1, 'posted on the first planning turn');
    assert.doesNotMatch(h.sends[0].content, /Host warning/);
    assert.equal(h.store.get(`group_task_chair_plan_attempts:${task.id}`), undefined);
  } finally {
    h.cleanup();
  }
});

test('C-1: multi-worker plan posts immediately without warning', async () => {
  const h = await createHarness({
    chatReply: 'Plan: @Coder Bot research, @Designer Bot design, @Reviewer Bot review. [STATUS:EXECUTING]',
  });
  try {
    const task = h.createTask([2, 3, 4], { activate: false });
    await h.loop.runTick();
    assert.equal(h.sends.length, 1);
    assert.doesNotMatch(h.sends[0].content, /Host warning/);
    assert.equal(h.store.get(`group_task_chair_planned:${task.id}`), '1');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// F1 (GT#11): the planning turn must not fire against a half-formed roster
// ---------------------------------------------------------------------------

test('F1: buildRosterSignature — stable roster => stable signature; any member change => new signature', () => {
  const { buildRosterSignature } = require('../dist-electron/main/services/groupTaskDaemon.js');
  const rosterA = [
    { role: 'chair', name: 'Twin Bot', globalmetaid: 'gmid-twin', metabotId: 1 },
    { role: 'worker', name: 'Coder Bot', globalmetaid: 'gmid-w2', metabotId: 2 },
    { role: 'worker', name: 'Designer Bot', globalmetaid: 'gmid-w3', metabotId: 3 },
  ];
  const rosterAShuffled = [rosterA[2], rosterA[0], rosterA[1]];
  assert.equal(buildRosterSignature(rosterA), buildRosterSignature(rosterAShuffled), 'order-independent');
  const rosterMinusDesigner = rosterA.filter((m) => m.metabotId !== 3);
  assert.notEqual(buildRosterSignature(rosterA), buildRosterSignature(rosterMinusDesigner), 'member removal changes the sig');
  const rosterWithReviewer = [...rosterA, { role: 'worker', name: 'Reviewer Bot', globalmetaid: 'gmid-w4', metabotId: 4 }];
  assert.notEqual(buildRosterSignature(rosterA), buildRosterSignature(rosterWithReviewer), 'member add changes the sig');
  const rosterRoleChanged = rosterA.map((m) => (m.metabotId === 3 ? { ...m, role: 'chair' } : m));
  assert.notEqual(buildRosterSignature(rosterA), buildRosterSignature(rosterRoleChanged), 'role change changes the sig');
  const rosterRemote = [
    { role: 'worker', name: null, displayName: 'Alicia Remote', globalmetaid: 'gmid-remote', metabotId: null },
  ];
  assert.notEqual(buildRosterSignature([]), buildRosterSignature(rosterRemote), 'remote member shows up in the sig');
});

test('F1: chair planning waits for the roster to settle — mid-create ticks never misplan', async () => {
  const h = await createHarness({
    chatReply: 'Plan: @Coder Bot research, @Designer Bot design, @Reviewer Bot review. [STATUS:EXECUTING]',
    chairPlanRosterSettleMs: 20_000,
    chairPlanRosterCapMs: 600_000,
  });
  try {
    // Simulate createGroupTask mid-flight: task row + chair + ONE worker.
    const task = h.createTask([2], { activate: false });
    await h.loop.runTick();
    assert.equal(h.chatCalls.length, 0, 'tick 1: roster still forming — no planning');
    assert.equal(h.sends.length, 0);
    assert.equal(h.store.get(`group_task_chair_planned:${task.id}`), undefined, 'planned flag not set while waiting');

    // More workers join as creation proceeds.
    h.groupTaskStore.addMember({ taskId: task.id, metabotId: 3, role: 'worker' });
    h.groupTaskStore.addMember({ taskId: task.id, metabotId: 4, role: 'worker' });
    await h.loop.runTick();
    assert.equal(h.chatCalls.length, 0, 'tick 2: roster changed again — still deferred');

    // Roster now stable, but inside the settle window.
    await h.loop.runTick();
    assert.equal(h.chatCalls.length, 0, 'tick 3: roster stable but not yet settled');

    // Time passes the settle window: planning fires with the FULL roster.
    h.state.nowMs += 25_000;
    await h.loop.runTick();
    assert.equal(h.chatCalls.length, 1, 'tick 4: planning fires once the roster settled');
    assert.match(h.chatCalls[0].userMessage, /Assign each seated specialist their own coarse seat/, 'directive sees the settled roster');
    assert.match(h.chatCalls[0].userMessage, /Coder Bot \[worker\]/, 'full roster embedded in the directive');
    assert.match(h.chatCalls[0].userMessage, /Designer Bot \[worker\]/, 'full roster embedded in the directive');
    assert.equal(h.sends.length, 1);
    assert.equal(h.store.get(`group_task_chair_planned:${task.id}`), '1');
  } finally {
    h.cleanup();
  }
});

test('F1: planning proceeds after the absolute cap even if the roster never settles', async () => {
  const h = await createHarness({
    chatReply: 'Plan: @Coder Bot research, @Designer Bot design. [STATUS:EXECUTING]',
    chairPlanRosterSettleMs: 60_000,
    chairPlanRosterCapMs: 90_000,
  });
  try {
    const task = h.createTask([2], { activate: false });
    await h.loop.runTick(); // roster sig recorded (chair + Coder)
    h.groupTaskStore.addMember({ taskId: task.id, metabotId: 3, role: 'worker' });
    await h.loop.runTick(); // sig changed; re-recorded, still deferred
    // Pin the task creation to (harness now - 2h): the cap must override the
    // settle gate once the task is old enough.
    h.db.run(
      `UPDATE group_tasks SET created_at = strftime('%Y-%m-%d %H:%M:%S', 1000000000 - 7200, 'unixepoch') WHERE id = ?`,
      [task.id],
    );
    h.state.nowMs += 95_000; // past the 90s cap from creation
    await h.loop.runTick();
    assert.equal(h.chatCalls.length, 1, 'cap overrides the settle gate');
    assert.equal(h.sends.length, 1, 'plan posted despite an unsettled roster');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// F2 (GT#11): session-level driving mutex (pure helpers)
// ---------------------------------------------------------------------------

test('F2: tryAcquireGroupTaskDriver — acquire / own-refresh / foreign-reject / stale-takeover', () => {
  const { tryAcquireGroupTaskDriver } = require('../dist-electron/main/services/groupTaskDaemon.js');
  const kv = new Map();
  const store = {
    get: (key) => kv.get(key),
    set: (key, value) => kv.set(key, value),
    delete: (key) => kv.delete(key),
  };

  const acquired = tryAcquireGroupTaskDriver(store, 7, 'rpc:1', 20_000, 1_000);
  assert.equal(acquired.ok, true, 'no claim -> acquire');
  assert.equal(store.get('group_task_driver:7'), 'rpc:1|1000');

  const ownNoRefresh = tryAcquireGroupTaskDriver(store, 7, 'rpc:1', 20_000, 2_000, false);
  assert.equal(ownNoRefresh.ok, true, 'own claim with refreshOwn=false still passes');
  assert.equal(store.get('group_task_driver:7'), 'rpc:1|1000', 'refreshOwn=false keeps the claim age-based');

  const ownRefresh = tryAcquireGroupTaskDriver(store, 7, 'rpc:1', 20_000, 3_000, true);
  assert.equal(ownRefresh.ok, true, 'own claim with refreshOwn=true passes');
  assert.equal(store.get('group_task_driver:7'), 'rpc:1|3000', 'refreshOwn=true extends the lease');

  const foreign = tryAcquireGroupTaskDriver(store, 7, 'daemon-uuid', 20_000, 4_000);
  assert.equal(foreign.ok, false, 'foreign fresh claim -> rejected');
  assert.equal(foreign.driverId, 'rpc:1');
  assert.equal(foreign.claimAgeMs, 1_000);
  assert.equal(foreign.retryAfterMs, 19_000);

  const stale = tryAcquireGroupTaskDriver(store, 7, 'daemon-uuid', 20_000, 30_000);
  assert.equal(stale.ok, true, 'stale claim -> takeover');
  assert.equal(store.get('group_task_driver:7'), 'daemon-uuid|30000');
});

test('F2: gateChairDrivingSend — worker sends pass; chair sends are mutually exclusive per session', () => {
  const { gateChairDrivingSend } = require('../dist-electron/main/services/groupTaskDaemon.js');
  const kv = new Map();
  const store = {
    get: (key) => kv.get(key),
    set: (key, value) => kv.set(key, value),
    delete: (key) => kv.delete(key),
  };

  // Worker sends are never driving.
  assert.deepEqual(
    gateChairDrivingSend({ kv: store, taskId: 7, senderMetabotId: 2, chairMetabotId: 1, graceMs: 20_000, nowMs: 1_000 }),
    { ok: true },
  );

  // First chair send acquires the claim under its session id.
  const first = gateChairDrivingSend({
    kv: store, taskId: 7, senderMetabotId: 1, chairMetabotId: 1,
    driverId: 'session-a', graceMs: 20_000, nowMs: 1_000,
  });
  assert.equal(first.ok, true);
  assert.equal(store.get('group_task_driver:7'), 'session-a|1000');

  // A DIFFERENT session is rejected with a readable error + retry hint.
  const second = gateChairDrivingSend({
    kv: store, taskId: 7, senderMetabotId: 1, chairMetabotId: 1,
    driverId: 'session-b', graceMs: 20_000, nowMs: 2_000,
  });
  assert.equal(second.ok, false, 'second session rejected while the first drives');
  assert.match(second.error, /being driven by another session/);
  assert.match(second.error, /retry in 19s/);
  assert.equal(second.retryAfterMs, 19_000);
  assert.equal(second.driverId, 'session-a');

  // The SAME session id keeps driving (refreshes instead of rejection).
  const same = gateChairDrivingSend({
    kv: store, taskId: 7, senderMetabotId: 1, chairMetabotId: 1,
    driverId: 'session-a', graceMs: 20_000, nowMs: 5_000,
  });
  assert.equal(same.ok, true, 'same driver_id refreshes instead of being rejected');
  assert.equal(store.get('group_task_driver:7'), 'session-a|5000');

  // Omitted driver_id defaults to rpc:<chairMetabotId>.
  const byDefault = gateChairDrivingSend({
    kv: store, taskId: 8, senderMetabotId: 1, chairMetabotId: 1, graceMs: 20_000, nowMs: 9_000,
  });
  assert.equal(byDefault.ok, true);
  assert.equal(store.get('group_task_driver:8'), 'rpc:1|9000');
});

// ---------------------------------------------------------------------------
// F6 (GT#11): [STATUS:REVIEW] parsing chain — the P2-7 Twin-activity
// suppression window must never swallow the chair's status switch
// ---------------------------------------------------------------------------

test('F6: chair [STATUS:REVIEW] during the Twin-activity suppression window is still parsed', async () => {
  const h = await createHarness({ disableChairPlanningTurn: true });
  try {
    const task = h.createTask([2]); // executing

    // The Twin speaks proactively inside the 60s suppression window — any
    // daemon chair AUTO reply is suppressed from this point on.
    insertGroupMessage(h.db, {
      pinId: 'f6-twin-active-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '各位，这个任务我来主导。', chainTimestamp: 1_000_000_000,
    });
    // A worker deliverable arrives — the auto-verify reply would be suppressed.
    insertGroupMessage(h.db, {
      pinId: 'f6-dlv-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: '[DELIVERABLE] metaapp: metaapp://ababababababababababababababababababababababababababababababababi0',
      chainTimestamp: 1_000_000_005,
    });
    // The chair flips the task to REVIEW while the window is still active.
    insertGroupMessage(h.db, {
      pinId: 'f6-review-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '[STATUS:REVIEW] 全部交付已核验', chainTimestamp: 1_000_000_010,
    });
    await h.loop.runTick();

    assert.equal(
      h.groupTaskStore.getTaskById(task.id).status,
      'review',
      'chair status switch is parsed and applied despite the suppression window',
    );
    // #14: the review entry posts the deterministic system closing line (a
    // host guarantee, NOT an LLM auto reply — still posted in the window so
    // the group never rests on a worker [WORKING]).
    assert.equal(h.sends.length, 1, 'no chair auto replies, only the system closing line');
    assert.equal(h.sends[0].metabotId, 1, 'closing posted as the chair');
    assert.match(h.sends[0].content, /进入验收阶段/, 'closing line content');
    assert.equal(h.groupTaskStore.listDeliverables(task.id).length, 1, 'deliverable row still recorded');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// P1-4: [DEPENDS_ON] derived assignments inherit the upstream ACK (ack-seen)
// ---------------------------------------------------------------------------

/** Minimal sqlite-like mock: kv for ack-seen + a message-pin table. */
const makeDerivedSqlite = ({ upstreamMessageId = null, ackSeen = false } = {}) => {
  const kv = new Map();
  if (ackSeen) kv.set('group_task_ack_seen:7:101', '1');
  return {
    get: (key) => (kv.has(key) ? kv.get(key) : null),
    set: (key, value) => kv.set(key, value),
    delete: (key) => kv.delete(key),
    getDatabase: () => ({
      exec: (sql, params) => {
        if (upstreamMessageId != null && String(params?.[1]) === REAL_PINID_1) {
          return [{ values: [[upstreamMessageId]] }];
        }
        return [];
      },
    }),
  };
};

test('P1-4: resolveDerivedAssignmentUpstream returns null for non-derived messages', () => {
  const task = { id: 7, groupId: GROUP_ID };
  const sqlite = makeDerivedSqlite();
  assert.equal(resolveDerivedAssignmentUpstream(task, { content: 'please do step 1' }, sqlite), null);
  assert.equal(resolveDerivedAssignmentUpstream(task, { content: '[DEPENDS_ON: ' }, sqlite), null);
  assert.equal(resolveDerivedAssignmentUpstream(task, { content: '' }, sqlite), null);
});

test('P1-4: a descriptive [DEPENDS_ON] (no resolvable pinid) gets a normal watch (falsy)', () => {
  const task = { id: 7, groupId: GROUP_ID };
  assert.equal(
    resolveDerivedAssignmentUpstream(task, { content: '[DEPENDS_ON: the upstream design]' }, makeDerivedSqlite()),
    '',
    'descriptive reference -> normal watch',
  );
  assert.equal(
    resolveDerivedAssignmentUpstream(
      task,
      { content: `[DEPENDS_ON: ${REAL_PINID_1}]` },
      makeDerivedSqlite({ upstreamMessageId: null }),
    ),
    '',
    'pinid not found in this group -> normal watch',
  );
});

test('P1-4: derived assignment inherits the upstream ACK only when ack-seen', () => {
  const task = { id: 7, groupId: GROUP_ID };
  const upstreamAcked = makeDerivedSqlite({ upstreamMessageId: 101, ackSeen: true });
  assert.equal(
    resolveDerivedAssignmentUpstream(task, { content: `[DEPENDS_ON: ${REAL_PINID_1}]` }, upstreamAcked),
    REAL_PINID_1,
    'upstream ACKed -> inherits, no new watch',
  );
  const upstreamNotAcked = makeDerivedSqlite({ upstreamMessageId: 101, ackSeen: false });
  assert.equal(
    resolveDerivedAssignmentUpstream(task, { content: `[DEPENDS_ON: ${REAL_PINID_1}]` }, upstreamNotAcked),
    '',
    'upstream message exists but not ACKed -> normal watch',
  );
});

// ---------------------------------------------------------------------------
// P1-3: the chair planning directive carries pending invites / placeholders
// ---------------------------------------------------------------------------

test('P1-3: buildOpenTeamPlanningStatusBlock reports pending invites and placeholders', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2], { activate: false });
    const membershipStore = new OpenTeamMembershipStore(h.db, h.store.getSaveFunction());
    const groupTaskStore = h.groupTaskStore;

    // Nothing to report -> empty block.
    assert.equal(buildOpenTeamPlanningStatusBlock(membershipStore, task, groupTaskStore), '');
    assert.equal(buildOpenTeamPlanningStatusBlock(undefined, task, groupTaskStore), '', 'unwired store');

    // A live pending invite must appear with the "do not re-decompose" hint.
    membershipStore.createInvite({
      taskId: task.id,
      groupId: GROUP_ID,
      inviteeGlobalmetaid: 'gmid-remote-invitee',
      inviteeName: 'Fortune Bot',
      invitePinId: 'pending-pin-1',
    });
    const block = buildOpenTeamPlanningStatusBlock(membershipStore, task, groupTaskStore);
    assert.match(block, /Fortune Bot/);
    assert.match(block, /Do NOT plan a "search for a remote bot/);
    assert.match(block, /already invited/);

    // A placeholder member (no join pin, no pending invite) must appear too.
    groupTaskStore.addMember({
      taskId: task.id,
      metabotId: null,
      globalmetaid: 'gmid-stale-placeholder',
      displayName: 'Stale Placeholder',
      role: 'worker',
      joinedPinId: null,
    });
    const block2 = buildOpenTeamPlanningStatusBlock(membershipStore, task, groupTaskStore);
    assert.match(block2, /Stale Placeholder/);
    assert.match(block2, /join never confirmed/);

    // A confirmed remote member (joined pin) is NOT a placeholder.
    groupTaskStore.addMember({
      taskId: task.id,
      metabotId: null,
      globalmetaid: 'gmid-confirmed-remote',
      displayName: 'Confirmed Remote',
      role: 'worker',
      joinedPinId: 'joined-pin-x',
    });
    const block3 = buildOpenTeamPlanningStatusBlock(membershipStore, task, groupTaskStore);
    assert.doesNotMatch(block3, /Confirmed Remote/);
  } finally {
    h.cleanup();
  }
});

test('P1-3: the planning directive embeds the OpenTeam block when invites are pending', async () => {
  const h = await createHarness();
  try {
    const membershipStore = new OpenTeamMembershipStore(h.db, h.store.getSaveFunction());
    // Wire the optional store getter (same shape main.ts passes).
    h.loop = createGroupTaskDaemonLoop({
      ...h.deps,
      getOpenTeamMembershipStore: () => membershipStore,
    });
    const task = h.createTask([2], { activate: false }); // planning
    membershipStore.createInvite({
      taskId: task.id,
      groupId: GROUP_ID,
      inviteeGlobalmetaid: 'gmid-remote-invitee',
      inviteeName: 'Fortune Bot',
      invitePinId: 'pending-pin-2',
    });
    await h.loop.runTick();

    assert.equal(h.sends.length, 1, 'chair posted exactly one plan');
    const planningCall = h.chatCalls[0];
    assert.match(planningCall.userMessage, /OpenTeam invites already sent/);
    assert.match(planningCall.userMessage, /Fortune Bot/);
    assert.match(planningCall.userMessage, /Do NOT plan a "search for a remote bot/);
  } finally {
    h.cleanup();
  }
});

test('P1-4: worker who spoke before the watch armed is not flagged at ACK timeout (implicit ACK)', async () => {
  const h = await createHarness({ ackTimeoutMs: 180_000 });
  try {
    const task = h.createTask([2]);
    const startMs = Date.now();
    h.state.nowMs = startMs;

    // Cursor edge: the worker's speech message has a LOWER id than the
    // assignment, so it is processed first (no watch exists yet — clearPendingAck
    // is a no-op), and the assignment re-arms the watch afterwards. The worker
    // demonstrably spoke at the same chain second as the assignment, so the
    // watchdog must treat it as engaged instead of flagging it as not ACKed.
    insertGroupMessage(h.db, {
      pinId: 'pin-impack-s1', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: 'on it, checking the sources',
      chainTimestamp: Math.ceil(startMs / 1000),
    });
    insertGroupMessage(h.db, {
      pinId: 'pin-impack-a1', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot please build the metaapp',
      chainTimestamp: Math.floor(startMs / 1000),
    });
    await h.loop.runTick();
    const assignId = h.db.exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', ['pin-impack-a1'])[0].values[0][0];
    const watch = JSON.parse(h.store.get(`group_task_ack_pending:${task.id}:2`));
    assert.equal(watch.messageId, assignId, 'watch armed by the assignment, not the speech');
    h.sends.length = 0;

    // Past the ACK timeout: the worker spoke at the assignment's chain second
    // (implicit ACK) → ack-seen recorded, watch cleared, NO chair reminder.
    h.state.nowMs = startMs + 200_000;
    await h.loop.runTick();
    assert.equal(h.sends.length, 0, 'no no-ACK reminder for an engaged worker');
    assert.equal(h.store.get(`group_task_ack_seen:${task.id}:${assignId}`), '1', 'ack-seen recorded for the assignment');
    assert.equal(h.store.get(`group_task_ack_pending:${task.id}:2`), undefined, 'pending watch cleared (kv delete)');

    // Later ticks stay quiet — the reminder never fires.
    h.state.nowMs = startMs + 400_000;
    await h.loop.runTick();
    assert.equal(h.sends.length, 0);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 清单 #10 P-A (groupTaskDaemon canonical path): a worker whose session did
// real work but ended with an EMPTY reply must fail the canonical attempt with
// WORKER_EMPTY_HANDOFF_WITH_ACTIVITY + summary, not an opaque bare code.
// ---------------------------------------------------------------------------
test('canonical: empty worker reply + substantive session activity → attempt fails with WORKER_EMPTY_HANDOFF_WITH_ACTIVITY', async () => {
  const h = await createHarness({
    coderChatSkills: ['web-search'],
    routing: () => ({ prompt: '<available_skills>web-search</available_skills>', activeSkillIds: ['web-search'] }),
    skillReply: '',
  });
  try {
    // The fake skill turn now also persists real-looking activity into the
    // task session (mimicking the real runner appending tool messages while
    // the worker worked) and ends with an empty final reply.
    const baseRunSkillTurn = h.deps.runSkillTurn;
    h.deps.runSkillTurn = async (params) => {
      const result = await baseRunSkillTurn(params);
      h.coworkStore.addMessage(params.sessionId, { type: 'assistant', content: 'Plan: implement the fix.' });
      h.coworkStore.addMessage(params.sessionId, { type: 'tool_use', content: 'Using tool: Edit', metadata: { toolName: 'Edit', toolInput: { file_path: 'src/a.ts' }, toolUseId: 'tu-1' } });
      h.coworkStore.addMessage(params.sessionId, { type: 'tool_result', content: 'Edited src/a.ts', metadata: { toolUseId: 'tu-1', isError: false, toolResult: 'Edited src/a.ts' } });
      h.coworkStore.addMessage(params.sessionId, { type: 'tool_use', content: 'Using tool: Bash', metadata: { toolName: 'Bash', toolInput: { command: 'npm test' }, toolUseId: 'tu-2' } });
      h.coworkStore.addMessage(params.sessionId, { type: 'tool_result', content: '315/315 tests passed', metadata: { toolUseId: 'tu-2', isError: false, toolResult: '315/315 tests passed' } });
      h.coworkStore.addMessage(params.sessionId, { type: 'assistant', content: 'Progress: core fix done.' });
      return result; // replyText: ''
    };

    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'empty-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot implement the fix and report back',
    });
    await h.loop.runTick();

    const canonicalId = h.groupTaskStore.getTaskById(task.id).orchestrationTaskId;
    assert.ok(canonicalId, 'canonical orchestration task linked');
    const canonical = h.orchestrationStore.getTask(canonicalId);
    const step = h.orchestrationStore.listSteps(canonical.id)[0];
    const attempt = h.orchestrationStore.listAttempts(step.id)[0];
    assert.equal(attempt.status, 'failed');
    assert.match(attempt.error, /^WORKER_EMPTY_HANDOFF_WITH_ACTIVITY:/);
    assert.match(attempt.error, /files=\[src\/a\.ts\]/);
    assert.match(attempt.error, /tests=\[.*315\/315/);
    assert.match(attempt.error, /toolCalls=2/);
    // the activity the summary describes matches what the session recorded
    const sessionMessages = h.coworkStore.getSessionMessages(attempt.workerSessionId);
    assert.equal(sessionMessages.filter((m) => m.type === 'tool_use').length, 2);
  } finally {
    h.cleanup();
  }
});

test('canonical: empty worker reply + bare session keeps the plain WORKER_EMPTY_HANDOFF', async () => {
  const h = await createHarness({
    coderChatSkills: ['web-search'],
    routing: () => ({ prompt: '<available_skills>web-search</available_skills>', activeSkillIds: ['web-search'] }),
    skillReply: '',
  });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'bare-empty-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot quick question',
    });
    await h.loop.runTick();

    const canonicalId = h.groupTaskStore.getTaskById(task.id).orchestrationTaskId;
    const canonical = h.orchestrationStore.getTask(canonicalId);
    const step = h.orchestrationStore.listSteps(canonical.id)[0];
    const attempt = h.orchestrationStore.listAttempts(step.id)[0];
    assert.equal(attempt.status, 'failed');
    assert.equal(attempt.error, 'WORKER_EMPTY_HANDOFF');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Team culture injection (P3: shared coordination base)
// ---------------------------------------------------------------------------

test('planning directive and turn tail carry the team culture block', async () => {
  const h = await createHarness({
    buildTeamCultureBlock: () => '<team_culture>\nShared glossary (use these exact terms):\n- deliverable: An on-chain metafile with verification JSON.\n</team_culture>',
  });
  try {
    const task = h.createTask([2], { activate: false }); // planning
    await h.loop.runTick();

    const planningCall = h.chatCalls[0];
    assert.match(planningCall.userMessage, /<team_culture>/);
    assert.match(planningCall.userMessage, /Shared glossary \(use these exact terms\):/,
      'the planning turn carries the culture block via the volatile tail');
    assert.equal(
      (planningCall.userMessage.match(/<team_culture>/g) ?? []).length,
      1,
      'exactly one culture block per turn — never duplicated by the directive',
    );
  } finally {
    h.cleanup();
  }
});

test('team culture block is omitted when the store is empty', async () => {
  const h = await createHarness({ buildTeamCultureBlock: () => null });
  try {
    const task = h.createTask([2], { activate: false });
    await h.loop.runTick();
    assert.doesNotMatch(h.chatCalls[0].userMessage, /<team_culture>/);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Entropy P1: cognition block TTL cache
// ---------------------------------------------------------------------------

const p1CognitionHarness = async () => {
  const cognitionCalls = [];
  const h = await createHarness({
    getMetaIDGroupCognitionPromptBlock: async (input) => {
      cognitionCalls.push({ observerGlobalMetaID: input.observerGlobalMetaID, roster: input.roster });
      return `<metaid_group_cognition>Observer: ${input.observerGlobalMetaID}</metaid_group_cognition>`;
    },
  });
  return { h, cognitionCalls };
};

const p1WorkerPing = (h, pinId, content) => insertGroupMessage(h.db, {
  pinId,
  senderMetaId: 'metaid-h',
  senderGlobalMetaId: 'gmid-boss',
  senderName: 'Human',
  content,
});

test('entropy P1: cognition block cached per (task, bot) within the TTL, rebuilt after expiry', async () => {
  const { h, cognitionCalls } = await p1CognitionHarness();
  try {
    h.createTask([2]);
    p1WorkerPing(h, 'p1-a-i0', '@Coder Bot go');
    await h.loop.runTick();
    h.state.nowMs += 21_000; // past the worker cooldown
    p1WorkerPing(h, 'p1-b-i0', '@Coder Bot go again');
    await h.loop.runTick();
    assert.equal(
      cognitionCalls.filter((call) => call.observerGlobalMetaID === 'gmid-w2').length,
      1,
      'second turn within the TTL reuses the cached block',
    );

    h.state.nowMs += 5 * 60_000 + 1_000; // past the cache TTL
    p1WorkerPing(h, 'p1-c-i0', '@Coder Bot third pass');
    await h.loop.runTick();
    assert.equal(
      cognitionCalls.filter((call) => call.observerGlobalMetaID === 'gmid-w2').length,
      2,
      'block rebuilt after the TTL expires',
    );
  } finally {
    h.cleanup();
  }
});

test('entropy P1: cognitionCache knob off restores per-turn rebuilds', async () => {
  const { h, cognitionCalls } = await p1CognitionHarness();
  try {
    h.store.set('groupTaskEntropyP1', JSON.stringify({ cognitionCache: false }));
    h.createTask([2]);
    p1WorkerPing(h, 'p1-d-i0', '@Coder Bot go');
    await h.loop.runTick();
    h.state.nowMs += 21_000;
    p1WorkerPing(h, 'p1-e-i0', '@Coder Bot go again');
    await h.loop.runTick();
    assert.equal(
      cognitionCalls.filter((call) => call.observerGlobalMetaID === 'gmid-w2').length,
      2,
      'knob off: every turn rebuilds',
    );
  } finally {
    h.cleanup();
  }
});

test('entropy P1: workerChairOnly knob off restores the full-roster worker cognition', async () => {
  const cognitionCalls = [];
  const h = await createHarness({
    getMetaIDGroupCognitionPromptBlock: async (input) => {
      cognitionCalls.push(input);
      return '<metaid_group_cognition>ok</metaid_group_cognition>';
    },
  });
  try {
    h.store.set('groupTaskEntropyP1', JSON.stringify({ workerChairOnly: false }));
    h.createTask([2]);
    p1WorkerPing(h, 'p1-f-i0', '@Coder Bot go');
    await h.loop.runTick();
    const workerInput = cognitionCalls.find((input) => input.observerGlobalMetaID === 'gmid-w2');
    assert.ok(workerInput);
    assert.deepEqual(
      workerInput.roster.map((member) => member.globalMetaID).sort(),
      ['gmid-twin', 'gmid-w2'],
      'knob off: worker sees the full roster again',
    );
  } finally {
    h.cleanup();
  }
});

test('entropy P1: the chair keeps the full-roster cognition for arbitration', async () => {
  const cognitionCalls = [];
  const h = await createHarness({
    getMetaIDGroupCognitionPromptBlock: async (input) => {
      cognitionCalls.push(input);
      return '<metaid_group_cognition>ok</metaid_group_cognition>';
    },
  });
  try {
    h.createTask([2, 3]);
    // Unaddressed floor-control message from a non-owner triggers a chair turn.
    insertGroupMessage(h.db, {
      pinId: 'p1-g-i0',
      senderMetaId: 'metaid-w2',
      senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: '环境已就绪，随时可以开工',
    });
    await h.loop.runTick();
    const chairInput = cognitionCalls.find((input) => input.observerGlobalMetaID === 'gmid-twin');
    assert.ok(chairInput, 'chair turn ran');
    assert.deepEqual(
      chairInput.roster.map((member) => member.globalMetaID).sort(),
      ['gmid-twin', 'gmid-w2', 'gmid-w3'],
      'chair cognition covers the whole roster',
    );
  } finally {
    h.cleanup();
  }
});

test('entropy P1 review: mid-TTL member join rebuilds the chair block; the worker chair-only view stays cached', async () => {
  const { h, cognitionCalls } = await p1CognitionHarness();
  try {
    const task = h.createTask([2]);
    p1WorkerPing(h, 'p1-r1-i0', '@Coder Bot go');
    await h.loop.runTick();
    assert.equal(cognitionCalls.filter((call) => call.observerGlobalMetaID === 'gmid-twin').length, 1);
    assert.equal(cognitionCalls.filter((call) => call.observerGlobalMetaID === 'gmid-w2').length, 1);

    h.state.nowMs += 21_000; // inside the TTL, past cooldowns
    h.groupTaskStore.addMember({ taskId: task.id, metabotId: 3, role: 'worker' });
    p1WorkerPing(h, 'p1-r2-i0', '@Coder Bot go again');
    await h.loop.runTick();
    assert.equal(
      cognitionCalls.filter((call) => call.observerGlobalMetaID === 'gmid-twin').length,
      2,
      'chair roster changed (join) -> fingerprint miss -> rebuild',
    );
    assert.equal(
      cognitionCalls.filter((call) => call.observerGlobalMetaID === 'gmid-w2').length,
      1,
      'worker chair-only view unaffected by a peer join -> stays cached',
    );
  } finally {
    h.cleanup();
  }
});

test('entropy P1 review: chair replaced mid-TTL rebuilds the worker block with the new chair entry', async () => {
  const { h, cognitionCalls } = await p1CognitionHarness();
  try {
    const task = h.createTask([2]);
    p1WorkerPing(h, 'p1-r3-i0', '@Coder Bot go');
    await h.loop.runTick();

    h.state.nowMs += 21_000; // inside the TTL
    h.db.run(
      'UPDATE group_task_members SET globalmetaid = ? WHERE task_id = ? AND role = ?',
      ['gmid-twin-2', task.id, 'chair'],
    );
    h.db.run('UPDATE metabots SET globalmetaid = ? WHERE id = 1', ['gmid-twin-2']);
    p1WorkerPing(h, 'p1-r4-i0', '@Coder Bot go again');
    await h.loop.runTick();

    const workerInputs = cognitionCalls.filter((input) => input.observerGlobalMetaID === 'gmid-w2');
    assert.equal(workerInputs.length, 2, 'chair change invalidates the cached worker block');
    assert.deepEqual(
      workerInputs[1].roster.map((member) => member.globalMetaID),
      ['gmid-twin-2'],
      'rebuilt with the NEW chair entry',
    );
  } finally {
    h.cleanup();
  }
});

test('entropy P1 review: chair without a globalMetaID falls back to the full-roster worker cognition', async () => {
  const cognitionCalls = [];
  const h = await createHarness({
    getMetaIDGroupCognitionPromptBlock: async (input) => {
      cognitionCalls.push(input);
      return '<metaid_group_cognition>ok</metaid_group_cognition>';
    },
  });
  try {
    const task = h.createTask([2]);
    h.db.run('UPDATE group_task_members SET globalmetaid = NULL WHERE task_id = ? AND role = ?', [task.id, 'chair']);
    h.db.run('UPDATE metabots SET globalmetaid = NULL WHERE id = 1');
    p1WorkerPing(h, 'p1-r5-i0', '@Coder Bot go');
    await h.loop.runTick();
    const workerInput = cognitionCalls.find((input) => input.observerGlobalMetaID === 'gmid-w2');
    assert.ok(workerInput, 'worker turn ran');
    assert.deepEqual(
      workerInput.roster.map((member) => member.globalMetaID),
      ['gmid-w2'],
      'chair-only filter would be empty -> full roster fallback keeps a non-empty view',
    );
  } finally {
    h.cleanup();
  }
});

test('entropy P0 review: numberless template ACK still arms the delivery deadline with the timeout default', async () => {
  const h = await createHarness({ ackTimeoutMs: 180_000 });
  try {
    const task = h.createTask([2]);
    h.state.nowMs = Date.now();
    insertGroupMessage(h.db, {
      pinId: 'pin-assign-t1', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot please build the metaapp',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    // Numberless ACK — exactly what the entropy-P0 template posts.
    insertGroupMessage(h.db, {
      pinId: 'pin-ack-t1', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 已接单，正在处理「build the metaapp」，预计需要一些时间。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    const raw = h.store.get('group_task_expected_delivery:1:2');
    assert.ok(raw, 'deadline armed even without a numeric ETA');
    const entry = JSON.parse(raw);
    assert.ok(entry.dueAt > h.state.nowMs, 'armed with a positive default window');

    // Past the default member timeout (20 min) with no deliverable -> the
    // P0-4 chair reminder must fire (it never did before this fix).
    h.state.nowMs += 21 * 60_000;
    await h.loop.runTick();
    assert.ok(
      h.sends.some((send) => /estimated delivery/.test(send.content)),
      'chair delivery reminder fired for the template-ACK deadline',
    );
  } finally {
    h.cleanup();
  }
});

test('P1-2: a dispatch swallowed by an open checkpoint posts a dispatch_held notice, workers stay silent', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2, 3]);
    h.state.nowMs = Date.now();
    h.groupTaskStore.openCheckpoint({
      taskId: task.id,
      topic: 'owner 需在火山方舟开通 doubao-seedance-2-0',
      msgPinId: 'pin-checkpoint',
    });
    insertGroupMessage(h.db, {
      pinId: 'pin-held-dispatch', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '账号已开通，@Coder Bot 继续 7 镜动画，@Designer Bot 对齐素材。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();

    // Workers are gated silent by the open checkpoint: no worker replies.
    assert.equal(
      h.sends.filter((send) => send.metabotId === 2 || send.metabotId === 3).length,
      0,
      'workers stay silent while the checkpoint is open',
    );
    // The host told the group the dispatch was held, as the chair, once.
    const held = h.sends.filter((send) =>
      send.metabotId === 1 && send.content.includes('[GROUP_TASK_NOTICE:dispatch_held]'));
    assert.equal(held.length, 1, 'exactly one dispatch-held notice');
    assert.match(held[0].content, /Coder Bot/);
    assert.match(held[0].content, /CHECKPOINT_RESOLVED/);
    assert.match(held[0].content, /doubao-seedance-2-0/, 'notice carries the checkpoint topic');
    // A second idempotent tick must not repost the notice for the same message.
    await h.loop.runTick();
    assert.equal(
      h.sends.filter((send) => send.content.includes('[GROUP_TASK_NOTICE:dispatch_held]')).length,
      1,
      'notice is posted once per held message',
    );
    // The checkpoint is still open — the notice's literal tag citation must
    // not be re-interpreted as a resolution when processed (host-notice tag
    // exemption).
    assert.ok(h.groupTaskStore.getOpenCheckpoint(task.id), 'checkpoint still open after the notice');
  } finally {
    h.cleanup();
  }
});

test('P1-2: a review-phase dispatch posts a dispatch_held notice with the reopen instruction', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    h.state.nowMs = Date.now();
    h.groupTaskStore.updateTaskStatus(task.id, 'review');
    insertGroupMessage(h.db, {
      pinId: 'pin-review-dispatch', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot one more fix before we close.',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.equal(
      h.sends.filter((send) => send.metabotId === 2).length,
      0,
      'workers stay silent in review',
    );
    const held = h.sends.filter((send) =>
      send.metabotId === 1 && send.content.includes('[GROUP_TASK_NOTICE:dispatch_held]'));
    assert.equal(held.length, 1);
    assert.match(held[0].content, /STATUS:EXECUTING/, 'review variant explains the reopen path');
    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'review', 'task stays in review');
  } finally {
    h.cleanup();
  }
});

test('P1-2: host notices citing protocol tags are never re-interpreted as those tags', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    h.state.nowMs = Date.now();
    h.groupTaskStore.openCheckpoint({
      taskId: task.id,
      topic: 'waiting for owner decision',
      msgPinId: 'pin-checkpoint-2',
    });
    h.groupTaskStore.updateTaskStatus(task.id, 'review');
    // The dispatch-held notice body itself, arriving on-chain from the chair:
    // it cites [CHECKPOINT_RESOLVED: …] and [STATUS:EXECUTING] as INSTRUCTIONS.
    insertGroupMessage(h.db, {
      pinId: 'pin-notice-roundtrip', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: [
        '[GROUP_TASK_NOTICE:dispatch_held]',
        '⏸️ A dispatch was HELD: a human checkpoint is open (waiting for owner decision).',
        'Once the owner has weighed in, post `[CHECKPOINT_RESOLVED: <decision>]` in the group.',
        'Reopen execution with `[STATUS:EXECUTING]` (or the Tasks panel Back-to-work action).',
      ].join('\n'),
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.ok(h.groupTaskStore.getOpenCheckpoint(task.id), 'cited CHECKPOINT_RESOLVED did not resolve the checkpoint');
    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'review', 'cited STATUS:EXECUTING did not reopen the task');
  } finally {
    h.cleanup();
  }
});

test('review fix: a new ETA ACK re-arms a fresh delivery-reminder cycle', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    h.state.nowMs = Date.now();
    const ack = (pin, eta) => insertGroupMessage(h.db, {
      pinId: pin, senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: `[WORKING] doing X，预计${eta}分钟`,
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    ack('pin-ack-1', 10);
    await h.loop.runTick();
    // Past the first ETA with no deliverable -> reminder fires once.
    h.state.nowMs += 11 * 60_000;
    await h.loop.runTick();
    assert.equal(h.sends.filter((send) => /estimated delivery/.test(send.content)).length, 1);
    assert.equal(h.store.get('group_task_delivery_reminded:1:2'), '1');

    // The worker ACKs a NEW assignment with a new ETA: the reminded flag from
    // the previous missed deadline must reset, or the next cycle's reminder
    // is suppressed forever.
    ack('pin-ack-2', 5);
    await h.loop.runTick();
    assert.equal(h.store.get('group_task_delivery_reminded:1:2'), undefined, 'reminded flag reset on re-arm');

    h.state.nowMs += 6 * 60_000;
    await h.loop.runTick();
    assert.equal(
      h.sends.filter((send) => /estimated delivery/.test(send.content)).length,
      2,
      'second deadline miss fires its own reminder',
    );
  } finally {
    h.cleanup();
  }
});

test('review fix: a delivered (even late) deliverable retires the deadline watch', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    h.state.nowMs = Date.now();
    insertGroupMessage(h.db, {
      pinId: 'pin-ack-late', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] doing X，预计10分钟',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    h.state.nowMs += 11 * 60_000;
    await h.loop.runTick(); // reminder fired
    assert.equal(h.sends.filter((send) => /estimated delivery/.test(send.content)).length, 1);

    // LATE deliverable lands: both kv keys retire — later ticks see no
    // outstanding deadline at all.
    insertGroupMessage(h.db, {
      pinId: 'pin-deliver-late', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: `[DELIVERABLE] metaapp: metaapp://${'ab'.repeat(32)}i0`,
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.equal(h.store.get('group_task_expected_delivery:1:2'), undefined, 'deadline entry retired on delivery');
    assert.equal(h.store.get('group_task_delivery_reminded:1:2'), undefined, 'reminded flag retired on delivery');

    h.state.nowMs += 30 * 60_000;
    await h.loop.runTick();
    assert.equal(
      h.sends.filter((send) => /estimated delivery/.test(send.content)).length,
      1,
      'no further deadline reminders after the deliverable arrived',
    );
  } finally {
    h.cleanup();
  }
});
