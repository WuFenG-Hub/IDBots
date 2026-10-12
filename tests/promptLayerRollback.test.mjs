import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { createCoworkStore, createSqliteStore, getRow } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

const { DreamStore } = require('../dist-electron/main/dreamStore.js');
const { MetaIDKnowledgeStore } = require('../dist-electron/main/metaidKnowledgeStore.js');
const {
  countNegativeSignalsForDay,
  evaluatePromptLayerRollback,
  ROLLBACK_NEGATIVE_FLOOR,
  ROLLBACK_BASELINE_MIN_DAYS,
  ROLLBACK_COLD_START_MIN_NEGATIVE,
  ROLLBACK_MAX_SNAPSHOTS_PER_BOT,
} = require('../dist-electron/main/libs/promptLayerRollback.js');

function loadDreamServiceModule() {
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
  try {
    return require('../dist-electron/main/services/dreamService.js');
  } finally {
    Module._load = originalLoad;
  }
}

const { DreamService } = loadDreamServiceModule();

const DAY1 = '2026-07-30';
const DAY1_START = new Date(2026, 6, 30).getTime();
const DAY2 = '2026-07-31';
const DAY2_START = new Date(2026, 6, 31).getTime();
const DAY0 = '2026-07-29';
const DAY0_START = new Date(2026, 6, 29).getTime();

const LONG_IDENTITY = `我是一个专注于视频创作的 MetaBot,名叫小火。${'我认真对待每一次交付,先验证再交付。'.repeat(10)}`;

const makePayload = (overrides = {}) => JSON.stringify({
  daily_summary: '今天为用户交付了演示视频,获得高度赞扬。',
  sections: { human: '和用户确认视频效果' },
  work_reviews: [
    { subject: '制作演示视频', counterparty: '用户', evaluation: 'warming', note: '用户从只回表情到主动追问细节' },
  ],
  important_memories: ['用户喜欢先验证再交付的节奏'],
  value_lessons: [{ rule: '交付前先自己验证一遍', source: '用户连续追问了两处细节' }],
  self_identity: LONG_IDENTITY,
  ...overrides,
});

const metabotStoreStub = () => ({
  listMetabots: () => [
    { id: 5, name: '小火', role: '视频创作者', soul: '认真严谨', llm_id: 'bot-own-llm', enabled: true },
  ],
});

const insertMessage = (db, sessionId, id, type, content, createdAt, sequence) => {
  db.run(
    'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, sessionId, type, content, '{}', createdAt, sequence]
  );
};

/** Day 1: one ordinary, well-received session. */
const seedDay1Activity = (coworkStore, db) => {
  const session = coworkStore.createSession('和用户聊发布', '/tmp/a', '', 'local', [], 5);
  insertMessage(db, session.id, 'd1-m1', 'user', '视频做好了吗', DAY1_START + 1000, 1);
  insertMessage(db, session.id, 'd1-m2', 'assistant', '做好了,你看下', DAY1_START + 2000, 2);
  return session;
};

/**
 * Day 2: a negative-feedback spike for the retention gate — two thumbs-down
 * replies plus one re-ask signal (cold start: 3 >= 3 with a 1-day baseline).
 */
const seedDay2NegativeActivity = (coworkStore, db) => {
  const session = coworkStore.createSession('改视频的回合', '/tmp/b', '', 'local', [], 5);
  insertMessage(db, session.id, 'd2-m1', 'user', '请把演示视频的背景音乐换成轻快的风格', DAY2_START + 1000, 1);
  insertMessage(db, session.id, 'd2-m2', 'assistant', '已经换成了古典钢琴', DAY2_START + 2000, 2);
  insertMessage(db, session.id, 'd2-m3', 'user', '请把演示视频的背景音乐换成轻快一点的风格', DAY2_START + 2000 + 120_000, 3);
  insertMessage(db, session.id, 'd2-m4', 'assistant', '这次换成了爵士鼓点', DAY2_START + 300_000, 4);
  insertMessage(db, session.id, 'd2-m5', 'assistant', '又调整了一版混音', DAY2_START + 400_000, 5);
  db.run(
    'INSERT INTO message_feedback (message_id, session_id, rating, comment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['d2-m2', session.id, 'down', '不是我要的风格', DAY2_START + 500_000, DAY2_START + 500_000]
  );
  db.run(
    'INSERT INTO message_feedback (message_id, session_id, rating, comment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['d2-m4', session.id, 'down', null, DAY2_START + 600_000, DAY2_START + 600_000]
  );
  return session;
};

test('snapshot table creation is idempotent', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    new DreamStore(db, () => {});
    new DreamStore(db, () => {}); // second ensure must not throw
    const table = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='metabot_prompt_layer_snapshots'");
    assert.equal(table[0].values.length, 1);
  } finally {
    cleanup();
  }
});

test('countNegativeSignalsForDay counts thumbs-down, low ratings and implicit signals', () => {
  const activity = {
    sessions: [{
      sessionId: 's1',
      title: 't',
      sessionType: 'standard',
      peerName: null,
      isOrder: false,
      messages: [
        { type: 'user', content: '这个方案明显不行,重做一版吧', createdAt: 1000 },
        { type: 'assistant', content: '好的', createdAt: 2000, feedbackRating: 'down' },
        { type: 'assistant', content: '再试一版', createdAt: 3000, feedbackRating: 'up' },
        { type: 'user', content: '这个方案明显不行,重做一版行不行', createdAt: 3000 + 60_000 },
      ],
    }],
    taskRuns: [],
    orderCount: 0,
    groupTasks: [
      { taskId: 1, title: 'A', goal: 'g', memberRole: 'worker', rating: 2, ratingComment: null, status: 'done', phase: 'accepted' },
      { taskId: 2, title: 'B', goal: 'g', memberRole: 'worker', rating: 4, ratingComment: null, status: 'done', phase: 'accepted' },
      { taskId: 3, title: 'C', goal: 'g', memberRole: 'worker', rating: 1, ratingComment: null, status: 'done', phase: 'active' },
    ],
  };
  // 1 thumbs-down + 1 accepted task rated 2 + 1 reask signal.
  // The 4-star task and the still-active (unrated phase) 1-star task do not count.
  assert.equal(countNegativeSignalsForDay(activity), 3);
  const empty = { sessions: [], taskRuns: [], orderCount: 0, groupTasks: [] };
  assert.equal(countNegativeSignalsForDay(empty), 0);
});

test('evaluatePromptLayerRollback: floor, baseline comparison, cold start', () => {
  // Below the absolute floor: never triggers.
  assert.equal(evaluatePromptLayerRollback({ negativeToday: ROLLBACK_NEGATIVE_FLOOR - 1, baselineDailyNegatives: [0, 0, 0, 0, 0, 0, 0] }).triggered, false);
  // At the floor but not above median + 1.
  assert.equal(evaluatePromptLayerRollback({ negativeToday: 2, baselineDailyNegatives: [1, 2, 2, 3, 1, 2, 2] }).triggered, false);
  // Above floor AND above median + 1: triggers.
  const triggered = evaluatePromptLayerRollback({ negativeToday: 4, baselineDailyNegatives: [0, 1, 0, 2, 1, 0, 1] });
  assert.equal(triggered.triggered, true);
  assert.ok(triggered.reason.includes('4'));
  assert.equal(triggered.baselineMedian, 1);
  // Cold start (< 7 baseline days): needs the absolute cold-start bar.
  assert.equal(
    evaluatePromptLayerRollback({ negativeToday: ROLLBACK_COLD_START_MIN_NEGATIVE - 1, baselineDailyNegatives: [0, 0, 0] }).triggered,
    false,
  );
  const cold = evaluatePromptLayerRollback({ negativeToday: ROLLBACK_COLD_START_MIN_NEGATIVE, baselineDailyNegatives: [0, 0, 0] });
  assert.equal(cold.triggered, true);
  assert.equal(cold.baselineMedian, null);
  assert.equal(ROLLBACK_BASELINE_MIN_DAYS, 7);
});

test('snapshot capture excludes self_identity, upserts per date and supersedes the previous active', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    const dreamStore = new DreamStore(db, () => {});
    coworkStore.createUserMemory({
      metabotId: 5,
      text: '旧的梦境规则',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      usageClass: 'value_boundary',
      origin: 'dream',
      isExplicit: true,
      forceNew: true,
      source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: DAY0 },
    });
    coworkStore.createUserMemory({
      metabotId: 5,
      text: LONG_IDENTITY,
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      usageClass: 'self_identity',
      origin: 'dream',
      isExplicit: true,
      forceNew: true,
      source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: DAY0 },
    });

    const snap1 = dreamStore.capturePromptLayerSnapshot(5, DAY1);
    assert.equal(snap1.status, 'active');
    assert.equal(snap1.payload.memories.length, 1, 'self_identity is never part of a snapshot');
    assert.equal(snap1.payload.memories[0].text, '旧的梦境规则');
    assert.equal(snap1.payload.memories[0].usageClass, 'value_boundary');
    assert.deepEqual(snap1.payload.promotedProcedureIds, []);

    // Same date upserts (one row per bot+date), keeping it the active one.
    const snap2 = dreamStore.capturePromptLayerSnapshot(5, DAY1);
    assert.equal(dreamStore.listPromptLayerSnapshots(5).length, 1, 'same-date capture upserts');
    assert.equal(snap2.dreamDate, DAY1);

    // A later date supersedes it.
    dreamStore.capturePromptLayerSnapshot(5, DAY2);
    const snapshots = dreamStore.listPromptLayerSnapshots(5);
    assert.equal(snapshots.length, 2);
    assert.equal(snapshots.find((row) => row.dreamDate === DAY1).status, 'superseded');
    assert.equal(dreamStore.getActivePromptLayerSnapshot(5).dreamDate, DAY2);
  } finally {
    cleanup();
  }
});

test('snapshot retention prunes the oldest superseded rows, never the active one', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const dreamStore = new DreamStore(db, () => {});
    const dateKeys = [];
    for (let day = 1; day <= 35; day += 1) {
      const date = new Date(2026, 7, day); // 2026-08-01 .. 2026-09-04
      dateKeys.push(
        `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
      );
    }
    for (const dreamDate of dateKeys) {
      dreamStore.savePromptLayerSnapshot({
        metabotId: 5,
        dreamDate,
        payload: { version: 1, memories: [], promotedProcedureIds: [] },
      });
    }
    const snapshots = dreamStore.listPromptLayerSnapshots(5, 200);
    assert.ok(snapshots.length <= ROLLBACK_MAX_SNAPSHOTS_PER_BOT);
    const active = snapshots.filter((row) => row.status === 'active');
    assert.equal(active.length, 1);
    assert.equal(active[0].dreamDate, dateKeys[dateKeys.length - 1], 'the latest date stays active');
    assert.ok(!snapshots.some((row) => row.dreamDate === dateKeys[0]), 'oldest superseded rows prune first');
  } finally {
    cleanup();
  }
});

test('rollbackDreamMemoriesForDate tombstones the date batch and restores snapshotted rows', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    new DreamStore(db, () => {}); // dream_date column + index migrations
    const oldMemory = coworkStore.createUserMemory({
      metabotId: 5,
      text: '旧规则:先验证再交付',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      usageClass: 'value_boundary',
      origin: 'dream',
      isExplicit: true,
      forceNew: true,
      source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: DAY0 },
    });
    const snapshotMemories = [{
      id: oldMemory.id,
      text: '旧规则:先验证再交付',
      fingerprint: getRow(db, 'SELECT fingerprint FROM user_memories WHERE id = ?', [oldMemory.id]).fingerprint,
      status: 'created',
      archivedAt: null,
    }];
    // Night DAY1's write: a fresh batch row + a dedup-merge that rewrites the
    // old row's text and appends a same-night provenance row.
    const nightRow = coworkStore.createUserMemory({
      metabotId: 5,
      text: '当晚的新规则',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      usageClass: 'value_boundary',
      origin: 'dream',
      isExplicit: true,
      forceNew: true,
      source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: DAY1 },
    });
    db.run('UPDATE user_memories SET text = ?, updated_at = ? WHERE id = ?', ['旧规则:先验证再交付,且绝不代签', Date.now(), oldMemory.id]);
    db.run(
      `INSERT INTO user_memory_sources (id, memory_id, metabot_id, session_id, source_channel, source_type, external_conversation_id, source_id, message_id, role, is_active, created_at, dream_date)
       VALUES (?, ?, 5, NULL, 'dream', 'dream', NULL, NULL, NULL, 'system', 1, ?, ?)`,
      [`src-merge-${oldMemory.id}`, oldMemory.id, Date.now(), DAY1]
    );

    const result = coworkStore.rollbackDreamMemoriesForDate(5, DAY1, snapshotMemories);
    // Both rows carry a DAY1 provenance row (the fresh write + the merge), so
    // both are tombstoned; the snapshotted old row is restored right after.
    assert.equal(result.removed, 2);
    assert.equal(result.restored, 1);
    assert.equal(result.skippedMissing, 0);

    const nightRowAfter = getRow(db, 'SELECT status FROM user_memories WHERE id = ?', [nightRow.id]);
    assert.equal(nightRowAfter.status, 'deleted');
    const restored = getRow(db, 'SELECT text, status FROM user_memories WHERE id = ?', [oldMemory.id]);
    assert.equal(restored.status, 'created');
    assert.equal(restored.text, '旧规则:先验证再交付', 'the merge rewrite is undone');
    const sourceStates = db.exec('SELECT dream_date, is_active FROM user_memory_sources WHERE memory_id = ?', [oldMemory.id])[0].values;
    const sourceStateByDate = Object.fromEntries(sourceStates.map((row) => [row[0], row[1]]));
    assert.deepEqual(sourceStateByDate, { [DAY0]: 1, [DAY1]: 0 }, 'prior provenance reactivates; the rolled-back night stays disavowed');

    // Missing rows are skipped, not resurrected.
    const withGhost = coworkStore.rollbackDreamMemoriesForDate(5, DAY1, [
      { id: 'mem-gone', text: 'x', fingerprint: 'f', status: 'created', archivedAt: null },
    ]);
    assert.equal(withGhost.skippedMissing, 1);
    assert.equal(withGhost.removed, 0, 'the date batch was already tombstoned');
  } finally {
    cleanup();
  }
});

test('markPromptLayerSnapshotRolledBack is terminal (a date is never rolled back twice)', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const dreamStore = new DreamStore(db, () => {});
    const snapshot = dreamStore.savePromptLayerSnapshot({
      metabotId: 5,
      dreamDate: DAY1,
      payload: { version: 1, memories: [], promotedProcedureIds: [] },
    });
    assert.equal(dreamStore.markPromptLayerSnapshotRolledBack(snapshot.id, 'spike'), true);
    const after = dreamStore.getPromptLayerSnapshot(5, DAY1);
    assert.equal(after.status, 'rolled_back');
    assert.equal(after.rollbackReason, 'spike');
    assert.ok(after.rolledBackAt > 0);
    assert.equal(dreamStore.markPromptLayerSnapshotRolledBack(snapshot.id, 'again'), false, 'second rollback refused');
    assert.equal(dreamStore.getActivePromptLayerSnapshot(5), null, 'no active snapshot left');
  } finally {
    cleanup();
  }
});

test('full dream flow: a negative-feedback spike rolls back the previous night\'s prompt layer', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    const dreamStore = new DreamStore(db, () => {});
    const knowledgeStore = new MetaIDKnowledgeStore(db, () => {});
    seedDay1Activity(coworkStore, db);

    // A pre-existing dream memory from an earlier night — rides into the
    // DAY1 snapshot and must survive the rollback untouched.
    const oldMemory = coworkStore.createUserMemory({
      metabotId: 5,
      text: '更早一晚的旧规则',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      usageClass: 'value_boundary',
      origin: 'dream',
      isExplicit: true,
      forceNew: true,
      source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: DAY0 },
    });
    // A validated capability draft old enough to promote on night 1.
    coworkStore.insertCapabilityDrafts(5, DAY0, [
      { title: '先验证再交付流程', description: '交付前先跑一遍验证', capabilityType: 'workflow' },
    ]);
    const draft = coworkStore.listCapabilityDrafts(5)[0];
    coworkStore.updateCapabilityDraftValidation({ id: draft.id, metabotId: 5, status: 'validated', validationScore: 0.95 });
    db.run('UPDATE capability_drafts SET validated_at = ?, last_reviewed_at = ? WHERE id = ?', [DAY0_START, DAY0_START, draft.id]);
    // A draft written by the night being rolled back — must be excluded from
    // any later validation/promotion.
    coworkStore.insertCapabilityDrafts(5, DAY1, [
      { title: '当夜新技巧', description: '当夜才学到的东西', capabilityType: 'skill' },
    ]);

    const prompts = [];
    const service = new DreamService({
      coworkStore,
      metabotStore: metabotStoreStub(),
      dreamStore,
      metaidKnowledgeStore: knowledgeStore,
      performChat: async (system, user) => { prompts.push(user); return makePayload(); },
      llmTimeoutMs: 5000,
      now: () => new Date(2026, 7, 1, 3, 0),
    });

    // Night 1: dream DAY1 — writes the day batch, promotes the old draft.
    await service.runNow(5, DAY1);
    const day1Memories = coworkStore.listUserMemories({
      metabotId: 5, scopeKind: 'owner', scopeKey: 'owner:self', origin: 'dream', status: 'all',
    });
    const nightFact = day1Memories.find((memory) => memory.text === '用户喜欢先验证再交付的节奏');
    assert.ok(nightFact && nightFact.status === 'created', 'night-1 write is live before the rollback');
    const snapshotDay1 = dreamStore.getPromptLayerSnapshot(5, DAY1);
    assert.equal(snapshotDay1.status, 'active');
    assert.ok(snapshotDay1.payload.memories.some((memory) => memory.id === oldMemory.id), 'the older layer is in the snapshot');
    assert.ok(!snapshotDay1.payload.memories.some((memory) => memory.usageClass === 'self_identity'));
    const promoted = knowledgeStore.listProcedures({ metabotId: 5, status: 'active' });
    assert.equal(promoted.length, 1, 'night-1 promotion hardened the old draft');
    assert.equal(snapshotDay1.payload.promotedProcedureIds.length, 0, 'snapshot predates the promotion pass');

    // Night 2: dream DAY2 with a negative-feedback spike → roll back DAY1.
    seedDay2NegativeActivity(coworkStore, db);
    await service.runNow(5, DAY2);

    const rolledBack = dreamStore.getPromptLayerSnapshot(5, DAY1);
    assert.equal(rolledBack.status, 'rolled_back');
    assert.ok(rolledBack.rollbackReason.includes('negative'), 'reason is recorded');
    const factAfter = coworkStore.listUserMemories({
      metabotId: 5, scopeKind: 'owner', scopeKey: 'owner:self', origin: 'dream', status: 'all', includeDeleted: true,
    }).find((memory) => memory.id === nightFact.id);
    assert.equal(factAfter.status, 'deleted', 'the rolled-back night batch is tombstoned');
    const oldAfter = coworkStore.listUserMemories({
      metabotId: 5, scopeKind: 'owner', scopeKey: 'owner:self', origin: 'dream', status: 'all',
    }).find((memory) => memory.id === oldMemory.id);
    assert.equal(oldAfter.status, 'created', 'the snapshotted older row survives');
    const identity = coworkStore.listUserMemories({
      metabotId: 5, scopeKind: 'owner', scopeKey: 'owner:self', usageClass: 'self_identity', status: 'all',
    });
    assert.equal(identity.length, 1);
    assert.equal(identity[0].status, 'created', 'self_identity is never rolled back');
    assert.equal(knowledgeStore.listProcedures({ metabotId: 5, status: 'active' }).length, 0, 'the night-1 promotion is archived');
    assert.equal(knowledgeStore.listProcedures({ metabotId: 5, status: 'archived' }).length, 1);
    const day1Draft = coworkStore.listCapabilityDrafts(5).find((entry) => entry.dreamDate === DAY1);
    assert.equal(day1Draft.status, 'rejected', 'drafts of the rolled-back date are excluded from validation/promotion');

    const night2Synthesis = prompts.find((prompt) => prompt.includes(DAY2) && prompt.includes('真实经历记录'));
    assert.ok(night2Synthesis, 'the night-2 synthesis prompt exists');
    assert.match(night2Synthesis, /2026-07-30/);
    assert.match(night2Synthesis, /已因负反馈激增被自动回滚/, 'the dream is told to treat that day\'s lessons with suspicion');

    const run2 = dreamStore.getRun(5, DAY2);
    assert.equal(run2.status, 'completed');
    assert.equal(run2.telemetry?.promptLayerRollback?.rolledBack, true);
    assert.equal(run2.telemetry?.promptLayerRollback?.rolledBackDate, DAY1);
    assert.equal(run2.telemetry?.promptLayerRollback?.negativeSignals, 3);

    // Tonight's own snapshot replaced the rolled-back one as the active layer.
    const activeSnapshot = dreamStore.getActivePromptLayerSnapshot(5);
    assert.equal(activeSnapshot.dreamDate, DAY2);
    assert.equal(dreamStore.listPromptLayerSnapshots(5).length, 2);
  } finally {
    cleanup();
  }
});

test('no rollback without a spike, without a snapshot, or on repair runs', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    const dreamStore = new DreamStore(db, () => {});
    seedDay1Activity(coworkStore, db);
    const service = new DreamService({
      coworkStore,
      metabotStore: metabotStoreStub(),
      dreamStore,
      performChat: async () => makePayload(),
      llmTimeoutMs: 5000,
      now: () => new Date(2026, 7, 1, 3, 0),
    });
    await service.runNow(5, DAY1);
    assert.equal(dreamStore.getPromptLayerSnapshot(5, DAY1).status, 'active');

    // Night 2 with a calm day: the gate evaluates but never fires.
    seedDay2NegativeActivityQuiet(coworkStore, db);
    await service.runNow(5, DAY2);
    const run2 = dreamStore.getRun(5, DAY2);
    assert.equal(run2.telemetry?.promptLayerRollback?.rolledBack, false);
    assert.equal(dreamStore.getPromptLayerSnapshot(5, DAY1).status, 'superseded', 'the new night supersedes, not rolls back');
  } finally {
    cleanup();
  }
});

/** A quiet day: one healthy session, no negative signals. */
const seedDay2NegativeActivityQuiet = (coworkStore, db) => {
  const session = coworkStore.createSession('顺利的一天', '/tmp/c', '', 'local', [], 5);
  insertMessage(db, session.id, 'd2q-m1', 'user', '海报做完了吗', DAY2_START + 1000, 1);
  insertMessage(db, session.id, 'd2q-m2', 'assistant', '做完了,效果很好', DAY2_START + 2000, 2);
  return session;
};
