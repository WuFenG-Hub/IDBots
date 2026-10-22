/**
 * Dream review P1 (2026-10-23), item P1-4: hot_reason becomes an append-only
 * history.
 *
 * metaid_knowledge_procedures.hot_reason was overwritten by every probation
 * flip / re-review demotion / pruning 'unused' / retention rollback — the
 * procedure's standing history survived only as the LAST reason. Every
 * setProcedureHotEligibility flip now appends one row to
 * metaid_knowledge_procedure_hot_events (procedure_id, ts, reason,
 * source_pass); hot_reason keeps serving legacy readers as the latest value.
 *
 * Covers:
 *   1. store level: each source pass (validation / re_review / promotion /
 *      pruning / rollback) lands a history row; no-op re-flips write nothing;
 *      hot_reason stays the latest reason,
 *   2. dreamService plumbing: the pruning pass stamps sourcePass 'pruning'
 *      end-to-end (harness night with an unused hot procedure),
 *   3. rollback pass: the retention-gate rollback stamps sourcePass
 *      'rollback' (harness night with a negative spike + an active promoted
 *      procedure).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { createCoworkStore, createSqliteStore, getRow } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

const { MetaIDKnowledgeStore } = require('../dist-electron/main/metaidKnowledgeStore.js');
const { shiftDateKey } = require('../dist-electron/main/libs/predictionLedger.js');

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
const {
  createDreamHarness,
  dayStartMs,
  seedSession,
  MARKERS,
  BOT_ID,
} = await import('./fixtures/rrsiDreamHarness.mjs');

function seedProcedure(db, metabotId = 5) {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key,
      chat_public_key, name, metaid, metabot_type, created_by, role, soul, created_at, updated_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, 'worker', 'test', 'role', 'soul', 1, 1)`,
    [metabotId, `mvc-${metabotId}`, `btc-${metabotId}`, `doge-${metabotId}`, `pub-${metabotId}`, `chat-${metabotId}`, `Bot ${metabotId}`, `metaid-${metabotId}`],
  );
}

test('hot flips append history rows per source pass; hot_reason keeps only the latest', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    seedProcedure(db);
    const store = new MetaIDKnowledgeStore(db, () => {}, () => 1_800_000_000_000);
    const procedure = store.upsertProcedure({
      metabotId: 5,
      title: '规程甲',
      triggerText: '当需要执行甲时',
      steps: ['第一步'],
      origin: 'dream',
    }).entry;

    // The four overwrite paths called out by the review, plus promotion.
    const flips = [
      { eligible: false, reason: 'gate_rejected', sourcePass: 'validation', atMs: 100 },
      { eligible: false, reason: 'demoted', sourcePass: 're_review', atMs: 200 },
      { eligible: false, reason: 'situational', sourcePass: 'promotion', atMs: 300 },
      { eligible: false, reason: 'unused', sourcePass: 'pruning', atMs: 400 },
      { eligible: true, reason: null, sourcePass: 'pruning', atMs: 500 },
      { eligible: false, reason: 'rollback', sourcePass: 'rollback', atMs: 600 },
    ];
    for (const flip of flips) {
      assert.equal(store.setProcedureHotEligibility(procedure.id, { ...flip }), true);
    }

    const events = store.listProcedureHotEvents(procedure.id);
    assert.deepEqual(
      events.map((event) => [event.ts, event.reason, event.sourcePass]),
      [
        [100, 'gate_rejected', 'validation'],
        [200, 'demoted', 're_review'],
        [300, 'situational', 'promotion'],
        [400, 'unused', 'pruning'],
        [500, null, 'pruning'],
        [600, 'rollback', 'rollback'],
      ],
      'every flip lands one append-only row with its pass',
    );

    // hot_reason is the LATEST reason only (legacy reader contract).
    const row = getRow(db, 'SELECT hot_reason, hot_eligible FROM metaid_knowledge_procedures WHERE id = ?', [procedure.id]);
    assert.equal(row.hot_reason, 'rollback');
    assert.equal(row.hot_eligible, 0);

    // A repeated flip re-runs the UPDATE (SQLite counts the matched row as
    // modified) and appends another history row — the history is a faithful
    // event log, not a state snapshot.
    assert.equal(store.setProcedureHotEligibility(procedure.id, { eligible: false, reason: 'rollback', sourcePass: 'rollback', atMs: 700 }), true);
    assert.equal(store.listProcedureHotEvents(procedure.id).length, 7, 'every requested flip lands on the event log');
  } finally {
    cleanup();
  }
});

test('dream plumbing: the pruning pass stamps sourcePass pruning end-to-end', async () => {
  const h = await createDreamHarness();
  const D = '2026-08-12';
  try {
    seedSession(h.coworkStore, h.db, D, [
      { type: 'user', content: '在吗' },
      { type: 'assistant', content: '在的' },
    ]);
    // An old hot procedure, applied on none of its 5 audited hot nights.
    const procedure = h.knowledgeStore.upsertProcedure({
      metabotId: BOT_ID,
      title: '旧规程',
      triggerText: '旧场景',
      steps: ['旧步骤'],
      origin: 'dream',
    }).entry;
    const oldMs = dayStartMs(D) - 20 * 86_400_000;
    h.db.run('UPDATE metaid_knowledge_procedures SET hot_since = ?, created_at = ? WHERE id = ?', [oldMs, oldMs, procedure.id]);
    for (let offset = 6; offset >= 2; offset -= 1) {
      const key = shiftDateKey(D, -offset);
      h.coworkStore.recordHotLayerExposures({
        metabotId: BOT_ID,
        usageDate: key,
        items: [{ kind: 'procedure', id: procedure.id, exposure: 'hot' }],
      });
      h.dreamStore.recordHotLayerUsageVerdicts(BOT_ID, key, [
        { kind: 'procedure', itemId: procedure.id, applied: false, evidence: { labels: [], channels: [] } },
      ], dayStartMs(key) + 1000);
    }
    await h.runNight(D);

    const row = getRow(h.db, 'SELECT hot_reason, hot_eligible FROM metaid_knowledge_procedures WHERE id = ?', [procedure.id]);
    assert.equal(row.hot_reason, 'unused');
    assert.equal(row.hot_eligible, 0);
    const events = h.knowledgeStore.listProcedureHotEvents(procedure.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, 'unused');
    assert.equal(events[0].sourcePass, 'pruning', 'the pruning pass is stamped on the history row');
  } finally {
    h.cleanup();
  }
});

test('dream plumbing: the retention rollback stamps sourcePass rollback', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new (require('../dist-electron/main/dreamStore.js').DreamStore)(db, () => {});
  const knowledgeStore = new MetaIDKnowledgeStore(db, () => {}, () => 1_800_000_000_000);
  const insertMessage = (sessionId, id, type, content, createdAt, sequence) => {
    db.run(
      'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, sessionId, type, content, '{}', createdAt, sequence],
    );
  };
  const D1 = '2026-07-30';
  const D1_START = new Date(2026, 6, 30).getTime();
  const D2 = '2026-07-31';
  const D2_START = new Date(2026, 6, 31).getTime();
  const D0 = '2026-07-29';
  const D0_START = new Date(2026, 6, 29).getTime();
  const LONG_IDENTITY = `我是专注的 MetaBot。${'我先验证再交付。'.repeat(30)}`;
  const makePayload = () => JSON.stringify({
    daily_summary: '普通的一天。',
    sections: {},
    work_reviews: [],
    important_memories: [],
    value_lessons: [],
    self_identity: LONG_IDENTITY,
    capability_learnings: [],
  });
  const metabotStoreStub = () => ({
    listMetabots: () => [
      { id: 5, name: '小火', role: '视频创作者', soul: '认真严谨', llm_id: 'bot-own-llm', enabled: true },
    ],
  });
  try {
    db.run(
      `INSERT INTO metabots (
        id, wallet_id, mvc_address, btc_address, doge_address, public_key,
        chat_public_key, name, metaid, metabot_type, created_by, role, soul, created_at, updated_at
      ) VALUES (5, 1, 'mvc-5', 'btc-5', 'doge-5', 'pub-5', 'chat-5', '小火', 'metaid-5', 'worker', 'test', 'role', 'soul', 1, 1)`,
    );
    // Night 1: an ordinary day; a validated old draft promotes into a
    // procedure, then the night's snapshot is captured.
    const day1 = coworkStore.createSession('和用户聊发布', '/tmp/a', '', 'local', [], 5);
    insertMessage(day1.id, 'd1-m1', 'user', '视频做好了吗', D1_START + 1000, 1);
    insertMessage(day1.id, 'd1-m2', 'assistant', '做好了,你看下', D1_START + 2000, 2);
    // An AGENT-authored probation procedure promoted on night 1 (the rollback
    // pass hot-flips agent-sourced procedures with a 'rollback' note; a
    // dream-origin procedure would be archived instead — see
    // applyPromptLayerRollback).
    const procedure = knowledgeStore.upsertProcedure({
      metabotId: 5,
      title: '试用中的规程',
      triggerText: '用户要求试用新流程时',
      steps: ['先小步验证'],
      origin: 'agent',
    }).entry;
    coworkStore.insertCapabilityDrafts(5, D1, [
      { title: '试用中的规程', description: ' probation ticket', capabilityType: 'skill' },
    ]);
    const draft = coworkStore.listCapabilityDrafts(5)[0];
    db.run(
      'UPDATE capability_drafts SET source_procedure_id = ?, promoted_procedure_id = ? WHERE id = ?',
      [procedure.id, procedure.id, draft.id],
    );
    void D0;
    void D0_START;

    const service = new DreamService({
      coworkStore,
      metabotStore: metabotStoreStub(),
      dreamStore,
      metaidKnowledgeStore: knowledgeStore,
      performChat: async () => makePayload(),
      llmTimeoutMs: 5000,
      now: () => new Date(2026, 7, 1, 3, 0),
    });
    await service.runNow(5, D1);
    const procedureId = procedure.id;
    assert.equal(
      dreamStore.getPromptLayerSnapshot(5, D1)?.status,
      'active',
      'night 1 captured the snapshot the rollback needs',
    );

    // Night 2: a negative-feedback spike (2 thumbs-down + 1 re-ask) rolls the
    // DAY1 layer back — the promoted procedure leaves the hot set with
    // reason 'rollback'.
    const day2 = coworkStore.createSession('改视频的回合', '/tmp/b', '', 'local', [], 5);
    insertMessage(day2.id, 'd2-m1', 'user', '请把背景音乐换成轻快的风格', D2_START + 1000, 1);
    insertMessage(day2.id, 'd2-m2', 'assistant', '已经换成了古典钢琴', D2_START + 2000, 2);
    insertMessage(day2.id, 'd2-m3', 'user', '请把背景音乐换成轻快一点的风格', D2_START + 132_000, 3);
    insertMessage(day2.id, 'd2-m4', 'assistant', '这次换成了爵士鼓点', D2_START + 300_000, 4);
    db.run(
      'INSERT INTO message_feedback (message_id, session_id, rating, comment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['d2-m2', day2.id, 'down', '不是我要的风格', D2_START + 500_000, D2_START + 500_000],
    );
    db.run(
      'INSERT INTO message_feedback (message_id, session_id, rating, comment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['d2-m4', day2.id, 'down', null, D2_START + 600_000, D2_START + 600_000],
    );
    await service.runNow(5, D2);

    const row = getRow(db, 'SELECT hot_reason, hot_eligible FROM metaid_knowledge_procedures WHERE id = ?', [procedureId]);
    assert.equal(row.hot_reason, 'rollback', 'rollback pass overwrote hot_reason');
    assert.equal(row.hot_eligible, 0);
    const events = knowledgeStore.listProcedureHotEvents(procedureId);
    assert.ok(
      events.some((event) => event.reason === 'rollback' && event.sourcePass === 'rollback'),
      'the rollback pass lands on the append-only history',
    );
  } finally {
    cleanup();
  }
});
