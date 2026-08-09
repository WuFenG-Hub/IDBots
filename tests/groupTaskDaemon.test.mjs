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
const { OrchestrationStore } = require('../dist-electron/main/orchestrationStore.js');
const { CoworkStore } = require('../dist-electron/main/coworkStore.js');
const { GroupTaskOrchestrationBridge } = require('../dist-electron/main/services/groupTaskOrchestrationBridge.js');
const {
  decideGroupTaskResponders,
  createGroupTaskDaemonLoop,
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
  };
  const seenChatErrors = new Set();
  const orchestrationBridge = new GroupTaskOrchestrationBridge({
    groupTaskStore,
    orchestrationStore,
    getMetabotById: (id) => metabotStore.getMetabotById(id),
  });

  const loop = createGroupTaskDaemonLoop({
    getStore: () => store,
    getGroupTaskStore: () => groupTaskStore,
    getMetabotStore: () => metabotStore,
    getCoworkStore: () => coworkStore,
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
  });

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
    store, db, metabotStore, groupTaskStore, orchestrationStore, coworkStore, loop,
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

test('cursor advances on no-reply messages and on per-message failure', async () => {
  const h = await createHarness();
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

    // first message blows up the LLM, second succeeds: cursor still advances past both
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

    assert.equal(h.chatCalls.length, 2, 'both messages attempted the LLM');
    assert.equal(h.sends.length, 1, 'only the second message produced a send');
    assert.match(h.sends[0].content, /reply-for-llm-2/);
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

test('skill path: routing hit runs the skill turn in the existing session, plain path untouched', async () => {
  const h = await createHarness({
    coderChatSkills: ['web-search'],
    routing: () => ({ prompt: '<available_skills>web-search</available_skills>', activeSkillIds: ['web-search'] }),
  });
  try {
    const task = h.createTask([2, 3]);
    // Round-4: a member WORKER (Designer Bot) mentions a colleague — the
    // sender is neither boss nor chair, so allowAllEnabled stays false.
    insertGroupMessage(h.db, {
      pinId: 'skill-i0', senderMetaId: 'metaid-3', senderGlobalMetaId: 'gmid-w3',
      senderName: 'Designer Bot', content: '@Coder Bot search for MetaID docs',
    });
    await h.loop.runTick();

    assert.equal(h.skillTurnCalls.length, 1, 'skill turn used');
    // P0-2 round-5: the host auto-ACK runs one fast chat call BEFORE the skill
    // turn (the fake returns 'reply-for-llm-2' without [WORKING], so the
    // template fallback is posted); the plain completion itself is not called.
    assert.equal(h.chatCalls.length, 1, 'exactly one chat call (the worker ACK)');
    assert.match(h.chatCalls[0].userMessage, /\[SYSTEM ACK directive/);
    assert.deepEqual(h.routingCalls[0].allowChatSkills, ['web-search']);
    assert.equal(h.routingCalls[0].allowAllEnabled, false, 'human sender: no owner privilege');

    // ran inside the existing metaweb_group_task session for (task, worker)
    const mapping = h.coworkStore.getConversationMapping('metaweb_group_task', `group-task:${task.id}`, 2);
    assert.ok(mapping);
    assert.equal(h.skillTurnCalls[0].sessionId, mapping.coworkSessionId);
    assert.deepEqual(h.skillTurnCalls[0].activeSkillIds, ['web-search']);
    assert.match(h.skillTurnCalls[0].systemPrompt, /available_skills/);
    assert.match(h.skillTurnCalls[0].userMessage, />>> Designer Bot: @Coder Bot/);

    // P0-2: the [WORKING] ACK went on-chain FIRST, then the turn reply;
    // the daemon did not double-append an assistant message for the ACK.
    assert.equal(h.sends.length, 2, 'ACK + turn reply posted');
    assert.match(h.sends[0].content, /^\[WORKING\]/, 'first send is the ACK status line');
    assert.deepEqual(
      [h.sends[0].metabotId, h.sends[1].metabotId],
      [2, 2],
      'both messages posted as the worker bot',
    );
    assert.equal(h.sends[1].content, 'skill-turn-reply');
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

test('skill routing: owner message grants allowAllEnabled to the responding bot', async () => {
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
    assert.equal(h.routingCalls[0].allowAllEnabled, true, 'owner privilege for skill scope');
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
    assert.deepEqual(
      h.sends.map((s) => [s.metabotId, s.content]),
      [[2, 'reply-for-llm-2']],
      'worker answered the pre-flip mention only; the post-flip mention is gated silent',
    );
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
    // P0-2 round-5: the host auto-ACK (one fast chat call) still posts the
    // "[WORKING] 已接单" signal even when the turn itself opts out with
    // [NO_REPLY] — the group must not see a silent worker.
    assert.equal(h.chatCalls.length, 1, 'one chat call (the worker ACK)');
    assert.match(h.chatCalls[0].userMessage, /\[SYSTEM ACK directive/);
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

test('chair trust: worker responding to a chair-sender message gets allowAllEnabled', async () => {
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
    assert.equal(h.routingCalls[0].allowAllEnabled, true, 'chair assignments unlock the full skill set');
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

  const workerPrompt = buildGroupTaskSystemPrompt({
    metabot: { name: 'Coder Bot' },
    task: { title: 'T', goal: 'G' },
    members,
    botRole: 'worker',
  });
  assert.match(workerPrompt, /^- Alicia Remote \(worker, remote teammate via OpenTeam\)$/m);
  assert.match(workerPrompt, /treat them as equal teammates and be polite/);
  assert.ok(!workerPrompt.includes('OpenTeam remote teammates (marked'), 'chair-only etiquette stays out of the worker playbook');
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
    assert.match(workerCall.userMessage, /- Coder Bot gmid-w2 \(worker\)/);
    assert.ok(!workerCall.systemPrompt.includes('<metaid_group_cognition>'),
      'cognition block must not sit in the system prompt (volatile, cache-prefix breaker)');

    const workerInput = cognitionCalls.find((input) => input.observerGlobalMetaID === 'gmid-w2');
    assert.ok(workerInput, 'cognition dep called for the responding worker');
    assert.deepEqual(
      workerInput.roster.map((member) => member.globalMetaID).sort(),
      ['gmid-twin', 'gmid-w2'],
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

    // the report never goes through the group send fn; only the deliverable ack did
    assert.deepEqual(h.sends.map((s) => s.metabotId), [1], 'only the chair deliverable ack hit the group');
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

    chairMsg('rw2-i0', '[STATUS:EXECUTING] rework needed');
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

test('P1-5 r2: planning directive demands distribution across at least 2 members when 2+ workers exist', async () => {
  const h = await createHarness();
  try {
    h.createTask([2, 3], { activate: false }); // planning; two workers on the roster
    await h.loop.runTick();
    const planningCall = h.chatCalls[0];
    assert.match(
      planningCall.userMessage,
      /DISTRIBUTE the subtasks across AT LEAST 2 DIFFERENT members by their strengths/,
      'with 2+ workers the directive forbids concentrating every subtask on one member',
    );
    assert.match(planningCall.userMessage, /never concentrate every subtask on a single member/);
  } finally {
    h.cleanup();
  }
});

test('P1-5 r2: planning directive with a single worker assigns all work to that member', async () => {
  const h = await createHarness();
  try {
    h.createTask([2], { activate: false });
    await h.loop.runTick();
    assert.match(
      h.chatCalls[0].userMessage,
      /single worker on the roster — assign all subtasks to that one member/,
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
