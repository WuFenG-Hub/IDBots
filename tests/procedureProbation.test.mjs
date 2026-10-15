import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { createRequire } from 'node:module';

import { getSqlJs, createCoworkStore, createSqliteStore } from './memoryTestUtils.mjs';
import {
  MARKERS,
  createDreamHarness,
  dayStartMs,
  dreamJson,
  seedSession,
  validationVerdicts,
} from './fixtures/rrsiDreamHarness.mjs';

const require = createRequire(import.meta.url);
const {
  PROCEDURE_HOT_REASONS,
  normalizeProcedureHotReason,
  buildProbationDraftDescription,
} = require('../dist-electron/main/libs/procedureProbation.js');
const { MetaIDKnowledgeStore, ensureMetaIDKnowledgeSchema } =
  require('../dist-electron/main/metaidKnowledgeStore.js');

function loadRunnerModule() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => process.cwd(),
        },
        BrowserWindow: { getAllWindows: () => [] },
      };
    }
    return originalLoad.call(this, request, ...rest);
  };
  try {
    return require('../dist-electron/main/libs/coworkRunner.js');
  } finally {
    Module._load = originalLoad;
  }
}

const CLOCK = 1_700_000_000_000;

// The pre-P2 DDL of metaid_knowledge_procedures, copied verbatim from
// metaidKnowledgeStore.ts with ${ORIGINS_SQL} expanded ('agent', 'dream',
// 'user') — the shape every production database has before this phase.
const PRE_P2_PROCEDURES_DDL = `
  CREATE TABLE IF NOT EXISTS metaid_knowledge_procedures (
    id TEXT PRIMARY KEY,
    metabot_id INTEGER NOT NULL REFERENCES metabots(id),
    title TEXT NOT NULL CHECK (trim(title) <> ''),
    title_fingerprint TEXT NOT NULL CHECK (trim(title_fingerprint) <> ''),
    trigger_text TEXT NOT NULL CHECK (trim(trigger_text) <> ''),
    steps_json TEXT NOT NULL DEFAULT '[]',
    pitfalls_json TEXT NOT NULL DEFAULT '[]',
    source_pin_ids_json TEXT NOT NULL DEFAULT '[]',
    category TEXT,
    tags_json TEXT NOT NULL DEFAULT '[]',
    confidence REAL NOT NULL DEFAULT 0.75 CHECK (confidence >= 0 AND confidence <= 1),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    origin TEXT NOT NULL DEFAULT 'agent' CHECK (origin IN ('agent', 'dream', 'user')),
    use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
    last_used_at INTEGER,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(metabot_id, title_fingerprint)
  );
`;

async function createStore() {
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  db.run('CREATE TABLE metabots (id INTEGER PRIMARY KEY, name TEXT)');
  db.run("INSERT INTO metabots (id, name) VALUES (5, '小火')");
  const store = new MetaIDKnowledgeStore(db, () => {}, () => CLOCK);
  return { db, store };
}

const saveAgent = (store, title, overrides = {}) => store.upsertProcedure({
  metabotId: 5,
  title,
  triggerText: '当用户要求交付时',
  steps: ['先自检', '再交付'],
  ...overrides,
});

// ---------------------------------------------------------------------------
// Store section (RRSI P2 Task 3)
// ---------------------------------------------------------------------------

test('migration: pre-P2 procedures are grandfathered hot, idempotent schema run', async () => {
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  db.run(PRE_P2_PROCEDURES_DDL);
  db.run(`
    INSERT INTO metaid_knowledge_procedures (
      id, metabot_id, title, title_fingerprint, trigger_text, steps_json,
      pitfalls_json, source_pin_ids_json, category, tags_json, confidence,
      status, origin, use_count, last_used_at, version, created_at, updated_at
    ) VALUES (
      'legacy-proc-1', 5, '老规程', 'fp-legacy', '当…', '["一步"]',
      '[]', '[]', NULL, '[]', 0.75, 'active', 'agent', 0, NULL, 1, 1, 1
    );
  `);
  ensureMetaIDKnowledgeSchema(db);
  ensureMetaIDKnowledgeSchema(db);
  const store = new MetaIDKnowledgeStore(db, () => {}, () => CLOCK);
  const entry = store.getProcedure('legacy-proc-1');
  assert.equal(entry.status, 'active');
  assert.equal(entry.hotEligible, true);
  assert.equal(entry.hotReason, null);
});

test('insert by origin: agent enters probation, dream is hot immediately', async () => {
  const { store } = await createStore();
  try {
    const agent = saveAgent(store, '新学规程');
    assert.equal(agent.created, true);
    assert.equal(agent.entry.hotEligible, false);
    assert.equal(agent.entry.hotReason, 'probation');
    assert.equal(agent.needsGate, true);

    const dream = store.upsertProcedure({
      metabotId: 5,
      title: '梦境规程',
      triggerText: '当…',
      steps: ['一步'],
      origin: 'dream',
    });
    assert.equal(dream.entry.hotEligible, true);
    assert.equal(dream.entry.hotSince, CLOCK);
    assert.equal(dream.needsGate, false);
  } finally {
    void store;
  }
});

test('archived resurrection closes: agent re-save re-activates on probation', async () => {
  const { store } = await createStore();
  try {
    const created = saveAgent(store, '复活的规程');
    assert.equal(store.setProcedureHotEligibility(created.entry.id, { eligible: true, reason: null }), true);
    assert.ok(store.archiveProcedureByTitle(5, '复活的规程'));
    const revived = saveAgent(store, '复活的规程');
    assert.equal(revived.created, false);
    assert.equal(revived.entry.status, 'active');
    assert.equal(revived.entry.hotEligible, false);
    assert.equal(revived.entry.hotReason, 'probation');
  } finally {
    void store;
  }
});

test('a hot procedure revised by agent stays hot with its hotSince', async () => {
  const { store } = await createStore();
  try {
    const created = saveAgent(store, '热规程');
    assert.equal(store.setProcedureHotEligibility(created.entry.id, { eligible: true, reason: null, atMs: CLOCK + 50 }), true);
    const revised = saveAgent(store, '热规程', { steps: ['新步骤'] });
    assert.equal(revised.entry.hotEligible, true);
    assert.equal(revised.entry.hotReason, null);
    assert.equal(revised.entry.hotSince, CLOCK + 50);
  } finally {
    void store;
  }
});

test('reason rules: gate_rejected revises to probation; unused stays unused', async () => {
  const { store } = await createStore();
  try {
    const rejected = saveAgent(store, '被拒规程');
    store.setProcedureHotEligibility(rejected.entry.id, { eligible: false, reason: 'gate_rejected' });
    const afterReject = saveAgent(store, '被拒规程', { steps: ['改进步骤'] });
    assert.equal(afterReject.entry.hotEligible, false);
    assert.equal(afterReject.entry.hotReason, 'probation');
    assert.equal(afterReject.needsGate, true);

    const unused = saveAgent(store, '闲置规程');
    store.setProcedureHotEligibility(unused.entry.id, { eligible: false, reason: 'unused' });
    const afterUnused = saveAgent(store, '闲置规程', { steps: ['又一次'] });
    assert.equal(afterUnused.entry.hotEligible, false);
    assert.equal(afterUnused.entry.hotReason, 'unused');
    assert.equal(afterUnused.needsGate, false);
  } finally {
    void store;
  }
});

test('a dream upsert promotes a probation procedure to hot', async () => {
  const { store } = await createStore();
  try {
    saveAgent(store, '候选规程');
    const promoted = store.upsertProcedure({
      metabotId: 5,
      title: '候选规程',
      triggerText: '当…',
      steps: ['一步'],
      origin: 'dream',
    });
    assert.equal(promoted.entry.hotEligible, true);
    assert.equal(promoted.entry.hotReason, null);
    assert.equal(promoted.entry.hotSince, CLOCK);
  } finally {
    void store;
  }
});

test('setProcedureHotEligibility refuses archived rows and keeps updatedAt', async () => {
  const { store } = await createStore();
  try {
    const created = saveAgent(store, '归档规程');
    assert.equal(store.setProcedureHotEligibility(created.entry.id, { eligible: true, reason: null }), true);
    const updatedAtBefore = store.getProcedure(created.entry.id).updatedAt;
    assert.ok(store.archiveProcedureByTitle(5, '归档规程'));
    assert.equal(
      store.setProcedureHotEligibility(created.entry.id, { eligible: false, reason: 'demoted' }),
      false,
      'archived rows are refused',
    );
    assert.equal(store.getProcedure(created.entry.id).updatedAt, updatedAtBefore);
  } finally {
    void store;
  }
});

test('listHotProcedures filters recall-only and archived; recall still returns them', async () => {
  const { store } = await createStore();
  try {
    saveAgent(store, '召回规程');
    saveAgent(store, '归档规程2');
    store.archiveProcedureByTitle(5, '归档规程2');
    store.upsertProcedure({
      metabotId: 5, title: '热规程2', triggerText: '当…', steps: ['一步'], origin: 'dream',
    });
    const hot = store.listHotProcedures(5);
    assert.deepEqual(hot.map((entry) => entry.title), ['热规程2']);
    const recall = store.listProcedures({ metabotId: 5, status: 'active' });
    assert.deepEqual(
      recall.map((entry) => entry.title).sort(),
      ['召回规程', '热规程2'],
    );
  } finally {
    void store;
  }
});

// ---------------------------------------------------------------------------
// Pure helpers (RRSI P2 Task 3)
// ---------------------------------------------------------------------------

test('PROCEDURE_HOT_REASONS and normalizeProcedureHotReason', () => {
  assert.deepEqual(PROCEDURE_HOT_REASONS, [
    'probation', 'gate_rejected', 'demoted', 'rollback', 'unused', 'situational',
  ]);
  assert.equal(normalizeProcedureHotReason('probation'), 'probation');
  assert.equal(normalizeProcedureHotReason('unused'), 'unused');
  assert.equal(normalizeProcedureHotReason('nope'), null);
  assert.equal(normalizeProcedureHotReason(null), null);
  assert.equal(normalizeProcedureHotReason(undefined), null);
  assert.equal(normalizeProcedureHotReason(42), null);
});

test('buildProbationDraftDescription renders sections and omits empty ones', () => {
  const full = buildProbationDraftDescription({
    triggerText: '当用户要求发布视频',
    steps: ['先检查字幕', '再导出'],
    pitfalls: ['不要跳过审阅'],
    sourcePinIds: ['pin-abc'],
  });
  assert.equal(
    full,
    '触发:当用户要求发布视频\n步骤:先检查字幕 → 再导出\n避免:不要跳过审阅\n来源 pin:pin-abc',
  );
  const minimal = buildProbationDraftDescription({
    triggerText: '当…',
    steps: ['一步'],
    pitfalls: [],
    sourcePinIds: [],
  });
  assert.equal(minimal, '触发:当…\n步骤:一步');
});

test('buildProbationDraftDescription caps at 1200 chars', () => {
  const description = buildProbationDraftDescription({
    triggerText: '当…',
    steps: ['超长步骤'.repeat(600)],
    pitfalls: [],
    sourcePinIds: [],
  });
  assert.equal(description.length, 1200);
  assert.ok(description.endsWith('…'));
});

// ---------------------------------------------------------------------------
// Probation drafts from procedure_save (RRSI P2 Task 4)
// ---------------------------------------------------------------------------

test('ensureProbationDraftForProcedure creates once, refreshes, and reopens after rejection', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    const first = coworkStore.ensureProbationDraftForProcedure({
      metabotId: 5, procedureId: 'proc-1', title: '新学规程', description: '第一版描述', dreamDate: '2026-08-02',
    });
    assert.equal(first.created, true);
    const refreshed = coworkStore.ensureProbationDraftForProcedure({
      metabotId: 5, procedureId: 'proc-1', title: '新学规程', description: '第二版描述', dreamDate: '2026-08-03',
    });
    assert.equal(refreshed.created, false);
    assert.equal(refreshed.draftId, first.draftId);
    const drafts = coworkStore.listCapabilityDrafts(5);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].description, '第二版描述');
    assert.equal(drafts[0].dreamDate, '2026-08-02', 'refresh keeps the original dream_date');
    assert.equal(drafts[0].capabilityType, 'workflow');
    assert.equal(drafts[0].sourceProcedureId, 'proc-1');

    coworkStore.updateCapabilityDraftValidation({ id: first.draftId, metabotId: 5, status: 'rejected' });
    const reopened = coworkStore.ensureProbationDraftForProcedure({
      metabotId: 5, procedureId: 'proc-1', title: '新学规程', description: '第三版描述', dreamDate: '2026-08-04',
    });
    assert.equal(reopened.created, true);
    assert.notEqual(reopened.draftId, first.draftId);

    assert.equal(
      coworkStore.ensureProbationDraftForProcedure({ metabotId: 5, procedureId: '', title: 'x', description: 'd', dreamDate: '2026-08-02' }),
      null,
      'invalid input returns null',
    );
  } finally {
    cleanup();
  }
});

test('hygiene purge keeps an old probation draft while deleting old plain drafts', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    coworkStore.insertCapabilityDrafts(5, '2026-01-01', [
      { title: '普通草案', description: 'd', capabilityType: 'workflow' },
    ]);
    coworkStore.ensureProbationDraftForProcedure({
      metabotId: 5, procedureId: 'proc-keep', title: '试用草案', description: 'd', dreamDate: '2026-01-01',
    });
    const purged = coworkStore.purgeExpiredCapabilityDrafts({ cutoffMs: Date.now() + 86_400_000 });
    assert.equal(purged, 1, 'only the plain draft ages out');
    const remaining = coworkStore.listCapabilityDrafts(5);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].sourceProcedureId, 'proc-keep');
  } finally {
    cleanup();
  }
});

test('runner: procedure_save opens one probation draft and recall shows the status line', async () => {
  const { CoworkRunner } = loadRunnerModule();
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    const knowledgeStore = new MetaIDKnowledgeStore(db, () => {}, () => CLOCK);
    const runner = new CoworkRunner(coworkStore, { knowledgeStore });
    const session = coworkStore.createSession('和用户聊发布', '/tmp/a', '', 'local', [], 5);

    const saved = runner.runProcedureSaveTool({
      title: '发布前查重规程',
      trigger: '当用户要求发布内容时',
      steps: ['先查重', '再发布'],
      sourcePinIds: ['pin-xyz'],
    }, session.id);
    assert.equal(saved.isError, false);
    assert.ok(saved.text.includes('joins your always-on procedures'), saved.text);

    const drafts = coworkStore.listCapabilityDrafts(5);
    assert.equal(drafts.length, 1);
    assert.ok(drafts[0].description.includes('触发:'));
    assert.ok(drafts[0].description.includes('pin-xyz'));

    const again = runner.runProcedureSaveTool({
      title: '发布前查重规程',
      trigger: '当用户要求发布内容时',
      steps: ['先查重', '再发布'],
      sourcePinIds: ['pin-xyz'],
    }, session.id);
    assert.equal(again.isError, false);
    assert.equal(coworkStore.listCapabilityDrafts(5).length, 1, 're-save keeps one draft');

    const recalled = runner.runProcedureRecallTool({ query: '查重' }, session.id);
    assert.equal(recalled.isError, false);
    assert.ok(recalled.text.includes('status: not yet validated by a dream'), recalled.text);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Gate flows for probation drafts (RRSI P2 Task 5)
// ---------------------------------------------------------------------------

const D1 = '2026-08-02';
const D2 = '2026-08-03';
const D3 = '2026-08-04';
const ROLLBACK_DAY0 = '2026-07-29';
const ROLLBACK_DAY1 = '2026-07-30';
const ROLLBACK_DAY2 = '2026-07-31';

const reconciliationKeep = (user) => {
  const ids = [...user.matchAll(/草案 #(\d+)/g)].map((match) => Number(match[1]));
  return {
    verdicts: ids.map((id) => ({ id, action: 'keep', conditions: '交付前', uncertainty: '', conflicts_with: [], note: 'n' })),
  };
};

const seedProbation = (h, title, dreamDate, overrides = {}) => {
  const saved = h.knowledgeStore.upsertProcedure({
    metabotId: 5,
    title,
    triggerText: `当用户要求${title}`,
    steps: ['先自检', '再交付'],
    sourcePinIds: [],
    origin: 'agent',
    ...overrides,
  });
  assert.equal(saved.needsGate, true);
  const ticket = h.coworkStore.ensureProbationDraftForProcedure({
    metabotId: 5,
    procedureId: saved.entry.id,
    title,
    description: `触发:当用户要求${title}\n步骤:先自检 → 再交付`,
    dreamDate,
  });
  return { procedureId: saved.entry.id, draftId: ticket.draftId };
};

const quietNight = (h) => {
  h.router.setFallback(() => dreamJson({ daily_summary: '普通的一天。' }));
};

test('flow: probation to hot — promotion flips eligibility, never rewrites the body', async () => {
  const h = await createDreamHarness();
  try {
    const seeded = seedProbation(h, '发布前查重流程', D1);
    seedSession(h.coworkStore, h.db, D2, [
      { type: 'user', content: '上次先查重很棒' },
      { type: 'assistant', content: '谢谢' },
    ]);
    quietNight(h);
    h.router.on(MARKERS.validation, ({ user }) => validationVerdicts(user, () => ({
      verdict: 'validated', score: 0.9, rationale: `${D2} 日记显示照做后获赞`,
    })));
    h.router.on(MARKERS.reconciliation, ({ user }) => reconciliationKeep(user));
    await h.runNight(D2);
    const draftAfterGate = h.coworkStore.listCapabilityDrafts(5).find((draft) => draft.id === seeded.draftId);
    assert.equal(draftAfterGate.status, 'validated');
    h.db.run('UPDATE capability_drafts SET validated_at = ? WHERE id = ?', [dayStartMs(D2), seeded.draftId]);

    seedSession(h.coworkStore, h.db, D3, [
      { type: 'user', content: '继续' },
      { type: 'assistant', content: '好' },
    ]);
    await h.runNight(D3);

    const procedure = h.knowledgeStore.getProcedure(seeded.procedureId);
    assert.equal(procedure.status, 'active');
    assert.equal(procedure.hotEligible, true);
    assert.equal(procedure.hotReason, null);
    assert.deepEqual(procedure.steps, ['先自检', '再交付'], 'the agent body is never rewritten');
    assert.equal(procedure.version, 1, 'promotion is not a content revision');
    const draft = h.coworkStore.listCapabilityDrafts(5).find((row) => row.id === seeded.draftId);
    assert.equal(draft.promotedProcedureId, seeded.procedureId);
    assert.ok(draft.promotedAt != null);
  } finally {
    h.cleanup();
  }
});

test('flow: agreed rejection flips the procedure to gate_rejected, one ledger row', async () => {
  const h = await createDreamHarness();
  try {
    const seeded = seedProbation(h, '未经验证的流程', D1);
    seedSession(h.coworkStore, h.db, D2, [
      { type: 'user', content: '照做后翻车了' },
      { type: 'assistant', content: '抱歉' },
    ]);
    quietNight(h);
    h.router.on(MARKERS.validation, ({ user }) => validationVerdicts(user, () => ({
      verdict: 'rejected', score: 0.3, rationale: `${D2} 日记显示照做后被差评`,
    })));
    await h.runNight(D2);

    const procedure = h.knowledgeStore.getProcedure(seeded.procedureId);
    assert.equal(procedure.status, 'active', 'an agent record is never archived by the gate');
    assert.equal(procedure.hotEligible, false);
    assert.equal(procedure.hotReason, 'gate_rejected');
    assert.equal(h.coworkStore.listFalsifiedHypotheses(5).length, 1);
  } finally {
    h.cleanup();
  }
});

test('flow: rollback keeps the agent record, archives the dream-origin procedure', async () => {
  const h = await createDreamHarness();
  try {
    // A promotable probation ticket plus a promotable plain dream draft,
    // both validated before night 1 (promptLayerRollback setup).
    const seeded = seedProbation(h, '回滚夜之前学的规程', ROLLBACK_DAY0);
    h.coworkStore.updateCapabilityDraftValidation({
      id: seeded.draftId, metabotId: 5, status: 'validated', validationScore: 0.95,
    });
    h.db.run('UPDATE capability_drafts SET validated_at = ? WHERE id = ?', [dayStartMs(ROLLBACK_DAY0), seeded.draftId]);
    h.coworkStore.insertCapabilityDrafts(5, ROLLBACK_DAY0, [
      { title: '普通晋升技巧', description: 'd', capabilityType: 'workflow' },
    ]);
    const plainDraft = h.coworkStore.listCapabilityDrafts(5).find((draft) => draft.sourceProcedureId == null);
    h.coworkStore.updateCapabilityDraftValidation({
      id: plainDraft.id, metabotId: 5, status: 'validated', validationScore: 0.95,
    });
    h.db.run('UPDATE capability_drafts SET validated_at = ? WHERE id = ?', [dayStartMs(ROLLBACK_DAY0), plainDraft.id]);

    seedSession(h.coworkStore, h.db, ROLLBACK_DAY1, [
      { type: 'user', content: '视频做好了吗' },
      { type: 'assistant', content: '做好了' },
    ]);
    quietNight(h);
    await h.runNight(ROLLBACK_DAY1);
    const agentProc = h.knowledgeStore.getProcedure(seeded.procedureId);
    assert.equal(agentProc.hotEligible, true, 'night 1 promoted the probation procedure');
    const dreamProcTitle = '普通晋升技巧';
    assert.ok(h.knowledgeStore.listProcedures({ metabotId: 5, status: 'active' }).some((entry) => entry.title === dreamProcTitle));

    // Day 2 carries a negative-feedback spike (two thumbs-down + one re-ask).
    const session = h.coworkStore.createSession('改视频的回合', '/tmp/b', '', 'local', [], 5);
    const base = dayStartMs(ROLLBACK_DAY2);
    const insertMessage = (id, type, content, createdAt, sequence) => h.db.run(
      'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, session.id, type, content, '{}', createdAt, sequence],
    );
    insertMessage('rb-m1', 'user', '请换成轻快的风格', base + 1000, 1);
    insertMessage('rb-m2', 'assistant', '已换成古典钢琴', base + 2000, 2);
    insertMessage('rb-m3', 'user', '请换成轻快一点的风格', base + 320_000, 3);
    insertMessage('rb-m4', 'assistant', '这次是爵士鼓点', base + 400_000, 4);
    h.db.run(
      'INSERT INTO message_feedback (message_id, session_id, rating, comment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['rb-m2', session.id, 'down', '不是我要的风格', base + 500_000, base + 500_000],
    );
    h.db.run(
      'INSERT INTO message_feedback (message_id, session_id, rating, comment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['rb-m4', session.id, 'down', null, base + 600_000, base + 600_000],
    );
    await h.runNight(ROLLBACK_DAY2);

    const agentAfter = h.knowledgeStore.getProcedure(seeded.procedureId);
    assert.equal(agentAfter.status, 'active', 'rollback never archives an agent record');
    assert.equal(agentAfter.hotEligible, false);
    assert.equal(agentAfter.hotReason, 'rollback');
    const dreamAfter = h.knowledgeStore.listProcedures({ metabotId: 5, status: 'all' })
      .find((entry) => entry.title === dreamProcTitle);
    assert.equal(dreamAfter.status, 'archived', 'dream-origin procedures keep the archive behavior');
    assert.equal(h.coworkStore.listFalsifiedHypotheses(5).length, 0, 'rollback rejections never write the ledger');
  } finally {
    h.cleanup();
  }
});

test('flow: missing source procedure rejects the ticket without a ledger row', async () => {
  const h = await createDreamHarness();
  try {
    const seeded = seedProbation(h, '来源已归档的规程', D1);
    seedSession(h.coworkStore, h.db, D2, [
      { type: 'user', content: '继续' },
      { type: 'assistant', content: '好' },
    ]);
    quietNight(h);
    h.router.on(MARKERS.validation, ({ user }) => validationVerdicts(user, () => ({
      verdict: 'validated', score: 0.9, rationale: `${D2} 日记显示照做后获赞`,
    })));
    h.router.on(MARKERS.reconciliation, ({ user }) => reconciliationKeep(user));
    await h.runNight(D2);
    h.db.run('UPDATE capability_drafts SET validated_at = ? WHERE id = ?', [dayStartMs(D2), seeded.draftId]);
    assert.ok(h.knowledgeStore.archiveProcedureByTitle(5, '来源已归档的规程'));

    seedSession(h.coworkStore, h.db, D3, [
      { type: 'user', content: '继续' },
      { type: 'assistant', content: '好' },
    ]);
    await h.runNight(D3);

    const draft = h.coworkStore.listCapabilityDrafts(5).find((row) => row.id === seeded.draftId);
    assert.equal(draft.status, 'rejected');
    assert.equal(draft.validationNotes, 'source procedure no longer active');
    assert.equal(h.coworkStore.listFalsifiedHypotheses(5).length, 0);
  } finally {
    h.cleanup();
  }
});

test('flow: the reconciliation prompt never offers the ticket\'s own procedure', async () => {
  const h = await createDreamHarness();
  try {
    const seeded = seedProbation(h, '先验证再交付流程', D1);
    seedSession(h.coworkStore, h.db, D2, [
      { type: 'user', content: '上次那样交付很棒' },
      { type: 'assistant', content: '谢谢' },
    ]);
    quietNight(h);
    h.router.on(MARKERS.validation, ({ user }) => validationVerdicts(user, () => ({
      verdict: 'validated', score: 0.9, rationale: `${D2} 日记显示照做后获赞`,
    })));
    let reconciliationPrompt = null;
    h.router.on(MARKERS.reconciliation, ({ user }) => {
      reconciliationPrompt = user;
      return reconciliationKeep(user);
    });
    await h.runNight(D2);
    assert.ok(reconciliationPrompt, 'the reconciliation pass ran');
    assert.ok(
      !reconciliationPrompt.includes(`procedure:${seeded.procedureId}`),
      'a probation draft never conflicts with (or merges into) its own procedure',
    );
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// P2 acceptance repairs: ticket reopen on revision, archived re-activation stamp
// ---------------------------------------------------------------------------

test('a validated-but-unpromoted ticket reopens in place; the promotion night cannot promote it', async () => {
  const h = await createDreamHarness();
  try {
    const seeded = seedProbation(h, '修改后再学的流程', D1);
    seedSession(h.coworkStore, h.db, D2, [
      { type: 'user', content: '上次那样很棒' },
      { type: 'assistant', content: '谢谢' },
    ]);
    quietNight(h);
    h.router.on(MARKERS.validation, ({ user }) => validationVerdicts(user, () => ({
      verdict: 'validated', score: 0.9, rationale: `${D2} 日记显示照做后获赞`,
    })));
    h.router.on(MARKERS.reconciliation, ({ user }) => reconciliationKeep(user));
    await h.runNight(D2);
    const validated = h.coworkStore.listCapabilityDrafts(5).find((draft) => draft.id === seeded.draftId);
    assert.equal(validated.status, 'validated');
    assert.equal(validated.promotedAt, null, 'validated but not yet promoted');

    // The agent revises the procedure: new body, new ticket description/date.
    const revised = h.knowledgeStore.upsertProcedure({
      metabotId: 5, title: '修改后再学的流程', triggerText: '当用户要求修改后的流程', steps: ['新步骤'],
      sourcePinIds: [], origin: 'agent',
    });
    assert.equal(revised.needsGate, true);
    const reopened = h.coworkStore.ensureProbationDraftForProcedure({
      metabotId: 5,
      procedureId: seeded.procedureId,
      title: '修改后再学的流程',
      description: '触发:当用户要求修改后的流程\n步骤:新步骤',
      dreamDate: D2,
    });
    assert.equal(reopened.created, false, 'the stale ticket is reopened, not duplicated');
    assert.equal(reopened.draftId, seeded.draftId);
    const rows = h.coworkStore.listCapabilityDrafts(5).filter((draft) => draft.sourceProcedureId === seeded.procedureId);
    assert.equal(rows.length, 1, 'still exactly one ticket for the procedure');
    assert.equal(rows[0].status, 'draft', 'the verdict is wiped — the gate re-judges the revision');
    assert.equal(rows[0].description, '触发:当用户要求修改后的流程\n步骤:新步骤');
    assert.equal(rows[0].dreamDate, D2);
    assert.equal(rows[0].validatedAt, null);
    assert.equal(rows[0].validationScore, null);
    assert.equal(rows[0].validationNotes, null);

    // The next promotion night must not harden the revised procedure.
    seedSession(h.coworkStore, h.db, D3, [
      { type: 'user', content: '继续' },
      { type: 'assistant', content: '好' },
    ]);
    await h.runNight(D3);
    assert.equal(h.knowledgeStore.getProcedure(seeded.procedureId).hotEligible, false);
    assert.equal(h.telemetry(D3)?.promotionBudget?.candidates, 0);
    assert.equal(h.telemetry(D3)?.promotionBudget?.promoted, 0);
  } finally {
    h.cleanup();
  }
});

test('an archived dream-origin procedure re-activates with a fresh hot_since', async () => {
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  db.run('CREATE TABLE metabots (id INTEGER PRIMARY KEY, name TEXT)');
  db.run("INSERT INTO metabots (id, name) VALUES (5, '小火')");
  let clock = CLOCK;
  const store = new MetaIDKnowledgeStore(db, () => {}, () => clock);
  const saved = store.upsertProcedure({
    metabotId: 5, title: '归档后复活的梦境规程', triggerText: '当…', steps: ['一步'], origin: 'dream',
  });
  assert.equal(saved.entry.hotSince, CLOCK, 'first hot stint stamped at the original clock');
  clock += 5000;
  assert.ok(store.archiveProcedureByTitle(5, '归档后复活的梦境规程'));
  assert.equal(store.getProcedure(saved.entry.id).hotSince, CLOCK, 'archiving keeps the old stamp');
  const revived = store.upsertProcedure({
    metabotId: 5, title: '归档后复活的梦境规程', triggerText: '当…', steps: ['新一步'], origin: 'dream',
  });
  assert.equal(revived.entry.hotEligible, true);
  assert.equal(revived.entry.status, 'active');
  assert.equal(revived.entry.hotSince, clock, 're-activation starts a fresh hot stint at the current clock');
});
